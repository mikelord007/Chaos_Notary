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
