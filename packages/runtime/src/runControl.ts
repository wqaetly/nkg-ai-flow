/**
 * Generic Run-level control seams.
 *
 * The Runtime owns only delivery and safe-boundary suspension. Higher-level
 * packages (for example `@ai-native-flow/advisor`) decide when guidance is
 * produced and whether a Run should be suspended.
 */

export type RunGuidanceSeverity = "nit" | "concern" | "blocker";

export interface RunGuidance {
  id: string;
  source: string;
  severity: RunGuidanceSeverity;
  code: string;
  message: string;
  suggestion?: string;
  evidence?: unknown;
  createdAt: string;
}

/**
 * Bounded in-memory inbox shared by the Runtime and optional supervision
 * modules. Guidance is intentionally read-only from node code: the producer
 * remains responsible for dedupe, retention, and persistence as events.
 */
export class RunGuidanceInbox {
  private readonly entries = new Map<string, RunGuidance[]>();

  constructor(private readonly maxEntriesPerRun = 128) {}

  push(runId: string, guidance: RunGuidance): void {
    const bucket = this.entries.get(runId) ?? [];
    bucket.push(guidance);
    if (bucket.length > this.maxEntriesPerRun) {
      bucket.splice(0, bucket.length - this.maxEntriesPerRun);
    }
    this.entries.set(runId, bucket);
  }

  list(runId: string): readonly RunGuidance[] {
    return [...(this.entries.get(runId) ?? [])];
  }

  clear(runId: string): void {
    this.entries.delete(runId);
  }
}

/** Process-local pause primitive used only at scheduler/node boundaries. */
export class RunPauseGate {
  private paused = false;
  private readonly waiters = new Set<() => void>();

  get isPaused(): boolean {
    return this.paused;
  }

  pause(): boolean {
    if (this.paused) return false;
    this.paused = true;
    return true;
  }

  resume(): boolean {
    if (!this.paused) return false;
    this.paused = false;
    for (const wake of this.waiters) wake();
    this.waiters.clear();
    return true;
  }

  async wait(signal?: AbortSignal): Promise<boolean> {
    if (!this.paused) return !signal?.aborted;
    if (signal?.aborted) return false;

    return new Promise<boolean>((resolve) => {
      const finish = (allowed: boolean) => {
        this.waiters.delete(onResume);
        signal?.removeEventListener("abort", onAbort);
        resolve(allowed);
      };
      const onResume = () => finish(true);
      const onAbort = () => finish(false);
      this.waiters.add(onResume);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}
