#!/usr/bin/env bash
# M5 acceptance test. Run from the repo root inside WSL:
#   bash scripts/verify-m5.sh
#
# Verifies observe_impact reports accurate real-world severity against
# live Prometheus data: "none" at baseline, "hard" with a "matched"
# verdict during a real fault, correctly rejects invalid input, and
# confirms metrics-watcher cannot reach mcp-server over the network (the
# same isolation guard M4 added after Qodo caught the equivalent gap for
# blast-radius-sandbox).
set -euo pipefail

API_URL="http://localhost:3000"
MCP_URL="http://localhost:3100"
METRICS_WATCHER_URL="http://localhost:3300"

call_mcp() {
  local args="${2:-}"
  [ -n "$args" ] || args='{}'
  docker compose exec -T mcp-server node dist/cliCall.js "$1" "$args"
}

call_metrics_watcher() {
  local args="${2:-}"
  [ -n "$args" ] || args='{}'
  docker compose exec -T metrics-watcher node dist/cliCall.js "$1" "$args"
}

wait_for() {
  local desc="$1" cmd="$2" tries="${3:-30}"
  for _ in $(seq 1 "$tries"); do
    if eval "$cmd" >/dev/null 2>&1; then
      echo "OK: $desc"
      return 0
    fi
    sleep 2
  done
  echo "FAIL: timed out waiting for $desc"
  exit 1
}

echo "== bringing up stack =="
docker compose up -d --build

wait_for "checkout-api healthy" "curl -sf ${API_URL}/health"
wait_for "mcp-server healthy" "curl -sf ${MCP_URL}/health"
wait_for "metrics-watcher healthy" "curl -sf ${METRICS_WATCHER_URL}/health"

echo "== settling for baseline traffic (60s) =="
sleep 60

echo "== observe_impact at baseline: expect observedSeverity none =="
baseline=$(call_metrics_watcher observe_impact '{"predicted_severity":"degraded","affected_routes":["/products"],"window_seconds":60}')
echo "$baseline"
printf '%s' "$baseline" | python3 -c "
import json, sys
result = json.load(sys.stdin)
observation = json.loads(result['content'][0]['text'])
assert observation['observedSeverity'] == 'none', f\"expected none, got {observation['observedSeverity']}\"
print('OK: baseline observed severity is none')
"

echo "== pause_container(chaos-pg-replica, 90s) via MCP =="
call_mcp pause_container '{"container":"chaos-pg-replica","duration_seconds":90}'
# Sleep a full minute so the 60s query window sits entirely inside the
# fault period (same lesson as verify-m1.sh/verify-m2.sh: a partial window
# dilutes the error rate below the assertion threshold even when the fault
# is working correctly).
sleep 60

echo "== observe_impact during fault: expect observedSeverity hard, verdict matched =="
faulted=$(call_metrics_watcher observe_impact '{"predicted_severity":"hard","affected_routes":["/products"],"window_seconds":60}')
echo "$faulted"
printf '%s' "$faulted" | python3 -c "
import json, sys
result = json.load(sys.stdin)
observation = json.loads(result['content'][0]['text'])
assert observation['observedSeverity'] == 'hard', f\"expected hard, got {observation['observedSeverity']}\"
assert observation['verdict'] == 'matched', f\"expected matched, got {observation['verdict']}\"
print('OK: fault-window observed severity is hard, verdict matched')
"

echo "== waiting for auto-revert (duration_seconds=90 must elapse on its own) =="
sleep 90

echo "== observe_impact rejects empty affected_routes =="
set +e
rejected=$(call_metrics_watcher observe_impact '{"predicted_severity":"hard","affected_routes":[],"window_seconds":60}' 2>&1)
rc=$?
set -e
[ "$rc" -ne 0 ] || { echo "FAIL: expected empty affected_routes to be rejected"; exit 1; }
echo "OK: empty affected_routes rejected ($rejected)"

echo "== network isolation: metrics-watcher cannot reach mcp-server =="
set +e
docker compose exec -T metrics-watcher wget -q --timeout=5 --spider http://mcp-server:3100/health
rc=$?
set -e
[ "$rc" -ne 0 ] || { echo "FAIL: metrics-watcher could reach mcp-server — network isolation broken"; exit 1; }
echo "OK: metrics-watcher cannot reach mcp-server"

echo "== M5 ACCEPTANCE TEST PASSED =="
