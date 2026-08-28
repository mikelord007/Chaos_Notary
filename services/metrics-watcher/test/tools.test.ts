// services/metrics-watcher/test/tools.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { handleObserveImpact, registerTools, KNOWN_ROUTES, type KnownRoute } from "../src/tools.js";
import type { RouteMetrics } from "../src/prometheus.js";

// A route-aware fake fetcher: unlike a fetcher that ignores its `route`
// argument, this one dispatches on it, so tests can prove observe_impact's
// severity computation is actually scoped to affected_routes and that the
// `routes` field in the response reflects each route's own real metrics.
// It also records the offsetSeconds it was called with, so tests can assert
// fault_ended_at was correctly translated into an offset and threaded
// through to route-metrics fetching.
const BASELINE: RouteMetrics = { errorRatePercent: 0, avgLatencyMs: 5, requestCount: 100 };

function makeFetcher(overrides: Partial<Record<KnownRoute, RouteMetrics>>) {
  const offsetsSeen: number[] = [];
  const fetcher = async (route: KnownRoute, offsetSeconds: number): Promise<RouteMetrics> => {
    offsetsSeen.push(offsetSeconds);
    return overrides[route] ?? BASELINE;
  };
  return { fetcher, offsetsSeen };
}

// checkout-api's own scrape-health fetcher — most tests don't care about
// this signal, so a stub that always reports "not down" and records what
// window/offset it was called with is enough to isolate the behavior under
// test from the real network-backed default.
function makeApiHealthFetcher(apiWasDown = false) {
  const callsSeen: Array<{ windowSeconds: number; offsetSeconds: number }> = [];
  const fetcher = async (windowSeconds: number, offsetSeconds: number): Promise<boolean> => {
    callsSeen.push({ windowSeconds, offsetSeconds });
    return apiWasDown;
  };
  return { fetcher, callsSeen };
}

test("handleObserveImpact reports hard severity and a matched verdict when the affected route is failing hard", async () => {
  const { fetcher } = makeFetcher({
    "/products": { errorRatePercent: 87, avgLatencyMs: 5, requestCount: 20 },
  });
  const result = await handleObserveImpact(
    { predicted_severity: "hard", affected_routes: ["/products"], window_seconds: 60 },
    fetcher,
    makeApiHealthFetcher().fetcher,
  );
  assert.equal(result.observedSeverity, "hard");
  assert.equal(result.verdict, "matched");
  assert.equal(result.routes["/products"].errorRatePercent, 87);
});

test("handleObserveImpact scopes observedSeverity to affected_routes only, ignoring unrelated routes' severity", async () => {
  const { fetcher } = makeFetcher({
    // /products is failing hard, but it's NOT in affected_routes.
    "/products": { errorRatePercent: 90, avgLatencyMs: 5, requestCount: 50 },
    // /orders — the only affected route — has no errors at all.
    "/orders": { errorRatePercent: 0, avgLatencyMs: 5, requestCount: 50 },
  });
  const result = await handleObserveImpact(
    { predicted_severity: "hard", affected_routes: ["/orders"], window_seconds: 60 },
    fetcher,
    makeApiHealthFetcher().fetcher,
  );
  assert.equal(result.observedSeverity, "none");
  assert.equal(result.verdict, "milder_than_predicted");
  // The unrelated route's real (hard) severity must still be visible in the
  // full routes breakdown — it's just not allowed to influence the verdict.
  assert.equal(result.routes["/products"].errorRatePercent, 90);
});

test("handleObserveImpact's routes field always contains all 4 known routes with real per-route metrics, not just the affected ones", async () => {
  const { fetcher } = makeFetcher({
    "/products": { errorRatePercent: 12, avgLatencyMs: 40, requestCount: 11 },
    "/orders": { errorRatePercent: 34, avgLatencyMs: 60, requestCount: 22 },
    "/health": { errorRatePercent: 0, avgLatencyMs: 3, requestCount: 33 },
    "/metrics": { errorRatePercent: 56, avgLatencyMs: 80, requestCount: 44 },
  });
  const result = await handleObserveImpact(
    { predicted_severity: "degraded", affected_routes: ["/health"], window_seconds: 60 },
    fetcher,
    makeApiHealthFetcher().fetcher,
  );
  assert.deepEqual(Object.keys(result.routes).sort(), [...KNOWN_ROUTES].sort());
  // Each route's metrics are the distinct, real values from the fetcher —
  // not a shared placeholder — proving every route was actually queried.
  assert.equal(result.routes["/products"].errorRatePercent, 12);
  assert.equal(result.routes["/orders"].errorRatePercent, 34);
  assert.equal(result.routes["/health"].errorRatePercent, 0);
  assert.equal(result.routes["/metrics"].errorRatePercent, 56);
});

