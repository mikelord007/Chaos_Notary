# M2: MCP Server Exposing Chaos Tools — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an MCP server that exposes container/network chaos actions against the M1 target stack as typed tools over Streamable HTTP, with server-owned bounded duration and guaranteed auto-revert.

**Architecture:** A new TypeScript service, `services/mcp-server`, structured as small pure/testable modules (allowlist, duration validation, Pumba argv builders, a process runner, a Docker Engine API client via `dockerode`, and an in-memory fault registry with timers) wired together in a thin `tools.ts` + `server.ts`. Fault injection (pause/stop/kill/netem) shells out to the `pumba` binary; reverts and status reads go through `dockerode` directly against the Docker socket. The service joins `docker-compose.yml` as `chaos-mcp-server`.

**Tech Stack:** Node 22 / TypeScript (matches `services/checkout-api`), `@modelcontextprotocol/sdk` (Streamable HTTP transport), `zod` (tool schemas), `dockerode` (Docker Engine API client), `pumba` (external chaos CLI binary, vendored into the image), `tsx` + Node's built-in `node:test` runner for unit tests (no new test framework dependency).

**Spec:** `docs/superpowers/specs/2026-08-26-m2-mcp-server-design.md`

## Global Constraints

- Duration bound: every mutating tool call's `duration_seconds` must be an integer in `[5, 300]` — enforced in code before any Docker/Pumba call (spec "Tool surface" / "Error handling").
- Target allowlist is exactly: `chaos-pg-primary`, `chaos-pg-replica`, `chaos-checkout-api`, `chaos-prometheus`, `chaos-grafana`. `chaos-mcp-server` and `chaos-loadgen` are never valid targets (spec "Target allowlist").
- Transport is Streamable HTTP only, mounted at `/mcp`, port `3100` (spec "Deployment").
- Container name for the new service is `chaos-mcp-server`, matching the existing `chaos-*` naming convention.
- Only one active fault per container at a time; a second mutating call against an already-faulted container is rejected as a conflict, not queued or silently overwritten (spec "Safety model" step 1).
- On process startup, before accepting tool calls, force-revert any allowlisted container found paused/stopped (spec "Safety model" step 4, "startup sweep").
- `npm ci` + committed lockfile for `services/mcp-server`, matching the fix already applied to `services/checkout-api` (see commit `c21641c`).

---

## File Structure

```
services/mcp-server/
  package.json
  package-lock.json
  tsconfig.json
  .dockerignore
  Dockerfile
  src/
    allowlist.ts        # static target list + type guard
    duration.ts          # duration_seconds bounds validation
    pumbaCommands.ts      # pure argv builders for pumba/tc invocations
    processRunner.ts      # spawn wrappers (toCompletion + detached)
    faultRegistry.ts      # in-memory active-fault state machine + timers
    dockerClient.ts        # dockerode wrapper: inspect/unpause/start + startupSweep
    tools.ts                # MCP tool schemas + handlers, wiring the above
    server.ts               # entrypoint: McpServer + StreamableHTTPServerTransport + http.Server
    cliCall.ts               # standalone MCP client CLI used by the acceptance script
  test/
    allowlist.test.ts
    duration.test.ts
    pumbaCommands.test.ts
    processRunner.test.ts
    faultRegistry.test.ts
    dockerClient.test.ts
    tools.test.ts
scripts/
  verify-m2.sh
docker-compose.yml            # modified: add mcp-server service
```

