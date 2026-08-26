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

test("revertAndRemove retries a failing revert with backoff, then succeeds, and removes the entry", async () => {
  const registry = new FaultRegistry({ log: () => {}, delayFn: async () => {} });
  const { scheduleTimer } = fakeScheduler();
  let attempts = 0;
  registry.register({
    container: "chaos-pg-replica",
    kind: "pause",
    durationSeconds: 30,
    revert: async () => {
      attempts++;
      if (attempts < 2) throw new Error("docker unpause failed");
    },
    scheduleTimer,
  });
  await registry.revertAndRemove("chaos-pg-replica");
  assert.equal(attempts, 2);
  assert.equal(registry.has("chaos-pg-replica"), false);
});

test("revertAndRemove logs and leaves the fault active after exhausting all retry attempts", async () => {
  const logs: string[] = [];
  const registry = new FaultRegistry({ log: (msg) => logs.push(msg), delayFn: async () => {} });
  const { scheduleTimer } = fakeScheduler();
  registry.register({
    container: "chaos-pg-replica",
    kind: "pause",
    durationSeconds: 30,
    revert: async () => {
      throw new Error("docker unpause failed");
    },
    scheduleTimer,
  });
  await registry.revertAndRemove("chaos-pg-replica");
  assert.equal(registry.has("chaos-pg-replica"), true);
  assert.equal(logs.length, 4); // 3 attempt-failure logs + 1 final "could not be reverted" log
});

test("clear returns false when the revert ultimately fails after all retries", async () => {
  const registry = new FaultRegistry({ log: () => {}, delayFn: async () => {} });
  const { scheduleTimer } = fakeScheduler();
  registry.register({
    container: "chaos-pg-replica",
    kind: "pause",
    durationSeconds: 30,
    revert: async () => {
      throw new Error("docker unpause failed");
    },
    scheduleTimer,
  });
  const didClear = await registry.clear("chaos-pg-replica");
  assert.equal(didClear, false);
  assert.equal(registry.has("chaos-pg-replica"), true);
});

test("a second revertAndRemove call for the same container while one is already in progress is a no-op", async () => {
  const registry = new FaultRegistry({ log: () => {}, delayFn: async () => {} });
  const { scheduleTimer } = fakeScheduler();
  let revertCallCount = 0;
  let resolveFirstRevert: (() => void) | undefined;
  registry.register({
    container: "chaos-pg-replica",
    kind: "pause",
    durationSeconds: 30,
    revert: async () => {
      revertCallCount++;
      await new Promise<void>((resolve) => {
        resolveFirstRevert = resolve;
      });
    },
    scheduleTimer,
  });
  const firstCall = registry.revertAndRemove("chaos-pg-replica");
  // second call while the first is still in-flight (revert hasn't resolved yet)
  await registry.revertAndRemove("chaos-pg-replica");
  assert.equal(revertCallCount, 1, "the second call must not start its own revert attempt");
  resolveFirstRevert!();
  await firstCall;
  assert.equal(registry.has("chaos-pg-replica"), false);
});
