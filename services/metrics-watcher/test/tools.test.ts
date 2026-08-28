// services/metrics-watcher/test/tools.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { handleObserveImpact, registerTools } from "../src/tools.js";

test("handleObserveImpact reports hard severity and a matched verdict when the affected route is failing hard", async () => {
  const result = await handleObserveImpact(
    { predicted_severity: "hard", affected_routes: ["/products"], window_seconds: 60 },
    async () => ({
      "/products": { errorRatePercent: 87, avgLatencyMs: 5, requestCount: 20 },
      "/orders": { errorRatePercent: null, avgLatencyMs: null, requestCount: 0 },
      "/health": { errorRatePercent: null, avgLatencyMs: null, requestCount: 0 },
      "/metrics": { errorRatePercent: null, avgLatencyMs: null, requestCount: 0 },
    })["/products"],
  );
  assert.equal(result.observedSeverity, "hard");
  assert.equal(result.verdict, "matched");
  assert.equal(result.routes["/products"].errorRatePercent, 87);
});

test("registerTools registers observe_impact on a real McpServer and validates input via zod", async () => {
  const server = new McpServer({ name: "test-server", version: "1.0.0" });
  registerTools(server, async () => ({ errorRatePercent: null, avgLatencyMs: null, requestCount: 0 }));

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((t) => t.name),
    ["observe_impact"],
  );

  const good = await client.callTool({
    name: "observe_impact",
    arguments: { predicted_severity: "degraded", affected_routes: ["/products"], window_seconds: 60 },
  });
  assert.equal(good.isError, undefined);

  const badSeverity = await client.callTool({
    name: "observe_impact",
    arguments: { predicted_severity: "catastrophic", affected_routes: ["/products"], window_seconds: 60 },
  });
  assert.equal(badSeverity.isError, true);

  const badRoute = await client.callTool({
    name: "observe_impact",
    arguments: { predicted_severity: "hard", affected_routes: ["/not-a-real-route"], window_seconds: 60 },
  });
  assert.equal(badRoute.isError, true);

  const emptyRoutes = await client.callTool({
    name: "observe_impact",
    arguments: { predicted_severity: "hard", affected_routes: [], window_seconds: 60 },
  });
  assert.equal(emptyRoutes.isError, true);

  const badWindow = await client.callTool({
    name: "observe_impact",
    arguments: { predicted_severity: "hard", affected_routes: ["/products"], window_seconds: 0 },
  });
  assert.equal(badWindow.isError, true);

  await client.close();
  await server.close();
});
