// services/blast-radius-sandbox/src/server.ts
import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerTools } from "./tools.js";

const PORT = Number(process.env.PORT ?? 3200);

async function main() {
  const httpServer = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (req.url === "/mcp") {
      // Stateless mode (sessionIdGenerator: undefined): each request is an
      // independent JSON-RPC call, and every caller here (the acceptance
      // script's cliCall.ts) is a short-lived, one-call-then-disconnect
      // client. The SDK enforces "one transport per request" at two levels:
      // the transport itself throws "Stateless transport cannot be reused
      // across requests" on its second call, and Server.connect() throws
      // "Already connected to a transport" if the same McpServer instance
      // is still attached to a prior transport — so both the transport AND
      // the McpServer must be created fresh per request, not shared for the
      // process's whole lifetime (a single shared instance, which this file
      // used until this fix, made every request after the first fail with
      // a bare 500 — verified against a live server; see
      // services/mcp-server/src/server.ts for the same fix and the
      // reasoning behind it). registerTools() is cheap (zod schema + a
      // closure, no I/O), so re-registering per request costs nothing
      // meaningful.
      const mcpServer = new McpServer({ name: "chaos-notary-blast-radius-sandbox", version: "1.0.0" });
      registerTools(mcpServer);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      // .catch(), not `void` alone: an unhandled rejection here would crash
      // the whole process on a single malformed request (this exact bug
      // was found and fixed in M2's server.ts during its Qodo review).
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
    console.log(`chaos-notary blast-radius sandbox listening on :${PORT}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
