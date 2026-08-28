// services/metrics-watcher/src/tools.ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { queryRouteMetrics, type RouteMetrics } from "./prometheus.js";
import { classifyRoute, worstOf, computeVerdict, type ObservedSeverity, type Verdict } from "./severity.js";

export const KNOWN_ROUTES = ["/products", "/orders", "/health", "/metrics"] as const;
export type KnownRoute = (typeof KNOWN_ROUTES)[number];

const PROMETHEUS_URL = process.env.PROMETHEUS_URL ?? "http://prometheus:9090";

export interface ObserveImpactArgs {
  predicted_severity: "hard" | "degraded";
  affected_routes: KnownRoute[];
  window_seconds: number;
}

export interface ObserveImpactResult {
  windowSeconds: number;
  predictedSeverity: "hard" | "degraded";
  observedSeverity: ObservedSeverity;
  verdict: Verdict;
  routes: Record<KnownRoute, RouteMetrics>;
}

type RouteMetricsFetcher = (route: KnownRoute) => Promise<RouteMetrics>;

// window_seconds varies per call, so the default fetcher is built per-call
// inside handleObserveImpact's default parameter (below), not as a single
// top-level constant.
export async function handleObserveImpact(
  args: ObserveImpactArgs,
  fetchRouteMetrics: RouteMetricsFetcher = (route) => queryRouteMetrics(PROMETHEUS_URL, route, args.window_seconds),
): Promise<ObserveImpactResult> {
  const routes = {} as Record<KnownRoute, RouteMetrics>;
  for (const route of KNOWN_ROUTES) {
    routes[route] = await fetchRouteMetrics(route);
  }

  const affectedSeverities = args.affected_routes.map((route) => classifyRoute(routes[route]));
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
): void {
  server.registerTool(
    "observe_impact",
    {
      title: "Observe real chaos-experiment impact",
      description:
        "Query Prometheus for checkout-api's real, currently-measured error rate and latency per route, and compare against a predicted severity from predict_blast_radius. Call this after a fault reverts, passing the same predicted_severity and affected routes you got from predict_blast_radius (stripped of any leading HTTP verb, e.g. 'GET /products' becomes '/products'), and the fault's duration_seconds as window_seconds.",
      inputSchema: {
        predicted_severity: z.enum(["hard", "degraded"]),
        affected_routes: z.array(z.enum(KNOWN_ROUTES)).min(1),
        window_seconds: z.number().int().positive(),
      },
    },
    async (args) => ({
      content: [{ type: "text", text: JSON.stringify(await handleObserveImpact(args, fetchRouteMetrics)) }],
    }),
  );
}
