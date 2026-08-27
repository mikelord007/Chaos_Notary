import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { FaultRegistry, ConflictError } from "../src/faultRegistry.js";
import { InvalidDurationError } from "../src/duration.js";
import {
  handleListTargets,
  handlePauseContainer,
  handleStopContainer,
  handleClearFault,
} from "../src/tools.js";

// NOTE: the brief's original FakeChild never emitted "exit", which left
// runToCompletion's promise (used by handleStopContainer/handleKillContainer)
// pending forever — confirmed by a standalone repro that raced it against a
// 3s timeout and never got a result. Real pumba stop/kill invocations are
// one-shot processes that exit on their own (nothing calls child.kill() for
// those paths), so FakeChild now simulates that by emitting "exit" on the
// next tick after construction. Listeners are always attached synchronously
// right after spawnFn() returns (before this fires), so ordering is safe.
class FakeChild extends EventEmitter {
  killed = false;
  constructor() {
    super();
    setImmediate(() => this.emit("exit", 0, null));
  }
  kill() {
    this.killed = true;
  }
}

function fakeDocker(status: { Status: string; Paused: boolean } = { Status: "running", Paused: false }) {
  const calls: string[] = [];
  return {
    calls,
    docker: {
      getContainer() {
        return {
          async inspect() {
            return { State: status };
          },
          async unpause() {
            calls.push("unpause");
          },
          async start() {
            calls.push("start");
          },
        };
      },
    } as any,
  };
}

test("handleListTargets reports every allowlisted container", async () => {
  const { docker } = fakeDocker();
  const registry = new FaultRegistry();
  const result = await handleListTargets({ docker, registry });
  assert.equal(result.length, 5);
  assert.equal(result[0].dockerStatus, "running");
  assert.equal(result[0].fault, null);
});

test("handlePauseContainer rejects a non-allowlisted container", async () => {
  const { docker } = fakeDocker();
  const registry = new FaultRegistry();
  await assert.rejects(
    handlePauseContainer(
      { container: "chaos-mcp-server", duration_seconds: 30 },
      { docker, registry, spawnFn: () => new FakeChild() as any },
    ),
  );
});

test("handlePauseContainer rejects an out-of-range duration", async () => {
  const { docker } = fakeDocker();
  const registry = new FaultRegistry();
  await assert.rejects(
    handlePauseContainer(
      { container: "chaos-pg-replica", duration_seconds: 1000 },
      { docker, registry, spawnFn: () => new FakeChild() as any },
    ),
    InvalidDurationError,
  );
});

test("handlePauseContainer registers a fault and rejects a second call as a conflict without spawning again", async () => {
  const { docker } = fakeDocker();
  const registry = new FaultRegistry();
  let spawnCount = 0;
  const spawnFn = () => {
    spawnCount++;
    return new FakeChild() as any;
  };
  await handlePauseContainer(
    { container: "chaos-pg-replica", duration_seconds: 30 },
    { docker, registry, spawnFn },
  );
  assert.equal(registry.has("chaos-pg-replica"), true);
  assert.equal(spawnCount, 1);
  await assert.rejects(
    handlePauseContainer(
      { container: "chaos-pg-replica", duration_seconds: 30 },
      { docker, registry, spawnFn },
    ),
    ConflictError,
  );
  // The conflict must be caught before touching Pumba at all — no second spawn.
  assert.equal(spawnCount, 1);
});

test("handleStopContainer registers a fault whose revert calls startContainer", async () => {
  const { docker, calls } = fakeDocker();
  const registry = new FaultRegistry();
  await handleStopContainer(
    { container: "chaos-checkout-api", duration_seconds: 30 },
    { docker, registry, spawnFn: () => new FakeChild() as any },
  );
  const fault = registry.get("chaos-checkout-api");
  assert.ok(fault);
  await fault!.revert();
  assert.ok(calls.includes("start"));
});

test("handleClearFault reverts and returns cleared: true when a fault is active", async () => {
  const { docker } = fakeDocker();
  const registry = new FaultRegistry();
  await handlePauseContainer(
    { container: "chaos-pg-replica", duration_seconds: 30 },
    { docker, registry, spawnFn: () => new FakeChild() as any },
  );
  const result = await handleClearFault({ container: "chaos-pg-replica" }, { docker, registry });
  assert.equal(result.cleared, true);
  assert.equal(registry.has("chaos-pg-replica"), false);
});

test("handleClearFault returns cleared: false when nothing is active", async () => {
  const { docker } = fakeDocker();
  const registry = new FaultRegistry();
  const result = await handleClearFault({ container: "chaos-pg-replica" }, { docker, registry });
  assert.equal(result.cleared, false);
});
