// services/mcp-server/src/server.ts
import http from "node:http";
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

  const httpServer = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (req.url === "/mcp") {
      // Stateless mode (sessionIdGenerator: undefined): each request is an
      // independent JSON-RPC call, not part of a persisted session. Every
      // caller (cliCall.ts, and in general any short-lived MCP client)
      // connects, makes one call, and disconnects. The SDK enforces "one
      // transport per request" at two levels: the transport itself throws
      // "Stateless transport cannot be reused across requests" on its
      // second call, and Server.connect() throws "Already connected to a
      // transport" if the same McpServer instance is still attached to a
      // prior transport -- so both the transport AND the McpServer must be
      // created fresh per request, not shared for the process's whole
      // lifetime. Verified against a live server: a single shared transport
      // made every request after the first fail with a bare 500;
      // registerTools() is cheap (zod schemas + closures, no I/O), so
      // re-registering per request costs nothing meaningful.
      const mcpServer = new McpServer({ name: "chaos-notary-mcp", version: "1.0.0" });
      registerTools(mcpServer, { docker, registry });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      mcpServer
        .connect(transport)
        .then(() => transport.handleRequest(req, res))
        .catch((err) => {
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

  async function shutdown(signal: string) {
    console.log(`received ${signal}, reverting ${registry.list().length} active fault(s) before exit`);
    await Promise.all(registry.list().map((fault) => registry.revertAndRemove(fault.container)));
    // revertAndRemove absorbs a revert's final failure (after its own retry
    // budget) and deliberately leaves that fault registered rather than
    // pretending it's clear — check for that here so a failed shutdown
    // revert is loud, not silent, and exit non-zero to tell the orchestrator
    // (Docker) this shutdown wasn't clean.
    const stillActive = registry.list();
    if (stillActive.length > 0) {
      console.error(
        `shutdown: ${stillActive.length} fault(s) could not be reverted before exit: ${stillActive
          .map((fault) => `${fault.container} (${fault.kind})`)
          .join(", ")}. These may still be active on the target containers.`,
      );
    }
    httpServer.close(() => process.exit(stillActive.length > 0 ? 1 : 0));
  }

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
