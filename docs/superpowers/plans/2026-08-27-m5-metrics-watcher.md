# M5: Metrics-Watcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a new, sealed MCP server that reports what Prometheus actually recorded after a chaos fault reverts, and compares it against what M4's `predict_blast_radius` predicted — wiring the result into M3's agent so its experiment report ends with a real observed outcome instead of stopping at a prediction.

**Architecture:** A new TypeScript service, `services/metrics-watcher`, structured like M2's `services/mcp-server` and M4's `services/blast-radius-sandbox` (same tsconfig, same `npm ci`/lockfile convention, same Streamable HTTP MCP transport in stateless mode). It has zero Docker access — its only external dependency is a read-only HTTP call to Prometheus's query API. It exposes one tool, `observe_impact`, backed by a pure PromQL query client and a pure severity-classification module. It is network-isolated so it can reach Prometheus and nothing else. Two already-merged M3 files get additive updates to actually use it.

**Tech Stack:** Node 22 / TypeScript, `@modelcontextprotocol/sdk`, `zod`, Node's built-in `node:test` runner (no new test framework — matches M2/M4).

**Spec:** `docs/superpowers/specs/2026-08-27-m5-metrics-watcher-design.md`

## Global Constraints

- Zero Docker access from `services/metrics-watcher`: no `docker.sock` mount, no Docker CLI in the image. Its only external call is `GET <PROMETHEUS_URL>/api/v1/query`.
- Network isolation: `metrics-watcher` joins only a new `observability-net` Compose network. `prometheus` becomes dual-homed (`default` + `observability-net`) so it stays reachable from `checkout-api`/`grafana` as before. `metrics-watcher` must NOT be able to reach `mcp-server` — verified in the acceptance test, not just asserted.
- Prometheus's only scrape target is `checkout-api:3000` (`observability/prometheus/prometheus.yml`). Metrics are labeled by `route` (plain paths: `/products`, `/orders`, `/health`, `/metrics`) — not by container, and not by HTTP method. `metrics-watcher` never takes a `container` argument.
- `affected_routes` in the tool input is restricted to a fixed 4-path enum (`/products`, `/orders`, `/health`, `/metrics`), matching M2/M4's "reject anything outside a fixed allowlist before touching anything" convention — this also avoids ever interpolating unvalidated route strings into a PromQL query string.
- Observed-severity thresholds, exact values, sourced from `scripts/verify-m1.sh`'s own already-proven acceptance thresholds (not new numbers, not M4's DB-specific 2000ms/80%): error rate `>= 40` percent is "hard"; `<= 1` percent is "none"; anything in between is "degraded". A route with zero requests in the query window reports `null` for `errorRatePercent`/`avgLatencyMs` (never `0` or `NaN`) and classifies as "none".
- Container name: `chaos-metrics-watcher`. Port `3300`, published loopback-only (`127.0.0.1:3300:3300`) in `docker-compose.yml`, matching M2/M4's posture.
- No changes to `services/mcp-server` or `services/blast-radius-sandbox` source code.
- Docker availability in the implementation environment should be checked fresh — prior milestones found no Docker available in this sandbox (checked Git Bash, PowerShell, WSL2 Ubuntu). Tasks needing Docker say so explicitly and have a documented fallback (build/typecheck/unit-test only, live verification deferred to the user).

---

## File Structure

```
services/metrics-watcher/
  package.json
  tsconfig.json
  .dockerignore
  Dockerfile
  src/
    prometheus.ts     # Prometheus query client (pure I/O wrapper, injectable fetch)
    severity.ts          # pure classification + verdict functions, no I/O
    tools.ts                # the observe_impact MCP tool
    server.ts                  # MCP server entrypoint
    cliCall.ts                    # standalone MCP client CLI, used by the acceptance script
  test/
    prometheus.test.ts
    severity.test.ts
    tools.test.ts
scripts/
  verify-m5.sh
docker-compose.yml             # modified: add metrics-watcher service, observability-net, dual-home prometheus
agent/
  chaos-notary.json             # modified: third mcp_servers[] entry, mandatory observe step
  README.md                       # modified: setup step for the new connector
README.md                          # modified: Status section marks M5 done
```

`severity.ts` is a refinement beyond the spec's 2-file sketch (`prometheus.ts` + `tools.ts`) — splitting the pure classification math out from the PromQL I/O wrapper gives each file one job and lets `severity.ts` be unit-tested with zero mocking, matching M4's `topology.ts` precedent of keeping pure logic separate from MCP wiring. `cliCall.ts` isn't named in the spec's file list either, but M2 and M4 both needed one for their acceptance scripts to call the service from bash — same here.

---

## Task 1: Scaffold `services/metrics-watcher`

**Files:**
- Create: `services/metrics-watcher/package.json`
- Create: `services/metrics-watcher/tsconfig.json`
- Create: `services/metrics-watcher/.dockerignore`

**Interfaces:**
- Produces: an `npm run build` / `npm test` / `npm start` scaffold every later task in this service builds on.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "metrics-watcher",
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

- [ ] **Step 2: Create `tsconfig.json`**

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

- [ ] **Step 3: Create `.dockerignore`**

```
node_modules
dist
*.log
```

- [ ] **Step 4: Install dependencies and verify the scaffold**

