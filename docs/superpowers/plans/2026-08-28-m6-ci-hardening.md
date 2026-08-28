# M6: CI Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the project's existing `scripts/verify-*.sh` acceptance scripts and unit test suites into GitHub Actions CI, so the class of regression this session's first-ever live Docker verification found (4 real bugs that survived every prior review and merge) gets caught automatically on every future PR.

**Architecture:** One new workflow file, `.github/workflows/verify.yml`, with 6 parallel jobs on `ubuntu-latest` (Docker + Compose v2 pre-installed, no setup needed): a `unit-tests` matrix job (Docker-free, fast) and 4 live-verification jobs (`verify-m1`, `verify-m2`, `verify-m4`, `verify-m5`), each running its already-existing script against a real Docker daemon. Branch protection requiring all 6 to pass is applied as a separate, explicitly-confirmed final step, only after the workflow has run green on a real PR.

**Tech Stack:** GitHub Actions, `ubuntu-latest` runners (Docker Engine + Compose v2 pre-installed), Node 22 (matching every service's Dockerfile).

**Spec:** `docs/superpowers/specs/2026-08-28-m6-ci-hardening-design.md`

## Global Constraints

- Trigger: every `pull_request` (any target) and every `push` to `main`.
- Concurrency: cancel an in-flight run when a new commit lands on the same PR/branch.
- `verify-m1`, `verify-m2`, `verify-m5` bring up the full stack (`docker compose up -d --build`, no scoping). `verify-m4` scopes to `docker compose up -d --build blast-radius-sandbox` only, matching the script's own existing scoping.
- Timeouts: 15 minutes for `verify-m1`/`verify-m4`, 20 minutes for `verify-m2`/`verify-m5` (covers real sleep-based fault-window timing plus build overhead).
- On failure, each live-verification job uploads `docker compose logs` as a build artifact, named uniquely per job (artifact names must be unique within a workflow run).
- `unit-tests` runs `npm ci && npm test` in each of `services/mcp-server`, `services/blast-radius-sandbox`, `services/metrics-watcher` (NOT `services/checkout-api` — it has no test suite; NOT M3's agent verification — that needs a live TrueForge instance, out of reach for CI).
- No changes to the acceptance scripts or unit tests themselves unless a real CI-environment issue is discovered during Task 1's verification (Non-goal: no redesigning working scripts).
- Branch protection is a separate, explicitly-confirmed step — never applied automatically, and only after the workflow's job names exist from a real run (GitHub can't reference job IDs that have never executed).

---

## Task 1: Write the CI workflow file

**Files:**
- Create: `.github/workflows/verify.yml`

**Interfaces:**
- Produces: 6 named CI jobs (`unit-tests`, `verify-m1`, `verify-m2`, `verify-m4`, `verify-m5`) that the Final Step references by name when configuring branch protection.

This is a config-only task — no TDD in the code sense, but the deliverable must be locally syntax-validated before commit (a GitHub Actions workflow can't be run locally end-to-end, so local validation catches YAML/schema mistakes before the Final Step's live PR run does).

- [ ] **Step 1: Write `.github/workflows/verify.yml`**

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
    defaults:
      run:
        working-directory: services/${{ matrix.service }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - run: npm test

  verify-m1:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - run: bash scripts/verify-m1.sh
      - name: Dump docker compose logs
        if: failure()
        run: docker compose logs > compose-logs-verify-m1.txt
      - name: Upload logs
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: compose-logs-verify-m1
          path: compose-logs-verify-m1.txt

  verify-m2:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
      - run: bash scripts/verify-m2.sh
      - name: Dump docker compose logs
        if: failure()
        run: docker compose logs > compose-logs-verify-m2.txt
      - name: Upload logs
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: compose-logs-verify-m2
          path: compose-logs-verify-m2.txt

  verify-m4:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - run: bash scripts/verify-m4.sh
      - name: Dump docker compose logs
        if: failure()
        run: docker compose logs > compose-logs-verify-m4.txt
      - name: Upload logs
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: compose-logs-verify-m4
          path: compose-logs-verify-m4.txt

  verify-m5:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
      - run: bash scripts/verify-m5.sh
      - name: Dump docker compose logs
        if: failure()
        run: docker compose logs > compose-logs-verify-m5.txt
      - name: Upload logs
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: compose-logs-verify-m5
          path: compose-logs-verify-m5.txt
```

Note: `verify-m4`'s own script (`scripts/verify-m4.sh`) already runs `docker compose up -d --build blast-radius-sandbox` internally (scoped, not the full stack) — the workflow step doesn't need to scope anything itself, it just invokes the script exactly like the other three.

- [ ] **Step 2: Validate the YAML locally**

Run: `node -e "const yaml = require('js-yaml'); yaml.load(require('fs').readFileSync('.github/workflows/verify.yml', 'utf8')); console.log('valid YAML')"`

If `js-yaml` isn't installed anywhere in this repo (check `npm ls js-yaml` in any service directory, or just check for a global install), use Python instead, which is already used elsewhere in this repo's scripts:

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/verify.yml')); print('valid YAML')"`

Expected: `valid YAML`, no exceptions. If neither `js-yaml` nor Python's `yaml` module is available, install PyYAML fresh: `pip install pyyaml` (or `python3 -m pip install pyyaml` if needed), then re-run the validation command above.

- [ ] **Step 3: Sanity-check the workflow structure against GitHub Actions' schema conventions**

There's no way to fully execute this workflow locally (it needs GitHub's own runner environment), so a careful manual review substitutes for a test run here — re-read the file once against this checklist:
- Every `uses:` action reference has an explicit version tag (`@v4`) — never an unpinned action.
- Every job that references `${{ matrix.service }}` is inside a job that actually declares that matrix.
- Artifact names (`compose-logs-verify-m1` through `compose-logs-verify-m5`) are unique — no two jobs upload an artifact with the same name.
- Indentation is consistent 2-space throughout (a common source of subtle YAML bugs).

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/verify.yml
git commit -m "ci: add GitHub Actions workflow running unit tests and live acceptance scripts"
```

---

## Final Step: Verify the workflow on a real PR, then apply branch protection

This step cannot be fully automated the way a normal SDD task loop works — GitHub Actions only runs on pushed commits, so "testing" this task means pushing a branch, opening a real PR, and watching (or polling) the Actions run to completion. Do this directly (not as a dispatched subagent task) since it requires live interaction with GitHub's API/UI across a real wait of up to ~20 minutes for the slowest jobs.

- [ ] **Step 1: Push the branch and open a PR**

```bash
git push -u origin feat/m6-ci-hardening
gh pr create --base main --head feat/m6-ci-hardening --title "M6: CI hardening" --body "Wires scripts/verify-*.sh and unit test suites into GitHub Actions, so this session's first-ever live Docker verification (which found 4 real bugs surviving every prior review and merge) becomes an automatic, permanent check instead of a one-time manual pass."
```

- [ ] **Step 2: Watch the workflow run to completion**

Use `gh pr checks <PR-number> --watch` or repeatedly check `gh run list --branch feat/m6-ci-hardening` until all 6 jobs report a final status. Expect this to take up to ~20 minutes (the slowest jobs, `verify-m2`/`verify-m5`, have a 20-minute ceiling).

- [ ] **Step 3: If any job fails, diagnose and fix**

Download the failure's uploaded log artifact (`gh run download <run-id> -n compose-logs-verify-mN`) if the failure isn't self-explanatory from the job's own console output (`gh run view <run-id> --log-failed`). Common first-run CI-specific issues to watch for, given this workflow has never run on GitHub's infrastructure before:
- A script assuming a tool that's on the WSL/local dev machine's `PATH` but not on `ubuntu-latest` by default (check `python3`, `curl`, `wget`, `psql` client — this repo's scripts already avoided needing a local `psql` client by using `docker exec`, so this is a lower risk, but verify).
- GitHub-hosted runners' Docker networking or resource limits (CPU/memory) being tighter than this session's WSL environment, causing a timing-sensitive assertion (e.g. a fault-window's error-rate threshold) to come in lower than expected under first-time image-pull-plus-build overhead. If this happens, widen the specific timing margin that's flaky (e.g. add a few more seconds to a `sleep` or a `window_seconds` value) — matching this project's established discipline of fixing the acceptance test's own margins, not disabling or skipping the check.

Push fixes as new commits on the same branch; `gh pr checks --watch` picks up the new run automatically. Repeat until all 6 jobs pass.

- [ ] **Step 4: Deliberately verify the CI actually catches regressions**

Prove the workflow isn't just green by accident — on the same branch, make one throwaway commit that reintroduces a trivial, obviously-wrong version of one of this session's real found bugs (e.g. temporarily change `services/mcp-server/Dockerfile`'s `FROM gaiaadm/pumba:1.2.1 AS pumba` back to the known-broken `FROM gaiaadm/pumba:0.10.5 AS pumba`), push it, and confirm the relevant job (`verify-m2`, since it needs `mcp-server` to build) goes red. Then immediately revert that commit (`git revert <sha>`) and push again, confirming the job goes green once more. This is the acceptance criterion that proves the CI has real teeth, not just that it runs.

- [ ] **Step 5: Get the branch merged**

Once all 6 jobs are green (post-revert), this is a normal PR ready to merge. Note: since this PR's own required-status-checks aren't configured as required yet (that's the next step, and can't be configured before this PR's jobs exist to reference), merging doesn't yet block on CI — but all 6 should still be green before merging, as the actual proof this milestone works. Use the `superpowers:finishing-a-development-branch` skill's menu to decide push-vs-merge-vs-keep (though the branch is already pushed with an open PR at this point — the skill's menu still applies for the merge decision itself). Given this project's established pattern (every prior milestone), the expected choice is "push and create a PR" — already done in Step 1, so proceed straight to confirming merge readiness and asking the user whether to merge now.

- [ ] **Step 6: Apply branch protection — STOP and confirm with the user first**

This is a repo-wide setting affecting everyone's ability to merge into `main`, not a normal code change — explicitly present this step to the user and get their go-ahead before running it, even though the spec and this plan already establish the intent. Once confirmed:

Array fields nested inside `required_status_checks` are unreliable to set via `gh api -f`'s bracket-array syntax — use a JSON payload instead, piped in via stdin, for a reliable request body:

```bash
cat <<'EOF' | gh api repos/mikelord007/Chaos_Notary/branches/main/protection --method PUT --input -
{
  "required_status_checks": {
    "strict": true,
    "contexts": [
      "unit-tests (mcp-server)",
      "unit-tests (blast-radius-sandbox)",
      "unit-tests (metrics-watcher)",
      "verify-m1",
      "verify-m2",
      "verify-m4",
      "verify-m5"
    ]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": null,
  "restrictions": null
}
EOF
```

Note: the `unit-tests` matrix job reports as three separate check contexts (one per matrix value, in the form `unit-tests (mcp-server)` etc.) — verify the exact context names GitHub actually used by checking `gh pr checks <PR-number>`'s output from Step 2/3 before running this command, and adjust the `contexts` list in the JSON above to match exactly what was observed (matrix job context naming can vary by GitHub Actions version/configuration, so confirm against the real run rather than assuming).

After applying, verify it took effect: `gh api repos/mikelord007/Chaos_Notary/branches/main/protection` and confirm the response lists all 7 contexts (3 matrix + 4 live-verification) under `required_status_checks.contexts`.

- [ ] **Step 7: Update the root README**

Add a line to the README (in the "Automated acceptance test" section, or a new short "Continuous Integration" subsection right after it) noting that `scripts/verify-m1.sh`/`verify-m2.sh`/`verify-m4.sh`/`verify-m5.sh` and each service's unit tests now run automatically on every PR via GitHub Actions (linking to the workflow file), and that `main` is protected by these checks. Update the M6 status line from "not yet built" to "done."

```bash
git add README.md
git commit -m "README: document M6 CI hardening"
git push
```
