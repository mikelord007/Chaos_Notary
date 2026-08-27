import type Docker from "dockerode";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ALLOWED_CONTAINERS, isAllowedContainer, type AllowedContainer } from "./allowlist.js";
import { validateDuration, MIN_DURATION_SECONDS, MAX_DURATION_SECONDS } from "./duration.js";
import {
  pumbaPauseArgs,
  pumbaStopArgs,
  pumbaKillArgs,
  pumbaNetemDelayArgs,
  pumbaNetemLossArgs,
} from "./pumbaCommands.js";
import { runToCompletion, spawnDetached, realSpawn, type SpawnFn } from "./processRunner.js";
import { FaultRegistry, ConflictError } from "./faultRegistry.js";
import { inspectContainer, unpauseContainer, startContainer } from "./dockerClient.js";

const PUMBA_BIN = "pumba";

export interface ToolDeps {
  docker: Docker;
  registry: FaultRegistry;
  spawnFn?: SpawnFn;
}

function requireAllowed(container: string): AllowedContainer {
  if (!isAllowedContainer(container)) {
    throw new Error(`${container} is not an allowed chaos target`);
  }
  return container;
}

// Checked before every mutating tool touches Pumba/Docker, not just left to
// FaultRegistry.register's own guard — a conflict must never cost a wasted
// (and potentially confusing) fault invocation against an already-faulted
// target. FaultRegistry.register still re-checks internally; that's a second
// line of defense, not the primary one.
function requireNoActiveFault(registry: FaultRegistry, container: AllowedContainer): void {
  const existing = registry.get(container);
  if (existing) {
    throw new ConflictError(`${container} already has an active ${existing.kind} fault`);
  }
}

export async function handleListTargets(deps: ToolDeps) {
  return Promise.all(
    ALLOWED_CONTAINERS.map(async (container) => {
      const status = await inspectContainer(deps.docker, container);
      const fault = deps.registry.get(container);
      return {
        container,
        dockerStatus: status.dockerStatus,
        fault: fault
          ? {
              kind: fault.kind,
              secondsRemaining: Math.max(0, Math.round((fault.expiresAt - Date.now()) / 1000)),
            }
          : null,
      };
    }),
  );
}

export async function handlePauseContainer(
  args: { container: string; duration_seconds: number },
  deps: ToolDeps,
) {
  const container = requireAllowed(args.container);
  validateDuration(args.duration_seconds);
  requireNoActiveFault(deps.registry, container);
  const spawnFn = deps.spawnFn ?? realSpawn;
  const child = spawnDetached(
    PUMBA_BIN,
    pumbaPauseArgs(container, args.duration_seconds),
    (result) => {
      if (result.error || (result.code !== 0 && result.code !== null)) {
        console.error(
          `pumba pause for ${container} failed: ${result.error?.message ?? `exit code ${result.code}`}`,
        );
        void deps.registry.revertAndRemove(container).catch(() => {});
      }
    },
    spawnFn,
  );
  deps.registry.register({
    container,
    kind: "pause",
    durationSeconds: args.duration_seconds,
    child,
    revert: async () => {
      if (!child.killed) child.kill();
      await unpauseContainer(deps.docker, container);
    },
  });
  return { container, expiresAt: new Date(Date.now() + args.duration_seconds * 1000).toISOString() };
}

export async function handleStopContainer(
  args: { container: string; duration_seconds: number },
  deps: ToolDeps,
) {
  const container = requireAllowed(args.container);
  validateDuration(args.duration_seconds);
  requireNoActiveFault(deps.registry, container);
  const spawnFn = deps.spawnFn ?? realSpawn;
  const result = await runToCompletion(PUMBA_BIN, pumbaStopArgs(container), spawnFn);
  if (result.error || (result.code !== 0 && result.code !== null)) {
    throw new Error(
      `pumba stop for ${container} failed: ${result.error?.message ?? `exit code ${result.code}`}`,
    );
  }
  deps.registry.register({
    container,
    kind: "stop",
    durationSeconds: args.duration_seconds,
    revert: async () => {
      await startContainer(deps.docker, container);
    },
  });
  return { container, expiresAt: new Date(Date.now() + args.duration_seconds * 1000).toISOString() };
}

export async function handleKillContainer(
  args: { container: string; signal?: string; duration_seconds: number },
  deps: ToolDeps,
) {
  const container = requireAllowed(args.container);
  validateDuration(args.duration_seconds);
  requireNoActiveFault(deps.registry, container);
  const signal = args.signal ?? "SIGKILL";
  const spawnFn = deps.spawnFn ?? realSpawn;
  const result = await runToCompletion(PUMBA_BIN, pumbaKillArgs(container, signal), spawnFn);
  if (result.error || (result.code !== 0 && result.code !== null)) {
    throw new Error(
      `pumba kill for ${container} failed: ${result.error?.message ?? `exit code ${result.code}`}`,
    );
  }
  deps.registry.register({
    container,
    kind: "kill",
    durationSeconds: args.duration_seconds,
    revert: async () => {
      await startContainer(deps.docker, container);
    },
  });
  return { container, expiresAt: new Date(Date.now() + args.duration_seconds * 1000).toISOString() };
}