Run: `cd services/metrics-watcher && npm install`
Expected: succeeds, creates `package-lock.json` and `node_modules`. If Docker/network access to the npm registry is unavailable in this environment, document that in your report and proceed — later tasks' `npm test`/`npm run build` will simply need to be re-run once installed.

- [ ] **Step 5: Commit**

```bash
git add services/metrics-watcher/package.json services/metrics-watcher/tsconfig.json services/metrics-watcher/.dockerignore services/metrics-watcher/package-lock.json
git commit -m "metrics-watcher: scaffold package"
```

---

## Task 2: Prometheus query client

**Files:**
- Create: `services/metrics-watcher/src/prometheus.ts`
- Test: `services/metrics-watcher/test/prometheus.test.ts`

**Interfaces:**
- Produces: `interface RouteMetrics { errorRatePercent: number | null; avgLatencyMs: number | null; requestCount: number }`, `async function queryRouteMetrics(baseUrl: string, route: string, windowSeconds: number, fetchImpl?: typeof fetch): Promise<RouteMetrics>`. Task 4 (tools.ts) calls `queryRouteMetrics`.

This is the only file in this service that talks to the network. It takes an injectable `fetchImpl` parameter (defaulting to the global `fetch`) so tests can supply a stub instead of hitting a real Prometheus — the same dependency-injection style `services/mcp-server/src/dockerClient.ts` already uses (functions take their I/O dependency as a parameter, not a module-level singleton).

- [ ] **Step 1: Write the failing tests**

```typescript
// services/metrics-watcher/test/prometheus.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { queryRouteMetrics } from "../src/prometheus.js";

function fakePrometheus(responses: Record<string, string>) {
  return async (url: string | URL) => {
    const u = new URL(url);
    const query = u.searchParams.get("query") ?? "";
    for (const [substring, value] of Object.entries(responses)) {
      if (query.includes(substring)) {
        return new Response(
          JSON.stringify({
            status: "success",
            data: { resultType: "vector", result: [{ metric: {}, value: [1700000000, value] }] },
          }),
          { status: 200 },
        );
      }
    }
    // No matching substring: empty result vector (Prometheus's real shape for "no data").
    return new Response(
      JSON.stringify({ status: "success", data: { resultType: "vector", result: [] } }),
      { status: 200 },
    );
  };
}

test("queryRouteMetrics returns real numbers when Prometheus has data", async () => {
  const fetchImpl = fakePrometheus({
    "increase(http_requests_total": "12",
    "status=~\"5..\"": "25",
    "http_request_duration_seconds_sum": "0.5",
  });
  const result = await queryRouteMetrics("http://prometheus:9090", "/products", 60, fetchImpl as unknown as typeof fetch);
  assert.equal(result.requestCount, 12);
  assert.equal(result.errorRatePercent, 25);
  assert.equal(result.avgLatencyMs, 500);
});

test("queryRouteMetrics returns nulls (not 0 or NaN) when there is no traffic in the window", async () => {
  const fetchImpl = fakePrometheus({});
  const result = await queryRouteMetrics("http://prometheus:9090", "/health", 60, fetchImpl as unknown as typeof fetch);
  assert.equal(result.requestCount, 0);
  assert.equal(result.errorRatePercent, null);
  assert.equal(result.avgLatencyMs, null);
});

test("queryRouteMetrics throws when Prometheus returns a non-2xx response", async () => {
  const fetchImpl = async () => new Response("internal error", { status: 500, statusText: "Internal Server Error" });
  await assert.rejects(
    () => queryRouteMetrics("http://prometheus:9090", "/products", 60, fetchImpl as unknown as typeof fetch),
    /Prometheus query failed/,
  );
});

test("queryRouteMetrics throws when Prometheus responds with a non-success status body", async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ status: "error", error: "bad query" }), { status: 200 });
  await assert.rejects(
    () => queryRouteMetrics("http://prometheus:9090", "/products", 60, fetchImpl as unknown as typeof fetch),
    /Prometheus query returned status/,
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd services/metrics-watcher && npm test`
Expected: FAIL — `../src/prometheus.js` cannot be found.

- [ ] **Step 3: Write the implementation**

```typescript
// services/metrics-watcher/src/prometheus.ts
export interface RouteMetrics {
  errorRatePercent: number | null;
  avgLatencyMs: number | null;
  requestCount: number;
}

interface PrometheusQueryResult {
  status: string;
  data?: {
    resultType: string;
    result: Array<{ metric: Record<string, string>; value: [number, string] }>;
  };
}

async function query(baseUrl: string, promql: string, fetchImpl: typeof fetch): Promise<number | null> {
  const url = new URL("/api/v1/query", baseUrl);
  url.searchParams.set("query", promql);
  const res = await fetchImpl(url.toString());
  if (!res.ok) {
    throw new Error(`Prometheus query failed: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as PrometheusQueryResult;
  if (body.status !== "success") {
    throw new Error(`Prometheus query returned status ${body.status}`);
  }
  const result = body.data?.result ?? [];
  if (result.length === 0) return null;
  return Number(result[0].value[1]);
}

