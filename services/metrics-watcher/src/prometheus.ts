export interface RouteMetrics {
  errorRatePercent: number | null;
  avgLatencyMs: number | null;
  requestCount: number;
}

interface PrometheusQueryResult {
  status: string;
  data?: {
    resultType: string;
    result: Array<{ metric: Record<string, string>; value: [number, string] }>;
  };
}

async function query(baseUrl: string, promql: string, fetchImpl: typeof fetch): Promise<number | null> {
  const url = new URL("/api/v1/query", baseUrl);
  url.searchParams.set("query", promql);
  const res = await fetchImpl(url.toString(), { signal: AbortSignal.timeout(5000) });
  if (!res.ok) {
    throw new Error(`Prometheus query failed: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as PrometheusQueryResult;
  if (body.status !== "success") {
    throw new Error(`Prometheus query returned status ${body.status}`);
  }
  const result = body.data?.result ?? [];
  if (result.length === 0) return null;
  const n = Number(result[0].value[1]);
  // Prometheus can legitimately return "NaN" or "+Inf"/"-Inf" as value
  // strings; treat those the same as "no data" rather than letting a
  // non-finite number leak into severity classification downstream.
  return Number.isFinite(n) ? n : null;
}

export async function queryRouteMetrics(
  baseUrl: string,
  route: string,
  windowSeconds: number,
  fetchImpl: typeof fetch = fetch,
  offsetSeconds: number = 0,
): Promise<RouteMetrics> {
  // offsetSeconds anchors the query window to end offsetSeconds ago instead
  // of "now" — used when the caller supplies fault_ended_at, so the window
  // covers the fault's own active period precisely rather than guessing
  // with a fixed buffer. See PromQL `offset` modifier docs: it applies to
  // the whole preceding range-vector selector.
  const offsetClause = offsetSeconds > 0 ? ` offset ${offsetSeconds}s` : "";

  const requestCountRaw = await query(
    baseUrl,
    `sum(increase(http_requests_total{route="${route}"}[${windowSeconds}s]${offsetClause}))`,
    fetchImpl,
  );
  const requestCount = requestCountRaw ?? 0;
  if (requestCount <= 0) {
    return { errorRatePercent: null, avgLatencyMs: null, requestCount: 0 };
  }

  const errorRatePercent = await query(
    baseUrl,
    `100 * (sum(rate(http_requests_total{route="${route}",status=~"5.."}[${windowSeconds}s]${offsetClause})) or vector(0)) / sum(rate(http_requests_total{route="${route}"}[${windowSeconds}s]${offsetClause}))`,
    fetchImpl,
  );

  const avgLatencySeconds = await query(
    baseUrl,
    `sum(rate(http_request_duration_seconds_sum{route="${route}"}[${windowSeconds}s]${offsetClause})) / sum(rate(http_request_duration_seconds_count{route="${route}"}[${windowSeconds}s]${offsetClause}))`,
    fetchImpl,
  );

  return {
    errorRatePercent: errorRatePercent ?? 0,
    avgLatencyMs: avgLatencySeconds !== null ? avgLatencySeconds * 1000 : null,
    requestCount,
  };
}

// Checks Prometheus's own up{job="checkout-api"} scrape-health signal over
// the same window/offset used for route metrics. checkout-api's only
// request counter increments in Fastify's onResponse hook, which cannot
// fire while the process itself is paused/stopped/killed — so during a
// full-outage fault, Prometheus's scrape of checkout-api fails entirely and
// queryRouteMetrics sees no data at all (nulls), which is indistinguishable
// from "genuinely idle route" without this separate signal.
export async function checkoutApiWasDown(
  baseUrl: string,
  windowSeconds: number,
  offsetSeconds: number,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const offsetClause = offsetSeconds > 0 ? ` offset ${offsetSeconds}s` : "";
  const minUp = await query(
    baseUrl,
    `min_over_time(up{job="checkout-api"}[${windowSeconds}s]${offsetClause})`,
    fetchImpl,
  );
  return minUp !== null && minUp < 1;
}
