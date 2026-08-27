# M3: Agent + approval gates — design

Status: approved, ready for implementation planning
Date: 2026-08-27

## Purpose

M1 built a target stack with a deliberate resilience gap. M2 built an MCP
server that turns manually-run chaos actions (`docker pause`, etc.) into
typed, bounded, auto-reverting tools. M3 turns that tool surface into an
actual agent: a [TrueForge](https://github.com/truefoundry/trueforge) agent
manifest that can call M2's tools, reasons in plain language about what it's
about to do before doing it, and is *structurally* prevented from taking any
destructive action without a human approving it first — not just asked to
be careful, but gated by the harness itself.

M3 is a manifest and its documentation, not a running service. There is
nothing to add to `docker-compose.yml`; TrueForge runs as its own separate
process (locally via `npx @truefoundry/trueforge`, or a shared deployment
via its own Docker Compose/Helm chart) and reaches `mcp-server` over the
network TrueForge and this stack both have access to.

## Goals

- A validated TrueForge agent manifest (`agent/chaos-notary.json`) that:
  - Declares a system prompt describing the agent's role, its available
    tools, how to run an experiment, and what it must never do.
  - References the M2 `mcp-server` MCP connector.
  - Gates all 5 destructive tools (`pause_container`, `stop_container`,
    `kill_container`, `inject_latency`, `inject_packet_loss`) behind
    TrueForge's `require_approval_for_tools`, by explicit tool name (not a
    tag selector — M2's tools don't declare MCP annotations, and adding
    them is out of scope for this milestone; see Non-goals).
  - Bounds the agent's own runtime (`iteration_limit`, `timeout_seconds`)
    so a single run can't loop indefinitely even before any approval gate
    is reached.
- Documentation (`agent/README.md`) covering the one step this repo cannot
  automate — registering `mcp-server` as a Connector in TrueForge's
  Settings UI — plus how to load the manifest and manually verify the
  approval gate actually fires.

## Non-goals

- Adding MCP tool annotations (`readOnlyHint`, `destructiveHint`) to M2's
  `tools.ts` and switching to a `@destructive` tag selector. The explicit
  tool-name list is simpler, has no dependency on getting annotations
  exactly right, and doesn't require touching already-merged, twice-review
  M2 code for this milestone. (A reasonable follow-up once M2's tool
  surface stabilizes further, not required now.)
- Blast-radius prediction before acting. (M4.)
- Automated metrics observation (querying Prometheus, reading a live error
  rate) as part of the agent's own tool access. (M5 — a metrics-watcher
  subagent.) The system prompt is explicit with the agent that it cannot
  do this yet and must not claim to.
- Running TrueForge itself and exercising the manifest end-to-end in this
  environment. Verification is manual, by the user, against a real
  TrueForge instance (see Testing).
- Any new service in `docker-compose.yml`. TrueForge is external to this
  stack.

## Architecture

### File structure

```
agent/
  chaos-notary.json   # the TrueForge agent manifest
  README.md            # setup + manual verification steps
```

### Manifest shape

Per TrueForge's documented agent-manifest schema (`type`, `name`,
`description`, `model`, `instructions`, `mcp_servers[]`, `config`):

```json
{
  "type": "truefoundry-agent",
  "name": "chaos-notary",
  "description": "Runs bounded, reversible chaos experiments against the Chaos Notary target stack, gated by human approval before any destructive action.",
  "model": {
    "name": "anthropic/claude-sonnet-5",
    "params": {
      "max_tokens": 4096,
      "temperature": 0.3
    }
  },
  "instructions": "<see System prompt below>",
  "mcp_servers": [
    {
      "name": "mcp-server",
      "enable_tools": ["@all"],
      "require_approval_for_tools": [
        "pause_container",
        "stop_container",
        "kill_container",
        "inject_latency",
        "inject_packet_loss"
      ]
    }
  ],
  "config": {
    "iteration_limit": 15,
    "timeout_seconds": 600
  }
}
```

`temperature: 0.3` is a deliberate choice, not TrueForge's default — this
agent's job is careful, explainable action, not creative variation.
`iteration_limit`/`timeout_seconds` are a second, independent bound on
runaway behavior, ahead of and separate from the per-tool approval gate.

