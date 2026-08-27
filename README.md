# Chaos Notary

A chaos-engineering agent that runs destructive resilience experiments
against a live system, predicts blast radius before acting, observes impact
in real time, and stops for human approval before any irreversible action.

The agent runs on [TrueForge](https://truefoundry.com) (an existing agent
harness). This repo builds everything around it: the target stack to break,
an MCP server exposing chaos tools, the agent definition, and a sealed
sandbox for blast-radius computation.

## Status

- **M1 — Target stack**: done, see below.
- **M2 — MCP server**: done. Exposes chaos tools (container pause/stop/kill, network latency/loss injection) over Streamable HTTP, wrapping Pumba, with bounded duration per fault and guaranteed auto-revert.
- M3 (agent + approval gates), M4 (blast-radius sandbox),
  M5 (metrics-watcher subagent), M6 (hardening) are not yet built.

## M1 — Target stack

A self-contained `docker compose` stack with a deliberate resilience gap:
`checkout-api`'s read path (`GET /products`) talks **only** to `pg-replica`.
There is no fallback to the primary. If the replica goes down, `/products`
returns `503`. That gap is the whole point — it's the failure mode the rest
of this project exists to find, predict, and demonstrate.

```
                 ┌─────────────┐
   loadgen  ───► │ checkout-api│ ───reads──► pg-replica  (no fallback!)
  (~10rps)       │  :3000      │ ───writes─► pg-primary  (streaming repl.)
                 └──────┬──────┘
                        │ /metrics
                        ▼
                 prometheus:9090 ──► grafana:3001 (dashboard "chaos-notary")
```

### Run it

Requires Docker with Compose v2. If you're on Windows without Docker
Desktop, run everything from inside WSL2 (Ubuntu, with systemd enabled and
Docker Engine installed there).

```bash
docker compose up -d --build
```

Then open:
- **Dashboard**: http://localhost:3001/d/chaos-notary (anonymous auth, no login)
- **Prometheus**: http://localhost:9090
- **API**: http://localhost:3000/health, http://localhost:3000/products

### Try the resilience gap yourself

```bash
docker pause chaos-pg-replica     # simulate replica outage
# watch the error-rate panel spike within ~30s
docker unpause chaos-pg-replica   # heal it
# watch it recover
```

### Automated acceptance test

`scripts/verify-m1.sh` runs the same experiment and asserts real numbers
pulled from Prometheus (baseline error rate < 1%, fault-window error rate
> 40%, recovered error rate < 1%). Run it from WSL:

```bash
bash scripts/verify-m1.sh
```

`scripts/verify-m2.sh` exercises the MCP server's chaos tools against the M1 stack,
verifying tool invocation, auto-revert behavior, and bounded-duration guarantees.

```bash
bash scripts/verify-m2.sh
```

### Services

| Service | Container | Port | Role |
|---|---|---|---|
| `checkout-api` | `chaos-checkout-api` | 3000 | Fastify API. `GET /products` (read, replica-only, no fallback), `POST /orders` (write, primary), `GET /health`, `GET /metrics` |
| `pg-primary` | `chaos-pg-primary` | 5432 | Postgres, streaming replication source |
| `pg-replica` | `chaos-pg-replica` | 5433 | Streaming replica, read-only |
| `prometheus` | `chaos-prometheus` | 9090 | Scrapes `checkout-api` every 5s |
| `grafana` | `chaos-grafana` | 3001 | Dashboard `chaos-notary`, provisioned as code, anonymous auth |
| `loadgen` | `chaos-loadgen` | — | Fire-and-forget traffic generator, ~10rps, 70% reads / 30% writes |
| `mcp-server` | `chaos-mcp-server` | 3100 | MCP server exposing chaos tools: pause/stop/kill containers, inject network latency/packet loss, with bounded duration and guaranteed auto-revert |

All credentials in `docker-compose.yml` are dev-only placeholders
(`chaos_dev_only_not_a_secret`, `chaos_dev_replica_not_a_secret`) — obviously
non-production, committed intentionally for a self-contained demo stack. The
`chaos-mcp-server` service also mounts `/var/run/docker.sock` read-write,
which is root-equivalent access to the host's Docker daemon — like the
credentials above, that's an intentional, disclosed choice for a
self-contained non-production demo stack, not an oversight.

## M2 — MCP server tool surface

The MCP server exposes 7 tools, all restricted to the 5-container allowlist
below. Every mutating tool takes a `duration_seconds` bounded to `[5, 300]`
and is guaranteed to auto-revert when that window elapses.

| Tool | Effect |
|---|---|
| `list_targets` | List each allowlisted container's current Docker state and active fault, if any |
| `pause_container` | Freeze a container's processes for a bounded duration |
| `stop_container` | Stop a container for a bounded duration, then auto-restart |
| `kill_container` | Send a signal that kills a container's process for a bounded duration, then auto-restart |
| `inject_latency` | Add network latency to a container's traffic for a bounded duration |
| `inject_packet_loss` | Drop a percentage of a container's network packets for a bounded duration |
| `clear_fault` | Manually revert whatever fault (if any) is currently active on a container |

Allowlisted containers: `chaos-pg-primary`, `chaos-pg-replica`,
`chaos-checkout-api`, `chaos-prometheus`, `chaos-grafana`. No other container
name is accepted by any tool.

## Qodo Code Review Evidence

[PR #1 — M1: Target stack](https://github.com/mikelord007/Chaos_Notary/pull/1)
(merged) is the representative example: Qodo's first pass found 3 real bugs —
a flaky acceptance-test assertion that could reject a correctly-working chaos
experiment, `POST /orders` misclassifying client input errors as primary-DB
outages, and a test script that could leave `pg-replica` permanently paused
if it failed partway through. All three were fixed in
[a052b77](https://github.com/mikelord007/Chaos_Notary/commit/a052b7721ed0cbe3c5c2bf92e39f2bbf8e3ac90c),
and a follow-up Qodo review against that commit confirmed all three resolved
with zero new findings before merge. The PR's comment history shows the full
loop: initial review → fixes → follow-up review.

Per-PR record, one line per merged PR:

| PR | What Qodo flagged | Resolution |
|---|---|---|
| [#1 — M1: Target stack](https://github.com/mikelord007/Chaos_Notary/pull/1) | 3 bugs: flaky fault-rate assertion in `verify-m1.sh` (High), client input errors misclassified as primary-DB outages in `POST /orders` (Medium), test script could leave `pg-replica` permanently paused on failure (Medium) | All 3 fixed in [a052b77](https://github.com/mikelord007/Chaos_Notary/commit/a052b7721ed0cbe3c5c2bf92e39f2bbf8e3ac90c); follow-up Qodo review confirmed 0 remaining findings before merge |
