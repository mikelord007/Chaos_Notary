// services/blast-radius-sandbox/src/tools.ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ALLOWED_CONTAINERS } from "./allowlist.js";
import { predictBlastRadius, type FaultKind, type PredictionResult } from "./topology.js";

const FAULT_KINDS = ["pause", "stop", "kill", "inject_latency", "inject_packet_loss"] as const;

export interface PredictArgs {
  container: string;
  fault_kind: FaultKind;
  latency_ms?: number;
  percent?: number;
}

export function handlePredictBlastRadius(args: PredictArgs): PredictionResult {
  return predictBlastRadius({
    container: args.container,
    faultKind: args.fault_kind,
    latencyMs: args.latency_ms,
    percent: args.percent,
  });
}

export function registerTools(server: McpServer): void {
  server.registerTool(
    "predict_blast_radius",
    {
      title: "Predict blast radius",
      description:
        "Predict what a proposed chaos fault will actually affect, based on M1's real topology, before running it. For inject_latency/inject_packet_loss, pass latency_ms/percent matching what you actually intend to run — omitting them defaults to a milder 'degraded' severity prediction.",
      inputSchema: {
        container: z.enum(ALLOWED_CONTAINERS),
        fault_kind: z.enum(FAULT_KINDS),
        latency_ms: z.number().int().positive().optional(),
        percent: z.number().min(0).max(100).optional(),
      },
    },
    async (args) => ({
      content: [{ type: "text", text: JSON.stringify(handlePredictBlastRadius(args)) }],
    }),
  );
}
