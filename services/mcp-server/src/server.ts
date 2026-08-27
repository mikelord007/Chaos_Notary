// services/mcp-server/src/server.ts
import http from "node:http";
import { randomUUID } from "node:crypto";
import Docker from "dockerode";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerTools } from "./tools.js";
import { FaultRegistry } from "./faultRegistry.js";
import { startupSweep } from "./dockerClient.js";

const PORT = Number(process.env.PORT ?? 3100);
const DOCKER_SOCKET_PATH = process.env.DOCKER_SOCKET_PATH ?? "/var/run/docker.sock";

async function main() {
  const docker = new Docker({ socketPath: DOCKER_SOCKET_PATH });
  const registry = new FaultRegistry();

  console.log("startup sweep: checking for lingering faults from a previous run");
  await startupSweep(docker, (msg) => console.log(msg));

  const mcpServer = new McpServer({ name: "chaos-notary-mcp", version: "1.0.0" });
  registerTools(mcpServer, { docker, registry });

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  await mcpServer.connect(transport);

  const httpServer = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (req.url === "/mcp") {
      transport.handleRequest(req, res).catch((err) => {
        console.error("error handling /mcp request", err);
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "internal server error" }));
        } else {
          res.end();
        }
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  httpServer.listen(PORT, () => {
    console.log(`chaos-notary MCP server listening on :${PORT}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
