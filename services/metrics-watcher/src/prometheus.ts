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
  const res = await fetchImpl(url.toString());
  if (!res.ok) {
    throw new Error(`Prometheus query failed: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as PrometheusQueryResult;
  if (body.status !== "success") {
    throw new Error(`Prometheus query returned status ${body.status}`);
  }
  const result = body.data?.result ?? [];
  if (result.length === 0) return null;
  return Number(result[0].value[1]);
}

export async function queryRouteMetrics(
  baseUrl: string,
  route: string,
  windowSeconds: number,
  fetchImpl: typeof fetch = fetch,
): Promise<RouteMetrics> {
  const requestCountRaw = await query(
    baseUrl,
    `sum(increase(http_requests_total{route="${route}"}[${windowSeconds}s]))`,
    fetchImpl,
  );
  const requestCount = requestCountRaw ?? 0;
  if (requestCount <= 0) {
    return { errorRatePercent: null, avgLatencyMs: null, requestCount: 0 };
  }

  const errorRatePercent = await query(
    baseUrl,
    `100 * (sum(rate(http_requests_total{route="${route}",status=~"5.."}[${windowSeconds}s])) or vector(0)) / sum(rate(http_requests_total{route="${route}"}[${windowSeconds}s]))`,
    fetchImpl,
  );

  const avgLatencySeconds = await query(
    baseUrl,
    `rate(http_request_duration_seconds_sum{route="${route}"}[${windowSeconds}s]) / rate(http_request_duration_seconds_count{route="${route}"}[${windowSeconds}s])`,
    fetchImpl,
  );

  return {
    errorRatePercent: errorRatePercent ?? 0,
    avgLatencyMs: avgLatencySeconds !== null ? avgLatencySeconds * 1000 : null,
    requestCount,
  };
}
