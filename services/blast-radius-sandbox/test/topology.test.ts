import { test } from "node:test";
import assert from "node:assert/strict";
import {
  predictBlastRadius,
  LATENCY_HARD_THRESHOLD_MS,
  PACKET_LOSS_HARD_THRESHOLD_PERCENT,
} from "../src/topology.js";

test("pausing chaos-pg-replica: hard severity, GET /products affected, POST /orders unaffected", () => {
  const result = predictBlastRadius({ container: "chaos-pg-replica", faultKind: "pause" });
  assert.equal(result.severity, "hard");
  assert.ok(result.affected.some((i) => i.target === "GET /products"));
  assert.ok(result.unaffected.some((u) => u.includes("POST /orders")));
});

test("pausing chaos-pg-primary: hard severity, POST /orders affected, GET /products unaffected", () => {
  const result = predictBlastRadius({ container: "chaos-pg-primary", faultKind: "pause" });
  assert.equal(result.severity, "hard");
  assert.ok(result.affected.some((i) => i.target === "POST /orders"));
  assert.ok(result.unaffected.some((u) => u.includes("GET /products")));
});

test("killing chaos-checkout-api: hard severity, both routes affected", () => {
  const result = predictBlastRadius({ container: "chaos-checkout-api", faultKind: "kill" });
  assert.equal(result.severity, "hard");
  assert.ok(result.affected.some((i) => i.target === "GET /products"));
  assert.ok(result.affected.some((i) => i.target === "POST /orders"));
});

test("stopping chaos-prometheus: hard severity, dashboard affected, API routes unaffected", () => {
  const result = predictBlastRadius({ container: "chaos-prometheus", faultKind: "stop" });
  assert.equal(result.severity, "hard");
  assert.ok(result.affected.some((i) => i.target.includes("Grafana")));
  assert.ok(result.unaffected.some((u) => u.includes("GET /products")));
  assert.ok(result.unaffected.some((u) => u.includes("POST /orders")));
});

test("pausing chaos-grafana: hard severity, dashboard UI affected, everything else unaffected", () => {
  const result = predictBlastRadius({ container: "chaos-grafana", faultKind: "pause" });
  assert.equal(result.severity, "hard");
  assert.ok(result.affected.some((i) => i.target.includes("Grafana dashboard UI")));
  assert.ok(result.unaffected.some((u) => u.includes("GET /products")));
});

test("inject_latency below the hard threshold on chaos-pg-replica is degraded severity", () => {
  const result = predictBlastRadius({
    container: "chaos-pg-replica",
    faultKind: "inject_latency",
    latencyMs: LATENCY_HARD_THRESHOLD_MS - 1,
  });
  assert.equal(result.severity, "degraded");
});

test("inject_latency at or above the hard threshold on chaos-pg-replica is hard severity", () => {
  const result = predictBlastRadius({
    container: "chaos-pg-replica",
    faultKind: "inject_latency",
    latencyMs: LATENCY_HARD_THRESHOLD_MS,
  });
  assert.equal(result.severity, "hard");
});

test("inject_packet_loss below the hard threshold is degraded severity", () => {
  const result = predictBlastRadius({
    container: "chaos-pg-replica",
    faultKind: "inject_packet_loss",
    percent: PACKET_LOSS_HARD_THRESHOLD_PERCENT - 1,
  });
  assert.equal(result.severity, "degraded");
});

test("inject_packet_loss at or above the hard threshold is hard severity", () => {
  const result = predictBlastRadius({
    container: "chaos-pg-replica",
    faultKind: "inject_packet_loss",
    percent: PACKET_LOSS_HARD_THRESHOLD_PERCENT,
  });
  assert.equal(result.severity, "hard");
});

test("a container outside the topology model throws", () => {
  assert.throws(() => predictBlastRadius({ container: "chaos-mcp-server", faultKind: "pause" }));
});

test("inject_latency/inject_packet_loss with no latencyMs/percent given defaults to degraded (0 is below both thresholds)", () => {
  const latency = predictBlastRadius({ container: "chaos-pg-replica", faultKind: "inject_latency" });
  assert.equal(latency.severity, "degraded");
  const loss = predictBlastRadius({ container: "chaos-pg-replica", faultKind: "inject_packet_loss" });
  assert.equal(loss.severity, "degraded");
});

test("inject_latency on a non-DB container never reaches hard severity, regardless of latency", () => {
  const result = predictBlastRadius({ container: "chaos-grafana", faultKind: "inject_latency", latencyMs: 999999 });
  assert.equal(result.severity, "degraded");
});

test("inject_packet_loss on a non-DB container never reaches hard severity, regardless of percent", () => {
  const result = predictBlastRadius({ container: "chaos-checkout-api", faultKind: "inject_packet_loss", percent: 100 });
  assert.equal(result.severity, "degraded");
});

test("inject_latency on chaos-prometheus never reaches hard severity", () => {
  const result = predictBlastRadius({ container: "chaos-prometheus", faultKind: "inject_latency", latencyMs: 999999 });
  assert.equal(result.severity, "degraded");
});
