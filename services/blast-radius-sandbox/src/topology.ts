import { isAllowedContainer, type AllowedContainer } from "./allowlist.js";

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

export const TOPOLOGY: Record<AllowedContainer, TopologyEntry> = {
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
        target: "GET /health",
        effect: "Fails — the whole API process is down, including its own healthcheck endpoint.",
      },
      {
        target: "chaos-prometheus's scrape of /metrics",
        effect:
          "Fails during the fault window (visible as a gap in Prometheus's own data, not a false reading).",
      },
    ],
    degradedFaultImpacts: [
      { target: "GET /products", effect: "Slower responses; the API process itself is still up and serving." },
      { target: "POST /orders", effect: "Slower responses; the API process itself is still up and serving." },
      { target: "GET /health", effect: "Slower responses; the API process itself is still up and serving." },
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
      {
        target: "Prometheus query API (:9090)",
        effect:
          "Unavailable for the duration — Prometheus itself is down, not just the Grafana dashboard reading from it.",
      },
    ],
    degradedFaultImpacts: [
      { target: "Grafana dashboard (chaos-notary)", effect: "Dashboard data becomes intermittent/delayed." },
      { target: "Prometheus query API (:9090)", effect: "Slower to respond; Prometheus itself is still up." },
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
  jitterMs?: number;
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

const DB_CONTAINERS = new Set(["chaos-pg-primary", "chaos-pg-replica"]);

export function predictBlastRadius(input: PredictionInput): PredictionResult {
  if (!isAllowedContainer(input.container)) {
    throw new Error(`${input.container} is not in the topology model`);
  }
  const entry = TOPOLOGY[input.container];
  const severity = computeSeverity(input);
  const noImpact = input.faultKind === "inject_packet_loss" && input.percent === 0;

  return {
    container: entry.container,
    faultKind: input.faultKind,
    severity,
    affected: noImpact ? [] : severity === "hard" ? entry.hardFaultImpacts : entry.degradedFaultImpacts,
    unaffected: entry.unaffected,
    notes: noImpact ? "0% packet loss configured — no traffic is dropped, no impact expected." : entry.notes,
  };
}

function computeSeverity(input: PredictionInput): "hard" | "degraded" {
  switch (input.faultKind) {
    case "pause":
    case "stop":
    case "kill":
      return "hard";
    case "inject_latency": {
      const worstCaseLatency = (input.latencyMs ?? 0) + (input.jitterMs ?? 0);
      return DB_CONTAINERS.has(input.container) && worstCaseLatency >= LATENCY_HARD_THRESHOLD_MS
        ? "hard"
        : "degraded";
    }
    case "inject_packet_loss": {
      const percent = input.percent ?? 0;
      if (percent >= 100) return "hard";
      return DB_CONTAINERS.has(input.container) && percent >= PACKET_LOSS_HARD_THRESHOLD_PERCENT
        ? "hard"
        : "degraded";
    }
  }
}
