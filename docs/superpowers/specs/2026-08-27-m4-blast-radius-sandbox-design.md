# M4: Blast-radius sandbox — design

Status: approved, ready for implementation planning
Date: 2026-08-27

## Purpose

M2 built the mechanism to run chaos experiments; M3 built an agent that
proposes them and stops for human approval. Neither actually predicts what
an experiment will do before it happens — M3's system prompt today just has
the agent describe its own expectation in prose, from general reasoning,
with nothing behind it. The README's own framing of this project
("predicts blast radius before acting") has never actually been built.

M4 builds that prediction: a small, deliberately isolated service that
answers one question — "if I fault container X with fault type Y, what
actually breaks, and what doesn't?" — using a hand-authored, accurate model
of M1's real topology, not guesswork. It is a *sealed* sandbox in the
literal sense: it has no Docker access, no ability to execute anything
against the real stack, and cannot be the source of any incident itself.
It only computes and reports.

## Goals

- A new service, `services/blast-radius-sandbox`, exposing one MCP tool —
  `predict_blast_radius` — that takes the same `(container, fault kind)`
  shape M2's tools already use and returns which routes/services are
  affected, which are explicitly unaffected, and why, grounded in M1's
  actual, verified architecture (not a generic guess).
- Zero Docker access from this service. No `docker.sock` mount, no `pumba`,
  no ability to inspect or touch the real stack. Its answers come entirely
  from a static, versioned topology model committed in this repo.
- Distinguish fault severity where M1's own implementation makes that
  distinction meaningful — e.g. `checkout-api`'s DB pools have a 2000ms
  connection/query timeout, so `inject_latency` above that threshold on a
  DB container is practically equivalent to a hard outage for the routes
  that depend on it, while lower latency is a real but different kind of
  impact (slower, not necessarily failing).
- Wire this into M3: the agent manifest gets a second `mcp_servers[]`
  entry, and the system prompt's experiment workflow calls
  `predict_blast_radius` and incorporates its actual output into the
  "here's what I expect to happen" statement, instead of reasoning from
  scratch every time.
- Prove the topology model doesn't silently drift from M2's actual
  allowlist (see Non-goals about not sharing code between the two
  services — the acceptance test cross-checks this instead).

## Non-goals

- No live or dynamic computation — this doesn't call M2, doesn't inspect
  Docker, doesn't query Prometheus. It's a static model, reasoned over.
  Comparing predicted vs. actually-observed impact is M5's territory
  (metrics-watcher subagent), not this milestone.
- No general-purpose dependency-graph engine. M1's topology is small and
  shallow (one hop: a target container affects specific routes/services
  directly depending on it; nothing cascades further in this stack).
  Hand-modeling the 5 allowlisted containers' real relationships is
  simpler and more accurate than building traversal machinery for a graph
  that will never need it.
- No code sharing between `services/blast-radius-sandbox` and
  `services/mcp-server` (e.g. importing M2's `allowlist.ts`). They are
  separate deployable services in this repo's existing pattern (M2 and
  `checkout-api` don't share code either); the container-name list is
  duplicated here on purpose, kept honest by an acceptance-test check that
  the two sets are equal, not by a shared package.
- No enforcement. This tool informs — it never blocks a chaos action. The
  actual control is M3's human-approval gate, unchanged by this milestone.
- No changes to M2's `services/mcp-server` at all.

## Architecture

### File structure

```
services/blast-radius-sandbox/
  package.json
  tsconfig.json
  Dockerfile
  src/
    allowlist.ts   # the same 5 container names as M2, duplicated on purpose
    topology.ts     # the hand-authored topology model + prediction logic
    tools.ts          # the predict_blast_radius MCP tool
    server.ts           # MCP server entrypoint (Streamable HTTP)
  test/
    allowlist.test.ts
    topology.test.ts
    tools.test.ts
scripts/
  verify-m4.sh          # acceptance test
agent/
  chaos-notary.json      # modified: second mcp_servers[] entry, revised workflow
  README.md                # modified: setup step for the new connector
```

### Deployment

A new `blast-radius-sandbox` service in `docker-compose.yml`:

- **Language/runtime**: TypeScript on Node, `@modelcontextprotocol/sdk`,
  matching `services/mcp-server`'s established conventions (`tsconfig.json`
  shape, `npm ci` + committed lockfile, Streamable HTTP transport in
  stateless mode — the exact bug class Qodo caught in M2/M3 doesn't need
  rediscovering here).
- **No `docker.sock` mount.** This is the entire point of "sealed" — the
  container has no way to reach the Docker daemon at all, so a bug here
  cannot become an incident.
- **Container name**: `chaos-blast-radius-sandbox`. Port `3200`, published
  loopback-only (`127.0.0.1:3200:3200`) for consistency with M2's posture,
  even though nothing this service does is destructive — there's no
  reason to publish it more broadly than it needs to be reached from.
- **`depends_on`**: nothing. This service has no dependency on the rest of
  the stack being up — it computes from static data, not live state.

### Topology model

`topology.ts` exports a static map, one entry per allowlisted container,
each describing what actually depends on it in M1's real architecture:

```typescript
export type FaultKind = "pause" | "stop" | "kill" | "inject_latency" | "inject_packet_loss";

export interface Impact {
  target: string;   // route or service description, e.g. "GET /products"
  effect: string;    // what happens, phrased for the fault's actual severity
}

export interface TopologyEntry {
  container: string;
  role: string;                // one-line description of what this container does
  hardFaultImpacts: Impact[];  // pause/stop/kill, or high-severity network fault
  degradedFaultImpacts: Impact[]; // lower-severity inject_latency/inject_packet_loss
  unaffected: string[];         // explicitly called out as NOT impacted, and why
  notes?: string;                // caveats worth surfacing (e.g. replication behavior)
}
```

