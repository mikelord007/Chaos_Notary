# Chaos Notary agent

The TrueForge agent manifest for Chaos Notary lives at
[`chaos-notary.json`](./chaos-notary.json). This is a static config file —
TrueForge is a separate, external agent harness this repo doesn't run or
control. Getting the agent working requires one manual setup step this repo
can't automate.

## Prerequisites

- The M1+M2 stack running: `docker compose up -d --build` from the repo
  root (see the root [`README.md`](../README.md) for details).
- A TrueForge instance you can reach: locally via
  `npx @truefoundry/trueforge@latest` (SQLite-backed, single command, per
  TrueForge's published quickstart — check TrueForge's current docs if
  that's changed), or a shared deployment. It needs network access to
  `mcp-server`. `docker-compose.yml` publishes that service as
  `127.0.0.1:3100:3100` — loopback-only, on purpose, because `/mcp` has no
  authentication and can pause/stop/kill the whole stack (see the comment
  above that port line in `docker-compose.yml`, and the root
  [`README.md`](../README.md)'s Qodo evidence table for PR #2, where this
  was one of 7 real bugs found and fixed). If TrueForge runs as a process
  on the same host as the Docker stack, it can reach the server at
  `http://localhost:3100`. If it can't — a remote or shared TrueForge
  deployment — put TrueForge on this project's Docker network instead (add
  it to `docker-compose.yml`'s network, or run it with `--network` pointing
  at this stack's compose network) and reach the server via its compose
  service DNS name, `http://chaos-mcp-server:3100`, rather than widening
  the published host port.

  **Do not widen the `127.0.0.1:3100:3100` binding in `docker-compose.yml`
  to expose `/mcp` more broadly — it has no authentication.**

- The same TrueForge instance also needs network access to the M4
  `blast-radius-sandbox` service, for the same reachability reasons —
  `docker-compose.yml` publishes it as `127.0.0.1:3200:3200`, loopback-only.
  Its `/mcp` endpoint has no authentication either; the stakes are lower
  since `predict_blast_radius` is read-only computation with no Docker
  access, but the same reachability pattern applies. If TrueForge runs as
  a process on the same host as the Docker stack, it can reach the server
  at `http://localhost:3200`. If it can't, put TrueForge on this project's
  Docker network (as above) and reach it via its compose service DNS name,
  `http://chaos-blast-radius-sandbox:3200`, rather than widening the
  published host port.

  **Do not widen the `127.0.0.1:3200:3200` binding either.**

- The same TrueForge instance also needs network access to the M5
  `metrics-watcher` service, for the same reachability reasons —
  `docker-compose.yml` publishes it as `127.0.0.1:3300:3300`, loopback-only.
  Its `/mcp` endpoint has no authentication either; the stakes are lower
  since `observe_impact` is a read-only Prometheus query with no Docker
  access, but the same reachability pattern applies. If TrueForge runs as
  a process on the same host as the Docker stack, it can reach the server
  at `http://localhost:3300`. If it can't, put TrueForge on this project's
  Docker network (as above) and reach it via its compose service DNS name,
  `http://chaos-metrics-watcher:3300`, rather than widening the published
  host port.

  **Do not widen the `127.0.0.1:3300:3300` binding either.**

## Setup

1. **Register `mcp-server` as a Connector.** In TrueForge's UI, go to
   Settings → Connectors, add a new MCP connector pointing at
   `http://localhost:3100/mcp` if TrueForge runs on the same host as the
   Docker stack, or `http://chaos-mcp-server:3100/mcp` if TrueForge is
   instead running on this project's Docker network (see Prerequisites
   above — do not point it at a widened `3100:3100` binding), and name it
   `mcp-server` — the manifest's `mcp_servers[0].name` must match whatever
   you name it here.

   The manifest's `mcp_servers[0]` entry sets `"type": "truefoundry-mcp-registry"`
   alongside `"name": "mcp-server"` — per TrueForge's
   [agent manifest reference](https://www.truefoundry.com/docs/agent-platform/agent-harness/sdk/agent-manifest-reference),
   `mcp_servers[]` is a discriminated union and `type` is required even for
   a Connector-registered server, not just a platform-catalog one; `name`
   is "the name of the MCP server as registered in the platform," which is
   exactly what step 1 above sets when you name the connector `mcp-server`.

   Even so, a clean manifest load is not proof the approval gate is
   wired — if this schema detail is still off in some way this repo
   couldn't check, TrueForge may silently ignore an unrecognized field
   rather than erroring. Treat the manifest as ungated until verification
   step 5 below (in "Manually verifying the approval gate") actually
   confirms the approval prompt fires before the tool executes.

2. **Register `blast-radius-sandbox` as a Connector.** Same UI, add a
   second MCP connector pointing at `http://localhost:3200/mcp` if
   TrueForge runs on the same host as the Docker stack, or
   `http://chaos-blast-radius-sandbox:3200/mcp` if TrueForge is instead
   running on this project's Docker network (see Prerequisites above — do
   not point it at a widened `3200:3200` binding), and name it
   `blast-radius-sandbox` — the manifest's `mcp_servers[1].name` must
   match whatever you name it here. Unlike `mcp-server`, this entry has no
   `require_approval_for_tools`: `predict_blast_radius` is read-only
   computation with no Docker access, so nothing on it needs gating.

