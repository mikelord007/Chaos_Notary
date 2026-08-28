// services/metrics-watcher/test/prometheus.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { queryRouteMetrics } from "../src/prometheus.js";

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
