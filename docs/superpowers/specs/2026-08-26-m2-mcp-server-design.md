# M2: MCP server exposing chaos tools — design

Status: approved, ready for implementation planning
Date: 2026-08-26

## Purpose

M1 built a target stack with a deliberate resilience gap (`checkout-api`'s
read path has no fallback off `pg-replica`) and proved the gap is real by
driving it by hand (`docker pause`) and asserting the blast radius in
Prometheus (`scripts/verify-m1.sh`).

M2 turns that manual capability into a programmatic one: an MCP server that
exposes the same class of actions — and a few more fault types — as typed
tools, so the M3 agent can drive experiments instead of a human running
`docker pause` at a terminal.

M2 is mechanism only. It does **not** decide when to run an experiment, does
not require human approval before acting, and does not compute blast radius
in advance. Those are M3 (agent + approval gates) and M4 (blast-radius
sandbox) respectively. M2's job is: given a valid, allowlisted tool call,
execute the fault reliably and guarantee it is reverted — even if nothing
ever calls it back to reverse it.

## Goals

- Expose container-level and network-level chaos actions as MCP tools over
  Streamable HTTP, callable by an agent running anywhere (not just a local
  child process), matching TrueForge's expected connection model.
- Every mutating tool call is bounded in time and self-heals: the server
  itself guarantees reversion after `duration_seconds`, independent of
  whether the caller, the agent process, or the MCP connection survives
  that long.
- Restrict actions to a known, static allowlist of this repo's own
  docker-compose containers. No action can reach outside the stack it was
  built to test.
- Give the caller a way to observe current state (`list_targets`) without
  needing direct Docker or Prometheus access.
- Prove it end-to-end with an automated acceptance script in the same style
  as `scripts/verify-m1.sh`.

## Non-goals

- Approval gates, human-in-the-loop confirmation, or any policy about
  *when* an experiment should run. (M3.)
- Blast-radius prediction before acting. (M4.)
- A metrics-watching subagent or automated observation loop. (M5.) M2 only
  needs to make faults observable in the Prometheus metrics that already
  exist; it does not consume them itself.
- Authentication/authorization on the HTTP transport beyond what's needed
  for a self-contained demo (see Security posture below).
- Faults against anything other than this repo's own docker-compose stack.

## Architecture

### Deployment

A new `mcp-server` service in `docker-compose.yml`:

- **Language/runtime**: TypeScript on Node, consistent with `checkout-api`.
  Uses the official `@modelcontextprotocol/sdk`.
- **Transport**: Streamable HTTP, listening on `3100` (path `/mcp`). Chosen
  over stdio because the agent runs on TrueForge, an external harness, not
  as a local child process of this server — HTTP is the only transport that
  makes sense when client and server aren't guaranteed to share a machine.
