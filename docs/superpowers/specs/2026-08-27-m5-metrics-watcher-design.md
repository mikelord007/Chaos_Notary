# M5: Metrics-watcher subagent — design

Status: approved, ready for implementation planning
Date: 2026-08-27

## Purpose

M4 built the ability to predict what a chaos experiment will affect before
it runs. Nothing yet confirms whether the prediction was right — the
agent's system prompt today just states its expectation and moves on. The
README's own framing of this project ("observes impact in real time") has
never actually been built. M5 closes that loop: after an approved fault
runs and reverts, a new component reports what Prometheus actually
recorded during that window and says, explicitly, whether it matched what
M4 predicted.

The milestone is named "metrics-watcher subagent" in the project roadmap.
Before designing it, we confirmed what that can actually mean on TrueForge
(the external agent harness this project runs on, researched for real via
its live docs/repo, not from training knowledge): TrueForge's manifest has
no field for declaring a second, custom-defined agent that the primary
agent delegates to. Its only subagent-related feature is
`dynamic_sub_agents`, a boolean toggle that lets the harness automatically
parallelize *a single agent's own* task execution — not something a
project author configures with custom instructions or a tool list.
("Create an Agent" — trueforge.dev/create-agent/overview;
github.com/truefoundry/trueforge.) So "metrics-watcher subagent" is built
the same way M2's and M4's capabilities were: a new MCP tool the existing
single agent calls, not a second declared agent.

## Goals

- A new service, `services/metrics-watcher`, exposing one MCP tool —
  `observe_impact` — that queries Prometheus for real, current numbers
  (error rate and latency, per route) over a given window and reports
  whether they matched, undershot, or overshot what M4 predicted for the
  fault that was just run.
- Zero Docker access, same sealed posture as M4. This service only makes
  read-only HTTP calls to Prometheus's query API (`:9090/api/v1/query`) —
  the same interface `scripts/verify-m1.sh` already uses successfully. It
  cannot affect the live stack.
- Network-isolated from `mcp-server` by design from the start, not after
  a review catches it. M4's Qodo review found that `blast-radius-sandbox`
  — despite having zero Docker access — could still reach `mcp-server`'s
  unauthenticated destructive endpoint over Compose's shared default
  network, undermining its "sealed" claim. `metrics-watcher` has the
  identical shape of risk (a read-only service with no legitimate reason
  to reach `mcp-server`), so it gets the same fix applied up front.
- Wire this into M3: the agent manifest gets a third `mcp_servers[]`
  entry, and the system prompt's experiment workflow gets a new
  **mandatory** final step — call `observe_impact` after the fault
  reverts, and report the real verdict instead of just the prediction.
- Ground every threshold in something already proven, not new arbitrary
  numbers: the "hard vs. degraded vs. none" classification of *observed*
  impact reuses M1's own already-verified acceptance thresholds
  (`scripts/verify-m1.sh` asserts baseline error rate `<1%`, fault-window
  error rate `>40%`) — a different signal from M4's DB-specific
  2000ms/80% configured-fault-magnitude thresholds, so this isn't
  duplicating M4's logic, just grounding in a second real, already-tested
  fact about this system.

## Non-goals

- No fault-triggering or fault-configuration logic. `metrics-watcher`
  only observes; running faults stays M2's job, predicting them stays
  M4's job. This tool takes the fault's parameters as input (what was
  predicted, which routes, how long) — it doesn't infer them.
- No live/streaming observation. Per the approved design, the tool is
  called once, after the fault window closes, not polled continuously
  during the fault. Continuous/live polling was considered and rejected
  as unnecessary complexity for this milestone — the same "sample after
  the window, don't build a streaming system" pattern M1's own
  acceptance test already uses successfully.
- No code sharing with M2 or M4 (matching M4's own established
  precedent). `metrics-watcher` doesn't import M2's allowlist or M4's
  topology model. It doesn't even need to know which *container* was
  faulted — Prometheus's only scrape target is `checkout-api:3000`
  (confirmed in `observability/prometheus/prometheus.yml`), so whatever
  was faulted, impact is only ever observable through checkout-api's own
  metrics. The tool's input is Prometheus-native (route paths, a
  severity label, a window), not a copy of M2's or M4's types.
- No enforcement. Like M4, this tool informs — it never blocks, retries,
  or re-runs anything. A "worse_than_predicted" verdict is information
  for the agent (and the human who approved the fault) to act on, not an
  automated trigger.
