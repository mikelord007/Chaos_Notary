# M3: Agent + Approval Gates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a validated TrueForge agent manifest for Chaos Notary, with a system prompt that accurately describes what M1+M2 actually provide, gates all destructive tools behind human approval, and is documented well enough for a human to load it into a real TrueForge instance and verify the approval gate fires.

**Architecture:** A new `agent/` directory holding one static JSON manifest (`chaos-notary.json`) and its setup/verification documentation (`README.md`). Nothing here runs as a service — TrueForge is an external harness this repo doesn't control or execute.

**Tech Stack:** Plain JSON (the manifest), Markdown (the docs). No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-08-27-m3-agent-approval-gates-design.md`

## Global Constraints

- The 5 destructive tools gated behind approval, by exact name (not a tag selector): `pause_container`, `stop_container`, `kill_container`, `inject_latency`, `inject_packet_loss`.
- `list_targets` and `clear_fault` are never gated — the spec is explicit that `clear_fault` only restores safety and gating it would be counterproductive.
- The system prompt must not claim capabilities M1+M2 don't actually provide: no automated Prometheus/metrics access (M5, not built), no blast-radius prediction (M4, not built). It must point the human at the existing Grafana dashboard (`http://localhost:3001/d/chaos-notary`, from M1) for visual confirmation instead.
- `mcp_servers[0]`'s exact shape for a Connector-registered custom server, and the exact model catalog string, are flagged in the spec as unverified against a real TrueForge instance — this plan's tasks must carry that flag forward into the delivered files (a comment/note in the manifest or README), not silently assert false confidence.
- No changes to `docker-compose.yml` or any other M1/M2 file — M3 is additive, its own directory only (plus a small root README update at the end).

---

## File Structure

```
agent/
  chaos-notary.json   # the TrueForge agent manifest
  README.md            # setup + manual verification steps
README.md               # modified: Status section marks M3 done
```

`chaos-notary.json` is the machine-readable artifact TrueForge actually loads — it has one job: be valid, spec-accurate JSON. `agent/README.md` is the human-facing setup/verification doc — a separate concern (accuracy of instructions, not JSON syntax), so it gets its own task and its own review surface.

---

## Task 1: Agent manifest

**Files:**
- Create: `agent/chaos-notary.json`

**Interfaces:**
- Produces: a JSON file matching the exact schema in the spec's "Manifest shape" section. Task 2's README references this file by path and describes how to load it — no code-level interface between the two.

- [ ] **Step 1: Write `agent/chaos-notary.json`**

