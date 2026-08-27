import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FaultRegistry, ConflictError } from "../src/faultRegistry.js";
import { InvalidDurationError } from "../src/duration.js";
import {
  handleListTargets,
  handlePauseContainer,
  handleStopContainer,
  handleClearFault,
  registerTools,
} from "../src/tools.js";

// Several tests below register a fault via a handler, which schedules a real
// setTimeout (30s+) through FaultRegistry.register (handlers don't have a way
// to inject a fake scheduleTimer through ToolDeps). Left uncleared, those
// timers pin the event loop and the whole suite takes ~30s wall-clock to
// exit. Clearing the timer directly (rather than going through
// registry.clear()/revertAndRemove(), which would re-invoke revert() and
// double up on side effects like calls.push("start")) is enough: the tests
// that care about revert behavior already exercise it explicitly.
function clearAllTimers(registry: FaultRegistry): void {
  for (const fault of registry.list()) {
    clearTimeout(fault.timer);
  }
}

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

test("handlePauseContainer registers a fault and rejects a second call as a conflict without spawning again", async (t) => {
  const { docker } = fakeDocker();
  const registry = new FaultRegistry();
  t.after(() => clearAllTimers(registry));
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

test("handleStopContainer registers a fault whose revert calls startContainer", async (t) => {
  const { docker, calls } = fakeDocker();
  const registry = new FaultRegistry();
  t.after(() => clearAllTimers(registry));
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

test("registerTools registers all 7 tools on a real McpServer and validates input via zod", async () => {
  const docker = {
    getContainer: () => ({
      inspect: async () => ({ State: { Status: "running", Paused: false } }),
    }),
  } as any;
  const registry = new FaultRegistry();
  const server = new McpServer({ name: "test-server", version: "1.0.0" });
  registerTools(server, { docker, registry });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((t) => t.name).sort(),
    [
      "clear_fault",
      "inject_latency",
      "inject_packet_loss",
      "kill_container",
      "list_targets",
      "pause_container",
      "stop_container",
    ].sort(),
  );

  const badContainer = await client.callTool({
    name: "pause_container",
    arguments: { container: "not-a-real-container", duration_seconds: 30 },
  });
  assert.equal(badContainer.isError, true);

  const badDuration = await client.callTool({
    name: "pause_container",
    arguments: { container: "chaos-pg-replica", duration_seconds: 9999 },
  });
  assert.equal(badDuration.isError, true);

  await client.close();
  await server.close();
});