- No changes to M2's `services/mcp-server` or M4's
  `services/blast-radius-sandbox` source code (docs/manifest additions to
  already-merged M3 files are in scope, matching M4's own precedent).

## Architecture

### File structure

```
services/metrics-watcher/
  package.json
  tsconfig.json
  Dockerfile
  src/
    prometheus.ts   # thin PromQL query client (verify-m1.sh's proven pattern, in TS)
    tools.ts           # the observe_impact MCP tool
    server.ts             # MCP server entrypoint (Streamable HTTP)
  test/
    prometheus.test.ts
    tools.test.ts
scripts/
  verify-m5.sh          # acceptance test
agent/
  chaos-notary.json      # modified: third mcp_servers[] entry, mandatory workflow step
  README.md                # modified: setup step for the new connector
```

### Deployment

A new `metrics-watcher` service in `docker-compose.yml`:

- **Language/runtime**: TypeScript on Node, `@modelcontextprotocol/sdk`,
  matching `services/mcp-server` and `services/blast-radius-sandbox`'s
  established conventions exactly (`tsconfig.json` shape, `npm ci` +
  committed lockfile, stateless Streamable HTTP transport).
- **No `docker.sock` mount.** Same sealed posture as M4 — this service
  cannot reach the Docker daemon at all.
- **Network isolation**: a new `observability-net` Compose network,
  shared only between `metrics-watcher` and `prometheus`. `prometheus`
  becomes dual-homed — stays on the implicit `default` network (needed
  for its existing scrape of `checkout-api` and to feed `grafana`) and
  additionally joins `observability-net`. `metrics-watcher` joins only
  `observability-net`, so it can reach Prometheus and nothing else — not
  `mcp-server`, not any other service. This mirrors the `sandbox-net`
  fix already applied to `blast-radius-sandbox` in M4.
- **Container name**: `chaos-metrics-watcher`. Port `3300`, published
  loopback-only (`127.0.0.1:3300:3300`), consistent with M2 and M4's
  posture.
- **`depends_on`**: `prometheus` (needs it up to answer queries; unlike
  M4, this service does have a real runtime dependency).

### Prometheus query client

`src/prometheus.ts` wraps `GET /api/v1/query` against `PROMETHEUS_URL`
(default `http://prometheus:9090`, matching the Compose service name),
using the same PromQL shapes `scripts/verify-m1.sh` already proved
correct:

```typescript
export interface RouteMetrics {
  errorRatePercent: number | null;  // null when requestCount is 0 (no data, not 0%)
  avgLatencyMs: number | null;
  requestCount: number;
}

export async function queryRouteMetrics(
  route: string,
  windowSeconds: number,
): Promise<RouteMetrics> {
  // errorRatePercent: 100 * (sum(rate(http_requests_total{route="<route>",status=~"5.."}[<window>s])) or vector(0))
  //                   / sum(rate(http_requests_total{route="<route>"}[<window>s]))
  // avgLatencyMs: 1000 * rate(http_request_duration_seconds_sum{route="<route>"}[<window>s])
  //               / rate(http_request_duration_seconds_count{route="<window>"}[<window>s])
  // requestCount: sum(increase(http_requests_total{route="<route>"}[<window>s]))
  // If requestCount resolves to 0 (empty Prometheus result vector), errorRatePercent
  // and avgLatencyMs are both null — division by zero must never surface as 0% or NaN.
}
```

Prometheus HTTP errors or an unreachable Prometheus propagate as a thrown
error, not a silently-empty result — `handleObserveImpact` lets this
surface as an MCP tool error (`isError: true`), matching M2/M4's existing
error-handling pattern (M2's Qodo review specifically caught a swallowed-
error bug in an earlier milestone; this service is built to avoid that
class of bug from the start).

### Severity classification and verdict

```typescript
export const OBSERVED_HARD_ERROR_RATE_PERCENT = 40;   // scripts/verify-m1.sh's own proven fault-window threshold
export const OBSERVED_NONE_ERROR_RATE_PERCENT = 1;    // scripts/verify-m1.sh's own proven baseline threshold

export type ObservedSeverity = "hard" | "degraded" | "none";
export type Verdict = "matched" | "milder_than_predicted" | "worse_than_predicted";

function classifyRoute(m: RouteMetrics): ObservedSeverity {
  if (m.errorRatePercent === null) return "none";  // no traffic in window
  if (m.errorRatePercent >= OBSERVED_HARD_ERROR_RATE_PERCENT) return "hard";
  if (m.errorRatePercent <= OBSERVED_NONE_ERROR_RATE_PERCENT) return "none";
  return "degraded";
}

// Observed severity across a fault = the WORST severity among the routes
// the agent said were predicted-affected. Severity ordering: hard > degraded > none.
function worstOf(severities: ObservedSeverity[]): ObservedSeverity { /* ... */ }

function computeVerdict(predicted: "hard" | "degraded", observed: ObservedSeverity): Verdict {
  const rank = { none: 0, degraded: 1, hard: 2 };
  if (rank[observed] === rank[predicted]) return "matched";
  return rank[observed] > rank[predicted] ? "worse_than_predicted" : "milder_than_predicted";
}
```

### Tool surface

One tool, `observe_impact`, registered the same way M2/M4's tools are
(zod schema via `registerTool`):

| Field | Type | Notes |
|---|---|---|
| `predicted_severity` | `"hard" \| "degraded"` | From the agent's earlier `predict_blast_radius` call |
| `affected_routes` | array of strings | Plain paths (e.g. `["/products"]`); the agent extracts these from M4's `Impact.target` strings (which may read `"GET /products"` — the leading HTTP verb is not a Prometheus route label and must be stripped before calling this tool) |
| `window_seconds` | positive integer | How far back to query; the agent passes the fault's `duration_seconds` |

Response:

```typescript
{
  windowSeconds: number,
  predictedSeverity: "hard" | "degraded",
  observedSeverity: "hard" | "degraded" | "none",
  verdict: "matched" | "milder_than_predicted" | "worse_than_predicted",
  routes: {
    [path: string]: { errorRatePercent: number | null, avgLatencyMs: number | null, requestCount: number }
  }
}
```

`routes` always includes checkout-api's 4 real paths (`/products`,
`/orders`, `/health`, `/metrics`), regardless of which are in
`affected_routes` — this lets the agent (and a human reading the report)
see the full picture, including confirmation that *unaffected* routes
really were unaffected, not just the ones predicted to be hit.

