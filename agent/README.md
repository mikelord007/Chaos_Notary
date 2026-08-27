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
   step 4 below (in "Manually verifying the approval gate") actually
   confirms the approval prompt fires before the tool executes.

2. **Load the manifest.** Via TrueForge's Agent Playground (paste/import
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
3. Confirm the agent calls `list_targets` first, then states its intent
   (which container, how long, what it expects) before proposing
   `pause_container` — this order matches the manifest's own "How to run
   an experiment" instructions (list_targets, then state intent, then
   propose the call).
4. **Confirm the approval prompt fires before the tool call executes** —
   this is the core thing being verified. If `pause_container` runs
   without a prompt, the manifest's `require_approval_for_tools` isn't
   wired correctly; check the Connector registration and the manifest's
   `mcp_servers[0].name` match.
5. Approve it. Confirm the agent points you at
   `http://localhost:3001/d/chaos-notary` to watch the effect, rather than
   claiming to have checked it itself.
6. After 30+ seconds, ask the agent to confirm the container recovered.
   Confirm it calls `list_targets` again and reports the container's
   Docker status as running with no active fault — not "healthy," since
   `list_targets` has no application-health signal to report (only Docker
   status and fault-registry state). Check the Grafana dashboard yourself
   for actual workload recovery.
7. Repeat step 2 asking it to target a container NOT on the allowlist
   (e.g. "pause chaos-mcp-server") — confirm the tool call is rejected and
   the agent reports that clearly rather than retrying or working around
   it.
