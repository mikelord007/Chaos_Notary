// services/blast-radius-sandbox/test/tools.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { handlePredictBlastRadius, registerTools } from "../src/tools.js";

test("handlePredictBlastRadius returns a prediction for an allowlisted container", () => {
  const result = handlePredictBlastRadius({ container: "chaos-pg-replica", fault_kind: "pause" });
  assert.equal(result.severity, "hard");
  assert.ok(result.affected.some((i) => i.target === "GET /products"));
});

test("registerTools registers predict_blast_radius on a real McpServer and validates input via zod", async () => {
  const server = new McpServer({ name: "test-server", version: "1.0.0" });
  registerTools(server);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((t) => t.name),
    ["predict_blast_radius"],
  );

  const good = await client.callTool({
    name: "predict_blast_radius",
    arguments: { container: "chaos-pg-replica", fault_kind: "pause" },
  });
  assert.equal(good.isError, undefined);

  const badContainer = await client.callTool({
    name: "predict_blast_radius",
    arguments: { container: "not-a-real-container", fault_kind: "pause" },
  });
  assert.equal(badContainer.isError, true);

  const badFaultKind = await client.callTool({
    name: "predict_blast_radius",
    arguments: { container: "chaos-pg-replica", fault_kind: "not-a-real-fault" },
  });
  assert.equal(badFaultKind.isError, true);

  await client.close();
  await server.close();
});