The five entries are authored directly from M1's actual, already-built
implementation — not inferred generically:

- **`chaos-pg-replica`**: hard fault → `GET /products` fails (503; no
  fallback to primary, by design — this is the whole resilience gap M1
  exists to demonstrate). `POST /orders` unaffected (writes go to
  primary). `/health`, `/metrics` unaffected (no DB dependency).
- **`chaos-pg-primary`**: hard fault → `POST /orders` fails (503, primary
  unavailable). `GET /products` unaffected — the replica keeps serving
  reads from what it already has. Note: ongoing replication stalls while
  primary is down, but that has no user-facing effect within a bounded
  5-300s experiment window.
- **`chaos-checkout-api`**: hard fault → both `GET /products` and
  `POST /orders` fail (the whole API is down). Prometheus's scrape of
  `/metrics` also fails during the fault (visible as a gap, not a false
  reading).
- **`chaos-prometheus`**: hard fault → no impact on `checkout-api`'s
  actual serving (a passive scraper going down doesn't affect what it
  scrapes) — but the Grafana dashboard stops showing new data for the
  duration, which is itself worth flagging: you're temporarily blinding
  your own observability.
- **`chaos-grafana`**: hard fault → no impact on serving or on metrics
  collection (Prometheus is independent of Grafana). Only the dashboard
  UI is unavailable; Prometheus's own query API at `:9090` still works.

Degraded-fault (`inject_latency`/`inject_packet_loss`) entries reuse the
same target routes but phrase the effect as slowdown/intermittent failure
rather than a flat 503, with one computed threshold: `checkout-api`'s DB
pools (`services/checkout-api/src/server.ts`) set
`connectionTimeoutMillis`/`query_timeout` to `2000`. `inject_latency` at or
above that on a DB container is treated as hard-fault-equivalent for the
routes depending on it (the query will time out regardless of the
"degraded" framing); below it, genuinely degraded. `inject_packet_loss` at
or above 80% is treated the same way; below that, degraded. These
thresholds are the "computation" in "blast-radius computation" — the tool
doesn't just look up a container, it reasons about the specific fault
parameters against a real constraint in the code.

### Tool surface

One tool, registered the same way M2's tools are (zod schema via
`registerTool`):

| Field | Type | Notes |
|---|---|---|
| `container` | enum of the 5 allowlisted names | Same allowlist as M2, duplicated per Non-goals |
| `fault_kind` | `"pause" \| "stop" \| "kill" \| "inject_latency" \| "inject_packet_loss"` | |
| `latency_ms` | optional integer | Only meaningful for `inject_latency`; used against the 2000ms threshold |
| `percent` | optional integer | Only meaningful for `inject_packet_loss`; used against the 80% threshold |

Response: `{ container, faultKind, severity: "hard" | "degraded", affected: Impact[], unaffected: string[], notes?: string }`.

Invalid `container` (not on the allowlist) or invalid `fault_kind`: rejected
by the zod schema before any lookup, same pattern M2 established.

### M3 integration

Two changes to already-merged M3 files, both additive:

- `agent/chaos-notary.json`: a second `mcp_servers[]` entry for this new
  connector (name TBD at implementation time to match whatever the human
  names it when registering — same "Unverified until registered" caveat
  pattern M3 already uses). The system prompt's "How to run an experiment"
  gets a new step between "call `list_targets`" and "state your intent":
  call `predict_blast_radius` for the proposed container/fault, and build
  the intent statement from its actual `affected`/`unaffected` output
  instead of freeform reasoning.
- `agent/README.md`: a new Setup step for registering the second
  connector, and an update to the manual verification walkthrough
  confirming the agent's stated intent actually reflects the tool's
  output (not just that it calls the tool).

## Error handling

- Non-allowlisted `container` or invalid `fault_kind`: rejected by the
  zod schema, matching M2's established pattern (reject before any
  processing).
- No Docker/network/external-service failure modes exist for this service
  — it has no external dependencies to fail. The only failure mode is a
  bug in the static topology data itself, which testing (below) is meant
  to catch before it ships.

## Testing / acceptance criteria

`scripts/verify-m4.sh`, in the same spirit as `verify-m1.sh`/`verify-m2.sh`
but lighter — this service has no live state to exercise, so the
acceptance test is about correctness of the static model, not about
watching real infrastructure react:

1. Service comes up healthy (`GET /health` on `chaos-blast-radius-sandbox`).
2. Call `predict_blast_radius` for `chaos-pg-replica` + `pause`; assert the
   response's `affected` list names `GET /products` and `unaffected` names
   `POST /orders`.
3. Call it for `chaos-pg-primary` + `pause`; assert the reverse (`POST
   /orders` affected, `GET /products` unaffected).
4. Call it for `chaos-pg-replica` + `inject_latency` with `latency_ms: 100`
   (below threshold) and again with `latency_ms: 3000` (above threshold);
   assert the two responses report different `severity`.
5. Call it with a non-allowlisted container name; assert rejection.
6. Cross-check: assert `services/blast-radius-sandbox/src/allowlist.ts`'s
   5 container names are identical (as a set) to
   `services/mcp-server/src/allowlist.ts`'s — this is the concrete guard
   against the two independently-maintained lists drifting apart, called
   out in Non-goals.

## Open questions for the implementation plan

None blocking. The topology model's content is fully specified above,
sourced from M1's actual code rather than left to the implementer's
judgment — the plan should transcribe it faithfully, not re-derive it.