**Unverified against a real TrueForge instance** (documented here rather
than guessed at with false confidence, in the same spirit as M2's Pumba
flag verification):
- The exact `mcp_servers[]` entry shape for a Connector-registered custom
  server (as opposed to `type: "truefoundry-mcp-registry"`, which is for
  TrueFoundry's own catalog, not a self-hosted server). Available
  documentation confirms *that* a custom server is referenced by name
  after being registered as a Connector, but not the precise field name/
  value TrueForge expects in that case. The implementation plan should
  include a step to check this against the actual TrueForge UI/docs when
  registering the connector, and adjust the manifest's `mcp_servers[0]`
  shape if it differs from the placeholder above.
- The exact model catalog string for Claude Sonnet 5 in TrueForge's model
  selector, if it differs from `anthropic/claude-sonnet-5`.

### System prompt (`instructions`)

```
You are the Chaos Notary agent: you run bounded, reversible resilience
experiments against a live demo stack (the "Chaos Notary target stack") to
reveal how it fails, and you always stop for explicit human approval
before taking any action that could disrupt the system.

## What you can do

You have access to 7 tools on the `mcp-server` connector, restricted to a
fixed 5-container allowlist (chaos-pg-primary, chaos-pg-replica,
chaos-checkout-api, chaos-prometheus, chaos-grafana):

- `list_targets` — read-only. Reports each allowlisted container's current
  Docker state and whether a fault is currently active on it. Always safe
  to call. Call it first before proposing any experiment, and again after
  one to confirm recovery.
- `pause_container`, `stop_container`, `kill_container` — freeze, stop, or
  kill a container's process for a bounded duration_seconds (5-300s),
  after which it automatically recovers on its own even if nothing calls
  you back.
- `inject_latency`, `inject_packet_loss` — add network latency or packet
  loss to a container's traffic for the same bounded duration.
- `clear_fault` — manually and immediately revert whatever fault is
  currently active on a container. Safe to call any time; it only ever
  restores safety, so it does not require approval.

Every fault-injection tool above (pause_container, stop_container,
kill_container, inject_latency, inject_packet_loss) is destructive and
requires human approval before you're allowed to invoke it — you will be
prompted automatically. Do not try to work around this or suggest the
human disable it.

## How to run an experiment

1. State what you're about to do and why, in plain language, before
   proposing the tool call: which container, which fault type, how long,
   and what you expect to happen (e.g. "pausing chaos-pg-replica for 60s
   should make GET /products start returning 503s, since it has no
   fallback to the primary").
2. Call `list_targets` first to confirm the target isn't already faulted.
3. Propose the fault-injection tool call. Wait for approval.
4. After the call returns, tell the human where to watch for the effect:
   the Grafana dashboard at http://localhost:3001/d/chaos-notary
   (provisioned by the M1 target stack) shows the live error-rate panel.
   You do not have a tool to query Prometheus directly yet — reading
   metrics automatically is planned for a later milestone and isn't built.
   Don't claim to have observed impact you can't actually see.
5. Once the fault's duration_seconds has elapsed, call `list_targets`
   again to confirm the container is back to a healthy, unfaulted state.
   If it isn't, say so plainly and call `clear_fault` — that call never
   needs approval.

## What you must never do

- Never call a fault-injection tool without first stating your intent and
  getting the approval prompt to fire.
- Never target a container outside the fixed allowlist — the tools will
  reject it, but don't try anyway or suggest working around it.
- Never claim you've verified an experiment's outcome by a means you don't
  actually have (e.g. don't claim to have "checked the metrics" — you can
  only report what list_targets tells you and point the human at the
  dashboard).
```

## Documentation (`agent/README.md`)

Covers, in order:
1. Prerequisite: the M1+M2 stack running (`docker compose up -d --build`),
   and a TrueForge instance running (`npx @truefoundry/trueforge`, or a
   shared deployment) with network access to `localhost:3100` (or wherever
   `mcp-server` is reachable from that instance).
2. Registering `mcp-server` as a Connector in TrueForge's Settings UI,
   pointing at the running server's `/mcp` endpoint — the one manual step
   this repo can't do for you.
3. Loading `agent/chaos-notary.json` into TrueForge (Agent Playground or
   SDK) and saving it to the Agent Registry.
4. A manual verification script: ask the agent to pause `chaos-pg-replica`
   for 30 seconds; confirm the approval prompt fires *before* any tool
   call happens; approve it; confirm the agent reports back correctly and
   that `list_targets` shows recovery once the duration elapses.

## Testing / acceptance criteria

No automated test — TrueForge is external to this repo and this session
has no way to run it. Acceptance is:
- `agent/chaos-notary.json` is valid JSON and matches the schema above.
- The system prompt makes no claim beyond what M1+M2 actually provide
  (no fabricated blast-radius prediction, no fabricated metrics access).
- `agent/README.md`'s manual verification steps are followed by the user
  against a real TrueForge instance before this milestone is considered
  proven, not just written.

## Open questions for the implementation plan

- Confirm the real `mcp_servers[]` entry shape for a Connector-registered
  custom server against TrueForge's actual UI/docs at registration time,
  and adjust the manifest if it differs from the placeholder shape above.
- Confirm the real model catalog string for Claude Sonnet 5 (or the
  model the user actually wants to run this agent on) in TrueForge's
  model selector.
