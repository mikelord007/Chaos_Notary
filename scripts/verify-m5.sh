#!/usr/bin/env bash
# M5 acceptance test. Run from the repo root inside WSL:
#   bash scripts/verify-m5.sh
#
# Verifies observe_impact reports accurate real-world severity against
# live Prometheus data: "none" at baseline, "hard" with a "matched"
# verdict during a real fault, correctly rejects invalid input, confirms
# metrics-watcher cannot reach mcp-server over the network (the same
# isolation guard M4 added after Qodo caught the equivalent gap for
# blast-radius-sandbox), and — the Qodo PR #5 regression coverage —
# confirms fault_ended_at-based offset anchoring holds up for a SHORT fault
# called well after it ended (the exact scenario a fixed +60s buffer gets
# wrong), and confirms a full chaos-checkout-api outage is reported as
# "hard" via the up{job="checkout-api"} scrape-health signal even though
# checkout-api's own request counters can't increment while it's paused.
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

# Pulls the expiresAt field out of a fault-injection tool's JSON response
# (pause_container/stop_container/kill_container/inject_latency/
# inject_packet_loss all return { container, expiresAt }). Follows this
# script's own established convention (see the baseline/faulted/delayed
# blocks below) of piping the raw response through python3 on stdin rather
# than interpolating JSON into a shell string, to avoid shell/JSON
# escaping bugs.
extract_expires_at() {
  python3 -c "
import json, sys
result = json.load(sys.stdin)
payload = json.loads(result['content'][0]['text'])
print(payload['expiresAt'])
"
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

echo "== observe_impact called well after revert, with a buffered window: still reports hard/matched (C2 regression) =="
# This is the exact scenario C2 broke: by now the fault (duration_seconds=90)
# reverted a good while ago and more script time has elapsed since. A window
# equal to just the fault's duration would land entirely in the recovered
# period and report "none"/"milder_than_predicted". A buffered window
# (duration_seconds + 60) still reaches back far enough to cover the fault's
# active period despite the delay.
delayed=$(call_metrics_watcher observe_impact '{"predicted_severity":"hard","affected_routes":["/products"],"window_seconds":150}')
echo "$delayed"
printf '%s' "$delayed" | python3 -c "
import json, sys
result = json.load(sys.stdin)
observation = json.loads(result['content'][0]['text'])
assert observation['observedSeverity'] == 'hard', f\"expected hard, got {observation['observedSeverity']}\"
assert observation['verdict'] == 'matched', f\"expected matched, got {observation['verdict']}\"
print('OK: buffered post-revert-delay observe_impact still reports hard/matched')
"

echo "== short fault + fault_ended_at: offset-anchored window still reports hard/matched (Qodo #5 regression) =="
# This is the exact scenario the old fixed +60s buffer got wrong: a SHORT
# fault (12s, well under the 90s test above) is only a small fraction of a
# buffered window, diluting the aggregate error rate below the "hard"
# threshold even though the fault itself was working correctly. Anchoring
# the query window to the fault's own real expiresAt (rather than guessing
# with a buffer) fixes this for any duration, not just long ones. We
# deliberately wait well past the fault's own auto-revert before calling
# observe_impact, to simulate a real "checked back in a while later" call —
# window_seconds is set to exactly the fault's own duration_seconds (12),
# not duration+60.
short_duration=12
pause_resp=$(call_mcp pause_container "{\"container\":\"chaos-pg-replica\",\"duration_seconds\":${short_duration}}")
echo "$pause_resp"
short_expires_at=$(printf '%s' "$pause_resp" | extract_expires_at)
echo "short fault expiresAt: ${short_expires_at}"

# Sleep past the fault's own duration plus a real extra delay beyond
# expiresAt, so the offset the server computes at call time is genuinely
# larger than window_seconds — exactly the case a fixed buffer can't
# handle for a short fault.
sleep $((short_duration + 20))

short_observe_args=$(printf '{"predicted_severity":"hard","affected_routes":["/products"],"window_seconds":%d,"fault_ended_at":"%s"}' "$short_duration" "$short_expires_at")
short_result=$(call_metrics_watcher observe_impact "$short_observe_args")
echo "$short_result"
printf '%s' "$short_result" | python3 -c "
import json, sys
result = json.load(sys.stdin)
observation = json.loads(result['content'][0]['text'])
assert observation['observedSeverity'] == 'hard', f\"expected hard, got {observation['observedSeverity']}\"
assert observation['verdict'] == 'matched', f\"expected matched, got {observation['verdict']}\"
print('OK: short-fault, offset-anchored observe_impact (called well after the fault ended) still reports hard/matched')
"

echo "== chaos-checkout-api outage: observedSeverity hard via up{} scrape-health, not request counters (Qodo #5 regression) =="
# checkout-api's only request counter increments in Fastify's onResponse
# hook, which cannot fire while the process itself is paused — so during
# this fault, checkout-api's own /metrics endpoint is entirely unscrapeable
# and queryRouteMetrics would see no request data at all. Without the
# up{job="checkout-api"} scrape-health check, that null data reads as
# "none" (idle), which is the opposite of correct for the single most
# common chaos scenario. affected_routes below are the routes M4's own
# topology predicts as hard-affected for chaos-checkout-api.
outage_duration=15
outage_resp=$(call_mcp pause_container "{\"container\":\"chaos-checkout-api\",\"duration_seconds\":${outage_duration}}")
echo "$outage_resp"
outage_expires_at=$(printf '%s' "$outage_resp" | extract_expires_at)
echo "checkout-api outage expiresAt: ${outage_expires_at}"

sleep $((outage_duration + 10))

outage_observe_args=$(printf '{"predicted_severity":"hard","affected_routes":["/products","/orders","/health"],"window_seconds":%d,"fault_ended_at":"%s"}' "$outage_duration" "$outage_expires_at")
outage_result=$(call_metrics_watcher observe_impact "$outage_observe_args")
echo "$outage_result"
printf '%s' "$outage_result" | python3 -c "
import json, sys
result = json.load(sys.stdin)
observation = json.loads(result['content'][0]['text'])
assert observation['observedSeverity'] == 'hard', f\"expected hard, got {observation['observedSeverity']}\"
print('OK: chaos-checkout-api outage correctly reported as hard via up{} scrape-health signal')
"

echo "== network isolation positive control: metrics-watcher CAN reach prometheus =="
# Proves wget works inside the metrics-watcher image and the container can
# reach a legitimate target, so the negative-control failure below is
# attributable to network topology, not a broken wget/container/exec.
docker compose exec -T metrics-watcher wget -q --timeout=5 --spider http://prometheus:9090/-/healthy
echo "OK: metrics-watcher can reach prometheus"

echo "== network isolation: metrics-watcher cannot reach mcp-server =="
set +e
docker compose exec -T metrics-watcher wget -q --timeout=5 --spider http://mcp-server:3100/health
rc=$?
set -e
[ "$rc" -ne 0 ] || { echo "FAIL: metrics-watcher could reach mcp-server — network isolation broken"; exit 1; }
echo "OK: metrics-watcher cannot reach mcp-server"

echo "== M5 ACCEPTANCE TEST PASSED =="
