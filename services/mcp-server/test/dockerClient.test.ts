import { test } from "node:test";
import assert from "node:assert/strict";
import {
  inspectContainer,
  unpauseContainer,
  startContainer,
  startupSweep,
} from "../src/dockerClient.js";

function fakeDocker(containers: Record<string, { Status: string; Paused: boolean }>) {
  const calls: string[] = [];
  return {
    calls,
    docker: {
      getContainer(name: string) {
        return {
          async inspect() {
            const state = containers[name];
            if (!state) throw new Error(`no such container: ${name}`);
            return { State: { Status: state.Status, Paused: state.Paused } };
          },
          async unpause() {
            calls.push(`unpause:${name}`);
            if (!containers[name]?.Paused) {
              const err: any = new Error("container is not paused");
              err.statusCode = 500;
              throw err;
            }
            containers[name]!.Paused = false;
          },
          async start() {
            calls.push(`start:${name}`);
            if (containers[name]?.Status === "running") {
              const err: any = new Error("container already started");
              err.statusCode = 304;
              throw err;
            }
            containers[name]!.Status = "running";
          },
        };
      },
    } as any,
  };
}

test("inspectContainer reports running, unpaused state", async () => {
  const { docker } = fakeDocker({ "chaos-pg-replica": { Status: "running", Paused: false } });
  const status = await inspectContainer(docker, "chaos-pg-replica");
  assert.deepEqual(status, {
    container: "chaos-pg-replica",
    dockerStatus: "running",
    paused: false,
  });
});

test("unpauseContainer swallows 'not paused' errors", async () => {
  const { docker } = fakeDocker({ "chaos-pg-replica": { Status: "running", Paused: false } });
  await assert.doesNotReject(unpauseContainer(docker, "chaos-pg-replica"));
});

test("startContainer swallows 'already started' errors", async () => {
  const { docker } = fakeDocker({ "chaos-pg-replica": { Status: "running", Paused: false } });
  await assert.doesNotReject(startContainer(docker, "chaos-pg-replica"));
});

test("startupSweep unpauses paused containers and starts stopped ones", async () => {
  const { docker, calls } = fakeDocker({
    "chaos-pg-primary": { Status: "running", Paused: false },
    "chaos-pg-replica": { Status: "running", Paused: true },
    "chaos-checkout-api": { Status: "exited", Paused: false },
    "chaos-prometheus": { Status: "running", Paused: false },
    "chaos-grafana": { Status: "running", Paused: false },
  });
  const logs: string[] = [];
  await startupSweep(docker, (msg) => logs.push(msg));
  assert.deepEqual(calls, ["unpause:chaos-pg-replica", "start:chaos-checkout-api"]);
  assert.equal(logs.length, 2);
});