- **Fault engine**: [Pumba](https://github.com/alexei-led/pumba), an
  existing open-source Docker chaos CLI, installed as a static binary in
  the server's image. Pumba talks to sibling containers over the Docker
  socket — it does not need to run inside each target container.
- **Docker access**: `/var/run/docker.sock` mounted read-write into the
  `mcp-server` container. This is the same "obviously dev-only, no secrets
  manager" posture the rest of the stack already uses (see
  `docker-compose.yml`'s existing credential comment) — a chaos tool that
  can't touch Docker can't do its job, and this is a self-contained local
  demo, not a shared or production environment.
- **Container name**: `chaos-mcp-server`, matching the `chaos-*` naming
  convention of every other service in the stack.

### Target allowlist

A static list, defined in code (not user-suppliable), of container names
this server is permitted to act on:

```
chaos-pg-primary
chaos-pg-replica
chaos-checkout-api
chaos-prometheus
chaos-grafana
```

`chaos-mcp-server` and `chaos-loadgen` are deliberately excluded — the
server should never be able to fault itself, and faulting the load
generator wouldn't exercise anything the dashboard shows. Any tool call
naming a container outside this list is rejected with a clear error before
any Docker/Pumba call is made.

## Tool surface

Specific, typed tools rather than one generic `inject_fault(type, ...)`
tool — clearer JSON schemas for the agent to reason about, and each tool's
failure modes are independent.

All `container` parameters are a string enum drawn from the allowlist
above. All mutating tools require `duration_seconds`, an integer bounded to
`[5, 300]`.

| Tool | Params | Effect |
|---|---|---|
| `list_targets` | *(none)* | Read-only. Returns each allowlisted container's current state (`running`, `paused`, or `faulted` + fault type) and, if faulted, seconds remaining until auto-revert. |
| `pause_container` | `container`, `duration_seconds` | `pumba pause` — freezes the container's processes. Reverted by `docker unpause`. |
| `stop_container` | `container`, `duration_seconds` | `pumba stop` — stops the container. Reverted by `docker start` (none of these services have a Docker restart policy, so this must be explicit). |
| `kill_container` | `container`, `signal` (default `SIGKILL`), `duration_seconds` | `pumba kill` — sends a signal, killing the process; the container exits. Reverted by `docker start`. |
| `inject_latency` | `container`, `latency_ms`, `jitter_ms` (default 0), `duration_seconds` | `pumba netem delay` — adds network latency via `tc`/`netem`. Reverted by clearing the netem qdisc. |
| `inject_packet_loss` | `container`, `percent`, `duration_seconds` | `pumba netem loss` — drops a percentage of packets. Reverted the same way as latency. |
| `clear_fault` | `container` | Manual early revert of whatever fault (if any) is currently active on that container. No-op if nothing is active. |

Every mutating tool's response includes the fault's id, the container, and
the ISO timestamp it will auto-revert at, so a caller can reason about
state without polling `list_targets`.

## Safety model

The server — not Pumba's own `--duration` flag — owns fault lifecycle and
duration bookkeeping, so behavior is uniform across all fault types
regardless of what each Pumba subcommand natively supports:

1. On a mutating tool call: validate `container` against the allowlist and
   `duration_seconds` against `[5, 300]`; reject otherwise. If the target
   already has an active fault, reject with a conflict error rather than
   stacking faults.
2. Run the Pumba action to create the fault. Record it in an in-memory
   registry (`container -> {faultType, startedAt, revertFn}`).
3. Schedule a timer for `duration_seconds` that calls `revertFn` (e.g.
   `docker unpause`, `docker start`, or the netem-clear command) and
   removes the registry entry. `clear_fault` runs the same `revertFn`
   early and cancels the timer.
4. **Startup sweep**: on process start, before accepting any tool calls,
   the server iterates the allowlist and force-reverts any container found
   paused or netem-faulted, and starts any found stopped. This is the same
   failure mode PR #1 already hit and fixed in `verify-m1.sh` (a script
   that pauses the replica but can exit before unpausing it) — solving it
   once at the server level means every future fault type inherits the
   protection instead of needing its own cleanup-on-crash logic.

This gives defense in depth ahead of M3: even with no agent-level approval
gates or supervision yet, nothing this server does can permanently break
the stack.

## Error handling

- Invalid/non-allowlisted `container`: reject before touching Docker.
- `duration_seconds` out of range: reject before touching Docker.
- Conflicting fault (target already faulted): reject, tell the caller what
  is currently active (matches `list_targets` output) instead of silently
  overwriting it.
- Pumba invocation fails (e.g. Docker socket error, container not found at
  call time): return the underlying error to the caller; do not add a
  registry entry or timer for a fault that didn't actually take effect.
- Revert itself fails (e.g. container was manually removed out-of-band):
  log loudly; keep retrying the revert on a backoff up to a fixed number of
  attempts rather than silently dropping it, since a stuck fault is exactly
  the failure mode this whole safety model exists to prevent.

## Testing / acceptance criteria

`scripts/verify-m2.sh`, in the same spirit as `verify-m1.sh` — real
assertions against Prometheus, not a visual check:

1. Stack (including `chaos-mcp-server`) comes up healthy.
2. Call `list_targets`; assert all allowlisted containers report `running`.
3. Call `pause_container(chaos-pg-replica, duration_seconds=30)`; assert
   Prometheus error rate on `/products` spikes within the fault window
   (same assertion style as M1, corrected for the dilution bug fixed in
   PR #1).
4. Without calling `clear_fault`, wait past `duration_seconds` and assert
   the container is back to `running` (via `list_targets` and/or
   `docker inspect`) and the error rate recovers — proving auto-revert
   works with no caller intervention.
5. Call a tool with a non-allowlisted container name (e.g.
   `chaos-mcp-server` itself) and assert it's rejected without any Docker
   state change.
6. Call `pause_container` twice on the same target back-to-back; assert the
   second call is rejected as a conflict rather than silently accepted.

## Open questions for the implementation plan

None blocking — the above is sufficient to write an implementation plan
against. Exact Pumba CLI invocation flags, the MCP tool JSON-schema
definitions, and the internal registry data structure are implementation
detail to be worked out in that plan, not this design.
