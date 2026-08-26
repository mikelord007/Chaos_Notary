import type { ChildProcess } from "node:child_process";
import type { AllowedContainer } from "./allowlist.js";
import type { FaultKind } from "./pumbaCommands.js";

export interface ActiveFault {
  container: AllowedContainer;
  kind: FaultKind;
  startedAt: number;
  expiresAt: number;
  revert: () => Promise<void>;
  timer: NodeJS.Timeout;
  child?: ChildProcess;
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

interface RegisterParams {
  container: AllowedContainer;
  kind: FaultKind;
  durationSeconds: number;
  revert: () => Promise<void>;
  child?: ChildProcess;
  now?: number;
  scheduleTimer?: (fn: () => void, ms: number) => NodeJS.Timeout;
}

export class FaultRegistry {
  private faults = new Map<AllowedContainer, ActiveFault>();
  private log: (msg: string) => void;
  private delayFn: (ms: number) => Promise<void>;

  constructor(opts?: { log?: (msg: string) => void; delayFn?: (ms: number) => Promise<void> }) {
    this.log = opts?.log ?? ((msg) => console.error(msg));
    this.delayFn = opts?.delayFn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  has(container: AllowedContainer): boolean {
    return this.faults.has(container);
  }

  get(container: AllowedContainer): ActiveFault | undefined {
    return this.faults.get(container);
  }

  list(): ActiveFault[] {
    return [...this.faults.values()];
  }

  register(params: RegisterParams): void {
    const existing = this.faults.get(params.container);
    if (existing) {
      throw new ConflictError(
        `${params.container} already has an active ${existing.kind} fault`,
      );
    }
    const now = params.now ?? Date.now();
    const schedule = params.scheduleTimer ?? ((fn, ms) => setTimeout(fn, ms));
    const expiresAt = now + params.durationSeconds * 1000;
    const timer = schedule(() => {
      void this.revertAndRemove(params.container);
    }, params.durationSeconds * 1000);
    this.faults.set(params.container, {
      container: params.container,
      kind: params.kind,
      startedAt: now,
      expiresAt,
      revert: params.revert,
      timer,
      child: params.child,
    });
  }

  async revertAndRemove(container: AllowedContainer): Promise<void> {
    const fault = this.faults.get(container);
    if (!fault) return;
    clearTimeout(fault.timer);
    const MAX_ATTEMPTS = 3;
    const BACKOFF_MS = [1000, 5000, 15000];
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        await fault.revert();
        this.faults.delete(container);
        return;
      } catch (err) {
        this.log(`revert attempt ${attempt}/${MAX_ATTEMPTS} for ${container} failed: ${(err as Error).message}`);
        if (attempt < MAX_ATTEMPTS) {
          await this.delayFn(BACKOFF_MS[attempt - 1]);
        }
      }
    }
    this.log(`${container} could not be reverted after ${MAX_ATTEMPTS} attempts (still marked as an active ${fault.kind} fault) — it will be retried on the server's next startup sweep.`);
  }

  async clear(container: AllowedContainer): Promise<boolean> {
    if (!this.faults.has(container)) return false;
    await this.revertAndRemove(container);
    return !this.faults.has(container);
  }
}
