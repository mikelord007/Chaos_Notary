#!/usr/bin/env bash
# M1 acceptance test. Run from the repo root inside WSL:
#   bash scripts/verify-m1.sh
#
# Asserts, with real numbers pulled from Prometheus (not a visual check):
#   1. stack comes up healthy and replication is live
#   2. baseline error rate is near zero
#   3. pausing pg-replica drives error rate well above baseline within 60s
#   4. unpausing pg-replica recovers error rate to baseline within 60s
set -euo pipefail

PROM_URL="http://localhost:9090"
API_URL="http://localhost:3000"

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
wait_for "replication live" \
  "docker exec chaos-pg-primary psql -U checkout -d checkout -tAc 'select count(*) from pg_stat_replication' | grep -q '^1$'"

echo "== smoke-testing routes =="
curl -sf "${API_URL}/products" | grep -q '"name"' || { echo "FAIL: /products did not return rows"; exit 1; }
status=$(curl -s -o /dev/null -w '%{http_code}' -X POST "${API_URL}/orders" \
  -H 'content-type: application/json' -d '{"productId":1,"quantity":1}')
[ "$status" = "201" ] || { echo "FAIL: POST /orders returned $status"; exit 1; }
echo "OK: /products and /orders smoke-tested"

echo "== settling for baseline (60s) =="
sleep 60
baseline=$(prom_query '100 * (sum(rate(http_requests_total{status=~"5.."}[1m])) or vector(0)) / sum(rate(http_requests_total[1m]))')
echo "baseline error rate: ${baseline}%"
python3 -c "assert float('$baseline') < 1.0, 'baseline error rate too high'" \
  || { echo "FAIL: baseline error rate ${baseline}% >= 1%"; exit 1; }

echo "== pausing pg-replica =="
docker pause chaos-pg-replica
# Safety net: if anything below fails/exits before the explicit unpause,
# don't leave the stack permanently faulted for the next run.
trap 'docker unpause chaos-pg-replica >/dev/null 2>&1 || true' EXIT
# Sleep a full minute so the 1m Prometheus rate window is entirely inside
# the fault period. Only reads (~70% of loadgen traffic) fail while the
# replica is paused, so a partial window under-samples the error rate.
sleep 60
faulted=$(prom_query '100 * (sum(rate(http_requests_total{status=~"5.."}[1m])) or vector(0)) / sum(rate(http_requests_total[1m]))')
echo "error rate during fault: ${faulted}%"
python3 -c "assert float('$faulted') > 40.0, 'fault did not raise error rate enough'" \
  || { echo "FAIL: error rate during fault only ${faulted}%, expected > 40%"; exit 1; }

echo "== unpausing pg-replica =="
docker unpause chaos-pg-replica
trap - EXIT
sleep 60
recovered=$(prom_query '100 * (sum(rate(http_requests_total{status=~"5.."}[1m])) or vector(0)) / sum(rate(http_requests_total[1m]))')
echo "error rate after recovery: ${recovered}%"
python3 -c "assert float('$recovered') < 1.0, 'error rate did not recover'" \
  || { echo "FAIL: error rate after recovery ${recovered}% >= 1%"; exit 1; }

echo "== M1 ACCEPTANCE TEST PASSED =="
echo "baseline=${baseline}% fault=${faulted}% recovered=${recovered}%"
