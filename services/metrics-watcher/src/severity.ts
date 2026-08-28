import type { RouteMetrics } from "./prometheus.js";

export const OBSERVED_HARD_ERROR_RATE_PERCENT = 40;
export const OBSERVED_NONE_ERROR_RATE_PERCENT = 1;

export type ObservedSeverity = "hard" | "degraded" | "none";
export type PredictedSeverity = "hard" | "degraded";
export type Verdict = "matched" | "milder_than_predicted" | "worse_than_predicted";

export function classifyRoute(metrics: RouteMetrics): ObservedSeverity {
  if (metrics.errorRatePercent === null) return "none";
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
