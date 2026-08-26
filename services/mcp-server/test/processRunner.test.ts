import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { runToCompletion, spawnDetached } from "../src/processRunner.js";

class FakeChild extends EventEmitter {
  killed = false;
  kill() {
    this.killed = true;
  }
}

test("runToCompletion resolves with the exit code once the fake child exits", async () => {
  const fake = new FakeChild();
  const spawnFn = () => fake as any;
  const resultPromise = runToCompletion("pumba", ["pause", "x"], spawnFn);
  fake.emit("exit", 0, null);
  const result = await resultPromise;
  assert.deepEqual(result, { code: 0, signal: null });
});

test("runToCompletion rejects if the fake child errors", async () => {
  const fake = new FakeChild();
  const spawnFn = () => fake as any;
  const resultPromise = runToCompletion("pumba", ["pause", "x"], spawnFn);
  fake.emit("error", new Error("spawn failed"));
  await assert.rejects(resultPromise, /spawn failed/);
});

test("spawnDetached invokes onExit when the fake child exits, and returns the child", () => {
  const fake = new FakeChild();
  const spawnFn = () => fake as any;
  let observed: unknown;
  const child = spawnDetached("pumba", ["netem", "x"], (result) => {
    observed = result;
  }, spawnFn);
  assert.equal(child, fake);
  fake.emit("exit", 0, null);
  assert.deepEqual(observed, { code: 0, signal: null });
});
