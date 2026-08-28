// services/metrics-watcher/test/prometheus.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { queryRouteMetrics, checkoutApiWasDown } from "../src/prometheus.js";

function fakePrometheus(responses: Record<string, string>) {
  return async (url: string | URL) => {
    const u = new URL(url);
    const query = u.searchParams.get("query") ?? "";
    for (const [substring, value] of Object.entries(responses)) {
      if (query.includes(substring)) {
        return new Response(
          JSON.stringify({
            status: "success",
            data: { resultType: "vector", result: [{ metric: {}, value: [1700000000, value] }] },
          }),
          { status: 200 },
        );
      }
    }
    // No matching substring: empty result vector (Prometheus's real shape for "no data").
    return new Response(
      JSON.stringify({ status: "success", data: { resultType: "vector", result: [] } }),
      { status: 200 },
    );
  };
}

// Captures every PromQL query string sent, rather than dispatching on it, so
// tests can assert on the exact query text (e.g. presence/absence of the
// `offset Ns` clause) instead of just the returned value.
function capturingFetcher(value: string | null) {
  const queries: string[] = [];
  const fetchImpl = async (url: string | URL) => {
    const u = new URL(url);
    queries.push(u.searchParams.get("query") ?? "");
    if (value === null) {
      return new Response(
        JSON.stringify({ status: "success", data: { resultType: "vector", result: [] } }),
        { status: 200 },
      );
    }
    return new Response(
      JSON.stringify({
        status: "success",
        data: { resultType: "vector", result: [{ metric: {}, value: [1700000000, value] }] },
      }),
      { status: 200 },
    );
  };
  return { fetchImpl, queries };
}

test("queryRouteMetrics returns real numbers when Prometheus has data", async () => {
  const fetchImpl = fakePrometheus({
    "increase(http_requests_total": "12",
    "status=~\"5..\"": "25",
    "http_request_duration_seconds_sum": "0.5",
  });
  const result = await queryRouteMetrics("http://prometheus:9090", "/products", 60, fetchImpl as unknown as typeof fetch);
  assert.equal(result.requestCount, 12);
  assert.equal(result.errorRatePercent, 25);
  assert.equal(result.avgLatencyMs, 500);
});

test("queryRouteMetrics returns nulls (not 0 or NaN) when there is no traffic in the window", async () => {
  const fetchImpl = fakePrometheus({});
  const result = await queryRouteMetrics("http://prometheus:9090", "/health", 60, fetchImpl as unknown as typeof fetch);
  assert.equal(result.requestCount, 0);
  assert.equal(result.errorRatePercent, null);
  assert.equal(result.avgLatencyMs, null);
});

test("queryRouteMetrics throws when Prometheus returns a non-2xx response", async () => {
  const fetchImpl = async () => new Response("internal error", { status: 500, statusText: "Internal Server Error" });
  await assert.rejects(
    () => queryRouteMetrics("http://prometheus:9090", "/products", 60, fetchImpl as unknown as typeof fetch),
    /Prometheus query failed/,
  );
});

test("queryRouteMetrics throws when Prometheus responds with a non-success status body", async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ status: "error", error: "bad query" }), { status: 200 });
  await assert.rejects(
    () => queryRouteMetrics("http://prometheus:9090", "/products", 60, fetchImpl as unknown as typeof fetch),
    /Prometheus query returned status/,
  );
});

test("queryRouteMetrics includes an `offset Ns` clause on every range-vector query when offsetSeconds > 0", async () => {
  const { fetchImpl, queries } = capturingFetcher("5");
  await queryRouteMetrics("http://prometheus:9090", "/products", 60, fetchImpl as unknown as typeof fetch, 45);
  assert.equal(queries.length, 3, "expects requestCount, errorRate, and latency queries");
  for (const q of queries) {
    assert.match(q, /\[60s\] offset 45s/, `query missing offset clause: ${q}`);
  }
});

test("queryRouteMetrics omits the offset clause when offsetSeconds is 0 or omitted", async () => {
  const { fetchImpl: fetchImplDefault, queries: queriesDefault } = capturingFetcher("5");
  await queryRouteMetrics("http://prometheus:9090", "/products", 60, fetchImplDefault as unknown as typeof fetch);
  assert.ok(queriesDefault.length > 0);
  for (const q of queriesDefault) {
    assert.ok(!q.includes("offset"), `query unexpectedly contains offset clause: ${q}`);
  }

  const { fetchImpl: fetchImplZero, queries: queriesZero } = capturingFetcher("5");
  await queryRouteMetrics("http://prometheus:9090", "/products", 60, fetchImplZero as unknown as typeof fetch, 0);
  for (const q of queriesZero) {
    assert.ok(!q.includes("offset"), `query unexpectedly contains offset clause: ${q}`);
  }
});

test("checkoutApiWasDown returns true when up{} reports below 1 (scrape target down) during the window", async () => {
  const fetchImpl = fakePrometheus({ 'up{job="checkout-api"}': "0" });
  const result = await checkoutApiWasDown(
    "http://prometheus:9090",
    60,
    30,
    fetchImpl as unknown as typeof fetch,
  );
  assert.equal(result, true);
});

test("checkoutApiWasDown returns false when up{} reports 1 (scrape target healthy) throughout the window", async () => {
  const fetchImpl = fakePrometheus({ 'up{job="checkout-api"}': "1" });
  const result = await checkoutApiWasDown(
    "http://prometheus:9090",
    60,
    30,
    fetchImpl as unknown as typeof fetch,
  );
  assert.equal(result, false);
});

test("checkoutApiWasDown returns false when there is no up{} data at all (treated as not-known-down)", async () => {
  const fetchImpl = fakePrometheus({});
  const result = await checkoutApiWasDown(
    "http://prometheus:9090",
    60,
    30,
    fetchImpl as unknown as typeof fetch,
  );
  assert.equal(result, false);
});

test("checkoutApiWasDown's query includes the offset clause when offsetSeconds > 0, and omits it when 0", async () => {
  const { fetchImpl, queries } = capturingFetcher("0");
  await checkoutApiWasDown("http://prometheus:9090", 60, 20, fetchImpl as unknown as typeof fetch);
  assert.equal(queries.length, 1);
  assert.match(queries[0], /min_over_time\(up\{job="checkout-api"\}\[60s\] offset 20s\)/);

  const { fetchImpl: fetchImplNoOffset, queries: queriesNoOffset } = capturingFetcher("0");
  await checkoutApiWasDown("http://prometheus:9090", 60, 0, fetchImplNoOffset as unknown as typeof fetch);
  assert.ok(!queriesNoOffset[0].includes("offset"));
});
