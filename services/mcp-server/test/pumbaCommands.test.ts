import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pumbaPauseArgs,
  pumbaStopArgs,
  pumbaKillArgs,
  pumbaNetemDelayArgs,
  pumbaNetemLossArgs,
} from "../src/pumbaCommands.js";

test("pause: pumba manages its own duration and reverts itself", () => {
  assert.deepEqual(pumbaPauseArgs("chaos-pg-replica", 30), [
    "pause",
    "--duration",
    "30s",
    "chaos-pg-replica",
  ]);
});

test("stop: one-shot, no duration flag (the registry owns the revert)", () => {
  assert.deepEqual(pumbaStopArgs("chaos-pg-replica"), ["stop", "chaos-pg-replica"]);
});

test("kill: one-shot with a signal", () => {
  assert.deepEqual(pumbaKillArgs("chaos-pg-replica", "SIGKILL"), [
    "kill",
    "--signal",
    "SIGKILL",
    "chaos-pg-replica",
  ]);
});

test("netem delay: pumba manages its own duration and reverts itself", () => {
  assert.deepEqual(pumbaNetemDelayArgs("chaos-pg-replica", 30, 100, 10), [
    "netem",
    "--duration",
    "30s",
    "delay",
    "--time",
    "100",
    "--jitter",
    "10",
    "chaos-pg-replica",
  ]);
});

test("netem loss: pumba manages its own duration and reverts itself", () => {
  assert.deepEqual(pumbaNetemLossArgs("chaos-pg-replica", 30, 25), [
    "netem",
    "--duration",
    "30s",
    "loss",
    "--percent",
    "25",
    "chaos-pg-replica",
  ]);
});