Invalid `predicted_severity`, empty `affected_routes`, or non-positive
`window_seconds`: rejected by the zod schema before any query, same
pattern M2/M4 established.

### M3 integration

Two changes to already-merged M3 files, both additive:

- `agent/chaos-notary.json`: a third `mcp_servers[]` entry (name TBD at
  implementation time, same "Unverified until registered" caveat pattern
  M3/M4 already use; no `require_approval_for_tools` — read-only). The
  system prompt's "How to run an experiment" workflow gets a new
  **mandatory** final step, after the fault reverts: call
  `observe_impact` with the severity/routes from the earlier
  `predict_blast_radius` call and the fault's `duration_seconds` as the
  window, then report the real verdict — replacing today's
  expectation-only close with an actual-outcome close.
- `agent/README.md`: a new Setup step for registering the third
  connector, and an update to the manual verification walkthrough
  confirming the agent's final report reflects `observe_impact`'s real
  verdict (not just that it called the tool).

## Error handling

- Invalid tool input: rejected by the zod schema, matching M2/M4's
  established pattern.
- Prometheus unreachable or returns a query error: propagates as a
  thrown error surfaced through the MCP tool's `isError: true`, never
  silently reported as `"none"` (a silent zero would misleadingly read as
  "confirmed no impact" instead of "couldn't check").
- A route with zero requests in the window: `errorRatePercent` and
  `avgLatencyMs` are both `null` (explicitly "no data"), never `0` or
  `NaN` — division by zero is checked before computing either value.

## Testing / acceptance criteria

`scripts/verify-m5.sh`, in the same spirit as `verify-m1.sh`/`verify-m4.sh`:

1. Service comes up healthy (`GET /health` on `chaos-metrics-watcher`).
2. Baseline call (no fault running): `observe_impact` with
   `predicted_severity: "degraded"`, `affected_routes: ["/products"]`,
   a short window — assert `observedSeverity: "none"` and near-zero
   error rates across routes.
3. Trigger a real fault via M2's tools (pause `chaos-pg-replica` for
   30s, matching `verify-m1.sh`'s own proven fault shape), wait for the
   fault window, then call `observe_impact` with
   `predicted_severity: "hard"`, `affected_routes: ["/products"]`,
   `window_seconds` covering the fault — assert `observedSeverity:
   "hard"` and `verdict: "matched"`.
4. Call `observe_impact` with an empty `affected_routes` array or a
   non-positive `window_seconds`; assert rejection.
5. Network isolation check: confirm `metrics-watcher` cannot reach
   `mcp-server` (e.g. attempt a connection from inside the
   `metrics-watcher` container to `mcp-server:3100` and assert it
   fails) — the concrete guard against the same network-reachability
   gap Qodo caught in M4, verified here from the start rather than
   after a review.

## Open questions for the implementation plan

None blocking. The severity-classification thresholds and PromQL shapes
are fully specified above, sourced from `scripts/verify-m1.sh`'s own
already-proven queries rather than left to the implementer's judgment —
the plan should transcribe them faithfully, not re-derive them.
