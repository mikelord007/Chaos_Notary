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
  `npx @truefoundry/trueforge@latest` (SQLite-backed, single command), or a
  shared deployment. It needs network access to wherever `mcp-server` is
  reachable — `http://localhost:3100` if TrueForge runs on the same host as
  the Docker stack.

## Setup

1. **Register `mcp-server` as a Connector.** In TrueForge's UI, go to
   Settings → Connectors, add a new MCP connector pointing at
   `http://localhost:3100/mcp` (adjust the host if TrueForge isn't running
   on the same machine as the Docker stack), and name it `mcp-server` —
   the manifest's `mcp_servers[0].name` must match whatever you name it
   here.

   **Unverified:** the exact field TrueForge's manifest schema uses to
   reference a Connector-registered (as opposed to catalog) MCP server
   wasn't confirmed against a live TrueForge instance while writing this
   manifest — only that servers are "registered once under Settings →
   Connectors" and "agents reference it by name." If loading the manifest
   in the next step fails with a schema error on `mcp_servers[0]`, check
   TrueForge's current docs/UI for the connector-reference field name and
   adjust `chaos-notary.json` accordingly.

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
   `pause_container`.
4. **Confirm the approval prompt fires before the tool call executes** —
   this is the core thing being verified. If `pause_container` runs
   without a prompt, the manifest's `require_approval_for_tools` isn't
   wired correctly; check the Connector registration and the manifest's
   `mcp_servers[0].name` match.
5. Approve it. Confirm the agent points you at
   `http://localhost:3001/d/chaos-notary` to watch the effect, rather than
   claiming to have checked it itself.
6. After 30+ seconds, ask the agent to confirm the container recovered.
   Confirm it calls `list_targets` again and reports the container as
   healthy with no active fault.
7. Repeat step 2 asking it to target a container NOT on the allowlist
   (e.g. "pause chaos-mcp-server") — confirm the tool call is rejected and
   the agent reports that clearly rather than retrying or working around
   it.