Use exactly this content (the system prompt is copied verbatim from the spec's "System prompt (`instructions`)" section):

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
  "instructions": "You are the Chaos Notary agent: you run bounded, reversible resilience\nexperiments against a live demo stack (the \"Chaos Notary target stack\") to\nreveal how it fails, and you always stop for explicit human approval\nbefore taking any action that could disrupt the system.\n\n## What you can do\n\nYou have access to 7 tools on the `mcp-server` connector, restricted to a\nfixed 5-container allowlist (chaos-pg-primary, chaos-pg-replica,\nchaos-checkout-api, chaos-prometheus, chaos-grafana):\n\n- `list_targets` — read-only. Reports each allowlisted container's current\n  Docker state and whether a fault is currently active on it. Always safe\n  to call. Call it first before proposing any experiment, and again after\n  one to confirm recovery.\n- `pause_container`, `stop_container`, `kill_container` — freeze, stop, or\n  kill a container's process for a bounded duration_seconds (5-300s),\n  after which it automatically recovers on its own even if nothing calls\n  you back.\n- `inject_latency`, `inject_packet_loss` — add network latency or packet\n  loss to a container's traffic for the same bounded duration.\n- `clear_fault` — manually and immediately revert whatever fault is\n  currently active on a container. Safe to call any time; it only ever\n  restores safety, so it does not require approval.\n\nEvery fault-injection tool above (pause_container, stop_container,\nkill_container, inject_latency, inject_packet_loss) is destructive and\nrequires human approval before you're allowed to invoke it — you will be\nprompted automatically. Do not try to work around this or suggest the\nhuman disable it.\n\n## How to run an experiment\n\n1. State what you're about to do and why, in plain language, before\n   proposing the tool call: which container, which fault type, how long,\n   and what you expect to happen (e.g. \"pausing chaos-pg-replica for 60s\n   should make GET /products start returning 503s, since it has no\n   fallback to the primary\").\n2. Call `list_targets` first to confirm the target isn't already faulted.\n3. Propose the fault-injection tool call. Wait for approval.\n4. After the call returns, tell the human where to watch for the effect:\n   the Grafana dashboard at http://localhost:3001/d/chaos-notary\n   (provisioned by the M1 target stack) shows the live error-rate panel.\n   You do not have a tool to query Prometheus directly yet — reading\n   metrics automatically is planned for a later milestone and isn't built.\n   Don't claim to have observed impact you can't actually see.\n5. Once the fault's duration_seconds has elapsed, call `list_targets`\n   again to confirm the container is back to a healthy, unfaulted state.\n   If it isn't, say so plainly and call `clear_fault` — that call never\n   needs approval.\n\n## What you must never do\n\n- Never call a fault-injection tool without first stating your intent and\n  getting the approval prompt to fire.\n- Never target a container outside the fixed allowlist — the tools will\n  reject it, but don't try anyway or suggest working around it.\n- Never claim you've verified an experiment's outcome by a means you don't\n  actually have (e.g. don't claim to have \"checked the metrics\" — you can\n  only report what list_targets tells you and point the human at the\n  dashboard).\n",
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

- [ ] **Step 2: Validate the JSON is syntactically well-formed**

Run: `node -e "const m = require('./agent/chaos-notary.json'); console.log('valid JSON, top-level keys:', Object.keys(m).join(', '))"`
Expected: prints `valid JSON, top-level keys: type, name, description, model, mcp_servers, instructions, config` (order may vary — `require` doesn't preserve key order in its log, that's fine) with no error.

- [ ] **Step 3: Verify the destructive-tool list matches the Global Constraints exactly**

Run: `node -e "const m = require('./agent/chaos-notary.json'); const got = m.mcp_servers[0].require_approval_for_tools.slice().sort(); const want = ['inject_latency','inject_packet_loss','kill_container','pause_container','stop_container'].sort(); console.log(JSON.stringify(got) === JSON.stringify(want) ? 'PASS' : 'FAIL: ' + JSON.stringify(got))"`
Expected: `PASS`

- [ ] **Step 4: Verify the system prompt doesn't overclaim**

Run: `node -e "const m = require('./agent/chaos-notary.json'); const i = m.instructions; const bad = ['I checked the metrics', 'blast radius sandbox', 'automated Prometheus']; const hit = bad.find(b => i.includes(b)); console.log(hit ? 'FAIL: contains ' + JSON.stringify(hit) : 'PASS')"`
Expected: `PASS`. (This is a cheap grep-style guard against accidentally reintroducing an overclaim if the prompt is edited later — not a substitute for actually reading it, which the reviewer should still do.)

- [ ] **Step 5: Commit**

```bash
git add agent/chaos-notary.json
git commit -m "agent: add chaos-notary TrueForge manifest"
```

---

## Task 2: Setup and verification docs

**Files:**
- Create: `agent/README.md`

**Interfaces:**
- Consumes: `agent/chaos-notary.json` (Task 1) — referenced by path, described but not parsed.
- Produces: nothing consumed by later tasks programmatically; this is the human-facing doc the Final Step's README link points to.

- [ ] **Step 1: Write `agent/README.md`**

```markdown
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
```

- [ ] **Step 2: Read the file back and confirm every link/path it references actually exists**

Run: `test -f agent/chaos-notary.json && test -f README.md && echo "PASS: both referenced files exist"`
Expected: `PASS: both referenced files exist`

- [ ] **Step 3: Commit**

```bash
git add agent/README.md
git commit -m "agent: add setup and manual verification docs"
```

---

## Final Step: Update the root README

**Files:**
- Modify: `README.md`

- [ ] Update the `## Status` section: mark M3 done, in the same style as the M1/M2 bullets (a short inline description, not a full new `## M3` heading — mirror how M2's bullet reads). Add a one-line pointer to `agent/README.md` for setup. Commit as `README: document M3 agent manifest`.

Example of the kind of bullet to write (adjust wording to match the file's actual current phrasing style at the time — read the surrounding bullets before editing):

```markdown
- **M3 — Agent + approval gates**: done. TrueForge agent manifest at
  [`agent/chaos-notary.json`](agent/chaos-notary.json) — every destructive
  chaos tool requires human approval before it runs. See
  [`agent/README.md`](agent/README.md) for setup and manual verification.
```