export async function handleInjectLatency(
  args: { container: string; latency_ms: number; jitter_ms?: number; duration_seconds: number },
  deps: ToolDeps,
) {
  const container = requireAllowed(args.container);
  validateDuration(args.duration_seconds);
  requireNoActiveFault(deps.registry, container);
  const spawnFn = deps.spawnFn ?? realSpawn;
  const child = spawnDetached(
    PUMBA_BIN,
    pumbaNetemDelayArgs(container, args.duration_seconds, args.latency_ms, args.jitter_ms ?? 0),
    (result) => {
      if (result.error || (result.code !== 0 && result.code !== null)) {
        console.error(
          `pumba netem delay for ${container} failed: ${result.error?.message ?? `exit code ${result.code}`}`,
        );
        void deps.registry.revertAndRemove(container).catch(() => {});
      }
    },
    spawnFn,
  );
  deps.registry.register({
    container,
    kind: "netem_delay",
    durationSeconds: args.duration_seconds,
    child,
    revert: async () => {
      if (!child.killed) child.kill();
    },
  });
  return { container, expiresAt: new Date(Date.now() + args.duration_seconds * 1000).toISOString() };
}

export async function handleInjectPacketLoss(
  args: { container: string; percent: number; duration_seconds: number },
  deps: ToolDeps,
) {
  const container = requireAllowed(args.container);
  validateDuration(args.duration_seconds);
  requireNoActiveFault(deps.registry, container);
  const spawnFn = deps.spawnFn ?? realSpawn;
  const child = spawnDetached(
    PUMBA_BIN,
    pumbaNetemLossArgs(container, args.duration_seconds, args.percent),
    (result) => {
      if (result.error || (result.code !== 0 && result.code !== null)) {
        console.error(
          `pumba netem loss for ${container} failed: ${result.error?.message ?? `exit code ${result.code}`}`,
        );
        void deps.registry.revertAndRemove(container).catch(() => {});
      }
    },
    spawnFn,
  );
  deps.registry.register({
    container,
    kind: "netem_loss",
    durationSeconds: args.duration_seconds,
    child,
    revert: async () => {
      if (!child.killed) child.kill();
    },
  });
  return { container, expiresAt: new Date(Date.now() + args.duration_seconds * 1000).toISOString() };
}

export async function handleClearFault(args: { container: string }, deps: ToolDeps) {
  const container = requireAllowed(args.container);
  const cleared = await deps.registry.clear(container);
  return { container, cleared };
}

export function registerTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "list_targets",
    {
      title: "List chaos targets",
      description: "List every allowlisted container's current Docker state and active fault, if any.",
      inputSchema: {},
    },
    async () => ({ content: [{ type: "text", text: JSON.stringify(await handleListTargets(deps)) }] }),
  );

  server.registerTool(
    "pause_container",
    {
      title: "Pause container",
      description: "Freeze a container's processes for a bounded duration; auto-reverts.",
      inputSchema: {
        container: z.enum(ALLOWED_CONTAINERS),
        duration_seconds: z.number().int().min(MIN_DURATION_SECONDS).max(MAX_DURATION_SECONDS),
      },
    },
    async (args) => ({ content: [{ type: "text", text: JSON.stringify(await handlePauseContainer(args, deps)) }] }),
  );

  server.registerTool(
    "stop_container",
    {
      title: "Stop container",
      description: "Stop a container for a bounded duration; auto-restarts.",
      inputSchema: {
        container: z.enum(ALLOWED_CONTAINERS),
        duration_seconds: z.number().int().min(MIN_DURATION_SECONDS).max(MAX_DURATION_SECONDS),
      },
    },
    async (args) => ({ content: [{ type: "text", text: JSON.stringify(await handleStopContainer(args, deps)) }] }),
  );

  server.registerTool(
    "kill_container",
    {
      title: "Kill container",
      description: "Send a signal that kills a container's process for a bounded duration; auto-restarts.",
      inputSchema: {
        container: z.enum(ALLOWED_CONTAINERS),
        signal: z.string().optional(),
        duration_seconds: z.number().int().min(MIN_DURATION_SECONDS).max(MAX_DURATION_SECONDS),
      },
    },
    async (args) => ({ content: [{ type: "text", text: JSON.stringify(await handleKillContainer(args, deps)) }] }),
  );

  server.registerTool(
    "inject_latency",
    {
      title: "Inject network latency",
      description: "Add network latency to a container's traffic for a bounded duration; auto-reverts.",
      inputSchema: {
        container: z.enum(ALLOWED_CONTAINERS),
        latency_ms: z.number().int().positive(),
        jitter_ms: z.number().int().nonnegative().optional(),
        duration_seconds: z.number().int().min(MIN_DURATION_SECONDS).max(MAX_DURATION_SECONDS),
      },
    },
    async (args) => ({ content: [{ type: "text", text: JSON.stringify(await handleInjectLatency(args, deps)) }] }),
  );

  server.registerTool(
    "inject_packet_loss",
    {
      title: "Inject packet loss",
      description: "Drop a percentage of a container's network packets for a bounded duration; auto-reverts.",
      inputSchema: {
        container: z.enum(ALLOWED_CONTAINERS),
        percent: z.number().min(0).max(100),
        duration_seconds: z.number().int().min(MIN_DURATION_SECONDS).max(MAX_DURATION_SECONDS),
      },
    },
    async (args) => ({ content: [{ type: "text", text: JSON.stringify(await handleInjectPacketLoss(args, deps)) }] }),
  );

  server.registerTool(
    "clear_fault",
    {
      title: "Clear fault",
      description: "Manually revert whatever fault (if any) is currently active on a container.",
      inputSchema: { container: z.enum(ALLOWED_CONTAINERS) },
    },
    async (args) => ({ content: [{ type: "text", text: JSON.stringify(await handleClearFault(args, deps)) }] }),
  );
}
