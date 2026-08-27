import { spawn, type ChildProcess } from "node:child_process";

export type SpawnFn = (command: string, args: string[]) => ChildProcess;

export const realSpawn: SpawnFn = (command, args) => spawn(command, args, { stdio: "ignore" });

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

export function runToCompletion(
  command: string,
  args: string[],
  spawnFn: SpawnFn = realSpawn,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawnFn(command, args);
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
}

export function spawnDetached(
  command: string,
  args: string[],
  onExit: (result: RunResult) => void,
  spawnFn: SpawnFn = realSpawn,
): ChildProcess {
  const child = spawnFn(command, args);
  child.on("error", (error) => onExit({ code: null, signal: null, error }));
  child.on("exit", (code, signal) => onExit({ code, signal }));
  return child;
}

// Success means the process ran to completion cleanly: exit code 0, not
// killed by a signal, and no spawn error. A null code (killed by a signal —
// OOM, an external `docker kill`, or anything else) is NOT success on its
// own; the one place a signal-driven exit is expected (our own revert()
// killing a detached pause/netem child early) is handled separately by the
// caller, not by loosening this check.
export function isFailure(result: RunResult): boolean {
  return Boolean(result.error) || result.code !== 0 || result.signal !== null;
}

// Resolves once the OS has confirmed the process actually started (Node's
// 'spawn' event), or rejects if it failed to start at all (e.g. ENOENT for a
// missing binary). This lets a caller that can't await full completion
// (pause/netem hold the process open for the whole fault duration) still
// catch the most common and most silent failure mode — a binary that never
// launched — before reporting success back to the MCP client.
export function waitForSpawn(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", (error) => reject(error));
  });
}