3. **Register `metrics-watcher` as a Connector.** Same UI, add a third MCP
   connector pointing at `http://localhost:3300/mcp` if TrueForge runs on
   the same host as the Docker stack, or `http://chaos-metrics-watcher:3300/mcp`
   if TrueForge is instead running on this project's Docker network (see
   Prerequisites above — do not point it at a widened `3300:3300`
   binding), and name it `metrics-watcher` — the manifest's
   `mcp_servers[2].name` must match whatever you name it here. Like
   `blast-radius-sandbox`, this entry has no `require_approval_for_tools`:
   `observe_impact` is a read-only Prometheus query with no Docker access,
   so nothing on it needs gating.

4. **Load the manifest.** Via TrueForge's Agent Playground (paste/import
   `chaos-notary.json`) or its SDK (`type: "truefoundry-agent"` manifests
   can be defined in code and saved programmatically — see TrueForge's
   docs). Save it to the Agent Registry.

   **Unverified:** the exact model catalog string
   (`anthropic/claude-sonnet-5` in the manifest) may not match what your
   TrueForge instance's model catalog actually calls it. If the agent
   fails to load or run because of the `model.name` field, check your
   instance's available models and update the manifest.

## Manually verifying the approval gate

This is the actual proof M3 works — there's no automated test for it (see
the design spec's Testing section for why). Run through this once against
a real TrueForge instance before considering M3 done:

1. Start a conversation with the loaded `chaos-notary` agent.
2. Ask it: "Pause chaos-pg-replica for 30 seconds and tell me what you
   expect to happen."
3. Confirm the agent calls `list_targets` first, then `predict_blast_radius`
   (container `chaos-pg-replica`, fault kind `pause`), then states its
   intent (which container, how long, what it expects) before proposing
   `pause_container` — this order matches the manifest's own "How to run
   an experiment" instructions (list_targets, then predict_blast_radius,
   then state intent, then propose the call).
4. **Confirm the stated intent actually reflects `predict_blast_radius`'s
   output, not the agent reasoning about it from scratch.** For
   `chaos-pg-replica` + `pause`, the tool reports severity `"hard"`,
   `GET /products` as affected, and `POST /orders` (along with
   `GET /health` and `GET /metrics`) as unaffected — the agent's intent
   statement should say as much (e.g. that `GET /products` will fail and
   `POST /orders` won't be touched), not some other guess. If it states
   something the tool didn't actually return, or skips calling the tool
   at all, the wiring in Step 2 of the system prompt isn't working.
5. **Confirm the approval prompt fires before the tool call executes** —
   this is the core thing being verified. If `pause_container` runs
   without a prompt, the manifest's `require_approval_for_tools` isn't
   wired correctly; check the Connector registration and the manifest's
   `mcp_servers[0].name` match.
6. Approve it. Confirm the agent points you at
   `http://localhost:3001/d/chaos-notary` to watch the effect, rather than
   claiming to have checked it itself.
7. After 30+ seconds, ask the agent to confirm the container recovered.
   Confirm it calls `list_targets` again and reports the container's
   Docker status as running with no active fault — not "healthy," since
   `list_targets` has no application-health signal to report (only Docker
   status and fault-registry state). Check the Grafana dashboard yourself
   for actual workload recovery.
8. **Confirm the closing report reflects `observe_impact`'s real verdict,
   not a restated prediction.** Let the same experiment run through to
   completion. For `chaos-pg-replica` + `pause`, `predict_blast_radius`'s
   only `affected` target is `GET /products`, which strips down to the
   known route `/products`, so `observe_impact` applies here and the agent
   should call it once Docker/fault state is confirmed clean in step 7:
   passing the `severity` from its earlier `predict_blast_radius` call as
   `predicted_severity`, `["/products"]` as `affected_routes`, and
   `window_seconds` set to the fault's `duration_seconds` **plus roughly 60
   seconds of buffer** (e.g. for this 30-second pause, expect something
   around 90, not exactly 30 — a window that ends exactly at
   `duration_seconds` risks landing entirely in the already-recovered
   period once the seconds of reasoning/tool-call time between the fault
   reverting and this call are accounted for). Separately, call
   `observe_impact` yourself with those same arguments (predicted_severity
   `"hard"`, affected_routes `["/products"]`, and a similarly buffered
   window_seconds) and compare: the agent's closing report should state the
   same real `observedSeverity` and `verdict` your direct call returns, not
   just a repeat of what `predict_blast_radius` predicted earlier. If the
   agent skips calling `observe_impact` when it does apply, passes a
   `window_seconds` with no buffer, or its closing report only restates the
   prediction instead of a real observed outcome, the wiring from Task 9 of
   the M5 plan (and the C1/C2 fixes on top of it) isn't working.

   Not every fault reaches this branch. If you instead run an experiment
   whose `predict_blast_radius affected` list contains no route-shaped
   targets (e.g. pausing `chaos-grafana`, or `inject_packet_loss` at
   `percent: 0`), confirm the agent does NOT call `observe_impact` at all,
   and instead says plainly that no route-level observation applies to
   that fault.
9. Repeat step 2 asking it to target a container NOT on the allowlist
   (e.g. "pause chaos-mcp-server") — confirm the tool call is rejected and
   the agent reports that clearly rather than retrying or working around
   it.
