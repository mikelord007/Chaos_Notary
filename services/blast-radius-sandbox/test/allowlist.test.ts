import { test } from "node:test";
import assert from "node:assert/strict";
import { ALLOWED_CONTAINERS, isAllowedContainer } from "../src/allowlist.js";

test("allowlist contains exactly the M1 stack's targets", () => {
  assert.deepEqual(
    [...ALLOWED_CONTAINERS].sort(),
    [
      "chaos-checkout-api",
      "chaos-grafana",
      "chaos-pg-primary",
      "chaos-pg-replica",
      "chaos-prometheus",
    ].sort(),
  );
});

test("isAllowedContainer accepts allowlisted names", () => {
  assert.equal(isAllowedContainer("chaos-pg-replica"), true);
});

test("isAllowedContainer rejects the mcp server", () => {
  assert.equal(isAllowedContainer("chaos-mcp-server"), false);
});

test("isAllowedContainer rejects this sandbox itself", () => {
  assert.equal(isAllowedContainer("chaos-blast-radius-sandbox"), false);
});

test("isAllowedContainer rejects unknown names", () => {
  assert.equal(isAllowedContainer("some-other-container"), false);
});
