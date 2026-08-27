#!/usr/bin/env bash
# M2 acceptance test. Run from the repo root inside WSL:
#   bash scripts/verify-m2.sh
#
# Asserts, with real numbers pulled from Prometheus and Docker (not a visual
# check):
#   1. stack (including mcp-server) comes up healthy
#   2. list_targets reports every allowlisted container as running
#   3. pause_container drives error rate up, same as M1's manual pause
#   4. the fault auto-reverts on its own — nothing calls clear_fault
#   5. a non-allowlisted target is rejected without touching Docker
#   6. a second pause on an already-faulted target is rejected as a conflict
set -euo pipefail

PROM_URL="http://localhost:9090"
API_URL="http://localhost:3000"
MCP_URL="http://localhost:3100"

call() {
  docker compose exec -T mcp-server node dist/cliCall.js "$1" "${2:-{}}"
}

prom_query() {
  curl -s --max-time 5 "${PROM_URL}/api/v1/query" --data-urlencode "query=$1" \
    | python3 -c '
import json, sys
data = json.load(sys.stdin)
result = data.get("data", {}).get("result", [])
print(result[0]["value"][1] if result else "0")
'
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

echo "== list_targets: expect all 5 running, no active faults =="
targets=$(call list_targets)
echo "$targets"
python3 -c "
import json, sys
result = json.loads('''$targets''')
items = json.loads(result['content'][0]['text'])
assert len(items) == 5, f'expected 5 targets, got {len(items)}'
for item in items:
    assert item['dockerStatus'] == 'running', f\"{item['container']} is {item['dockerStatus']}\"
    assert item['fault'] is None, f\"{item['container']} has an unexpected active fault\"
print('OK: all 5 targets running, no faults')
"

echo "== settling for baseline (60s) =="
sleep 60
baseline=$(prom_query '100 * (sum(rate(http_requests_total{status=~"5.."}[1m])) or vector(0)) / sum(rate(http_requests_total[1m]))')
echo "baseline error rate: ${baseline}%"
python3 -c "assert float('$baseline') < 1.0, 'baseline error rate too high'"

echo "== pause_container(chaos-pg-replica, 30s) via MCP =="
call pause_container '{"container":"chaos-pg-replica","duration_seconds":30}'
sleep 30
faulted=$(prom_query '100 * (sum(rate(http_requests_total{status=~"5.."}[1m])) or vector(0)) / sum(rate(http_requests_total[1m]))')
echo "error rate during fault: ${faulted}%"
python3 -c "assert float('$faulted') > 40.0, 'fault did not raise error rate enough'"

echo "== waiting for auto-revert (no clear_fault call) =="
sleep 30
recovered=$(prom_query '100 * (sum(rate(http_requests_total{status=~"5.."}[1m])) or vector(0)) / sum(rate(http_requests_total[1m]))')
echo "error rate after auto-revert: ${recovered}%"
python3 -c "assert float('$recovered') < 1.0, 'error rate did not recover after auto-revert'"

status=$(call list_targets)
python3 -c "
import json
result = json.loads('''$status''')
items = json.loads(result['content'][0]['text'])
replica = next(i for i in items if i['container'] == 'chaos-pg-replica')
assert replica['dockerStatus'] == 'running', f\"expected running, got {replica['dockerStatus']}\"
assert replica['fault'] is None, 'fault still active after it should have auto-reverted'
print('OK: chaos-pg-replica back to running with no active fault')
"

echo "== rejecting a non-allowlisted target =="
set +e
rejected=$(call pause_container '{"container":"chaos-mcp-server","duration_seconds":30}' 2>&1)
rc=$?
set -e
[ "$rc" -ne 0 ] || { echo "FAIL: expected pause_container on chaos-mcp-server to fail"; exit 1; }
echo "OK: non-allowlisted target rejected ($rejected)"

echo "== rejecting a conflicting second fault =="
call pause_container '{"container":"chaos-checkout-api","duration_seconds":30}'
set +e
conflict=$(call pause_container '{"container":"chaos-checkout-api","duration_seconds":30}' 2>&1)
rc=$?
set -e
call clear_fault '{"container":"chaos-checkout-api"}' >/dev/null
[ "$rc" -ne 0 ] || { echo "FAIL: expected the second pause_container call to be rejected as a conflict"; exit 1; }
echo "OK: conflicting fault rejected ($conflict)"

echo "== M2 ACCEPTANCE TEST PASSED =="
