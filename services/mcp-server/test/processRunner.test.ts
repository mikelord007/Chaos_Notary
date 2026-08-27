import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { runToCompletion, spawnDetached, isFailure, waitForSpawn } from "../src/processRunner.js";

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

test("isFailure is false only for a clean exit: code 0, no signal, no error", () => {
  assert.equal(isFailure({ code: 0, signal: null }), false);
});

test("isFailure is true for a non-zero exit code", () => {
  assert.equal(isFailure({ code: 1, signal: null }), true);
});

test("isFailure is true for a null code with a signal (killed by an external signal)", () => {
  assert.equal(isFailure({ code: null, signal: "SIGKILL" }), true);
});

test("isFailure is true when a spawn error is present, even with a zero code", () => {
  assert.equal(isFailure({ code: 0, signal: null, error: new Error("boom") }), true);
});

test("waitForSpawn resolves once the fake child emits 'spawn'", async () => {
  const fake = new FakeChild();
  const promise = waitForSpawn(fake as any);
  fake.emit("spawn");
  await assert.doesNotReject(promise);
});

test("waitForSpawn rejects if the fake child emits 'error' before 'spawn'", async () => {
  const fake = new FakeChild();
  const promise = waitForSpawn(fake as any);
  fake.emit("error", new Error("ENOENT"));
  await assert.rejects(promise, /ENOENT/);
});
