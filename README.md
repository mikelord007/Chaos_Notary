# Chaos Notary

A chaos-engineering agent that runs destructive resilience experiments
against a live system, predicts blast radius before acting, checks real
impact against its own prediction after the fact, and stops for human
approval before any irreversible action.

The agent runs on [TrueForge](https://truefoundry.com) (an existing agent
harness). This repo builds everything around it: the target stack to break,
an MCP server exposing chaos tools, the agent definition, and a sealed
sandbox for blast-radius computation.

## Status

- **M1 — Target stack**: done, see below.
- **M2 — MCP server**: done. Exposes chaos tools (container pause/stop/kill, network latency/loss injection) over Streamable HTTP, wrapping Pumba, with bounded duration per fault and guaranteed auto-revert.
- **M3 — Agent + approval gates**: done. TrueForge agent manifest declares human approval for every destructive chaos tool; whether the gate actually fires is confirmed by manually running it against a live TrueForge instance, a check not yet performed in this repo — see [`agent/README.md`](agent/README.md) for setup and that verification walkthrough.
- **M4 — Blast-radius sandbox**: done. Sealed read-only service for predicting chaos experiment blast radius, wired as a second MCP connector in the agent manifest, with zero Docker access to ensure it cannot affect the live stack.
- **M5 — Metrics-watcher**: done. Reports what Prometheus actually recorded after a chaos fault reverts and compares it against M4's prediction, wired as a third MCP connector in the agent manifest, closing the predict-then-observe loop. The unit test suite passes and the service typechecks cleanly, but the Docker image build, the docker-compose network wiring, and `scripts/verify-m5.sh`'s live run are unverified against a real Docker daemon — a check not yet performed in this repo (Docker was unavailable throughout this milestone's implementation environment).

M6 (hardening) is not yet built.

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

`scripts/verify-m4.sh` exercises the blast-radius sandbox in isolation (no other
stack services required), checking its allowlist stays in sync with the MCP
server's, its topology predictions match M1's actual DB-container blast radius,
its latency severity threshold behaves correctly, and it rejects a
non-allowlisted container.

```bash
bash scripts/verify-m4.sh
```

`scripts/verify-m5.sh` brings up the full stack and exercises the metrics-watcher
service, checking that baseline observed severity is "none," a real pause-triggered
fault produces "hard" observed severity with a "matched" verdict, invalid input
(empty affected_routes) is rejected, and verifying metrics-watcher's network isolation
from mcp-server — placed on its own `observability-net` to prevent reaching
mcp-server, the same topology-isolation guard M4 established via `sandbox-net`.

```bash
bash scripts/verify-m5.sh
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
| `blast-radius-sandbox` | `chaos-blast-radius-sandbox` | 3200 | Read-only prediction service: computes expected blast radius of chaos experiments using static topology model, no Docker access |
| `metrics-watcher` | `chaos-metrics-watcher` | 3300 | Observes and reports actual impact severity from live Prometheus data after chaos faults, wired as third MCP connector alongside MCP server and blast-radius-sandbox |

All credentials in `docker-compose.yml` are dev-only placeholders
(`chaos_dev_only_not_a_secret`, `chaos_dev_replica_not_a_secret`) — obviously
non-production, committed intentionally for a self-contained demo stack. The
`chaos-mcp-server` service also mounts `/var/run/docker.sock` read-write,
which is root-equivalent access to the host's Docker daemon — like the
credentials above, that's an intentional, disclosed choice for a
self-contained non-production demo stack, not an oversight. The `/mcp`
endpoint itself has no authentication — any client that can reach it can
pause, stop, or kill the allowlisted containers — so the published port is
bound to `127.0.0.1` only (see `docker-compose.yml`), not exposed to the
wider network. Three services now have deliberately restricted network
membership, each isolated on its own dedicated Compose network rather than
the implicit default network: `mcp-server` itself has none of these
restrictions — it needs full default-network access to reach the Docker
socket and the containers it manages — but `blast-radius-sandbox` is placed
on its own network (`sandbox-net`), and `metrics-watcher` is placed on its
own network (`observability-net`, shared only with `prometheus`, which is
dual-homed onto both `default` and `observability-net` so it can still be
scraped from and reached by `metrics-watcher`). `blast-radius-sandbox`
makes zero outbound calls and depends on nothing, so `sandbox-net`
isolation costs it no reachability it actually needs; `metrics-watcher`'s
only legitimate outbound call is to `prometheus`, so `observability-net`
isolation costs it nothing either. Both arrangements ensure neither service
can reach `mcp-server` (or anything else outside its own dedicated network)
by Docker's internal service-name DNS even if a compromised or buggy
dependency inside either tried to. That keeps the "sealed sandbox" claim
true at the network layer for `blast-radius-sandbox`, and the equivalent
claim true for `metrics-watcher`, not just at the application layer (no
Docker socket, read-only computation).

## M2 — MCP server tool surface

The MCP server exposes 7 tools. The 6 that take a `container` argument
(everything except `list_targets`) are restricted to the 5-container
allowlist below; the 5 that inject a fault (everything except
`list_targets` and `clear_fault`) take a `duration_seconds` bounded to
`[5, 300]` and are guaranteed to auto-revert when that window elapses.

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
| [#2 — M2: MCP server](https://github.com/mikelord007/Chaos_Notary/pull/2) | 7 bugs (5 High, 2 Medium): a stateful MCP transport that broke every call after the first client session, three fault-injection tools reporting success before confirming Pumba even launched, a cross-tool race letting two different mutating tools claim the same container, `kill_container` accepting non-terminating signals (e.g. `SIGSTOP`) the revert path couldn't detect or undo, shutdown silently declaring success when a revert was actually stuck, a signal-killed process counted as a successful fault, and the destructive `/mcp` endpoint published with no authentication | All 7 fixed in [58df2cf](https://github.com/mikelord007/Chaos_Notary/commit/58df2cf); follow-up Qodo review confirmed 0 remaining findings before merge |
| [#3 — M3: Agent + approval gates](https://github.com/mikelord007/Chaos_Notary/pull/3) | 4 bugs (1 High, 3 Medium): the TrueForge agent manifest omitted the required `mcp_servers[0].type` field (would have left the connector unresolvable), the manual verification steps claimed `list_targets` can report container "health" when it only returns Docker/fault state, the system prompt and the verification walkthrough disagreed on whether to check `list_targets` or state intent first, and the README's M3 status bullet read as though the approval gate had already been verified live when that step was still pending | All 4 fixed in [380b76a](https://github.com/mikelord007/Chaos_Notary/commit/380b76a); follow-up Qodo review confirmed 0 remaining findings before merge |
| [#4 — M4: Blast-radius sandbox](https://github.com/mikelord007/Chaos_Notary/pull/4) | 6 bugs (3 High, 3 Medium): 100% packet loss on non-DB containers was still classified "degraded" instead of an outage-equivalent "hard", the real `inject_latency` tool's `jitter_ms` parameter was accepted but silently ignored by severity prediction, the sealed sandbox shared Compose's default network with the unauthenticated destructive `mcp-server` — reachable via Docker service-name DNS despite having zero Docker-socket access itself (Security); explicit `percent: 0` falsely reported a network-fault impact, `chaos-checkout-api`'s hard-fault list omitted its own `GET /health`, and `chaos-prometheus`'s hard-fault list omitted its own query API | All 6 fixed across [f733132](https://github.com/mikelord007/Chaos_Notary/commit/f733132), [4bbb5bf](https://github.com/mikelord007/Chaos_Notary/commit/4bbb5bf), [69896ea](https://github.com/mikelord007/Chaos_Notary/commit/69896ea); follow-up Qodo review confirmed all 6 fixes correctly reflected in the diff and tests before merge |
