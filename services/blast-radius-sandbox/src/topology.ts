export type FaultKind = "pause" | "stop" | "kill" | "inject_latency" | "inject_packet_loss";

export interface Impact {
  target: string;
  effect: string;
}

export interface TopologyEntry {
  container: string;
  role: string;
  hardFaultImpacts: Impact[];
  degradedFaultImpacts: Impact[];
  unaffected: string[];
  notes?: string;
}

export const LATENCY_HARD_THRESHOLD_MS = 2000;
export const PACKET_LOSS_HARD_THRESHOLD_PERCENT = 80;

export const TOPOLOGY: Record<string, TopologyEntry> = {
  "chaos-pg-replica": {
    container: "chaos-pg-replica",
    role:
      "Streaming replica; checkout-api's read path (GET /products) talks to this and only this — no fallback to primary.",
    hardFaultImpacts: [
      {
        target: "GET /products",
        effect:
          "Fails with 503 (replica unavailable). No fallback to primary exists — this is the resilience gap M1 was built to demonstrate.",
      },
    ],
    degradedFaultImpacts: [
      {
        target: "GET /products",
        effect:
          "Response time increases; requests exceeding checkout-api's 2000ms query timeout will still fail with 503.",
      },
    ],
    unaffected: [
      "POST /orders (writes go to pg-primary, not the replica)",
      "GET /health (no DB dependency)",
      "GET /metrics (no DB dependency)",
    ],
  },
  "chaos-pg-primary": {
    container: "chaos-pg-primary",
    role: "Streaming replication source; checkout-api's write path (POST /orders) talks to this.",
    hardFaultImpacts: [
      { target: "POST /orders", effect: "Fails with 503 (primary unavailable)." },
    ],
    degradedFaultImpacts: [
      {
        target: "POST /orders",
        effect:
          "Response time increases; requests exceeding checkout-api's 2000ms query timeout will still fail with 503.",
      },
    ],
    unaffected: [
      "GET /products (the replica keeps serving reads from data it already has; it does not need the primary to be up to answer a read)",
    ],
    notes:
      "Ongoing replication from primary to replica stalls while the primary is down, but that has no user-facing effect within a bounded 5-300s experiment window.",
  },
  "chaos-checkout-api": {
    container: "chaos-checkout-api",
    role: "The Fastify API itself — both the read and write paths, plus /health and /metrics.",
    hardFaultImpacts: [
      { target: "GET /products", effect: "Fails — the whole API is down." },
      { target: "POST /orders", effect: "Fails — the whole API is down." },
      {
        target: "chaos-prometheus's scrape of /metrics",
        effect:
          "Fails during the fault window (visible as a gap in Prometheus's own data, not a false reading).",
      },
    ],
    degradedFaultImpacts: [
      { target: "GET /products", effect: "Slower responses; the API process itself is still up and serving." },
      { target: "POST /orders", effect: "Slower responses; the API process itself is still up and serving." },
    ],
    unaffected: [],
  },
  "chaos-prometheus": {
    container: "chaos-prometheus",
    role: "Scrapes checkout-api's /metrics every 5s; feeds the Grafana dashboard.",
    hardFaultImpacts: [
      {
        target: "Grafana dashboard (chaos-notary)",
        effect:
          "Stops showing new data for the duration — you are temporarily blinding your own observability, not affecting checkout-api itself.",
      },
    ],
    degradedFaultImpacts: [
      { target: "Grafana dashboard (chaos-notary)", effect: "Dashboard data becomes intermittent/delayed." },
    ],
    unaffected: [
      "GET /products (checkout-api's actual serving is unaffected by its passive scraper going down)",
      "POST /orders (checkout-api's actual serving is unaffected by its passive scraper going down)",
    ],
  },
  "chaos-grafana": {
    container: "chaos-grafana",
    role: "Dashboard UI reading from Prometheus.",
    hardFaultImpacts: [{ target: "Grafana dashboard UI", effect: "Unavailable for the duration." }],
    degradedFaultImpacts: [{ target: "Grafana dashboard UI", effect: "Slow to load." }],
    unaffected: [
      "GET /products (no dependency)",
      "POST /orders (no dependency)",
      "Prometheus's own data collection (independent of Grafana)",
      "Prometheus's own query API at :9090 (still directly queryable)",
    ],
  },
};

export interface PredictionInput {
  container: string;
  faultKind: FaultKind;
  latencyMs?: number;
  percent?: number;
}

export interface PredictionResult {
  container: string;
  faultKind: FaultKind;
  severity: "hard" | "degraded";
  affected: Impact[];
  unaffected: string[];
  notes?: string;
}

export function predictBlastRadius(input: PredictionInput): PredictionResult {
  const entry = TOPOLOGY[input.container];
  if (!entry) {
    throw new Error(`${input.container} is not in the topology model`);
  }

  const severity = computeSeverity(input);

  return {
    container: entry.container,
    faultKind: input.faultKind,
    severity,
    affected: severity === "hard" ? entry.hardFaultImpacts : entry.degradedFaultImpacts,
    unaffected: entry.unaffected,
    notes: entry.notes,
  };
}

function computeSeverity(input: PredictionInput): "hard" | "degraded" {
  switch (input.faultKind) {
    case "pause":
    case "stop":
    case "kill":
      return "hard";
    case "inject_latency":
      return (input.latencyMs ?? 0) >= LATENCY_HARD_THRESHOLD_MS ? "hard" : "degraded";
    case "inject_packet_loss":
      return (input.percent ?? 0) >= PACKET_LOSS_HARD_THRESHOLD_PERCENT ? "hard" : "degraded";
  }
}
