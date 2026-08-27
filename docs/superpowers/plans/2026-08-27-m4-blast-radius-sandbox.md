# M4: Blast-Radius Sandbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a new, deliberately isolated MCP server that predicts what a proposed chaos experiment will actually affect — grounded in M1's real, verified topology — and wire it into M3's agent so its "here's what I expect to happen" statement comes from a real computation instead of freeform reasoning.

**Architecture:** A new TypeScript service, `services/blast-radius-sandbox`, structured like M2's `services/mcp-server` (same tsconfig, same `npm ci`/lockfile convention, same Streamable HTTP MCP transport in stateless mode) but with zero Docker access — no `docker.sock`, no `pumba`, no ability to touch the real stack. It exposes one tool, `predict_blast_radius`, backed by a static, hand-authored topology model. Two already-merged M3 files get additive updates to actually use it.

**Tech Stack:** Node 22 / TypeScript, `@modelcontextprotocol/sdk`, `zod`, Node's built-in `node:test` runner (no new test framework — matches M2).

**Spec:** `docs/superpowers/specs/2026-08-27-m4-blast-radius-sandbox-design.md`

## Global Constraints

- Zero Docker access from `services/blast-radius-sandbox`: no `docker.sock` mount, no `pumba`, no Docker CLI in the image. This is the entire point of "sealed."
- The 5-container allowlist is duplicated from M2's `services/mcp-server/src/allowlist.ts`, not imported — deliberate, per spec's Non-goals (no code sharing between the two services). Kept honest by an acceptance-test cross-check, not by shared code.
- Severity thresholds, exact values: `inject_latency` at or above `2000` ms on a DB container (`chaos-pg-primary` or `chaos-pg-replica`) is "hard" severity (matches `checkout-api`'s actual `connectionTimeoutMillis`/`query_timeout` of 2000 in `services/checkout-api/src/server.ts`); below that, "degraded." `inject_packet_loss` at or above `80` percent is "hard"; below that, "degraded." `pause`/`stop`/`kill` are always "hard."
- Container name: `chaos-blast-radius-sandbox`. Port `3200`, published loopback-only (`127.0.0.1:3200:3200`) in `docker-compose.yml`, matching M2's posture.
- No changes to `services/mcp-server` at all.
- Docker availability in the implementation environment should be checked fresh — a prior milestone (M2) found no Docker available in this sandbox (checked Git Bash, PowerShell, WSL2 Ubuntu); that may or may not still hold. Tasks needing Docker say so explicitly and have a documented fallback.

---

## File Structure

```
services/blast-radius-sandbox/
  package.json
  tsconfig.json
  .dockerignore
  Dockerfile
  src/
    allowlist.ts     # the same 5 container names as M2, duplicated on purpose
    topology.ts        # static topology model + predictBlastRadius()
    tools.ts              # the predict_blast_radius MCP tool
    server.ts                # MCP server entrypoint
    cliCall.ts                  # standalone MCP client CLI, used by the acceptance script
  test/
    allowlist.test.ts
    topology.test.ts
    tools.test.ts
scripts/
  verify-m4.sh
docker-compose.yml             # modified: add blast-radius-sandbox service
agent/
  chaos-notary.json             # modified: second mcp_servers[] entry, revised workflow
  README.md                       # modified: setup step for the new connector
README.md                          # modified: Status section marks M4 done
```

Each source file has one job, matching M2's established decomposition: `allowlist.ts` is pure validation, `topology.ts` is the pure data model + prediction logic (no I/O, fully unit-testable), `tools.ts` is the thin MCP wiring layer, `server.ts` is the composition root.

---

## Task 1: Scaffold `services/blast-radius-sandbox`

**Files:**
- Create: `services/blast-radius-sandbox/package.json`
- Create: `services/blast-radius-sandbox/tsconfig.json`
- Create: `services/blast-radius-sandbox/.dockerignore`

**Interfaces:**
- Produces: `npm run build` (tsc → `dist/`), `npm test` (runs `test/**/*.test.ts` via `tsx` + `node:test`), the dependency set every later task relies on.

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "blast-radius-sandbox",
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
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@types/node": "^22.5.0",
    "tsx": "^4.19.0",
    "typescript": "^5.5.4"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`** (identical compiler options to `services/mcp-server/tsconfig.json` and `services/checkout-api/tsconfig.json`, for consistency across the repo's TS services)

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
cd services/blast-radius-sandbox && npm install
```

Expected: `package-lock.json` is created.

- [ ] **Step 5: Commit**

```bash
git add services/blast-radius-sandbox/package.json services/blast-radius-sandbox/package-lock.json services/blast-radius-sandbox/tsconfig.json services/blast-radius-sandbox/.dockerignore
git commit -m "blast-radius-sandbox: scaffold package"
```

---

## Task 2: Target allowlist

**Files:**
- Create: `services/blast-radius-sandbox/src/allowlist.ts`
- Test: `services/blast-radius-sandbox/test/allowlist.test.ts`

**Interfaces:**
- Produces: `ALLOWED_CONTAINERS: readonly string[]`, `type AllowedContainer`, `isAllowedContainer(name: string): name is AllowedContainer`. Every later module that takes a `container` parameter uses this type.

This is a deliberate duplicate of `services/mcp-server/src/allowlist.ts`'s content — per the Global Constraints, do not import from that package. Task 8's acceptance script cross-checks the two independently.

- [ ] **Step 1: Write the failing test**

```typescript
// services/blast-radius-sandbox/test/allowlist.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/blast-radius-sandbox && npm test`
Expected: FAIL — `../src/allowlist.js` cannot be found.

- [ ] **Step 3: Write the implementation**

```typescript
// services/blast-radius-sandbox/src/allowlist.ts
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

Run: `cd services/blast-radius-sandbox && npm test`
Expected: PASS, all 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add services/blast-radius-sandbox/src/allowlist.ts services/blast-radius-sandbox/test/allowlist.test.ts
git commit -m "blast-radius-sandbox: add target allowlist"
```

---

## Task 3: Topology model and prediction logic

**Files:**
- Create: `services/blast-radius-sandbox/src/topology.ts`
- Test: `services/blast-radius-sandbox/test/topology.test.ts`

**Interfaces:**
- Produces: `type FaultKind = "pause" | "stop" | "kill" | "inject_latency" | "inject_packet_loss"`, `interface Impact { target: string; effect: string }`, `interface PredictionInput { container: string; faultKind: FaultKind; latencyMs?: number; percent?: number }`, `interface PredictionResult { container: string; faultKind: FaultKind; severity: "hard" | "degraded"; affected: Impact[]; unaffected: string[]; notes?: string }`, `predictBlastRadius(input: PredictionInput): PredictionResult` (throws a plain `Error` if `input.container` isn't in the topology model), `LATENCY_HARD_THRESHOLD_MS = 2000`, `PACKET_LOSS_HARD_THRESHOLD_PERCENT = 80`.

This is the core deliverable of M4 — the topology content below is transcribed directly from the spec's "Topology model" section, which was itself sourced from M1's actual code (`services/checkout-api/src/server.ts`'s DB pool config, and the read/write routing the M1 design already established). Do not re-derive or "improve" this content — it's a faithful transcription, not a design decision for this task.

- [ ] **Step 1: Write the failing test**

```typescript
// services/blast-radius-sandbox/test/topology.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  predictBlastRadius,
  LATENCY_HARD_THRESHOLD_MS,
  PACKET_LOSS_HARD_THRESHOLD_PERCENT,
} from "../src/topology.js";

test("pausing chaos-pg-replica: hard severity, GET /products affected, POST /orders unaffected", () => {
  const result = predictBlastRadius({ container: "chaos-pg-replica", faultKind: "pause" });
  assert.equal(result.severity, "hard");
  assert.ok(result.affected.some((i) => i.target === "GET /products"));
  assert.ok(result.unaffected.some((u) => u.includes("POST /orders")));
});

test("pausing chaos-pg-primary: hard severity, POST /orders affected, GET /products unaffected", () => {
  const result = predictBlastRadius({ container: "chaos-pg-primary", faultKind: "pause" });
  assert.equal(result.severity, "hard");
  assert.ok(result.affected.some((i) => i.target === "POST /orders"));
  assert.ok(result.unaffected.some((u) => u.includes("GET /products")));
});

test("killing chaos-checkout-api: hard severity, both routes affected", () => {
  const result = predictBlastRadius({ container: "chaos-checkout-api", faultKind: "kill" });
  assert.equal(result.severity, "hard");
  assert.ok(result.affected.some((i) => i.target === "GET /products"));
  assert.ok(result.affected.some((i) => i.target === "POST /orders"));
});

test("stopping chaos-prometheus: hard severity, dashboard affected, API routes unaffected", () => {
  const result = predictBlastRadius({ container: "chaos-prometheus", faultKind: "stop" });
  assert.equal(result.severity, "hard");
  assert.ok(result.affected.some((i) => i.target.includes("Grafana")));
  assert.ok(result.unaffected.some((u) => u.includes("GET /products")));
  assert.ok(result.unaffected.some((u) => u.includes("POST /orders")));
});

test("pausing chaos-grafana: hard severity, dashboard UI affected, everything else unaffected", () => {
  const result = predictBlastRadius({ container: "chaos-grafana", faultKind: "pause" });
  assert.equal(result.severity, "hard");
  assert.ok(result.affected.some((i) => i.target.includes("Grafana dashboard UI")));
  assert.ok(result.unaffected.some((u) => u.includes("GET /products")));
});

test("inject_latency below the hard threshold on chaos-pg-replica is degraded severity", () => {
  const result = predictBlastRadius({
    container: "chaos-pg-replica",
    faultKind: "inject_latency",
    latencyMs: LATENCY_HARD_THRESHOLD_MS - 1,
  });
  assert.equal(result.severity, "degraded");
});

test("inject_latency at or above the hard threshold on chaos-pg-replica is hard severity", () => {
  const result = predictBlastRadius({
    container: "chaos-pg-replica",
    faultKind: "inject_latency",
    latencyMs: LATENCY_HARD_THRESHOLD_MS,
  });
  assert.equal(result.severity, "hard");
});

test("inject_packet_loss below the hard threshold is degraded severity", () => {
  const result = predictBlastRadius({
    container: "chaos-pg-replica",
    faultKind: "inject_packet_loss",
    percent: PACKET_LOSS_HARD_THRESHOLD_PERCENT - 1,
  });
  assert.equal(result.severity, "degraded");
});

test("inject_packet_loss at or above the hard threshold is hard severity", () => {
  const result = predictBlastRadius({
    container: "chaos-pg-replica",
    faultKind: "inject_packet_loss",
    percent: PACKET_LOSS_HARD_THRESHOLD_PERCENT,
  });
  assert.equal(result.severity, "hard");
});

test("a container outside the topology model throws", () => {
  assert.throws(() => predictBlastRadius({ container: "chaos-mcp-server", faultKind: "pause" }));
});

test("inject_latency/inject_packet_loss with no latencyMs/percent given defaults to degraded (0 is below both thresholds)", () => {
  const latency = predictBlastRadius({ container: "chaos-pg-replica", faultKind: "inject_latency" });
  assert.equal(latency.severity, "degraded");
  const loss = predictBlastRadius({ container: "chaos-pg-replica", faultKind: "inject_packet_loss" });
  assert.equal(loss.severity, "degraded");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/blast-radius-sandbox && npm test`
Expected: FAIL — `../src/topology.js` cannot be found.

- [ ] **Step 3: Write the implementation**

```typescript
// services/blast-radius-sandbox/src/topology.ts
export type FaultKind = "pause" | "stop" | "kill" | "inject_latency" | "inject_packet_loss";

export interface Impact {
  target: string;
  effect: string;
}

export interface TopologyEntry {
  container: string;
  role: string;
  hardFaultImpacts: Impact[];
  degradedFaultImpacts: Impact[];
  unaffected: string[];
  notes?: string;
}

export const LATENCY_HARD_THRESHOLD_MS = 2000;
export const PACKET_LOSS_HARD_THRESHOLD_PERCENT = 80;

export const TOPOLOGY: Record<string, TopologyEntry> = {
  "chaos-pg-replica": {
    container: "chaos-pg-replica",
    role:
      "Streaming replica; checkout-api's read path (GET /products) talks to this and only this — no fallback to primary.",
    hardFaultImpacts: [
      {
        target: "GET /products",
        effect:
          "Fails with 503 (replica unavailable). No fallback to primary exists — this is the resilience gap M1 was built to demonstrate.",
      },
    ],
    degradedFaultImpacts: [
      {
        target: "GET /products",
        effect:
          "Response time increases; requests exceeding checkout-api's 2000ms query timeout will still fail with 503.",
      },
    ],
    unaffected: [
      "POST /orders (writes go to pg-primary, not the replica)",
      "GET /health (no DB dependency)",
      "GET /metrics (no DB dependency)",
    ],
  },
  "chaos-pg-primary": {
    container: "chaos-pg-primary",
    role: "Streaming replication source; checkout-api's write path (POST /orders) talks to this.",
    hardFaultImpacts: [
      { target: "POST /orders", effect: "Fails with 503 (primary unavailable)." },
    ],
    degradedFaultImpacts: [
      {
        target: "POST /orders",
        effect:
          "Response time increases; requests exceeding checkout-api's 2000ms query timeout will still fail with 503.",
      },
    ],
    unaffected: [
      "GET /products (the replica keeps serving reads from data it already has; it does not need the primary to be up to answer a read)",
    ],
    notes:
      "Ongoing replication from primary to replica stalls while the primary is down, but that has no user-facing effect within a bounded 5-300s experiment window.",
  },
  "chaos-checkout-api": {
    container: "chaos-checkout-api",
    role: "The Fastify API itself — both the read and write paths, plus /health and /metrics.",
    hardFaultImpacts: [
      { target: "GET /products", effect: "Fails — the whole API is down." },
      { target: "POST /orders", effect: "Fails — the whole API is down." },
      {
        target: "chaos-prometheus's scrape of /metrics",
        effect:
          "Fails during the fault window (visible as a gap in Prometheus's own data, not a false reading).",
      },
    ],
    degradedFaultImpacts: [
      { target: "GET /products", effect: "Slower responses; the API process itself is still up and serving." },
      { target: "POST /orders", effect: "Slower responses; the API process itself is still up and serving." },
    ],
    unaffected: [],
  },
  "chaos-prometheus": {
    container: "chaos-prometheus",
    role: "Scrapes checkout-api's /metrics every 5s; feeds the Grafana dashboard.",
    hardFaultImpacts: [
      {
        target: "Grafana dashboard (chaos-notary)",
        effect:
          "Stops showing new data for the duration — you are temporarily blinding your own observability, not affecting checkout-api itself.",
      },
    ],
    degradedFaultImpacts: [
      { target: "Grafana dashboard (chaos-notary)", effect: "Dashboard data becomes intermittent/delayed." },
    ],
    unaffected: [
      "GET /products (checkout-api's actual serving is unaffected by its passive scraper going down)",
      "POST /orders (checkout-api's actual serving is unaffected by its passive scraper going down)",
    ],
  },
  "chaos-grafana": {
    container: "chaos-grafana",
    role: "Dashboard UI reading from Prometheus.",
    hardFaultImpacts: [{ target: "Grafana dashboard UI", effect: "Unavailable for the duration." }],
    degradedFaultImpacts: [{ target: "Grafana dashboard UI", effect: "Slow to load." }],
    unaffected: [
      "GET /products (no dependency)",
      "POST /orders (no dependency)",
      "Prometheus's own data collection (independent of Grafana)",
      "Prometheus's own query API at :9090 (still directly queryable)",
    ],
  },
};

export interface PredictionInput {
  container: string;
  faultKind: FaultKind;
  latencyMs?: number;
  percent?: number;
}

export interface PredictionResult {
  container: string;
  faultKind: FaultKind;
  severity: "hard" | "degraded";
  affected: Impact[];
  unaffected: string[];
  notes?: string;
}

export function predictBlastRadius(input: PredictionInput): PredictionResult {
  const entry = TOPOLOGY[input.container];
  if (!entry) {
    throw new Error(`${input.container} is not in the topology model`);
  }

  const severity = computeSeverity(input);

  return {
    container: entry.container,
    faultKind: input.faultKind,
    severity,
    affected: severity === "hard" ? entry.hardFaultImpacts : entry.degradedFaultImpacts,
    unaffected: entry.unaffected,
    notes: entry.notes,
  };
}

function computeSeverity(input: PredictionInput): "hard" | "degraded" {
  switch (input.faultKind) {
    case "pause":
    case "stop":
    case "kill":
      return "hard";
    case "inject_latency":
      return (input.latencyMs ?? 0) >= LATENCY_HARD_THRESHOLD_MS ? "hard" : "degraded";
    case "inject_packet_loss":
      return (input.percent ?? 0) >= PACKET_LOSS_HARD_THRESHOLD_PERCENT ? "hard" : "degraded";
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/blast-radius-sandbox && npm test`
Expected: PASS, all 11 new tests green, plus the 5 from Task 2 (16 total).

- [ ] **Step 5: Commit**

```bash
git add services/blast-radius-sandbox/src/topology.ts services/blast-radius-sandbox/test/topology.test.ts
git commit -m "blast-radius-sandbox: add topology model and prediction logic"
```

---

## Task 4: MCP tool handler

**Files:**
- Create: `services/blast-radius-sandbox/src/tools.ts`
- Test: `services/blast-radius-sandbox/test/tools.test.ts`

**Interfaces:**
- Consumes: `ALLOWED_CONTAINERS` (Task 2); `predictBlastRadius`, `type FaultKind` (Task 3).
- Produces: `registerTools(server: McpServer): void`, which registers the `predict_blast_radius` tool. Also exports `handlePredictBlastRadius` directly for unit testing without going through the MCP protocol layer. Task 5 (server entrypoint) calls `registerTools`.

- [ ] **Step 1: Write the failing test**

```typescript
// services/blast-radius-sandbox/test/tools.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { handlePredictBlastRadius, registerTools } from "../src/tools.js";

test("handlePredictBlastRadius returns a prediction for an allowlisted container", () => {
  const result = handlePredictBlastRadius({ container: "chaos-pg-replica", fault_kind: "pause" });
  assert.equal(result.severity, "hard");
  assert.ok(result.affected.some((i) => i.target === "GET /products"));
});

test("registerTools registers predict_blast_radius on a real McpServer and validates input via zod", async () => {
  const server = new McpServer({ name: "test-server", version: "1.0.0" });
  registerTools(server);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((t) => t.name),
    ["predict_blast_radius"],
  );

  const good = await client.callTool({
    name: "predict_blast_radius",
    arguments: { container: "chaos-pg-replica", fault_kind: "pause" },
  });
  assert.equal(good.isError, undefined);

  const badContainer = await client.callTool({
    name: "predict_blast_radius",
    arguments: { container: "not-a-real-container", fault_kind: "pause" },
  });
  assert.equal(badContainer.isError, true);

  const badFaultKind = await client.callTool({
    name: "predict_blast_radius",
    arguments: { container: "chaos-pg-replica", fault_kind: "not-a-real-fault" },
  });
  assert.equal(badFaultKind.isError, true);

  await client.close();
  await server.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/blast-radius-sandbox && npm test`
Expected: FAIL — `../src/tools.js` cannot be found.

- [ ] **Step 3: Write the implementation**

```typescript
// services/blast-radius-sandbox/src/tools.ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ALLOWED_CONTAINERS } from "./allowlist.js";
import { predictBlastRadius, type FaultKind, type PredictionResult } from "./topology.js";

const FAULT_KINDS = ["pause", "stop", "kill", "inject_latency", "inject_packet_loss"] as const;

export interface PredictArgs {
  container: string;
  fault_kind: FaultKind;
  latency_ms?: number;
  percent?: number;
}

export function handlePredictBlastRadius(args: PredictArgs): PredictionResult {
  return predictBlastRadius({
    container: args.container,
    faultKind: args.fault_kind,
    latencyMs: args.latency_ms,
    percent: args.percent,
  });
}

export function registerTools(server: McpServer): void {
  server.registerTool(
    "predict_blast_radius",
    {
      title: "Predict blast radius",
      description:
        "Predict what a proposed chaos fault will actually affect, based on M1's real topology, before running it.",
      inputSchema: {
        container: z.enum(ALLOWED_CONTAINERS),
        fault_kind: z.enum(FAULT_KINDS),
        latency_ms: z.number().int().positive().optional(),
        percent: z.number().min(0).max(100).optional(),
      },
    },
    async (args) => ({
      content: [{ type: "text", text: JSON.stringify(handlePredictBlastRadius(args)) }],
    }),
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/blast-radius-sandbox && npm test`
Expected: PASS, all 3 new tests green, plus the 16 from Tasks 2-3 (19 total).

- [ ] **Step 5: Typecheck**

Run: `cd services/blast-radius-sandbox && npm run build`
Expected: no errors. This is the first task touching the MCP SDK's actual types — fix any type mismatches between `tools.ts` and the installed `@modelcontextprotocol/sdk` version's `registerTool` signature before continuing, same as M2's Task 8 had to.

- [ ] **Step 6: Commit**

```bash
git add services/blast-radius-sandbox/src/tools.ts services/blast-radius-sandbox/test/tools.test.ts
git commit -m "blast-radius-sandbox: add predict_blast_radius MCP tool"
```

---

## Task 5: Server entrypoint

**Files:**
- Create: `services/blast-radius-sandbox/src/server.ts`

**Interfaces:**
- Consumes: `registerTools` (Task 4).
- Produces: the running process. Nothing else depends on this file.

No unit test for this task — it's composition-root wiring, matching the established convention from M2's `server.ts` (also untested) and `services/checkout-api/src/server.ts` (same). Verified via build + the acceptance test in Task 8.

- [ ] **Step 1: Write the implementation**

```typescript
// services/blast-radius-sandbox/src/server.ts
import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerTools } from "./tools.js";

const PORT = Number(process.env.PORT ?? 3200);

async function main() {
  const mcpServer = new McpServer({ name: "chaos-notary-blast-radius-sandbox", version: "1.0.0" });
  registerTools(mcpServer);

  // Stateless mode: each request is an independent JSON-RPC call. See M3's
  // server.ts for why — a stateful transport with a generated session ID
  // rejects every request after the first client session closes, and every
  // caller here (the acceptance script's cliCall.ts) is a short-lived,
  // one-call-then-disconnect client.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  await mcpServer.connect(transport);

  const httpServer = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (req.url === "/mcp") {
      // .catch(), not `void` alone: an unhandled rejection here would crash
      // the whole process on a single malformed request (this exact bug
      // was found and fixed in M2's server.ts during its Qodo review).
      transport.handleRequest(req, res).catch((err) => {
        console.error("error handling /mcp request", err);
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "internal server error" }));
        } else {
          res.end();
        }
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  httpServer.listen(PORT, () => {
    console.log(`chaos-notary blast-radius sandbox listening on :${PORT}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Run the full unit test suite once more before moving to Docker**

Run: `cd services/blast-radius-sandbox && npm test`
Expected: PASS, all 19 tests from Tasks 2-4 still green.

- [ ] **Step 3: Typecheck**

Run: `cd services/blast-radius-sandbox && npm run build`
Expected: no errors, `dist/server.js` produced.

- [ ] **Step 4: Commit**

```bash
git add services/blast-radius-sandbox/src/server.ts
git commit -m "blast-radius-sandbox: add server entrypoint"
```

---

## Task 6: Dockerfile

**Files:**
- Create: `services/blast-radius-sandbox/Dockerfile`

**Interfaces:**
- Produces: a buildable image containing the compiled server. No external binaries needed — unlike M2's Dockerfile, there's no `pumba` to vendor and no Docker CLI to install, since this service never touches Docker at all.

- [ ] **Step 1: Write the Dockerfile**

```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE 3200
CMD ["node", "dist/server.js"]
```

- [ ] **Step 2: Build the image if Docker is available; otherwise skip and note it**

Check Docker availability first: `docker version`. If unavailable in this environment (a prior milestone found this to be the case in this sandbox — see Global Constraints), skip this step, note in your report that the build is unverified, and move on — this is a documented, accepted gap, not a blocker. If Docker IS available:

```bash
docker build -t blast-radius-sandbox-test services/blast-radius-sandbox
docker run --rm -p 3200:3200 blast-radius-sandbox-test &
sleep 2
curl -sf http://localhost:3200/health
docker stop $(docker ps -q --filter ancestor=blast-radius-sandbox-test)
```

Expected (if run): the curl returns `{"status":"ok"}`.

- [ ] **Step 3: Commit**

```bash
git add services/blast-radius-sandbox/Dockerfile
git commit -m "blast-radius-sandbox: add Dockerfile"
```

---

## Task 7: Wire into docker-compose

**Files:**
- Modify: `docker-compose.yml`

**Interfaces:**
- Consumes: the image built in Task 6.
- Produces: `chaos-blast-radius-sandbox`, reachable at `localhost:3200`.

- [ ] **Step 1: Add the service**

Add this block to `docker-compose.yml`, after the `mcp-server` service block:

```yaml
  blast-radius-sandbox:
    build: ./services/blast-radius-sandbox
    container_name: chaos-blast-radius-sandbox
    environment:
      PORT: "3200"
    ports:
      - "127.0.0.1:3200:3200"
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://localhost:3200/health"]
      interval: 5s
      timeout: 5s
      retries: 10
    restart: unless-stopped
```

No `depends_on` — this service computes from static data and has no dependency on the rest of the stack being up.

- [ ] **Step 2: Bring up the whole stack and verify the new service is healthy, if Docker is available**

If Docker is unavailable in this environment (see Global Constraints), skip this step and note it in your report.

```bash
docker compose up -d --build
docker compose ps blast-radius-sandbox
curl -sf http://localhost:3200/health
```

Expected (if run): `docker compose ps` shows `chaos-blast-radius-sandbox` as `healthy`; the curl returns `{"status":"ok"}`.

- [ ] **Step 3: Commit**

```bash
git add docker-compose.yml
git commit -m "docker-compose: add blast-radius-sandbox service"
```

---

## Task 8: Acceptance test

**Files:**
- Create: `services/blast-radius-sandbox/src/cliCall.ts`
- Create: `scripts/verify-m4.sh`

**Interfaces:**
- Consumes: the running `chaos-blast-radius-sandbox` container's own `dist/`, called via `docker compose exec`.
- Produces: a repeatable acceptance script covering the 6 criteria from the spec's Testing section.

`cliCall.ts` is a standalone MCP client, deliberately duplicated from `services/mcp-server/src/cliCall.ts` rather than shared (same reasoning as the allowlist duplication — these are separate deployable services), pointed at this service's own port.

- [ ] **Step 1: Write `cliCall.ts`**

```typescript
// services/blast-radius-sandbox/src/cliCall.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

async function main() {
  const [, , toolName, argsJson] = process.argv;
  if (!toolName) {
    console.error("usage: cliCall.js <toolName> [argsJson]");
    process.exit(1);
  }
  const args = argsJson ? JSON.parse(argsJson) : {};

  const client = new Client({ name: "verify-m4-cli", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL("http://localhost:3200/mcp"));
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: toolName, arguments: args });
    console.log(JSON.stringify(result));
    if (result.isError) {
      process.exitCode = 1;
    }
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Build and confirm it compiles**

```bash
cd services/blast-radius-sandbox && npm run build
```

Expected: zero errors, `dist/cliCall.js` produced.

- [ ] **Step 3: Write `scripts/verify-m4.sh`**

```bash
#!/usr/bin/env bash
# M4 acceptance test. Run from the repo root inside WSL:
#   bash scripts/verify-m4.sh
#
# Unlike verify-m1.sh/verify-m2.sh, this service has no live infrastructure
# to react to — it's a static computation. The acceptance test is about
# correctness of the topology model and the allowlist staying in sync with
# M2's, not about watching real containers fail and recover.
set -euo pipefail

echo "== allowlist cross-check: blast-radius-sandbox vs mcp-server =="
extract_allowlist() {
  grep -A6 'ALLOWED_CONTAINERS = \[' "$1" | grep '"chaos-' | tr -d ' ",' | sort
}
sandbox_list=$(extract_allowlist services/blast-radius-sandbox/src/allowlist.ts)
mcp_list=$(extract_allowlist services/mcp-server/src/allowlist.ts)
if [ "$sandbox_list" = "$mcp_list" ]; then
  echo "OK: allowlists match"
else
  echo "FAIL: allowlists differ"
  echo "blast-radius-sandbox:"
  echo "$sandbox_list"
  echo "mcp-server:"
  echo "$mcp_list"
  exit 1
fi

echo "== bringing up stack =="
docker compose up -d --build

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

wait_for "blast-radius-sandbox healthy" "curl -sf http://localhost:3200/health"

call() {
  docker compose exec -T blast-radius-sandbox node dist/cliCall.js "$1" "${2:-{}}"
}

echo "== predict_blast_radius(chaos-pg-replica, pause): expect GET /products affected, POST /orders unaffected =="
result=$(call predict_blast_radius '{"container":"chaos-pg-replica","fault_kind":"pause"}')
echo "$result"
python3 -c "
import json
result = json.loads('''$result''')
prediction = json.loads(result['content'][0]['text'])
assert prediction['severity'] == 'hard', f\"expected hard, got {prediction['severity']}\"
assert any(i['target'] == 'GET /products' for i in prediction['affected']), 'GET /products not in affected'
assert any('POST /orders' in u for u in prediction['unaffected']), 'POST /orders not in unaffected'
print('OK: chaos-pg-replica pause prediction correct')
"

echo "== predict_blast_radius(chaos-pg-primary, pause): expect POST /orders affected, GET /products unaffected =="
result=$(call predict_blast_radius '{"container":"chaos-pg-primary","fault_kind":"pause"}')
echo "$result"
python3 -c "
import json
result = json.loads('''$result''')
prediction = json.loads(result['content'][0]['text'])
assert prediction['severity'] == 'hard', f\"expected hard, got {prediction['severity']}\"
assert any(i['target'] == 'POST /orders' for i in prediction['affected']), 'POST /orders not in affected'
assert any('GET /products' in u for u in prediction['unaffected']), 'GET /products not in unaffected'
print('OK: chaos-pg-primary pause prediction correct')
"

echo "== predict_blast_radius severity threshold: latency below vs at/above 2000ms =="
below=$(call predict_blast_radius '{"container":"chaos-pg-replica","fault_kind":"inject_latency","latency_ms":100}')
above=$(call predict_blast_radius '{"container":"chaos-pg-replica","fault_kind":"inject_latency","latency_ms":3000}')
python3 -c "
import json
below_pred = json.loads(json.loads('''$below''')['content'][0]['text'])
above_pred = json.loads(json.loads('''$above''')['content'][0]['text'])
assert below_pred['severity'] == 'degraded', f\"expected degraded for 100ms, got {below_pred['severity']}\"
assert above_pred['severity'] == 'hard', f\"expected hard for 3000ms, got {above_pred['severity']}\"
print('OK: latency threshold behaves correctly')
"

echo "== predict_blast_radius rejects a non-allowlisted container =="
set +e
rejected=$(call predict_blast_radius '{"container":"chaos-mcp-server","fault_kind":"pause"}' 2>&1)
rc=$?
set -e
[ "$rc" -ne 0 ] || { echo "FAIL: expected predict_blast_radius on chaos-mcp-server to be rejected"; exit 1; }
echo "OK: non-allowlisted container rejected ($rejected)"

echo "== M4 ACCEPTANCE TEST PASSED =="
```

- [ ] **Step 4: Mark it executable, and run it if Docker is available**

```bash
chmod +x scripts/verify-m4.sh
```

If Docker is unavailable in this environment, run only the allowlist cross-check portion standalone instead of the full script (it needs no Docker):

```bash
extract_allowlist() {
  grep -A6 'ALLOWED_CONTAINERS = \[' "$1" | grep '"chaos-' | tr -d ' ",' | sort
}
diff <(extract_allowlist services/blast-radius-sandbox/src/allowlist.ts) <(extract_allowlist services/mcp-server/src/allowlist.ts) && echo "OK: allowlists match"
```

Note in your report which parts were actually run. If Docker IS available, run the full script:

```bash
bash scripts/verify-m4.sh
```

Expected: `== M4 ACCEPTANCE TEST PASSED ==` at the end.

- [ ] **Step 5: Commit**

```bash
git add services/blast-radius-sandbox/src/cliCall.ts scripts/verify-m4.sh
git commit -m "add M4 acceptance test"
```

---

## Task 9: Wire into M3's agent

**Files:**
- Modify: `agent/chaos-notary.json`
- Modify: `agent/README.md`

**Interfaces:**
- Consumes: nothing programmatically — this is a manifest/docs update referencing the new service by its MCP tool name (`predict_blast_radius`) and connector name.

This task touches already-merged M3 files. Read both files in full before editing — do not guess at their current exact content from this plan; the plan was written before this task runs and the files may have small differences (e.g. from prior review fix rounds). Preserve everything not called out below.

- [ ] **Step 1: Add a second `mcp_servers[]` entry to `agent/chaos-notary.json`**

Add this object to the `mcp_servers` array, alongside the existing `mcp-server` entry (do not remove or modify the existing entry):

```json
{
  "type": "truefoundry-mcp-registry",
  "name": "blast-radius-sandbox",
  "enable_tools": ["@all"]
}
```

No `require_approval_for_tools` on this entry — `predict_blast_radius` is read-only computation, nothing on it is destructive.

- [ ] **Step 2: Revise the system prompt's "How to run an experiment" section**

Find the numbered list inside the `instructions` string (currently: 1. call `list_targets`, 2. state intent, 3. propose the tool call, 4. point at the dashboard, 5. confirm recovery — the exact current numbering may differ slightly from this description if M3 went through further edits; read the actual current text first). Insert a new step between "call `list_targets`" and "state your intent," instructing the agent to call `predict_blast_radius` with the proposed container and fault type, and to build its intent statement from the tool's actual `affected`/`unaffected`/`severity` output rather than from its own general reasoning. Renumber the remaining steps accordingly. Keep every other constraint in the prompt intact (the "never" section, the dashboard pointer, the "don't claim to have checked the metrics" rule, etc.) — this task only touches the experiment-workflow ordering, not the rest of the prompt.

Verify your edit compiles as valid JSON and still contains no overclaim, using the same guard from M3's Task 1:

```bash
node -e "const m = require('./agent/chaos-notary.json'); console.log('valid JSON')"
node -e "const m = require('./agent/chaos-notary.json'); const i = m.instructions; const bad = ['I checked the metrics', 'blast radius sandbox', 'automated Prometheus']; const hit = bad.find(b => i.includes(b)); console.log(hit ? 'FAIL: contains ' + JSON.stringify(hit) : 'PASS')"
```

Expected: `valid JSON` then `PASS`.

- [ ] **Step 3: Add a setup step to `agent/README.md` for the second connector**

Read the current file first (it already documents registering the `mcp-server` connector, with an "Unverified" caveat about the manifest schema that M3's own follow-up review resolved — `mcp_servers[]` entries need `type: "truefoundry-mcp-registry"`, confirmed against TrueForge's real docs). Add a parallel step for registering `blast-radius-sandbox` as a second Connector, pointing at `http://localhost:3200/mcp` (or the sandbox's compose-network address, following the same reachability guidance already established for the first connector — this service has no authentication either, though nothing it does is destructive, so the stakes are lower; still keep the guidance consistent rather than introducing a different pattern for no reason).

Also add one step to the "Manually verifying the approval gate" walkthrough (or a new short walkthrough section, your judgment on which fits better) confirming the agent's stated intent actually reflects `predict_blast_radius`'s real output — e.g., ask it to predict pausing `chaos-pg-replica`, and confirm it correctly reports that `GET /products` is affected and `POST /orders` is not, rather than reasoning about it from scratch.

- [ ] **Step 4: Commit**

```bash
git add agent/chaos-notary.json agent/README.md
git commit -m "agent: wire in the blast-radius-sandbox connector"
```

---

## Final Step: Update the root README

**Files:**
- Modify: `README.md`

- [ ] Update the `## Status` section: mark M4 done, in the same style as the M1/M2/M3 bullets (a short inline description, not a full new heading). Remove M4 from the combined "M4, M5, M6 not yet built" line, leaving M5-M6. Add `chaos-blast-radius-sandbox` to the `### Services` table with its port and role (read-only computation, no Docker access). Commit as `README: document M4 blast-radius sandbox`.
