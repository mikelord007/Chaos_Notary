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
- M2 (MCP server), M3 (agent + approval gates), M4 (blast-radius sandbox),
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

### Services

| Service | Container | Port | Role |
|---|---|---|---|
| `checkout-api` | `chaos-checkout-api` | 3000 | Fastify API. `GET /products` (read, replica-only, no fallback), `POST /orders` (write, primary), `GET /health`, `GET /metrics` |
| `pg-primary` | `chaos-pg-primary` | 5432 | Postgres, streaming replication source |
| `pg-replica` | `chaos-pg-replica` | 5433 | Streaming replica, read-only |
| `prometheus` | `chaos-prometheus` | 9090 | Scrapes `checkout-api` every 5s |
| `grafana` | `chaos-grafana` | 3001 | Dashboard `chaos-notary`, provisioned as code, anonymous auth |
| `loadgen` | `chaos-loadgen` | — | Fire-and-forget traffic generator, ~10rps, 70% reads / 30% writes |

All credentials in `docker-compose.yml` are dev-only placeholders
(`chaos_dev_only_not_a_secret`, `chaos_dev_replica_not_a_secret`) — obviously
non-production, committed intentionally for a self-contained demo stack.

## Qodo Code Review Evidence

See [`docs/qodo-evidence.md`](docs/qodo-evidence.md) for the per-PR record of
what Qodo flagged and how it was resolved.