Each module has one job: `allowlist`/`duration` are pure validation, `pumbaCommands` is pure argv construction (no execution — testable without spawning anything), `processRunner` is the only thing that touches `child_process`, `faultRegistry` is a pure state machine (revert functions and timer scheduling are injected, so it's testable without real timers or Docker), `dockerClient` is the only thing that touches `dockerode`, and `tools.ts` wires it all into MCP tool definitions.

---

## Task 1: Scaffold `services/mcp-server`

**Files:**
- Create: `services/mcp-server/package.json`
- Create: `services/mcp-server/tsconfig.json`
- Create: `services/mcp-server/.dockerignore`

**Interfaces:**
- Produces: `npm run build` (tsc → `dist/`), `npm test` (runs `test/**/*.test.ts` via `tsx` + `node:test`), the dependency set every later task relies on.

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "mcp-server",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start": "node dist/server.js",
    "test": "node --import tsx --test test/**/*.test.ts"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.30.0",
    "dockerode": "^5.0.1",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@types/dockerode": "^4.0.1",
    "@types/node": "^22.5.0",
    "tsx": "^4.19.0",
    "typescript": "^5.5.4"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`** (same compiler options as `services/checkout-api/tsconfig.json`, so behavior stays consistent across the repo's two TS services)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Write `.dockerignore`**

```
node_modules
dist
*.log
```

- [ ] **Step 4: Install dependencies and commit the lockfile**

```bash
cd services/mcp-server && npm install
```

Expected: `package-lock.json` is created.

- [ ] **Step 5: Commit**

```bash
git add services/mcp-server/package.json services/mcp-server/package-lock.json services/mcp-server/tsconfig.json services/mcp-server/.dockerignore
git commit -m "mcp-server: scaffold package"
```

---

## Task 2: Target allowlist

**Files:**
- Create: `services/mcp-server/src/allowlist.ts`
- Test: `services/mcp-server/test/allowlist.test.ts`

**Interfaces:**
- Produces: `ALLOWED_CONTAINERS: readonly string[]`, `type AllowedContainer`, `isAllowedContainer(name: string): name is AllowedContainer`. Every later module that takes a `container` parameter uses this type.

- [ ] **Step 1: Write the failing test**

```typescript
// services/mcp-server/test/allowlist.test.ts
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

test("isAllowedContainer rejects the mcp server itself", () => {
  assert.equal(isAllowedContainer("chaos-mcp-server"), false);
});

test("isAllowedContainer rejects loadgen", () => {
  assert.equal(isAllowedContainer("chaos-loadgen"), false);
});

test("isAllowedContainer rejects unknown names", () => {
  assert.equal(isAllowedContainer("some-other-container"), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/mcp-server && npm test`
Expected: FAIL — `../src/allowlist.js` cannot be found.

- [ ] **Step 3: Write the implementation**

```typescript
// services/mcp-server/src/allowlist.ts
export const ALLOWED_CONTAINERS = [
  "chaos-pg-primary",
  "chaos-pg-replica",
  "chaos-checkout-api",
  "chaos-prometheus",
  "chaos-grafana",
] as const;

export type AllowedContainer = (typeof ALLOWED_CONTAINERS)[number];

export function isAllowedContainer(name: string): name is AllowedContainer {
  return (ALLOWED_CONTAINERS as readonly string[]).includes(name);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/mcp-server && npm test`
Expected: PASS, all 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add services/mcp-server/src/allowlist.ts services/mcp-server/test/allowlist.test.ts
git commit -m "mcp-server: add target allowlist"
```

---

## Task 3: Duration validation

**Files:**
- Create: `services/mcp-server/src/duration.ts`
- Test: `services/mcp-server/test/duration.test.ts`

**Interfaces:**
- Produces: `MIN_DURATION_SECONDS = 5`, `MAX_DURATION_SECONDS = 300`, `InvalidDurationError extends Error`, `validateDuration(seconds: number): void` (throws `InvalidDurationError` on failure, returns normally otherwise).

- [ ] **Step 1: Write the failing test**

```typescript
// services/mcp-server/test/duration.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateDuration,
  InvalidDurationError,
  MIN_DURATION_SECONDS,
  MAX_DURATION_SECONDS,
} from "../src/duration.js";

test("accepts the minimum boundary", () => {
  assert.doesNotThrow(() => validateDuration(MIN_DURATION_SECONDS));
});

test("accepts the maximum boundary", () => {
  assert.doesNotThrow(() => validateDuration(MAX_DURATION_SECONDS));
});

test("rejects below the minimum", () => {
  assert.throws(() => validateDuration(MIN_DURATION_SECONDS - 1), InvalidDurationError);
});

test("rejects above the maximum", () => {
  assert.throws(() => validateDuration(MAX_DURATION_SECONDS + 1), InvalidDurationError);
});

test("rejects non-integers", () => {
  assert.throws(() => validateDuration(30.5), InvalidDurationError);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/mcp-server && npm test`
Expected: FAIL — `../src/duration.js` cannot be found.

- [ ] **Step 3: Write the implementation**

```typescript
// services/mcp-server/src/duration.ts
export const MIN_DURATION_SECONDS = 5;
export const MAX_DURATION_SECONDS = 300;

export class InvalidDurationError extends Error {}

export function validateDuration(seconds: number): void {
  if (!Number.isInteger(seconds)) {
    throw new InvalidDurationError(`duration_seconds must be an integer, got ${seconds}`);
  }
  if (seconds < MIN_DURATION_SECONDS || seconds > MAX_DURATION_SECONDS) {
    throw new InvalidDurationError(
      `duration_seconds must be between ${MIN_DURATION_SECONDS} and ${MAX_DURATION_SECONDS}, got ${seconds}`,
    );
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/mcp-server && npm test`
Expected: PASS, all 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add services/mcp-server/src/duration.ts services/mcp-server/test/duration.test.ts
git commit -m "mcp-server: add duration_seconds validation"
```

---

## Task 4: Pumba/tc argv builders

**Files:**
- Create: `services/mcp-server/src/pumbaCommands.ts`
- Test: `services/mcp-server/test/pumbaCommands.test.ts`

**Interfaces:**
- Produces: `type FaultKind = "pause" | "stop" | "kill" | "netem_delay" | "netem_loss"`, and pure argv builders: `pumbaPauseArgs`, `pumbaStopArgs`, `pumbaKillArgs`, `pumbaNetemDelayArgs`, `pumbaNetemLossArgs`. Each returns `string[]` — the args to pass to `pumba`, never executes anything.

These builders only construct argv arrays; they don't spawn processes, so they're fully unit-testable. Before wiring them into `processRunner`/`tools.ts` in later tasks, verify the flags against the actual pinned Pumba binary once (Step 0 below) — Pumba's exact flag names have drifted across versions in the past, and this plan pins a specific version in the Dockerfile (Task 10), so confirm against that version rather than trusting recollection.

- [ ] **Step 0: Verify Pumba's actual CLI flags against the pinned image**

```bash
docker run --rm gaiaadm/pumba:0.10.5 pumba pause --help
docker run --rm gaiaadm/pumba:0.10.5 pumba stop --help
docker run --rm gaiaadm/pumba:0.10.5 pumba kill --help
docker run --rm gaiaadm/pumba:0.10.5 pumba netem delay --help
docker run --rm gaiaadm/pumba:0.10.5 pumba netem loss --help
```

Compare the flag names (`--duration`, `--signal`, `--time`, `--jitter`, `--percent`) against Step 3 below and adjust the implementation if this specific pinned version differs. Record what you found in the commit message for this task if anything changed.

- [ ] **Step 1: Write the failing test**

```typescript
// services/mcp-server/test/pumbaCommands.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/mcp-server && npm test`
Expected: FAIL — `../src/pumbaCommands.js` cannot be found.

- [ ] **Step 3: Write the implementation**

```typescript
// services/mcp-server/src/pumbaCommands.ts
export type FaultKind = "pause" | "stop" | "kill" | "netem_delay" | "netem_loss";

// pause and netem are pumba's own duration-bounded commands: pumba holds the
// fault open for --duration and reverts it itself when that elapses. The
// registry (Task 6) still tracks a backup timer in case that process dies
// early, but pumba is the primary revert path for these two.
export function pumbaPauseArgs(container: string, durationSeconds: number): string[] {
  return ["pause", "--duration", `${durationSeconds}s`, container];
}

export function pumbaNetemDelayArgs(
  container: string,
  durationSeconds: number,
  latencyMs: number,
  jitterMs: number,
): string[] {
  return [
    "netem",
    "--duration",
    `${durationSeconds}s`,
    "delay",
    "--time",
    String(latencyMs),
    "--jitter",
    String(jitterMs),
    container,
  ];
}

export function pumbaNetemLossArgs(
  container: string,
  durationSeconds: number,
  percent: number,
): string[] {
  return [
    "netem",
    "--duration",
    `${durationSeconds}s`,
    "loss",
    "--percent",
    String(percent),
    container,
  ];
}

// stop and kill are one-shot: pumba has no notion of "stopped for N seconds
// then restart". The registry (Task 6) owns reverting these via dockerClient.
export function pumbaStopArgs(container: string): string[] {
  return ["stop", container];
}

export function pumbaKillArgs(container: string, signal: string): string[] {
  return ["kill", "--signal", signal, container];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/mcp-server && npm test`
Expected: PASS, all 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add services/mcp-server/src/pumbaCommands.ts services/mcp-server/test/pumbaCommands.test.ts
git commit -m "mcp-server: add pumba argv builders"
```

---

## Task 5: Process runner

**Files:**
- Create: `services/mcp-server/src/processRunner.ts`
- Test: `services/mcp-server/test/processRunner.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `type SpawnFn = (command: string, args: string[]) => ChildProcess`, `realSpawn: SpawnFn`, `interface RunResult { code: number | null; signal: NodeJS.Signals | null }`, `runToCompletion(command, args, spawnFn?): Promise<RunResult>`, `spawnDetached(command, args, onExit: (result: RunResult) => void, spawnFn?): ChildProcess`. `spawnFn` defaults to `realSpawn` but is injectable so callers (and tests) can fake process execution.

- [ ] **Step 1: Write the failing test**

```typescript
// services/mcp-server/test/processRunner.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/mcp-server && npm test`
Expected: FAIL — `../src/processRunner.js` cannot be found.

- [ ] **Step 3: Write the implementation**

```typescript
// services/mcp-server/src/processRunner.ts
import { spawn, type ChildProcess } from "node:child_process";

export type SpawnFn = (command: string, args: string[]) => ChildProcess;

export const realSpawn: SpawnFn = (command, args) => spawn(command, args, { stdio: "ignore" });

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export function runToCompletion(
  command: string,
  args: string[],
  spawnFn: SpawnFn = realSpawn,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawnFn(command, args);
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
}

export function spawnDetached(
  command: string,
  args: string[],
  onExit: (result: RunResult) => void,
  spawnFn: SpawnFn = realSpawn,
): ChildProcess {
  const child = spawnFn(command, args);
  child.on("exit", (code, signal) => onExit({ code, signal }));
  return child;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/mcp-server && npm test`
Expected: PASS, all 3 tests green.

- [ ] **Step 5: Commit**

```bash
git add services/mcp-server/src/processRunner.ts services/mcp-server/test/processRunner.test.ts
git commit -m "mcp-server: add process runner"
```

---

## Task 6: Fault registry

**Files:**
- Create: `services/mcp-server/src/faultRegistry.ts`
- Test: `services/mcp-server/test/faultRegistry.test.ts`

**Interfaces:**
- Consumes: `AllowedContainer` (Task 2), `FaultKind` (Task 4).
- Produces: `class ConflictError extends Error`, `class FaultRegistry` with methods `has(container): boolean`, `get(container): ActiveFault | undefined`, `list(): ActiveFault[]`, `register(params): void` (throws `ConflictError` if the container already has an active fault), `revertAndRemove(container): Promise<void>`, `clear(container): Promise<boolean>` (returns `false` if nothing was active). `ActiveFault` has `{ container, kind, startedAt, expiresAt, revert, timer, child? }`.

This is the core safety mechanism from the spec: `register` schedules a timer that calls `revert` and removes the entry when `durationSeconds` elapses, independent of whether anything else ever calls `clear`. Timer scheduling and `now` are injectable so tests don't need real waiting.

- [ ] **Step 1: Write the failing test**

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/mcp-server && npm test`
Expected: FAIL — `../src/faultRegistry.js` cannot be found.

- [ ] **Step 3: Write the implementation**

```typescript
// services/mcp-server/src/faultRegistry.ts
import type { ChildProcess } from "node:child_process";
import type { AllowedContainer } from "./allowlist.js";
import type { FaultKind } from "./pumbaCommands.js";

export interface ActiveFault {
  container: AllowedContainer;
  kind: FaultKind;
  startedAt: number;
  expiresAt: number;
  revert: () => Promise<void>;
  timer: NodeJS.Timeout;
  child?: ChildProcess;
}

export class ConflictError extends Error {}

interface RegisterParams {
  container: AllowedContainer;
  kind: FaultKind;
  durationSeconds: number;
  revert: () => Promise<void>;
  child?: ChildProcess;
  now?: number;
  scheduleTimer?: (fn: () => void, ms: number) => NodeJS.Timeout;
}

export class FaultRegistry {
  private faults = new Map<AllowedContainer, ActiveFault>();

  has(container: AllowedContainer): boolean {
    return this.faults.has(container);
  }

  get(container: AllowedContainer): ActiveFault | undefined {
    return this.faults.get(container);
  }

  list(): ActiveFault[] {
    return [...this.faults.values()];
  }

  register(params: RegisterParams): void {
    const existing = this.faults.get(params.container);
    if (existing) {
      throw new ConflictError(
        `${params.container} already has an active ${existing.kind} fault`,
      );
    }
    const now = params.now ?? Date.now();
    const schedule = params.scheduleTimer ?? ((fn, ms) => setTimeout(fn, ms));
    const expiresAt = now + params.durationSeconds * 1000;
    const timer = schedule(() => {
      void this.revertAndRemove(params.container);
    }, params.durationSeconds * 1000);
    this.faults.set(params.container, {
      container: params.container,
      kind: params.kind,
      startedAt: now,
      expiresAt,
      revert: params.revert,
      timer,
      child: params.child,
    });
  }

  async revertAndRemove(container: AllowedContainer): Promise<void> {
    const fault = this.faults.get(container);
    if (!fault) return;
    clearTimeout(fault.timer);
    this.faults.delete(container);
    await fault.revert();
  }

  async clear(container: AllowedContainer): Promise<boolean> {
    if (!this.faults.has(container)) return false;
    await this.revertAndRemove(container);
    return true;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/mcp-server && npm test`
Expected: PASS, all 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add services/mcp-server/src/faultRegistry.ts services/mcp-server/test/faultRegistry.test.ts
git commit -m "mcp-server: add fault registry with conflict detection and timed revert"
```

---

## Task 7: Docker client (status + reverts + startup sweep)

**Files:**
- Create: `services/mcp-server/src/dockerClient.ts`
- Test: `services/mcp-server/test/dockerClient.test.ts`

**Interfaces:**
- Consumes: `ALLOWED_CONTAINERS`, `AllowedContainer` (Task 2).
- Produces: `interface ContainerStatus { container: AllowedContainer; dockerStatus: string; paused: boolean }`, `inspectContainer(docker: Docker, container: AllowedContainer): Promise<ContainerStatus>`, `unpauseContainer(docker: Docker, container: AllowedContainer): Promise<void>` (swallows "not paused" errors — safe to call on an already-running container), `startContainer(docker: Docker, container: AllowedContainer): Promise<void>` (swallows "already started" errors), `startupSweep(docker: Docker, log: (msg: string) => void): Promise<void>`. `Docker` is `dockerode`'s default export type.

`unpauseContainer`/`startContainer` are deliberately idempotent-safe: they're used both as registry `revert` functions and by the startup sweep, and both call sites need "make sure it's running" semantics rather than "assert it was paused/stopped".

- [ ] **Step 1: Write the failing test**

```typescript
// services/mcp-server/test/dockerClient.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/mcp-server && npm test`
Expected: FAIL — `../src/dockerClient.js` cannot be found.

- [ ] **Step 3: Write the implementation**

```typescript
// services/mcp-server/src/dockerClient.ts
import type Docker from "dockerode";
import { ALLOWED_CONTAINERS, type AllowedContainer } from "./allowlist.js";

export interface ContainerStatus {
  container: AllowedContainer;
  dockerStatus: string;
  paused: boolean;
}

export async function inspectContainer(
  docker: Docker,
  container: AllowedContainer,
): Promise<ContainerStatus> {
  const info = await docker.getContainer(container).inspect();
  return {
    container,
    dockerStatus: info.State.Status,
    paused: info.State.Paused,
  };
}

export async function unpauseContainer(docker: Docker, container: AllowedContainer): Promise<void> {
  try {
    await docker.getContainer(container).unpause();
  } catch (err) {
    // Already unpaused — this call is meant to be safe to make unconditionally.
  }
}

export async function startContainer(docker: Docker, container: AllowedContainer): Promise<void> {
  try {
    await docker.getContainer(container).start();
  } catch (err) {
    // Already running — this call is meant to be safe to make unconditionally.
  }
}

export async function startupSweep(docker: Docker, log: (msg: string) => void): Promise<void> {
  for (const container of ALLOWED_CONTAINERS) {
    let status: ContainerStatus;
    try {
      status = await inspectContainer(docker, container);
    } catch (err) {
      log(`startup sweep: could not inspect ${container}, skipping: ${(err as Error).message}`);
      continue;
    }
    if (status.paused) {
      log(`startup sweep: ${container} was paused, unpausing`);
      await unpauseContainer(docker, container);
    } else if (status.dockerStatus !== "running") {
      log(`startup sweep: ${container} was ${status.dockerStatus}, starting`);
      await startContainer(docker, container);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/mcp-server && npm test`
Expected: PASS, all 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add services/mcp-server/src/dockerClient.ts services/mcp-server/test/dockerClient.test.ts
git commit -m "mcp-server: add dockerode client with idempotent reverts and startup sweep"
```

---

## Task 8: Tool handlers

**Files:**
- Create: `services/mcp-server/src/tools.ts`
- Test: `services/mcp-server/test/tools.test.ts`

**Interfaces:**
- Consumes: `ALLOWED_CONTAINERS`, `AllowedContainer`, `isAllowedContainer` (Task 2); `validateDuration`, `InvalidDurationError` (Task 3); all `pumba*Args` builders (Task 4); `runToCompletion`, `spawnDetached`, `SpawnFn` (Task 5); `FaultRegistry`, `ConflictError` (Task 6); `inspectContainer`, `unpauseContainer`, `startContainer` (Task 7).
- Produces: `interface ToolDeps { docker: Docker; registry: FaultRegistry; spawnFn?: SpawnFn }` and `registerTools(server: McpServer, deps: ToolDeps): void`, which registers all 7 tools (`list_targets`, `pause_container`, `stop_container`, `kill_container`, `inject_latency`, `inject_packet_loss`, `clear_fault`) on an MCP `McpServer` instance. Also exports the individual handler functions (`handleListTargets`, `handlePauseContainer`, etc.) directly so they can be unit-tested without going through the MCP protocol layer.

Every mutating handler follows the same shape: validate `container` is allowlisted, validate `duration_seconds`, check the registry for a conflict, run the pumba command, register the fault with an appropriate `revert`. `pause`/`netem_delay`/`netem_loss` use `spawnDetached` (pumba holds the fault open for its own `--duration` and reverts itself; the registry's timer is the backup); `stop`/`kill` use `runToCompletion` (pumba's action is instantaneous, so the registry's timer is the *only* revert path, calling `startContainer`).

- [ ] **Step 1: Write the failing test**

```typescript
// services/mcp-server/test/tools.test.ts
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

class FakeChild extends EventEmitter {
  killed = false;
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/mcp-server && npm test`
Expected: FAIL — `../src/tools.js` cannot be found.

- [ ] **Step 3: Write the implementation**

```typescript
// services/mcp-server/src/tools.ts
import type Docker from "dockerode";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ALLOWED_CONTAINERS, isAllowedContainer, type AllowedContainer } from "./allowlist.js";
import { validateDuration, MIN_DURATION_SECONDS, MAX_DURATION_SECONDS } from "./duration.js";
import {
  pumbaPauseArgs,
  pumbaStopArgs,
  pumbaKillArgs,
  pumbaNetemDelayArgs,
  pumbaNetemLossArgs,
} from "./pumbaCommands.js";
import { runToCompletion, spawnDetached, realSpawn, type SpawnFn } from "./processRunner.js";
import { FaultRegistry, ConflictError } from "./faultRegistry.js";
import { inspectContainer, unpauseContainer, startContainer } from "./dockerClient.js";

const PUMBA_BIN = "pumba";

export interface ToolDeps {
  docker: Docker;
  registry: FaultRegistry;
  spawnFn?: SpawnFn;
}

function requireAllowed(container: string): AllowedContainer {
  if (!isAllowedContainer(container)) {
    throw new Error(`${container} is not an allowed chaos target`);
  }
  return container;
}

// Checked before every mutating tool touches Pumba/Docker, not just left to
// FaultRegistry.register's own guard — a conflict must never cost a wasted
// (and potentially confusing) fault invocation against an already-faulted
// target. FaultRegistry.register still re-checks internally; that's a second
// line of defense, not the primary one.
function requireNoActiveFault(registry: FaultRegistry, container: AllowedContainer): void {
  const existing = registry.get(container);
  if (existing) {
    throw new ConflictError(`${container} already has an active ${existing.kind} fault`);
  }
}

export async function handleListTargets(deps: ToolDeps) {
  return Promise.all(
    ALLOWED_CONTAINERS.map(async (container) => {
      const status = await inspectContainer(deps.docker, container);
      const fault = deps.registry.get(container);
      return {
        container,
        dockerStatus: status.dockerStatus,
        fault: fault
          ? {
              kind: fault.kind,
              secondsRemaining: Math.max(0, Math.round((fault.expiresAt - Date.now()) / 1000)),
            }
          : null,
      };
    }),
  );
}

export async function handlePauseContainer(
  args: { container: string; duration_seconds: number },
  deps: ToolDeps,
) {
  const container = requireAllowed(args.container);
  validateDuration(args.duration_seconds);
  requireNoActiveFault(deps.registry, container);
  const spawnFn = deps.spawnFn ?? realSpawn;
  const child = spawnDetached(PUMBA_BIN, pumbaPauseArgs(container, args.duration_seconds), () => {}, spawnFn);
  deps.registry.register({
    container,
    kind: "pause",
    durationSeconds: args.duration_seconds,
    child,
    revert: async () => {
      if (!child.killed) child.kill();
      await unpauseContainer(deps.docker, container);
    },
  });
  return { container, expiresAt: new Date(Date.now() + args.duration_seconds * 1000).toISOString() };
}

export async function handleStopContainer(
  args: { container: string; duration_seconds: number },
  deps: ToolDeps,
) {
  const container = requireAllowed(args.container);
  validateDuration(args.duration_seconds);
  requireNoActiveFault(deps.registry, container);
  const spawnFn = deps.spawnFn ?? realSpawn;
  await runToCompletion(PUMBA_BIN, pumbaStopArgs(container), spawnFn);
  deps.registry.register({
    container,
    kind: "stop",
    durationSeconds: args.duration_seconds,
    revert: async () => {
      await startContainer(deps.docker, container);
    },
  });
  return { container, expiresAt: new Date(Date.now() + args.duration_seconds * 1000).toISOString() };
}

export async function handleKillContainer(
  args: { container: string; signal?: string; duration_seconds: number },
  deps: ToolDeps,
) {
  const container = requireAllowed(args.container);
  validateDuration(args.duration_seconds);
  requireNoActiveFault(deps.registry, container);
  const signal = args.signal ?? "SIGKILL";
  const spawnFn = deps.spawnFn ?? realSpawn;
  await runToCompletion(PUMBA_BIN, pumbaKillArgs(container, signal), spawnFn);
  deps.registry.register({
    container,
    kind: "kill",
    durationSeconds: args.duration_seconds,
    revert: async () => {
      await startContainer(deps.docker, container);
    },
  });
  return { container, expiresAt: new Date(Date.now() + args.duration_seconds * 1000).toISOString() };
}

export async function handleInjectLatency(
  args: { container: string; latency_ms: number; jitter_ms?: number; duration_seconds: number },
  deps: ToolDeps,
) {
  const container = requireAllowed(args.container);
  validateDuration(args.duration_seconds);
  requireNoActiveFault(deps.registry, container);
  const spawnFn = deps.spawnFn ?? realSpawn;
  const child = spawnDetached(
    PUMBA_BIN,
    pumbaNetemDelayArgs(container, args.duration_seconds, args.latency_ms, args.jitter_ms ?? 0),
    () => {},
    spawnFn,
  );
  deps.registry.register({
    container,
    kind: "netem_delay",
    durationSeconds: args.duration_seconds,
    child,
    revert: async () => {
      if (!child.killed) child.kill();
    },
  });
  return { container, expiresAt: new Date(Date.now() + args.duration_seconds * 1000).toISOString() };
}

export async function handleInjectPacketLoss(
  args: { container: string; percent: number; duration_seconds: number },
  deps: ToolDeps,
) {
  const container = requireAllowed(args.container);
  validateDuration(args.duration_seconds);
  requireNoActiveFault(deps.registry, container);
  const spawnFn = deps.spawnFn ?? realSpawn;
  const child = spawnDetached(
    PUMBA_BIN,
    pumbaNetemLossArgs(container, args.duration_seconds, args.percent),
    () => {},
    spawnFn,
  );
  deps.registry.register({
    container,
    kind: "netem_loss",
    durationSeconds: args.duration_seconds,
    child,
    revert: async () => {
      if (!child.killed) child.kill();
    },
  });
  return { container, expiresAt: new Date(Date.now() + args.duration_seconds * 1000).toISOString() };
}

export async function handleClearFault(args: { container: string }, deps: ToolDeps) {
  const container = requireAllowed(args.container);
  const cleared = await deps.registry.clear(container);
  return { container, cleared };
}

export function registerTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "list_targets",
    {
      title: "List chaos targets",
      description: "List every allowlisted container's current Docker state and active fault, if any.",
      inputSchema: {},
    },
    async () => ({ content: [{ type: "text", text: JSON.stringify(await handleListTargets(deps)) }] }),
  );

  server.registerTool(
    "pause_container",
    {
      title: "Pause container",
      description: "Freeze a container's processes for a bounded duration; auto-reverts.",
      inputSchema: {
        container: z.enum(ALLOWED_CONTAINERS),
        duration_seconds: z.number().int().min(MIN_DURATION_SECONDS).max(MAX_DURATION_SECONDS),
      },
    },
    async (args) => ({ content: [{ type: "text", text: JSON.stringify(await handlePauseContainer(args, deps)) }] }),
  );

  server.registerTool(
    "stop_container",
    {
      title: "Stop container",
      description: "Stop a container for a bounded duration; auto-restarts.",
      inputSchema: {
        container: z.enum(ALLOWED_CONTAINERS),
        duration_seconds: z.number().int().min(MIN_DURATION_SECONDS).max(MAX_DURATION_SECONDS),
      },
    },
    async (args) => ({ content: [{ type: "text", text: JSON.stringify(await handleStopContainer(args, deps)) }] }),
  );

  server.registerTool(
    "kill_container",
    {
      title: "Kill container",
      description: "Send a signal that kills a container's process for a bounded duration; auto-restarts.",
      inputSchema: {
        container: z.enum(ALLOWED_CONTAINERS),
        signal: z.string().optional(),
        duration_seconds: z.number().int().min(MIN_DURATION_SECONDS).max(MAX_DURATION_SECONDS),
      },
    },
    async (args) => ({ content: [{ type: "text", text: JSON.stringify(await handleKillContainer(args, deps)) }] }),
  );

  server.registerTool(
    "inject_latency",
    {
      title: "Inject network latency",
      description: "Add network latency to a container's traffic for a bounded duration; auto-reverts.",
      inputSchema: {
        container: z.enum(ALLOWED_CONTAINERS),
        latency_ms: z.number().int().positive(),
        jitter_ms: z.number().int().nonnegative().optional(),
        duration_seconds: z.number().int().min(MIN_DURATION_SECONDS).max(MAX_DURATION_SECONDS),
      },
    },
    async (args) => ({ content: [{ type: "text", text: JSON.stringify(await handleInjectLatency(args, deps)) }] }),
  );

  server.registerTool(
    "inject_packet_loss",
    {
      title: "Inject packet loss",
      description: "Drop a percentage of a container's network packets for a bounded duration; auto-reverts.",
      inputSchema: {
        container: z.enum(ALLOWED_CONTAINERS),
        percent: z.number().min(0).max(100),
        duration_seconds: z.number().int().min(MIN_DURATION_SECONDS).max(MAX_DURATION_SECONDS),
      },
    },
    async (args) => ({ content: [{ type: "text", text: JSON.stringify(await handleInjectPacketLoss(args, deps)) }] }),
  );

  server.registerTool(
    "clear_fault",
    {
      title: "Clear fault",
      description: "Manually revert whatever fault (if any) is currently active on a container.",
      inputSchema: { container: z.enum(ALLOWED_CONTAINERS) },
    },
    async (args) => ({ content: [{ type: "text", text: JSON.stringify(await handleClearFault(args, deps)) }] }),
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/mcp-server && npm test`
Expected: PASS, all 7 tests green.

- [ ] **Step 5: Typecheck**

Run: `cd services/mcp-server && npm run build`
Expected: no errors. Fix any type mismatches between `tools.ts` and the SDK's `registerTool` signature before continuing — this is the first task that touches the SDK's actual types, so this is where a version drift would surface.

- [ ] **Step 6: Commit**

```bash
git add services/mcp-server/src/tools.ts services/mcp-server/test/tools.test.ts
git commit -m "mcp-server: add MCP tool handlers"
```

---

## Task 9: Server entrypoint

**Files:**
- Create: `services/mcp-server/src/server.ts`

**Interfaces:**
- Consumes: `registerTools` (Task 8), `startupSweep` (Task 7).
- Produces: the running process. Nothing else depends on this file — it's the composition root.

No unit test for this task: it's wiring (HTTP listener + SDK transport + process startup), which is exactly the kind of glue code this repo already treats as build+smoke-verified rather than unit-tested (`services/checkout-api/src/server.ts` has no tests either). Verified in Step 3 below via a real build and a manual health check.

- [ ] **Step 1: Write the implementation**

```typescript
// services/mcp-server/src/server.ts
import http from "node:http";
import { randomUUID } from "node:crypto";
import Docker from "dockerode";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerTools } from "./tools.js";
import { FaultRegistry } from "./faultRegistry.js";
import { startupSweep } from "./dockerClient.js";

const PORT = Number(process.env.PORT ?? 3100);
const DOCKER_SOCKET_PATH = process.env.DOCKER_SOCKET_PATH ?? "/var/run/docker.sock";

async function main() {
  const docker = new Docker({ socketPath: DOCKER_SOCKET_PATH });
  const registry = new FaultRegistry();

  console.log("startup sweep: checking for lingering faults from a previous run");
  await startupSweep(docker, (msg) => console.log(msg));

  const mcpServer = new McpServer({ name: "chaos-notary-mcp", version: "1.0.0" });
  registerTools(mcpServer, { docker, registry });

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  await mcpServer.connect(transport);

  const httpServer = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (req.url === "/mcp") {
      void transport.handleRequest(req, res);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  httpServer.listen(PORT, () => {
    console.log(`chaos-notary MCP server listening on :${PORT}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Run the full unit test suite once more before moving to Docker**

Run: `cd services/mcp-server && npm test`
Expected: PASS, all tests from Tasks 2–8 still green.

- [ ] **Step 3: Typecheck**

Run: `cd services/mcp-server && npm run build`
Expected: no errors, `dist/server.js` produced.

- [ ] **Step 4: Commit**

```bash
git add services/mcp-server/src/server.ts
git commit -m "mcp-server: add server entrypoint"
```

---

## Task 10: Dockerfile

**Files:**
- Create: `services/mcp-server/Dockerfile`

**Interfaces:**
- Produces: a buildable image containing the compiled server plus the `pumba` binary.

- [ ] **Step 1: Write the Dockerfile**

```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM gaiaadm/pumba:0.10.5 AS pumba

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=pumba /pumba /usr/local/bin/pumba
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE 3100
CMD ["node", "dist/server.js"]
```

- [ ] **Step 2: Verify the pumba binary actually lands where expected**

```bash
docker build -t chaos-mcp-server-test services/mcp-server
docker run --rm --entrypoint pumba chaos-mcp-server-test --version
```

Expected: prints a Pumba version string. If `gaiaadm/pumba:0.10.5` doesn't expose the binary at `/pumba` (image layouts occasionally change across tags), inspect the image directly — `docker run --rm --entrypoint sh gaiaadm/pumba:0.10.5 -c 'which pumba'` — and adjust the `COPY --from=pumba` source path to match.

- [ ] **Step 3: Commit**

```bash
git add services/mcp-server/Dockerfile
git commit -m "mcp-server: add Dockerfile"
```

---

## Task 11: Wire into docker-compose

**Files:**
- Modify: `docker-compose.yml`

**Interfaces:**
- Consumes: the image built in Task 10.
- Produces: `chaos-mcp-server`, reachable at `localhost:3100`, depended on by nothing (it depends on the rest of the stack already being healthy, since it targets them).

- [ ] **Step 1: Add the service**

Add this block to `docker-compose.yml`, after the `loadgen` service and before the `volumes:` key:

```yaml
  mcp-server:
    build: ./services/mcp-server
    container_name: chaos-mcp-server
    environment:
      PORT: "3100"
      DOCKER_SOCKET_PATH: /var/run/docker.sock
    ports:
      - "3100:3100"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    depends_on:
      pg-primary:
        condition: service_healthy
      pg-replica:
        condition: service_healthy
      checkout-api:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://localhost:3100/health"]
      interval: 5s
      timeout: 5s
      retries: 10
```

- [ ] **Step 2: Bring up the whole stack and verify the new service is healthy**

```bash
docker compose up -d --build
docker compose ps mcp-server
curl -sf http://localhost:3100/health
```

Expected: `docker compose ps` shows `chaos-mcp-server` as `healthy`; the curl returns `{"status":"ok"}`.

- [ ] **Step 3: Commit**

```bash
git add docker-compose.yml
git commit -m "docker-compose: add mcp-server service"
```

---

## Task 12: Acceptance test

**Files:**
- Create: `services/mcp-server/src/cliCall.ts`
- Create: `scripts/verify-m2.sh`

**Interfaces:**
- Consumes: the running `chaos-mcp-server` container's own `dist/` (built in Task 10), called via `docker compose exec`.
- Produces: a repeatable, real-numbers acceptance script in the same spirit as `scripts/verify-m1.sh`.

`cliCall.ts` is a tiny standalone MCP client — it connects to the server's own `/mcp` endpoint from inside the same container and calls one tool, printing the JSON result to stdout. This avoids adding a second npm package to the repo just for the acceptance script: `verify-m2.sh` invokes it via `docker compose exec mcp-server node dist/cli-call.js <tool> <json-args>`.

- [ ] **Step 1: Write `cliCall.ts`**

```typescript
// services/mcp-server/src/cliCall.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

async function main() {
  const [, , toolName, argsJson] = process.argv;
  if (!toolName) {
    console.error("usage: cli-call.js <toolName> [argsJson]");
    process.exit(1);
  }
  const args = argsJson ? JSON.parse(argsJson) : {};

  const client = new Client({ name: "verify-m2-cli", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL("http://localhost:3100/mcp"));
  await client.connect(transport);
  try {
    const result = await client.callTool({ name: toolName, arguments: args });
    console.log(JSON.stringify(result));
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Build and smoke-test it manually**

```bash
docker compose up -d --build mcp-server
docker compose exec mcp-server node dist/cliCall.js list_targets
```

Expected: JSON containing all 5 allowlisted containers with `dockerStatus: "running"` and `fault: null`.

- [ ] **Step 3: Write `scripts/verify-m2.sh`**

```bash
#!/usr/bin/env bash
# M2 acceptance test. Run from the repo root inside WSL:
#   bash scripts/verify-m2.sh
#
# Asserts, with real numbers pulled from Prometheus and Docker (not a visual
# check):
#   1. stack (including mcp-server) comes up healthy
#   2. list_targets reports every allowlisted container as running
#   3. pause_container drives error rate up, same as M1's manual pause
#   4. the fault auto-reverts on its own — nothing calls clear_fault
#   5. a non-allowlisted target is rejected without touching Docker
#   6. a second pause on an already-faulted target is rejected as a conflict
set -euo pipefail

PROM_URL="http://localhost:9090"
API_URL="http://localhost:3000"
MCP_URL="http://localhost:3100"

call() {
  docker compose exec -T mcp-server node dist/cliCall.js "$1" "${2:-{}}"
}

prom_query() {
  curl -s --max-time 5 "${PROM_URL}/api/v1/query" --data-urlencode "query=$1" \
    | python3 -c '
import json, sys
data = json.load(sys.stdin)
result = data.get("data", {}).get("result", [])
print(result[0]["value"][1] if result else "0")
'
}

wait_for() {
  local desc="$1" cmd="$2" tries="${3:-30}"
  for _ in $(seq 1 "$tries"); do
    if eval "$cmd" >/dev/null 2>&1; then
      echo "OK: $desc"
      return 0
    fi
    sleep 2
  done
  echo "FAIL: timed out waiting for $desc"
  exit 1
}

echo "== bringing up stack =="
docker compose up -d --build

wait_for "checkout-api healthy" "curl -sf ${API_URL}/health"
wait_for "mcp-server healthy" "curl -sf ${MCP_URL}/health"

echo "== list_targets: expect all 5 running, no active faults =="
targets=$(call list_targets)
echo "$targets"
python3 -c "
import json, sys
result = json.loads('''$targets''')
items = json.loads(result['content'][0]['text'])
assert len(items) == 5, f'expected 5 targets, got {len(items)}'
for item in items:
    assert item['dockerStatus'] == 'running', f\"{item['container']} is {item['dockerStatus']}\"
    assert item['fault'] is None, f\"{item['container']} has an unexpected active fault\"
print('OK: all 5 targets running, no faults')
"

echo "== settling for baseline (60s) =="
sleep 60
baseline=$(prom_query '100 * (sum(rate(http_requests_total{status=~"5.."}[1m])) or vector(0)) / sum(rate(http_requests_total[1m]))')
echo "baseline error rate: ${baseline}%"
python3 -c "assert float('$baseline') < 1.0, 'baseline error rate too high'"

echo "== pause_container(chaos-pg-replica, 30s) via MCP =="
call pause_container '{"container":"chaos-pg-replica","duration_seconds":30}'
sleep 30
faulted=$(prom_query '100 * (sum(rate(http_requests_total{status=~"5.."}[1m])) or vector(0)) / sum(rate(http_requests_total[1m]))')
echo "error rate during fault: ${faulted}%"
python3 -c "assert float('$faulted') > 40.0, 'fault did not raise error rate enough'"

echo "== waiting for auto-revert (no clear_fault call) =="
sleep 30
recovered=$(prom_query '100 * (sum(rate(http_requests_total{status=~"5.."}[1m])) or vector(0)) / sum(rate(http_requests_total[1m]))')
echo "error rate after auto-revert: ${recovered}%"
python3 -c "assert float('$recovered') < 1.0, 'error rate did not recover after auto-revert'"

status=$(call list_targets)
python3 -c "
import json
result = json.loads('''$status''')
items = json.loads(result['content'][0]['text'])
replica = next(i for i in items if i['container'] == 'chaos-pg-replica')
assert replica['dockerStatus'] == 'running', f\"expected running, got {replica['dockerStatus']}\"
assert replica['fault'] is None, 'fault still active after it should have auto-reverted'
print('OK: chaos-pg-replica back to running with no active fault')
"

echo "== rejecting a non-allowlisted target =="
set +e
rejected=$(call pause_container '{"container":"chaos-mcp-server","duration_seconds":30}' 2>&1)
rc=$?
set -e
[ "$rc" -ne 0 ] || { echo "FAIL: expected pause_container on chaos-mcp-server to fail"; exit 1; }
echo "OK: non-allowlisted target rejected ($rejected)"

echo "== rejecting a conflicting second fault =="
call pause_container '{"container":"chaos-checkout-api","duration_seconds":30}'
set +e
conflict=$(call pause_container '{"container":"chaos-checkout-api","duration_seconds":30}' 2>&1)
rc=$?
set -e
call clear_fault '{"container":"chaos-checkout-api"}' >/dev/null
[ "$rc" -ne 0 ] || { echo "FAIL: expected the second pause_container call to be rejected as a conflict"; exit 1; }
echo "OK: conflicting fault rejected ($conflict)"

echo "== M2 ACCEPTANCE TEST PASSED =="
```

- [ ] **Step 4: Mark it executable and run it**

```bash
chmod +x scripts/verify-m2.sh
bash scripts/verify-m2.sh
```

Expected: `== M2 ACCEPTANCE TEST PASSED ==` at the end. If any assertion fails, fix the underlying issue (not the assertion) before continuing — same rule PR #1's Qodo review already established for `verify-m1.sh`.

- [ ] **Step 5: Commit**

```bash
git add services/mcp-server/src/cliCall.ts scripts/verify-m2.sh
git commit -m "add M2 acceptance test"
```

---

## Final Step: Update the README

**Files:**
- Modify: `README.md`

- [ ] Update the `## Status` section: mark M2 done, add a short description of the MCP server (mirroring how M1 is described), and add `chaos-mcp-server` to the `### Services` table with its port and role. Commit as `README: document M2 MCP server`.
