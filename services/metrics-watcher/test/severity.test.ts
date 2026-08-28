import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyRoute, worstOf, computeVerdict } from "../src/severity.js";

test("classifyRoute: no traffic in window classifies as none", () => {
  assert.equal(classifyRoute({ errorRatePercent: null, avgLatencyMs: null, requestCount: 0 }), "none");
});

test("classifyRoute: error rate at or above 40% classifies as hard", () => {
  assert.equal(classifyRoute({ errorRatePercent: 40, avgLatencyMs: 10, requestCount: 5 }), "hard");
  assert.equal(classifyRoute({ errorRatePercent: 87, avgLatencyMs: 10, requestCount: 5 }), "hard");
});

test("classifyRoute: error rate at or below 1% classifies as none", () => {
  assert.equal(classifyRoute({ errorRatePercent: 0, avgLatencyMs: 10, requestCount: 5 }), "none");
  assert.equal(classifyRoute({ errorRatePercent: 1, avgLatencyMs: 10, requestCount: 5 }), "none");
});

test("classifyRoute: error rate strictly between 1% and 40% classifies as degraded", () => {
  assert.equal(classifyRoute({ errorRatePercent: 1.5, avgLatencyMs: 10, requestCount: 5 }), "degraded");
  assert.equal(classifyRoute({ errorRatePercent: 39.9, avgLatencyMs: 10, requestCount: 5 }), "degraded");
});

test("worstOf: returns the highest-severity value present", () => {
  assert.equal(worstOf(["none", "degraded", "none"]), "degraded");
  assert.equal(worstOf(["none", "degraded", "hard"]), "hard");
  assert.equal(worstOf(["none"]), "none");
});

test("worstOf: empty array returns none", () => {
  assert.equal(worstOf([]), "none");
});

test("computeVerdict: observed matches predicted", () => {
  assert.equal(computeVerdict("hard", "hard"), "matched");
  assert.equal(computeVerdict("degraded", "degraded"), "matched");
});

test("computeVerdict: observed is milder than predicted", () => {
  assert.equal(computeVerdict("hard", "degraded"), "milder_than_predicted");
  assert.equal(computeVerdict("hard", "none"), "milder_than_predicted");
  assert.equal(computeVerdict("degraded", "none"), "milder_than_predicted");
});

test("computeVerdict: observed is worse than predicted", () => {
  assert.equal(computeVerdict("degraded", "hard"), "worse_than_predicted");
});

test("classifyRoute: avgLatencyMs at or above 2000ms classifies as hard even with zero/null error rate", () => {
  assert.equal(classifyRoute({ errorRatePercent: 0, avgLatencyMs: 2000, requestCount: 5 }), "hard");
  assert.equal(classifyRoute({ errorRatePercent: null, avgLatencyMs: 2500, requestCount: 5 }), "hard");
});

test("classifyRoute: avgLatencyMs just below 2000ms does not escalate via latency alone (boundary is exact)", () => {
  // Still governed by error rate as before — a low error rate with
  // sub-threshold latency must NOT classify as hard.
  assert.equal(classifyRoute({ errorRatePercent: 0, avgLatencyMs: 1999, requestCount: 5 }), "none");
  assert.equal(classifyRoute({ errorRatePercent: 1.5, avgLatencyMs: 1999, requestCount: 5 }), "degraded");
});

test("classifyRoute: null error rate with apiWasDown true classifies as hard (genuine outage, not idle)", () => {
  assert.equal(classifyRoute({ errorRatePercent: null, avgLatencyMs: null, requestCount: 0 }, true), "hard");
});

test("classifyRoute: null error rate with apiWasDown false (or omitted) keeps existing none behavior", () => {
  assert.equal(classifyRoute({ errorRatePercent: null, avgLatencyMs: null, requestCount: 0 }, false), "none");
  assert.equal(classifyRoute({ errorRatePercent: null, avgLatencyMs: null, requestCount: 0 }), "none");
});
