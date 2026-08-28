// services/metrics-watcher/src/tools.ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { queryRouteMetrics, checkoutApiWasDown, type RouteMetrics } from "./prometheus.js";
import { classifyRoute, worstOf, computeVerdict, type ObservedSeverity, type Verdict } from "./severity.js";

export const KNOWN_ROUTES = ["/products", "/orders", "/health", "/metrics"] as const;
export type KnownRoute = (typeof KNOWN_ROUTES)[number];

const PROMETHEUS_URL = process.env.PROMETHEUS_URL ?? "http://prometheus:9090";

export interface ObserveImpactArgs {
  predicted_severity: "hard" | "degraded";
  affected_routes: KnownRoute[];
  window_seconds: number;
  fault_ended_at?: string;
}

export interface ObserveImpactResult {
  windowSeconds: number;
  predictedSeverity: "hard" | "degraded";
  observedSeverity: ObservedSeverity;
  verdict: Verdict;
  routes: Record<KnownRoute, RouteMetrics>;
}

// Both fetchers take the per-call offsetSeconds explicitly (rather than
// having it baked silently into a closure) so callers — including tests —
// can observe exactly what offset a given fault_ended_at was translated
// into and that it was actually threaded through to every Prometheus query.
type RouteMetricsFetcher = (route: KnownRoute, offsetSeconds: number) => Promise<RouteMetrics>;
type ApiHealthFetcher = (windowSeconds: number, offsetSeconds: number) => Promise<boolean>;

// window_seconds varies per call, so the default fetchers are built per-call
// inside handleObserveImpact's default parameters (below), not as a single
// top-level constant.
export async function handleObserveImpact(
  args: ObserveImpactArgs,
  fetchRouteMetrics: RouteMetricsFetcher = (route, offsetSeconds) =>
    queryRouteMetrics(PROMETHEUS_URL, route, args.window_seconds, undefined, offsetSeconds),
  fetchApiHealth: ApiHealthFetcher = (windowSeconds, offsetSeconds) =>
    checkoutApiWasDown(PROMETHEUS_URL, windowSeconds, offsetSeconds),
): Promise<ObserveImpactResult> {
  // When fault_ended_at is supplied (the fault tool's own expiresAt,
  // verbatim), anchor the query window to end there instead of "now" — the
  // server computes the real elapsed offset with its own Date.now(), so the
  // caller never has to estimate elapsed time itself. Without it, behavior
  // is unchanged: window ends at "now" (offsetSeconds 0), still useful for
  // mid-fault or ad-hoc calls.
  const offsetSeconds = args.fault_ended_at
    ? Math.max(0, Math.round((Date.now() - Date.parse(args.fault_ended_at)) / 1000))
    : 0;

  const routes = {} as Record<KnownRoute, RouteMetrics>;
  for (const route of KNOWN_ROUTES) {
    routes[route] = await fetchRouteMetrics(route, offsetSeconds);
  }

  // A single API-wide scrape-health check, not one per route: checkout-api's
  // request counters can't increment while the process itself is
  // paused/stopped/killed, so a route with null error-rate data during a
  // full outage must be escalated to "hard" rather than read as "none".
  const apiWasDown = await fetchApiHealth(args.window_seconds, offsetSeconds);

  const affectedSeverities = args.affected_routes.map((route) => classifyRoute(routes[route], apiWasDown));
  const observedSeverity = worstOf(affectedSeverities);
  const verdict = computeVerdict(args.predicted_severity, observedSeverity);

  return {
    windowSeconds: args.window_seconds,
    predictedSeverity: args.predicted_severity,
    observedSeverity,
    verdict,
    routes,
  };
}

export function registerTools(
  server: McpServer,
  fetchRouteMetrics?: RouteMetricsFetcher,
  fetchApiHealth?: ApiHealthFetcher,
): void {
  server.registerTool(
    "observe_impact",
    {
      title: "Observe real chaos-experiment impact",
      description:
        "Query Prometheus for checkout-api's real, currently-measured error rate and latency per route, and compare against a predicted severity from predict_blast_radius. Call this after a fault reverts, passing the same predicted_severity and affected routes you got from predict_blast_radius (stripped of any leading HTTP verb, e.g. 'GET /products' becomes '/products'; only pass targets that are actual routes — some predict_blast_radius targets describe impact on Prometheus/Grafana themselves and are not routes at all, so skip calling this tool if none of the affected targets are routes). Pass fault_ended_at as the exact expiresAt timestamp (ISO-8601) returned by the fault-injection tool call, if you have it — this precisely time-anchors the query window to the fault's own active period regardless of how much reasoning/tool-call time has since passed, and with it window_seconds should be set to exactly the fault's duration_seconds (no buffer needed). If you don't have an expiresAt to anchor with, omit fault_ended_at and instead pass window_seconds with some margin beyond duration_seconds (e.g. duration_seconds + ~60s) as a fallback, since the window will then end at 'now' and a window equal to exactly duration_seconds risks landing entirely in the already-recovered period. Note observedSeverity/verdict now also escalate to 'hard' when avgLatencyMs reaches 2000ms (matching checkout-api's own timeout) regardless of error rate, and separately when checkout-api's own Prometheus scrape was down during the window (a full outage, not idle traffic) — but a latency-only fault that stays below 2000ms with no accompanying error spike is still only visible via the response's per-route avgLatencyMs directly, not via observedSeverity/verdict alone.",
      inputSchema: {
        predicted_severity: z.enum(["hard", "degraded"]),
        affected_routes: z.array(z.enum(KNOWN_ROUTES)).min(1),
        window_seconds: z.number().int().positive(),
        fault_ended_at: z.string().datetime().optional(),
      },
    },
    async (args) => ({
      content: [
        { type: "text", text: JSON.stringify(await handleObserveImpact(args, fetchRouteMetrics, fetchApiHealth)) },
      ],
    }),
  );
}
