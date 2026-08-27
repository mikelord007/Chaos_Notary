// services/blast-radius-sandbox/src/server.ts
import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerTools } from "./tools.js";

const PORT = Number(process.env.PORT ?? 3200);

async function main() {
  const mcpServer = new McpServer({ name: "chaos-notary-blast-radius-sandbox", version: "1.0.0" });
  registerTools(mcpServer);

  // Stateless mode: each request is an independent JSON-RPC call. See
  // services/mcp-server/src/server.ts (M2) for why — a stateful transport with a generated session ID
  // rejects every request after the first client session closes, and every
  // caller here (the acceptance script's cliCall.ts) is a short-lived,
  // one-call-then-disconnect client.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  await mcpServer.connect(transport);

  const httpServer = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (req.url === "/mcp") {
      // .catch(), not `void` alone: an unhandled rejection here would crash
      // the whole process on a single malformed request (this exact bug
      // was found and fixed in M2's server.ts during its Qodo review).
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
    console.log(`chaos-notary blast-radius sandbox listening on :${PORT}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
