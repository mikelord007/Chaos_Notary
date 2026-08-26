// services/mcp-server/test/faultRegistry.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { FaultRegistry, ConflictError } from "../src/faultRegistry.js";

function fakeScheduler() {
  const scheduled: Array<{ fn: () => void; ms: number }> = [];
  const scheduleTimer = (fn: () => void, ms: number) => {
    scheduled.push({ fn, ms });
    return {} as NodeJS.Timeout;
  };
  return { scheduled, scheduleTimer };
}

test("register then get returns the active fault", () => {
  const registry = new FaultRegistry();
  const { scheduleTimer } = fakeScheduler();
  let reverted = false;
  registry.register({
    container: "chaos-pg-replica",
    kind: "pause",
    durationSeconds: 30,
    revert: async () => {
      reverted = true;
    },
    now: 1000,
    scheduleTimer,
  });
  assert.equal(registry.has("chaos-pg-replica"), true);
  assert.equal(registry.get("chaos-pg-replica")?.kind, "pause");
  assert.equal(registry.get("chaos-pg-replica")?.expiresAt, 1000 + 30_000);
  assert.equal(reverted, false);
});

test("registering a second fault on an already-faulted container throws ConflictError", () => {
  const registry = new FaultRegistry();
  const { scheduleTimer } = fakeScheduler();
  registry.register({
    container: "chaos-pg-replica",
    kind: "pause",
    durationSeconds: 30,
    revert: async () => {},
    scheduleTimer,
  });
  assert.throws(
    () =>
      registry.register({
        container: "chaos-pg-replica",
        kind: "stop",
        durationSeconds: 30,
        revert: async () => {},
        scheduleTimer,
      }),
    ConflictError,
  );
});

test("the scheduled timer calls revert and removes the entry when it fires", async () => {
  const registry = new FaultRegistry();
  const { scheduled, scheduleTimer } = fakeScheduler();
  let reverted = false;
  registry.register({
    container: "chaos-pg-replica",
    kind: "pause",
    durationSeconds: 30,
    revert: async () => {
      reverted = true;
    },
    scheduleTimer,
  });
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].ms, 30_000);
  scheduled[0].fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reverted, true);
  assert.equal(registry.has("chaos-pg-replica"), false);
});

test("clear reverts an active fault early and returns true", async () => {
  const registry = new FaultRegistry();
  const { scheduleTimer } = fakeScheduler();
  let reverted = false;
  registry.register({
    container: "chaos-pg-replica",
    kind: "pause",
    durationSeconds: 30,
    revert: async () => {
      reverted = true;
    },
    scheduleTimer,
  });
  const didClear = await registry.clear("chaos-pg-replica");
  assert.equal(didClear, true);
  assert.equal(reverted, true);
  assert.equal(registry.has("chaos-pg-replica"), false);
});

test("clear on a container with no active fault returns false and does nothing", async () => {
  const registry = new FaultRegistry();
  const didClear = await registry.clear("chaos-pg-replica");
  assert.equal(didClear, false);
});

test("list returns every active fault", () => {
  const registry = new FaultRegistry();
  const { scheduleTimer } = fakeScheduler();
  registry.register({
    container: "chaos-pg-replica",
    kind: "pause",
    durationSeconds: 30,
    revert: async () => {},
    scheduleTimer,
  });
  registry.register({
    container: "chaos-checkout-api",
    kind: "stop",
    durationSeconds: 60,
    revert: async () => {},
    scheduleTimer,
  });
  assert.equal(registry.list().length, 2);
});
