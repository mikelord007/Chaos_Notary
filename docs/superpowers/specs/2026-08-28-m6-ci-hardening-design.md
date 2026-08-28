# M6: CI hardening — design

Status: approved, ready for implementation planning
Date: 2026-08-28

## Purpose

Every milestone through M5 was built, unit-tested, Qodo-reviewed, and merged
without ever actually running against a live Docker daemon — Docker was
unavailable in the development environment for the entire project. The
moment it became available this session, running the stack for real
immediately surfaced 4 real bugs that had survived every prior review and
merge: a Dockerfile pinning a non-existent image tag (the stack was never
buildable), a healthcheck probing the wrong loopback address (silently
blocking two services from ever starting), an acceptance script missing
required authentication (broken since M1), and a Critical bug in the
MCP transport layer itself (every request after the first failed) that no
unit test could structurally ever catch, since all of them use an
in-process transport pair instead of real repeated HTTP calls.

M6 exists to make sure this class of regression can never resurface
silently again: wire the project's own `scripts/verify-*.sh` acceptance
scripts and unit test suites into GitHub Actions CI, so every PR and every
push to `main` proves the stack actually works, not just that it typechecks
and passes review.

## Goals

- A GitHub Actions workflow, `.github/workflows/verify.yml`, that runs on
  every pull request and every push to `main`.
- Five parallel jobs: `verify-m1`, `verify-m2`, `verify-m4`, `verify-m5`
  (each brings up the relevant part of the stack and runs its script for
  real, against Docker), and `unit-tests` (fast, Docker-free — runs
  `npm test` in each of `services/mcp-server`, `services/blast-radius-sandbox`,
  `services/metrics-watcher`).
- `verify-m1`, `verify-m2`, `verify-m5` bring up the full stack
  (`docker compose up -d --build`, no scoping) since they exercise real
  cross-service traffic, Postgres replication, and MCP tool calls.
  `verify-m4` scopes to `docker compose up -d --build blast-radius-sandbox`
  only, matching the script's own existing scoping (a static computation
  with no live stack dependency).
- Each live-verification job gets a `timeout-minutes` ceiling (15 for
  m1/m4, 20 for m2/m5, covering real sleep-based fault-window timing plus
  build overhead) and uploads `docker compose logs` as a build artifact on
  failure, so a red run is debuggable from the GitHub Actions UI alone.
- A `concurrency` group keyed on the PR/branch, so a new push cancels an
  in-flight run instead of wasting CI minutes on a stale commit.
- Once the workflow is written and verified green on a real PR, apply a
  branch protection rule on `main` requiring all five jobs to pass before
  merge — a separate, explicit, confirmed step (branch protection is a
  repo-wide setting affecting everyone's ability to merge, not something
  to change without a clear go-ahead, and it can't be configured against
  job IDs that don't exist yet).

## Non-goals

- No changes to the acceptance scripts or unit tests themselves — this
  milestone wires already-existing, already-working scripts into CI. If a
  script needs a fix to run cleanly in CI (e.g. an environment assumption
  that doesn't hold on a GitHub-hosted runner), that's an in-scope bug fix
  discovered during implementation, not a redesign of the script.
- No `services/checkout-api` unit-test job — it has no test suite
  currently (`package.json` has no `test` script), and adding one is a
  separate concern from wiring up CI for what already exists.
- No M3 (agent + approval gate) verification in CI — that requires a live
  TrueForge instance and manual interaction, which is out of reach for an
  automated CI job and stays a manual step per `agent/README.md`.
- No deployment, release, or publishing automation — this milestone is
  about verification, not shipping.
- No changes to the project's dev-only credentials, Docker socket mount,
  or other disclosed non-production choices — those remain deliberate
  design decisions for a self-contained demo stack, not gaps this
  milestone closes.

## Architecture

### Workflow structure

```yaml
name: verify
on:
  pull_request:
  push:
    branches: [main]
concurrency:
  group: verify-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true
jobs:
  unit-tests:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        service: [mcp-server, blast-radius-sandbox, metrics-watcher]
    steps:
      - checkout
      - setup-node (matching the Node version each service's Dockerfile uses: 22)
      - npm ci (in services/${{ matrix.service }})
      - npm test (in services/${{ matrix.service }})

  verify-m1:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - checkout
      - bash scripts/verify-m1.sh
      - on failure: upload docker compose logs as an artifact

  verify-m2:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps: [same pattern as verify-m1, running scripts/verify-m2.sh]

  verify-m4:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps: [same pattern, running scripts/verify-m4.sh]

  verify-m5:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps: [same pattern, running scripts/verify-m5.sh]
```

GitHub-hosted `ubuntu-latest` runners ship with Docker Engine and Compose
v2 pre-installed — no setup action needed beyond `actions/checkout@v4`
(and `actions/setup-node@v4` for the unit-tests job, pinned to Node 22 to
match every service's Dockerfile).

### Failure-artifact capture

Each live-verification job's final step (guarded with `if: failure()`)
runs `docker compose logs > compose-logs.txt` and uploads it via
`actions/upload-artifact@v4`, so a red run can be root-caused from the
Actions UI without needing to reproduce it locally — the exact debugging
step that would have shortened this session's own investigation into the
MCP transport-reuse bug.

### Branch protection (separate, confirmed step)

After the workflow is merged and has run green at least once on a real PR
(so the job names exist for GitHub to reference), apply a branch
protection rule on `main`:
`gh api repos/{owner}/{repo}/branches/main/protection` (or the
equivalent `gh ruleset` command) requiring `unit-tests`, `verify-m1`,
`verify-m2`, `verify-m4`, `verify-m5` to pass. This step is explicitly
gated on the user's go-ahead in the implementation plan, not automatic.

## Error handling

- A script failing in CI is not itself an error to "handle" — that's the
  whole point of the job; it should fail loudly and block merge (once
  branch protection is applied).
- Genuine CI-environment flakiness (e.g. a slow runner diluting a real
  fault-window's Prometheus rate calculation below the assertion
  threshold) is a real risk given the scripts' sleep-based timing was
  tuned against this session's actual measured wall-clock behavior, not
  GitHub's runner performance. If this surfaces during implementation
  (a job fails intermittently for a reason unrelated to the code under
  test), the plan's implementer should widen the specific timing margin
  that's flaky, not disable or skip the check — matching this project's
  established discipline of fixing the acceptance test rather than
  working around it.

## Testing / acceptance criteria

1. The workflow file is valid YAML and passes `actionlint` (or GitHub's
   own workflow syntax validation on push) — no unresolved schema errors.
2. Opening a real PR (this milestone's own PR) triggers all 5 jobs.
3. All 5 jobs pass, running the exact same scripts already verified live
   in this session, now inside GitHub's environment instead of this
   session's WSL instance.
4. Deliberately breaking something in a throwaway commit (e.g.
   reintroducing one of the 4 bugs this session found and fixed) and
   confirming the relevant job goes red, then reverting — proves the CI
   actually catches what it's meant to catch, not just that it runs.
5. Branch protection is applied only after all of the above pass, with
   explicit confirmation before applying it.

## Open questions for the implementation plan

None blocking. The workflow's job structure, triggers, and timeout
values are all specified above from the user's own answers during
brainstorming; the plan should transcribe them faithfully.
