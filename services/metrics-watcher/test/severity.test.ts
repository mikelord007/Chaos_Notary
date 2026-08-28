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
