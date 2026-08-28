import type { RouteMetrics } from "./prometheus.js";

export const OBSERVED_HARD_ERROR_RATE_PERCENT = 40;
export const OBSERVED_NONE_ERROR_RATE_PERCENT = 1;
// Matches checkout-api's own connectionTimeoutMillis/query_timeout
// (services/checkout-api/src/server.ts) and M4's own LATENCY_HARD_THRESHOLD_MS
// (services/blast-radius-sandbox/src/topology.ts) — the same real physical
// constraint, not a new invented number.
export const OBSERVED_HARD_LATENCY_MS = 2000;

export type ObservedSeverity = "hard" | "degraded" | "none";
export type PredictedSeverity = "hard" | "degraded";
export type Verdict = "matched" | "milder_than_predicted" | "worse_than_predicted";

// apiWasDown: true when Prometheus's own up{job="checkout-api"} scrape-health
// signal shows the target was unreachable for some part of the query window
// (see checkoutApiWasDown in prometheus.ts). A genuinely unreachable API is
// unambiguously worse than "no data" — it means the route couldn't even be
// scraped, not that it was idle — so null error-rate data escalates to
// "hard" instead of the default "none" in that case.
export function classifyRoute(metrics: RouteMetrics, apiWasDown: boolean = false): ObservedSeverity {
  if (metrics.avgLatencyMs !== null && metrics.avgLatencyMs >= OBSERVED_HARD_LATENCY_MS) return "hard";
  if (metrics.errorRatePercent === null) return apiWasDown ? "hard" : "none";
  if (metrics.errorRatePercent >= OBSERVED_HARD_ERROR_RATE_PERCENT) return "hard";
  if (metrics.errorRatePercent <= OBSERVED_NONE_ERROR_RATE_PERCENT) return "none";
  return "degraded";
}

const SEVERITY_RANK: Record<ObservedSeverity, number> = { none: 0, degraded: 1, hard: 2 };

export function worstOf(severities: ObservedSeverity[]): ObservedSeverity {
  return severities.reduce<ObservedSeverity>(
    (worst, s) => (SEVERITY_RANK[s] > SEVERITY_RANK[worst] ? s : worst),
    "none",
  );
}

export function computeVerdict(predicted: PredictedSeverity, observed: ObservedSeverity): Verdict {
  if (SEVERITY_RANK[observed] === SEVERITY_RANK[predicted]) return "matched";
  return SEVERITY_RANK[observed] > SEVERITY_RANK[predicted] ? "worse_than_predicted" : "milder_than_predicted";
}
