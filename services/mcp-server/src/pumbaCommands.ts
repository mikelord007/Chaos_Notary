export type FaultKind = "pause" | "stop" | "kill" | "netem_delay" | "netem_loss";

// pause and netem are pumba's own duration-bounded commands: pumba holds the
// fault open for --duration and reverts it itself when that elapses. The
// registry (Task 6) still tracks a backup timer in case that process dies
// early, but pumba is the primary revert path for these two.
export function pumbaPauseArgs(container: string, durationSeconds: number): string[] {
  return ["pause", "--duration", `${durationSeconds}s`, container];
}

export function pumbaNetemDelayArgs(
  container: string,
  durationSeconds: number,
  latencyMs: number,
  jitterMs: number,
): string[] {
  return [
    "netem",
    "--duration",
    `${durationSeconds}s`,
    "delay",
    "--time",
    String(latencyMs),
    "--jitter",
    String(jitterMs),
    container,
  ];
}

export function pumbaNetemLossArgs(
  container: string,
  durationSeconds: number,
  percent: number,
): string[] {
  return [
    "netem",
    "--duration",
    `${durationSeconds}s`,
    "loss",
    "--percent",
    String(percent),
    container,
  ];
}

// stop and kill are one-shot: pumba has no notion of "stopped for N seconds
// then restart". The registry (Task 6) owns reverting these via dockerClient.
export function pumbaStopArgs(container: string): string[] {
  return ["stop", container];
}

export function pumbaKillArgs(container: string, signal: string): string[] {
  return ["kill", "--signal", signal, container];
}
