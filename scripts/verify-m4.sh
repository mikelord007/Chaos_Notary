#!/usr/bin/env bash
# M4 acceptance test. Run from the repo root inside WSL:
#   bash scripts/verify-m4.sh
#
# Unlike verify-m1.sh/verify-m2.sh, this service has no live infrastructure
# to react to — it's a static computation. The acceptance test is about
# correctness of the topology model and the allowlist staying in sync with
# M2's, not about watching real containers fail and recover.
set -euo pipefail

echo "== allowlist cross-check: blast-radius-sandbox vs mcp-server =="
extract_allowlist() {
  grep -A6 'ALLOWED_CONTAINERS = \[' "$1" | grep '"chaos-' | tr -d ' ",' | sort
}
sandbox_list=$(extract_allowlist services/blast-radius-sandbox/src/allowlist.ts)
mcp_list=$(extract_allowlist services/mcp-server/src/allowlist.ts)
if [ "$sandbox_list" = "$mcp_list" ]; then
  echo "OK: allowlists match"
else
  echo "FAIL: allowlists differ"
  echo "blast-radius-sandbox:"
  echo "$sandbox_list"
  echo "mcp-server:"
  echo "$mcp_list"
  exit 1
fi

echo "== bringing up stack =="
docker compose up -d --build

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

wait_for "blast-radius-sandbox healthy" "curl -sf http://localhost:3200/health"

call() {
  docker compose exec -T blast-radius-sandbox node dist/cliCall.js "$1" "${2:-{}}"
}

echo "== predict_blast_radius(chaos-pg-replica, pause): expect GET /products affected, POST /orders unaffected =="
result=$(call predict_blast_radius '{"container":"chaos-pg-replica","fault_kind":"pause"}')
echo "$result"
python3 -c "
import json
result = json.loads('''$result''')
prediction = json.loads(result['content'][0]['text'])
assert prediction['severity'] == 'hard', f\"expected hard, got {prediction['severity']}\"
assert any(i['target'] == 'GET /products' for i in prediction['affected']), 'GET /products not in affected'
assert any('POST /orders' in u for u in prediction['unaffected']), 'POST /orders not in unaffected'
print('OK: chaos-pg-replica pause prediction correct')
"

echo "== predict_blast_radius(chaos-pg-primary, pause): expect POST /orders affected, GET /products unaffected =="
result=$(call predict_blast_radius '{"container":"chaos-pg-primary","fault_kind":"pause"}')
echo "$result"
python3 -c "
import json
result = json.loads('''$result''')
prediction = json.loads(result['content'][0]['text'])
assert prediction['severity'] == 'hard', f\"expected hard, got {prediction['severity']}\"
assert any(i['target'] == 'POST /orders' for i in prediction['affected']), 'POST /orders not in affected'
assert any('GET /products' in u for u in prediction['unaffected']), 'GET /products not in unaffected'
print('OK: chaos-pg-primary pause prediction correct')
"

echo "== predict_blast_radius severity threshold: latency below vs at/above 2000ms =="
below=$(call predict_blast_radius '{"container":"chaos-pg-replica","fault_kind":"inject_latency","latency_ms":100}')
above=$(call predict_blast_radius '{"container":"chaos-pg-replica","fault_kind":"inject_latency","latency_ms":3000}')
python3 -c "
import json
below_pred = json.loads(json.loads('''$below''')['content'][0]['text'])
above_pred = json.loads(json.loads('''$above''')['content'][0]['text'])
assert below_pred['severity'] == 'degraded', f\"expected degraded for 100ms, got {below_pred['severity']}\"
assert above_pred['severity'] == 'hard', f\"expected hard for 3000ms, got {above_pred['severity']}\"
print('OK: latency threshold behaves correctly')
"

echo "== predict_blast_radius rejects a non-allowlisted container =="
set +e
rejected=$(call predict_blast_radius '{"container":"chaos-mcp-server","fault_kind":"pause"}' 2>&1)
rc=$?
set -e
[ "$rc" -ne 0 ] || { echo "FAIL: expected predict_blast_radius on chaos-mcp-server to be rejected"; exit 1; }
echo "OK: non-allowlisted container rejected ($rejected)"

echo "== M4 ACCEPTANCE TEST PASSED =="