export async function queryRouteMetrics(
  baseUrl: string,
  route: string,
  windowSeconds: number,
  fetchImpl: typeof fetch = fetch,
): Promise<RouteMetrics> {
  const requestCountRaw = await query(
    baseUrl,
    `sum(increase(http_requests_total{route="${route}"}[${windowSeconds}s]))`,
    fetchImpl,
  );
  const requestCount = requestCountRaw ?? 0;
  if (requestCount <= 0) {
    return { errorRatePercent: null, avgLatencyMs: null, requestCount: 0 };
  }

  const errorRatePercent = await query(
    baseUrl,
    `100 * (sum(rate(http_requests_total{route="${route}",status=~"5.."}[${windowSeconds}s])) or vector(0)) / sum(rate(http_requests_total{route="${route}"}[${windowSeconds}s]))`,
    fetchImpl,
  );

  const avgLatencySeconds = await query(
    baseUrl,
    `rate(http_request_duration_seconds_sum{route="${route}"}[${windowSeconds}s]) / rate(http_request_duration_seconds_count{route="${route}"}[${windowSeconds}s])`,
    fetchImpl,
  );

  return {
    errorRatePercent: errorRatePercent ?? 0,
    avgLatencyMs: avgLatencySeconds !== null ? avgLatencySeconds * 1000 : null,
    requestCount,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd services/metrics-watcher && npm test`
Expected: PASS, all 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add services/metrics-watcher/src/prometheus.ts services/metrics-watcher/test/prometheus.test.ts
git commit -m "metrics-watcher: add Prometheus query client"
```

---

## Task 3: Severity classification and verdict

**Files:**
- Create: `services/metrics-watcher/src/severity.ts`
- Test: `services/metrics-watcher/test/severity.test.ts`

**Interfaces:**
- Consumes: `RouteMetrics` (Task 2, type only — this file does no I/O).
- Produces: `type ObservedSeverity = "hard" | "degraded" | "none"`, `type PredictedSeverity = "hard" | "degraded"`, `type Verdict = "matched" | "milder_than_predicted" | "worse_than_predicted"`, `function classifyRoute(m: RouteMetrics): ObservedSeverity`, `function worstOf(severities: ObservedSeverity[]): ObservedSeverity`, `function computeVerdict(predicted: PredictedSeverity, observed: ObservedSeverity): Verdict`, and the exported constants `OBSERVED_HARD_ERROR_RATE_PERCENT`, `OBSERVED_NONE_ERROR_RATE_PERCENT`. Task 4 (tools.ts) calls all three functions.

- [ ] **Step 1: Write the failing tests**

```typescript
// services/metrics-watcher/test/severity.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyRoute, worstOf, computeVerdict } from "../src/severity.js";

test("classifyRoute: no traffic in window classifies as none", () => {
  assert.equal(classifyRoute({ errorRatePercent: null, avgLatencyMs: null, requestCount: 0 }), "none");
});

test("classifyRoute: error rate at or above 40% classifies as hard", () => {
  assert.equal(classifyRoute({ errorRatePercent: 40, avgLatencyMs: 10, requestCount: 5 }), "hard");
  assert.equal(classifyRoute({ errorRatePercent: 87, avgLatencyMs: 10, requestCount: 5 }), "hard");
});

test("classifyRoute: error rate at or below 1% classifies as none", () => {
  assert.equal(classifyRoute({ errorRatePercent: 0, avgLatencyMs: 10, requestCount: 5 }), "none");
  assert.equal(classifyRoute({ errorRatePercent: 1, avgLatencyMs: 10, requestCount: 5 }), "none");
});

test("classifyRoute: error rate strictly between 1% and 40% classifies as degraded", () => {
  assert.equal(classifyRoute({ errorRatePercent: 1.5, avgLatencyMs: 10, requestCount: 5 }), "degraded");
  assert.equal(classifyRoute({ errorRatePercent: 39.9, avgLatencyMs: 10, requestCount: 5 }), "degraded");
});

test("worstOf: returns the highest-severity value present", () => {
  assert.equal(worstOf(["none", "degraded", "none"]), "degraded");
  assert.equal(worstOf(["none", "degraded", "hard"]), "hard");
  assert.equal(worstOf(["none"]), "none");
});

test("worstOf: empty array returns none", () => {
  assert.equal(worstOf([]), "none");
});

test("computeVerdict: observed matches predicted", () => {
  assert.equal(computeVerdict("hard", "hard"), "matched");
  assert.equal(computeVerdict("degraded", "degraded"), "matched");
});

test("computeVerdict: observed is milder than predicted", () => {
  assert.equal(computeVerdict("hard", "degraded"), "milder_than_predicted");
  assert.equal(computeVerdict("hard", "none"), "milder_than_predicted");
  assert.equal(computeVerdict("degraded", "none"), "milder_than_predicted");
});

test("computeVerdict: observed is worse than predicted", () => {
  assert.equal(computeVerdict("degraded", "hard"), "worse_than_predicted");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd services/metrics-watcher && npm test`
Expected: FAIL — `../src/severity.js` cannot be found.

- [ ] **Step 3: Write the implementation**

```typescript
// services/metrics-watcher/src/severity.ts
import type { RouteMetrics } from "./prometheus.js";

export const OBSERVED_HARD_ERROR_RATE_PERCENT = 40;
export const OBSERVED_NONE_ERROR_RATE_PERCENT = 1;

export type ObservedSeverity = "hard" | "degraded" | "none";
export type PredictedSeverity = "hard" | "degraded";
export type Verdict = "matched" | "milder_than_predicted" | "worse_than_predicted";

export function classifyRoute(metrics: RouteMetrics): ObservedSeverity {
  if (metrics.errorRatePercent === null) return "none";
  if (metrics.errorRatePercent >= OBSERVED_HARD_ERROR_RATE_PERCENT) return "hard";
  if (metrics.errorRatePercent <= OBSERVED_NONE_ERROR_RATE_PERCENT) return "none";
  return "degraded";
}

const SEVERITY_RANK: Record<ObservedSeverity, number> = { none: 0, degraded: 1, hard: 2 };

export function worstOf(severities: ObservedSeverity[]): ObservedSeverity {
  return severities.reduce<ObservedSeverity>(
    (worst, s) => (SEVERITY_RANK[s] > SEVERITY_RANK[worst] ? s : worst),
    "none",
  );
}

export function computeVerdict(predicted: PredictedSeverity, observed: ObservedSeverity): Verdict {
  if (SEVERITY_RANK[observed] === SEVERITY_RANK[predicted]) return "matched";
  return SEVERITY_RANK[observed] > SEVERITY_RANK[predicted] ? "worse_than_predicted" : "milder_than_predicted";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd services/metrics-watcher && npm test`
Expected: PASS, all 9 new tests green, plus the 4 from Task 2 (13 total).

- [ ] **Step 5: Commit**

```bash
git add services/metrics-watcher/src/severity.ts services/metrics-watcher/test/severity.test.ts
git commit -m "metrics-watcher: add severity classification and verdict logic"
```

---

## Task 4: `observe_impact` MCP tool

**Files:**
- Create: `services/metrics-watcher/src/tools.ts`
- Test: `services/metrics-watcher/test/tools.test.ts`

**Interfaces:**
- Consumes: `queryRouteMetrics`, `type RouteMetrics` (Task 2); `classifyRoute`, `worstOf`, `computeVerdict` (Task 3).
- Produces: `KNOWN_ROUTES` (the 4-path tuple), `type KnownRoute`, `function registerTools(server: McpServer): void` (registers the `observe_impact` tool). Also exports `handleObserveImpact` directly for unit testing without going through the MCP protocol layer. Task 5 (server entrypoint) calls `registerTools`.

- [ ] **Step 1: Write the failing tests**

```typescript
// services/metrics-watcher/test/tools.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { handleObserveImpact, registerTools } from "../src/tools.js";

test("handleObserveImpact reports hard severity and a matched verdict when the affected route is failing hard", async () => {
  const result = await handleObserveImpact(
    { predicted_severity: "hard", affected_routes: ["/products"], window_seconds: 60 },
    async () => ({
      "/products": { errorRatePercent: 87, avgLatencyMs: 5, requestCount: 20 },
      "/orders": { errorRatePercent: null, avgLatencyMs: null, requestCount: 0 },
      "/health": { errorRatePercent: null, avgLatencyMs: null, requestCount: 0 },
      "/metrics": { errorRatePercent: null, avgLatencyMs: null, requestCount: 0 },
    })["/products"],
  );
  assert.equal(result.observedSeverity, "hard");
  assert.equal(result.verdict, "matched");
  assert.equal(result.routes["/products"].errorRatePercent, 87);
});

test("registerTools registers observe_impact on a real McpServer and validates input via zod", async () => {
  const server = new McpServer({ name: "test-server", version: "1.0.0" });
  registerTools(server, async () => ({ errorRatePercent: null, avgLatencyMs: null, requestCount: 0 }));

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((t) => t.name),
    ["observe_impact"],
  );

  const good = await client.callTool({
    name: "observe_impact",
    arguments: { predicted_severity: "degraded", affected_routes: ["/products"], window_seconds: 60 },
  });
  assert.equal(good.isError, undefined);

  const badSeverity = await client.callTool({
    name: "observe_impact",
    arguments: { predicted_severity: "catastrophic", affected_routes: ["/products"], window_seconds: 60 },
  });
  assert.equal(badSeverity.isError, true);

  const badRoute = await client.callTool({
    name: "observe_impact",
    arguments: { predicted_severity: "hard", affected_routes: ["/not-a-real-route"], window_seconds: 60 },
  });
  assert.equal(badRoute.isError, true);

  const emptyRoutes = await client.callTool({
    name: "observe_impact",
    arguments: { predicted_severity: "hard", affected_routes: [], window_seconds: 60 },
  });
  assert.equal(emptyRoutes.isError, true);

  const badWindow = await client.callTool({
    name: "observe_impact",
    arguments: { predicted_severity: "hard", affected_routes: ["/products"], window_seconds: 0 },
  });
  assert.equal(badWindow.isError, true);

  await client.close();
  await server.close();
});
```

Note: the test above calls `handleObserveImpact` and `registerTools` with an explicit fake route-metrics fetcher as their last argument, matching the DI style already used in `prometheus.ts` — the real implementation's default wires this to `queryRouteMetrics` against `PROMETHEUS_URL`, exactly as shown in Step 3 below.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd services/metrics-watcher && npm test`
Expected: FAIL — `../src/tools.js` cannot be found.

- [ ] **Step 3: Write the implementation**

```typescript
// services/metrics-watcher/src/tools.ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { queryRouteMetrics, type RouteMetrics } from "./prometheus.js";
import { classifyRoute, worstOf, computeVerdict, type ObservedSeverity, type Verdict } from "./severity.js";

export const KNOWN_ROUTES = ["/products", "/orders", "/health", "/metrics"] as const;
export type KnownRoute = (typeof KNOWN_ROUTES)[number];

const PROMETHEUS_URL = process.env.PROMETHEUS_URL ?? "http://prometheus:9090";

export interface ObserveImpactArgs {
  predicted_severity: "hard" | "degraded";
  affected_routes: KnownRoute[];
  window_seconds: number;
}

export interface ObserveImpactResult {
  windowSeconds: number;
  predictedSeverity: "hard" | "degraded";
  observedSeverity: ObservedSeverity;
  verdict: Verdict;
  routes: Record<KnownRoute, RouteMetrics>;
}

type RouteMetricsFetcher = (route: KnownRoute) => Promise<RouteMetrics>;

// window_seconds varies per call, so the default fetcher is built per-call
// inside handleObserveImpact's default parameter (below), not as a single
// top-level constant.
export async function handleObserveImpact(
  args: ObserveImpactArgs,
  fetchRouteMetrics: RouteMetricsFetcher = (route) => queryRouteMetrics(PROMETHEUS_URL, route, args.window_seconds),
): Promise<ObserveImpactResult> {
  const routes = {} as Record<KnownRoute, RouteMetrics>;
  for (const route of KNOWN_ROUTES) {
    routes[route] = await fetchRouteMetrics(route);
  }

  const affectedSeverities = args.affected_routes.map((route) => classifyRoute(routes[route]));
  const observedSeverity = worstOf(affectedSeverities);
  const verdict = computeVerdict(args.predicted_severity, observedSeverity);

  return {
    windowSeconds: args.window_seconds,
    predictedSeverity: args.predicted_severity,
    observedSeverity,
    verdict,
    routes,
  };
}

export function registerTools(
  server: McpServer,
  fetchRouteMetrics?: RouteMetricsFetcher,
): void {
  server.registerTool(
    "observe_impact",
    {
      title: "Observe real chaos-experiment impact",
      description:
        "Query Prometheus for checkout-api's real, currently-measured error rate and latency per route, and compare against a predicted severity from predict_blast_radius. Call this after a fault reverts, passing the same predicted_severity and affected routes you got from predict_blast_radius (stripped of any leading HTTP verb, e.g. 'GET /products' becomes '/products'), and the fault's duration_seconds as window_seconds.",
      inputSchema: {
        predicted_severity: z.enum(["hard", "degraded"]),
        affected_routes: z.array(z.enum(KNOWN_ROUTES)).min(1),
        window_seconds: z.number().int().positive(),
      },
    },
    async (args) => ({
      content: [{ type: "text", text: JSON.stringify(await handleObserveImpact(args, fetchRouteMetrics)) }],
    }),
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd services/metrics-watcher && npm test`
Expected: PASS, all new tests green, plus the 13 from Tasks 2-3.

- [ ] **Step 5: Typecheck**

Run: `cd services/metrics-watcher && npm run build`
Expected: no errors. Fix any type mismatches between `tools.ts` and the installed `@modelcontextprotocol/sdk` version's `registerTool` signature before continuing, same as M2's Task 8 and M4's Task 4 had to.

- [ ] **Step 6: Commit**

```bash
git add services/metrics-watcher/src/tools.ts services/metrics-watcher/test/tools.test.ts
git commit -m "metrics-watcher: add observe_impact MCP tool"
```

---

## Task 5: Server entrypoint

**Files:**
- Create: `services/metrics-watcher/src/server.ts`

**Interfaces:**
- Consumes: `registerTools` (Task 4).
- Produces: `dist/server.js` entrypoint, `PORT` env var (default `3300`), `/health` and `/mcp` HTTP endpoints. Task 6 (Dockerfile) runs this as the container's `CMD`.

- [ ] **Step 1: Write the implementation**

No TDD here — this is composition-root wiring with no independently testable logic of its own, same as M2's and M4's `server.ts`.

```typescript
// services/metrics-watcher/src/server.ts
import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerTools } from "./tools.js";

const PORT = Number(process.env.PORT ?? 3300);

async function main() {
  const mcpServer = new McpServer({ name: "chaos-notary-metrics-watcher", version: "1.0.0" });
  registerTools(mcpServer);

  // Stateless mode: each request is an independent JSON-RPC call. See
  // services/mcp-server/src/server.ts (M2) for why — a stateful transport with a generated
  // session ID rejects every request after the first client session closes,
  // and every caller here (the acceptance script's cliCall.ts) is a
  // short-lived, one-call-then-disconnect client.
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
    console.log(`chaos-notary metrics-watcher listening on :${PORT}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Typecheck**

Run: `cd services/metrics-watcher && npm run build`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add services/metrics-watcher/src/server.ts
git commit -m "metrics-watcher: add server entrypoint"
```

---

## Task 6: Dockerfile

**Files:**
- Create: `services/metrics-watcher/Dockerfile`

**Interfaces:**
- Consumes: `package.json`/`package-lock.json` (Task 1), `src/` (Tasks 1-5).
- Produces: a buildable image at `./services/metrics-watcher`. Task 7 (docker-compose) references this build context.

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
EXPOSE 3300
CMD ["node", "dist/server.js"]
```

- [ ] **Step 2: Verify it builds, if Docker is available**

Run: `docker build -t chaos-metrics-watcher-test ./services/metrics-watcher`
Expected: builds successfully. If Docker is unavailable in this environment (check fresh — Git Bash, PowerShell, and WSL2 Ubuntu were all found to lack it in prior milestones), document that in your report; Task 7's docker-compose wiring and the acceptance test remain the concrete way to verify this later, on a machine with Docker.

- [ ] **Step 3: Commit**

```bash
git add services/metrics-watcher/Dockerfile
git commit -m "metrics-watcher: add Dockerfile"
```

---

## Task 7: Wire into docker-compose

**Files:**
- Modify: `docker-compose.yml`

**Interfaces:**
- Consumes: buildable image at `./services/metrics-watcher` (Task 6).
- Produces: compose service key `metrics-watcher` (container `chaos-metrics-watcher`), port `3300`, network `observability-net`. Task 8 (acceptance test) calls this via `docker compose exec metrics-watcher`.

Read the current `docker-compose.yml` in full before editing — do not guess at its exact current content from this description; it has been through 4 prior milestones' worth of edits and the plan may not reflect its latest exact state.

- [ ] **Step 1: Add the `metrics-watcher` service**

Add this service block, after the existing `blast-radius-sandbox` block:

```yaml
  metrics-watcher:
    build: ./services/metrics-watcher
    container_name: chaos-metrics-watcher
    environment:
      PORT: "3300"
      PROMETHEUS_URL: http://prometheus:9090
    ports:
      - "127.0.0.1:3300:3300"
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://localhost:3300/health"]
      interval: 5s
      timeout: 5s
      retries: 10
    restart: unless-stopped
    depends_on:
      - prometheus
    # Isolated on its own network, separate from every other service's
    # implicit default network — mirrors the sandbox-net fix M4's Qodo
    # review taught us to apply. metrics-watcher's only legitimate call is
    # to Prometheus; this keeps it unreachable from mcp-server's
    # unauthenticated, destructive /mcp endpoint even if a compromised
    # process inside it tried. Host access to its own published port
    # (127.0.0.1:3300) is unaffected by which network it's attached to.
    networks:
      - observability-net
```

- [ ] **Step 2: Dual-home the `prometheus` service onto `observability-net`**

Find the existing `prometheus:` service block. Once a service gets an explicit `networks:` key, Compose stops auto-attaching it to the implicit `default` network — so `default` must be listed explicitly to preserve Prometheus's existing reachability from `checkout-api` (which scrapes it — actually Prometheus scrapes `checkout-api`, not the reverse, but Prometheus still needs `default` to reach `checkout-api:3000` for that scrape) and to `grafana` (which queries Prometheus). Add:

```yaml
    networks:
      - default
      - observability-net
```

to the end of the `prometheus:` block (after its existing `depends_on: - checkout-api` line).

- [ ] **Step 3: Declare the new network**

Find the top-level `networks:` block (currently just `sandbox-net:`). Add `observability-net:` alongside it:

```yaml
networks:
  sandbox-net:
  observability-net:
```

- [ ] **Step 4: Validate the compose file**

If Docker is available: run `docker compose config` and confirm it parses without error, `metrics-watcher` and `prometheus` both show `observability-net` in their resolved network list, and every other service's network list is unchanged from before this edit. If Docker is unavailable, carefully proofread the YAML indentation yourself (2-space, matching the rest of the file) and note in your report that live validation is deferred.

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml
git commit -m "docker-compose: add metrics-watcher service, isolate on observability-net"
```

---

## Task 8: Acceptance test

**Files:**
- Create: `services/metrics-watcher/src/cliCall.ts`
- Create: `scripts/verify-m5.sh`

**Interfaces:**
- Consumes: `observe_impact` tool (Task 4), `chaos-metrics-watcher` service running on `:3300` (Task 7), `mcp-server`'s `pause_container`/`list_targets` tools (already merged, M2).
- Produces: a runnable `bash scripts/verify-m5.sh` acceptance test.

- [ ] **Step 1: Write `cliCall.ts`**

```typescript
// services/metrics-watcher/src/cliCall.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

async function main() {
  const [, , toolName, argsJson] = process.argv;
  if (!toolName) {
    console.error("usage: cliCall.js <toolName> [argsJson]");
    process.exit(1);
  }
  const args = argsJson ? JSON.parse(argsJson) : {};

  const client = new Client({ name: "verify-m5-cli", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL("http://localhost:3300/mcp"));
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

- [ ] **Step 2: Write `scripts/verify-m5.sh`**

```bash
#!/usr/bin/env bash
# M5 acceptance test. Run from the repo root inside WSL:
#   bash scripts/verify-m5.sh
#
# Verifies observe_impact reports accurate real-world severity against
# live Prometheus data: "none" at baseline, "hard" with a "matched"
# verdict during a real fault, correctly rejects invalid input, and
# confirms metrics-watcher cannot reach mcp-server over the network (the
# same isolation guard M4 added after Qodo caught the equivalent gap for
# blast-radius-sandbox).
set -euo pipefail

API_URL="http://localhost:3000"
MCP_URL="http://localhost:3100"
METRICS_WATCHER_URL="http://localhost:3300"

call_mcp() {
  local args="${2:-}"
  [ -n "$args" ] || args='{}'
  docker compose exec -T mcp-server node dist/cliCall.js "$1" "$args"
}

call_metrics_watcher() {
  local args="${2:-}"
  [ -n "$args" ] || args='{}'
  docker compose exec -T metrics-watcher node dist/cliCall.js "$1" "$args"
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
wait_for "metrics-watcher healthy" "curl -sf ${METRICS_WATCHER_URL}/health"

echo "== settling for baseline traffic (60s) =="
sleep 60

echo "== observe_impact at baseline: expect observedSeverity none =="
baseline=$(call_metrics_watcher observe_impact '{"predicted_severity":"degraded","affected_routes":["/products"],"window_seconds":60}')
echo "$baseline"
printf '%s' "$baseline" | python3 -c "
import json, sys
result = json.load(sys.stdin)
observation = json.loads(result['content'][0]['text'])
assert observation['observedSeverity'] == 'none', f\"expected none, got {observation['observedSeverity']}\"
print('OK: baseline observed severity is none')
"

echo "== pause_container(chaos-pg-replica, 90s) via MCP =="
call_mcp pause_container '{"container":"chaos-pg-replica","duration_seconds":90}'
# Sleep a full minute so the 60s query window sits entirely inside the
# fault period (same lesson as verify-m1.sh/verify-m2.sh: a partial window
# dilutes the error rate below the assertion threshold even when the fault
# is working correctly).
sleep 60

echo "== observe_impact during fault: expect observedSeverity hard, verdict matched =="
faulted=$(call_metrics_watcher observe_impact '{"predicted_severity":"hard","affected_routes":["/products"],"window_seconds":60}')
echo "$faulted"
printf '%s' "$faulted" | python3 -c "
import json, sys
result = json.load(sys.stdin)
observation = json.loads(result['content'][0]['text'])
assert observation['observedSeverity'] == 'hard', f\"expected hard, got {observation['observedSeverity']}\"
assert observation['verdict'] == 'matched', f\"expected matched, got {observation['verdict']}\"
print('OK: fault-window observed severity is hard, verdict matched')
"

echo "== waiting for auto-revert (duration_seconds=90 must elapse on its own) =="
sleep 90

echo "== observe_impact rejects empty affected_routes =="
set +e
rejected=$(call_metrics_watcher observe_impact '{"predicted_severity":"hard","affected_routes":[],"window_seconds":60}' 2>&1)
rc=$?
set -e
[ "$rc" -ne 0 ] || { echo "FAIL: expected empty affected_routes to be rejected"; exit 1; }
echo "OK: empty affected_routes rejected ($rejected)"

echo "== network isolation: metrics-watcher cannot reach mcp-server =="
set +e
docker compose exec -T metrics-watcher wget -q --timeout=5 --spider http://mcp-server:3100/health
rc=$?
set -e
[ "$rc" -ne 0 ] || { echo "FAIL: metrics-watcher could reach mcp-server — network isolation broken"; exit 1; }
echo "OK: metrics-watcher cannot reach mcp-server"

echo "== M5 ACCEPTANCE TEST PASSED =="
```

- [ ] **Step 3: Make the script executable**

Run: `chmod +x scripts/verify-m5.sh`

- [ ] **Step 4: Run it, if Docker is available**

Run: `bash scripts/verify-m5.sh`
Expected: `M5 ACCEPTANCE TEST PASSED`, with the whole run taking roughly 4-5 minutes (baseline settle + fault window + revert wait, same shape as `verify-m2.sh`). If Docker is unavailable, document that in your report — this is the concrete gap the PR description and README must disclose, same pattern as every prior milestone's Docker-dependent verification.

- [ ] **Step 5: Commit**

```bash
git add services/metrics-watcher/src/cliCall.ts scripts/verify-m5.sh
git commit -m "add M5 acceptance test"
```

---

## Task 9: Wire into M3's agent

**Files:**
- Modify: `agent/chaos-notary.json`
- Modify: `agent/README.md`

**Interfaces:**
- Consumes: nothing programmatically — this is a manifest/docs update referencing the new service by its MCP tool name (`observe_impact`) and connector name.

This task touches already-merged M3/M4 files. Read both files in full before editing — do not guess at their current exact content from this plan; they have already been through several review-fix rounds. Preserve everything not called out below.

- [ ] **Step 1: Add a third `mcp_servers[]` entry to `agent/chaos-notary.json`**

Add this object to the `mcp_servers` array, alongside the existing `mcp-server` and `blast-radius-sandbox` entries (do not remove or modify either existing entry):

```json
{
  "type": "truefoundry-mcp-registry",
  "name": "metrics-watcher",
  "enable_tools": ["@all"]
}
```

No `require_approval_for_tools` on this entry — `observe_impact` is read-only, nothing on it is destructive.

- [ ] **Step 2: Add a bullet describing `observe_impact` under "## What you can do"**

The current instructions describe `predict_blast_radius` on the `blast-radius-sandbox` connector as one bullet. Add a parallel bullet for `observe_impact` on the `metrics-watcher` connector, in the same style, describing: it takes `predicted_severity`, `affected_routes`, and `window_seconds`; it queries Prometheus for checkout-api's real error rate/latency over that window; it returns `observedSeverity` and a `verdict` comparing observed against predicted. Also read-only, side-effect-free, never requires approval.

- [ ] **Step 3: Correct the now-false claim in "How to run an experiment"**

The current workflow's step about telling the human where to watch for the effect says something like: "You do not have a tool to query Prometheus directly yet — reading metrics automatically is planned for a later milestone and isn't built. Don't claim to have observed impact you can't actually see." This is no longer true once this task lands — remove or rewrite that specific sentence; keep the rest of the step (pointing the human at the Grafana dashboard as an additional, human-facing view) intact.

- [ ] **Step 4: Add a new mandatory final workflow step**

After the existing step that calls `list_targets` again post-fault to confirm Docker/fault state is clean, add a new final step: once the fault has fully reverted, call `observe_impact` with the `predicted_severity` and `affected_routes` obtained from the earlier `predict_blast_radius` call (stripping any leading HTTP verb from each target string — e.g. `"GET /products"` becomes `"/products"`) and `window_seconds` equal to the fault's `duration_seconds`. Report the tool's real `observedSeverity` and `verdict` to the human as the close of the experiment report — this replaces stating only an expectation with stating a real, checked outcome. Make this step explicitly mandatory, matching how `predict_blast_radius` was made mandatory (not optional) in Task 9 of the M4 plan — the agent must always call it, not just when convenient.

- [ ] **Step 5: Update "What you must never do"**

The current text says something like: "don't claim to have 'checked the metrics' ... list_targets only tells you Docker/fault state; report exactly that, and point the human at the dashboard for anything beyond it." This is now only half true: the agent genuinely can check real metrics via `observe_impact`. Rewrite this rule so it still forbids overclaiming beyond what a tool's real output supports, but explicitly carves out `observe_impact`'s real `observedSeverity`/`verdict`/per-route numbers as things the agent MAY cite, since those come from a real, current Prometheus query — not invented. The rule should still forbid claiming to have checked anything `list_targets` doesn't actually report (Docker/fault state only), and should still forbid any claim not backed by a real tool's actual output.

- [ ] **Step 6: Verify the edit compiles as valid JSON and still contains no overclaim**

```bash
node -e "const m = require('./agent/chaos-notary.json'); console.log('valid JSON')"
node -e "const m = require('./agent/chaos-notary.json'); const i = m.instructions; const bad = ['I checked the metrics', 'blast radius sandbox', 'automated Prometheus']; const hit = bad.find(b => i.includes(b)); console.log(hit ? 'FAIL: contains ' + JSON.stringify(hit) : 'PASS')"
```

Expected: `valid JSON` then `PASS`. (The `bad` list above is inherited verbatim from M3/M4's own guard — it still correctly flags overclaiming language even though the underlying capability has grown; the guard checks for specific dishonest phrasings, not for "mentions metrics" in general, so a truthful new sentence about `observe_impact`'s real output should not trip it. If it does trip on truthful new text, that's a signal the new wording is too close to the banned phrasing — rephrase rather than working around the guard.)

- [ ] **Step 7: Add a setup step to `agent/README.md` for the third connector**

Read the current file first (it documents registering `mcp-server` and `blast-radius-sandbox` as Connectors). Add a parallel step for registering `metrics-watcher` as a third Connector, pointing at `http://localhost:3300/mcp` (or the service's compose-network address, following the same reachability guidance already established for the first two connectors).

Also add a step to the manual verification walkthrough confirming the agent's final report actually reflects `observe_impact`'s real verdict — e.g., run a real pause experiment through to completion and confirm the agent's closing report states a real `observedSeverity`/`verdict` matching what a direct `observe_impact` call would show for that same window, not a restated prediction.

- [ ] **Step 8: Commit**

```bash
git add agent/chaos-notary.json agent/README.md
git commit -m "agent: wire in the metrics-watcher connector"
```

---

## Final Step: Update the root README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the Status section**

Change the M5 bullet from "M5 (metrics-watcher subagent) ... not yet built" to a done bullet in the same style as the existing M1-M4 bullets, e.g.: "**M5 — Metrics-watcher**: done. Reports what Prometheus actually recorded after a chaos fault reverts and compares it against M4's prediction, wired as a third MCP connector in the agent manifest, closing the predict-then-observe loop." Update the trailing "M6 (hardening) is not yet built" sentence to only mention M6.

- [ ] **Step 2: Add a Services table row**

Add a row for `metrics-watcher` / `chaos-metrics-watcher` / `3300` / a one-line role description, matching the existing table's format (see the `blast-radius-sandbox` row for the pattern).

- [ ] **Step 3: Mention `verify-m5.sh` in the Automated acceptance test section**

Add a short paragraph + fenced `bash scripts/verify-m5.sh` block, matching the existing entries for `verify-m1.sh`/`verify-m2.sh`/`verify-m4.sh`.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "README: document M5 metrics-watcher"
```