test("handleObserveImpact reports worse_than_predicted when observed severity exceeds the prediction", async () => {
  const { fetcher } = makeFetcher({
    "/products": { errorRatePercent: 92, avgLatencyMs: 200, requestCount: 30 },
  });
  const result = await handleObserveImpact(
    { predicted_severity: "degraded", affected_routes: ["/products"], window_seconds: 60 },
    fetcher,
    makeApiHealthFetcher().fetcher,
  );
  assert.equal(result.observedSeverity, "hard");
  assert.equal(result.verdict, "worse_than_predicted");
});

test("handleObserveImpact escalates to hard when checkoutApiWasDown is true, even with null route metrics", async () => {
  // No fault_ended_at, so requestCount/errorRatePercent come back null via
  // the BASELINE-overriding fetcher below (simulating checkout-api's own
  // request counters never incrementing during a full outage).
  const { fetcher } = makeFetcher({
    "/products": { errorRatePercent: null, avgLatencyMs: null, requestCount: 0 },
  });
  const result = await handleObserveImpact(
    { predicted_severity: "hard", affected_routes: ["/products"], window_seconds: 60 },
    fetcher,
    makeApiHealthFetcher(true).fetcher,
  );
  assert.equal(result.observedSeverity, "hard");
  assert.equal(result.verdict, "matched");
});

test("handleObserveImpact keeps none for null route metrics when checkoutApiWasDown is false (genuinely idle route)", async () => {
  const { fetcher } = makeFetcher({
    "/products": { errorRatePercent: null, avgLatencyMs: null, requestCount: 0 },
  });
  const result = await handleObserveImpact(
    { predicted_severity: "hard", affected_routes: ["/products"], window_seconds: 60 },
    fetcher,
    makeApiHealthFetcher(false).fetcher,
  );
  assert.equal(result.observedSeverity, "none");
  assert.equal(result.verdict, "milder_than_predicted");
});

test("handleObserveImpact computes offsetSeconds from fault_ended_at and passes it through to route-metrics/api-health fetching", async () => {
  const { fetcher, offsetsSeen } = makeFetcher({});
  const { fetcher: apiHealthFetcher, callsSeen } = makeApiHealthFetcher();

  const faultEndedAt = new Date(Date.now() - 45_000).toISOString(); // ended 45s ago
  await handleObserveImpact(
    { predicted_severity: "hard", affected_routes: ["/products"], window_seconds: 30, fault_ended_at: faultEndedAt },
    fetcher,
    apiHealthFetcher,
  );

  // Every route fetch (all 4 known routes) should see the same computed offset.
  assert.equal(offsetsSeen.length, KNOWN_ROUTES.length);
  for (const offset of offsetsSeen) {
    // Allow a small amount of slack for real elapsed test-execution time.
    assert.ok(offset >= 44 && offset <= 47, `expected offset ~45, got ${offset}`);
  }
  assert.equal(callsSeen.length, 1, "api health should be checked once per call, not once per route");
  assert.equal(callsSeen[0].windowSeconds, 30);
  assert.ok(callsSeen[0].offsetSeconds >= 44 && callsSeen[0].offsetSeconds <= 47);
});

test("handleObserveImpact uses offsetSeconds 0 when fault_ended_at is omitted", async () => {
  const { fetcher, offsetsSeen } = makeFetcher({});
  const { fetcher: apiHealthFetcher, callsSeen } = makeApiHealthFetcher();

  await handleObserveImpact(
    { predicted_severity: "hard", affected_routes: ["/products"], window_seconds: 60 },
    fetcher,
    apiHealthFetcher,
  );

  for (const offset of offsetsSeen) {
    assert.equal(offset, 0);
  }
  assert.equal(callsSeen[0].offsetSeconds, 0);
});

test("registerTools surfaces a fetcher error as isError: true through the real McpServer/Client round trip", async () => {
  const server = new McpServer({ name: "test-server-error", version: "1.0.0" });
  registerTools(
    server,
    async () => {
      throw new Error("prometheus unreachable");
    },
    async () => false,
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client-error", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  const result = await client.callTool({
    name: "observe_impact",
    arguments: { predicted_severity: "hard", affected_routes: ["/products"], window_seconds: 60 },
  });
  assert.equal(result.isError, true);

  await client.close();
  await server.close();
});

test("registerTools registers observe_impact on a real McpServer and validates input via zod", async () => {
  const server = new McpServer({ name: "test-server", version: "1.0.0" });
  registerTools(
    server,
    async () => ({ errorRatePercent: null, avgLatencyMs: null, requestCount: 0 }),
    async () => false,
  );

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

  const goodWithFaultEndedAt = await client.callTool({
    name: "observe_impact",
    arguments: {
      predicted_severity: "degraded",
      affected_routes: ["/products"],
      window_seconds: 60,
      fault_ended_at: new Date().toISOString(),
    },
  });
  assert.equal(goodWithFaultEndedAt.isError, undefined);

  const badFaultEndedAt = await client.callTool({
    name: "observe_impact",
    arguments: {
      predicted_severity: "degraded",
      affected_routes: ["/products"],
      window_seconds: 60,
      fault_ended_at: "not-a-timestamp",
    },
  });
  assert.equal(badFaultEndedAt.isError, true);

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
