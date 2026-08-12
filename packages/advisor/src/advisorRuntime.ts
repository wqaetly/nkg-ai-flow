import type { EventBus, NodeEvent, NodeEventKind, Unsubscribe } from "@ai-native-flow/event-bus";
import type {
  InvocationRouter,
  InvokeArgs,
  RunGuidanceInbox,
  RunManager,
  RunRecord,
} from "@ai-native-flow/runtime";
import type {
  AdvisedExecuteResult,
  AdvisorNote,
  AdvisorNoteInput,
  AdvisorReviewBatch,
  AdvisorRuntimeApi,
  AdvisorRuntimeOptions,
  AdvisorStartedRun,
} from "./types.js";

const DEFAULT_TRIGGERS: readonly NodeEventKind[] = [
  "node_finished",
  "node_error",
  "run_finished",
  "run_failed",
];

const CONTENT_FREE = new Set([
  "done",
  "complete",
  "stop",
  "lgtm",
  "no issue",
  "no issue continue",
  "nothing to add",
  "no further input",
]);

export interface AdvisorRuntimeHost {
  eventBus: EventBus;
  invocationRouter: InvocationRouter;
  runManager: RunManager;
  guidanceInbox: RunGuidanceInbox;
}

/** Optional Run-level supervision facade. */
export class AdvisorRuntime implements AdvisorRuntimeApi {
  private readonly mode;
  private readonly triggerKinds;

  constructor(
    private readonly host: AdvisorRuntimeHost,
    private readonly options: AdvisorRuntimeOptions,
  ) {
    this.mode = options.mode ?? "observe";
    this.triggerKinds = new Set(options.triggerKinds ?? DEFAULT_TRIGGERS);
  }

  async start(args: InvokeArgs): Promise<AdvisorStartedRun> {
    if (this.mode === "off") {
      const started = await this.host.invocationRouter.start(args);
      return {
        runRecord: started.runRecord,
        completed: started.completed.then((result) => ({ ...result, advisories: [] })),
        listAdvisories: () => [],
        resume: (reason) => this.host.runManager.resume(started.runRecord.runId, reason),
        dispose: () => {},
      };
    }

    const deferred = await this.host.invocationRouter.startDeferred(args);
    const session = new AdvisorSession(
      this.host,
      this.options,
      this.mode,
      this.triggerKinds,
      deferred.runRecord,
    );
    session.attach();
    deferred.startExecution();
    const completed = deferred.completed.then(async (result) => {
      await session.drain(this.options.maxReviewWaitMs ?? 30_000);
      session.dispose();
      return { ...result, advisories: session.list() };
    });
    return {
      runRecord: deferred.runRecord,
      completed,
      listAdvisories: () => session.list(),
      resume: (reason) => this.host.runManager.resume(deferred.runRecord.runId, reason),
      dispose: () => session.dispose(),
    };
  }

  async invoke(args: InvokeArgs): Promise<AdvisedExecuteResult> {
    const started = await this.start(args);
    return started.completed;
  }
}

class AdvisorSession {
  private readonly notes: AdvisorNote[] = [];
  private readonly seen = new Set<string>();
  private readonly pending: NodeEvent[] = [];
  private unsubscribe?: Unsubscribe;
  private tail: Promise<void> = Promise.resolve();
  private backlog = 0;
  private disposed = false;
  private halted = false;
  private consecutiveFailures = 0;
  private lastReviewedEventId?: string;

  constructor(
    private readonly host: AdvisorRuntimeHost,
    private readonly options: AdvisorRuntimeOptions,
    private readonly mode: "observe" | "steer" | "gate",
    private readonly triggerKinds: ReadonlySet<NodeEventKind>,
    private readonly run: RunRecord,
  ) {}

  attach(): void {
    this.unsubscribe = this.host.eventBus.subscribe(this.run.runId, (event) =>
      this.onEvent(event),
    );
  }

  list(): readonly AdvisorNote[] {
    return [...this.notes];
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.host.guidanceInbox.clear(this.run.runId);
  }

  async drain(maxWaitMs: number): Promise<boolean> {
    if (this.backlog === 0) return true;
    return Promise.race([
      this.tail.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), maxWaitMs)),
    ]);
  }

  private onEvent(event: NodeEvent): void | Promise<void> {
    if (this.disposed || this.halted || event.kind === "run_advisory") return;
    this.pending.push(event);
    if (!this.triggerKinds.has(event.kind)) return;

    const review = this.enqueueReview();
    if (this.mode !== "observe") return review;

    const threshold = this.options.syncBacklog ?? "off";
    if (threshold !== "off" && this.backlog >= threshold) {
      return this.waitForCatchup(threshold, this.options.maxReviewWaitMs ?? 30_000);
    }
  }

  private enqueueReview(): Promise<void> {
    const events = this.pending.splice(0);
    if (events.length === 0) return this.tail;
    const batch = this.createBatch(events);
    this.backlog += 1;
    const task = this.tail.then(() => this.review(batch));
    this.tail = task.catch(() => {}).finally(() => {
      this.backlog = Math.max(0, this.backlog - 1);
    });
    return task;
  }

  private createBatch(events: NodeEvent[]): AdvisorReviewBatch {
    const last = events.at(-1)!;
    const batch: AdvisorReviewBatch = {
      advisorId: this.options.advisorId,
      target: {
        runId: this.run.runId,
        flowId: this.run.flowId,
        flowVersion: this.run.flowVersion,
        ...(this.run.traceId ? { traceId: this.run.traceId } : {}),
      },
      ...(this.lastReviewedEventId
        ? { fromEventId: this.lastReviewedEventId }
        : {}),
      toEventId: last.eventId,
      events,
    };
    this.lastReviewedEventId = last.eventId;
    return batch;
  }

  private async review(batch: AdvisorReviewBatch): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort("advisor review timeout"),
      this.options.maxReviewWaitMs ?? 30_000,
    );
    try {
      const raw = await this.options.reviewer(batch, controller.signal);
      this.consecutiveFailures = 0;
      const input = Array.isArray(raw) ? raw : raw ? [raw] : [];
      const accepted = input.map((note) => this.accept(note, batch)).find(Boolean);
      if (accepted) await this.deliver(accepted, batch);
    } catch (error) {
      this.consecutiveFailures += 1;
      this.options.onError?.(error, batch);
      if (
        this.consecutiveFailures >=
        (this.options.maxConsecutiveFailures ?? 3)
      ) {
        this.halted = true;
        this.pending.splice(0);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  private accept(
    input: AdvisorNoteInput,
    batch: AdvisorReviewBatch,
  ): AdvisorNote | undefined {
    const message = input.message.trim();
    const normalized = normalize(input.dedupeKey ?? `${input.code} ${message}`);
    if (!normalized || CONTENT_FREE.has(normalized) || this.seen.has(normalized)) {
      return undefined;
    }
    this.seen.add(normalized);
    const sourceEventId = batch.toEventId;
    return {
      id: `advice_${crypto.randomUUID()}`,
      advisorId: this.options.advisorId,
      source: `advisor:${this.options.advisorId}`,
      severity: input.severity ?? "nit",
      code: input.code,
      message,
      ...(input.suggestion ? { suggestion: input.suggestion } : {}),
      ...(input.evidence !== undefined ? { evidence: input.evidence } : {}),
      createdAt: new Date().toISOString(),
      dedupeKey: normalized,
      sourceEventId,
    };
  }

  private async deliver(
    note: AdvisorNote,
    batch: AdvisorReviewBatch,
  ): Promise<void> {
    this.notes.push(note);
    await this.host.eventBus.publish({
      runId: this.run.runId,
      flowId: this.run.flowId,
      flowVersion: this.run.flowVersion,
      ...(this.run.traceId ? { traceId: this.run.traceId } : {}),
      seq: 0,
      kind: "run_advisory",
      parentEventId: note.sourceEventId,
      payload: {
        advisorId: note.advisorId,
        severity: note.severity,
        code: note.code,
        message: note.message,
        ...(note.suggestion ? { suggestion: note.suggestion } : {}),
        ...(note.evidence !== undefined ? { evidence: note.evidence } : {}),
        dedupeKey: note.dedupeKey,
        sourceEventId: note.sourceEventId,
      },
    });

    if (
      this.mode === "observe" ||
      (note.severity !== "concern" && note.severity !== "blocker")
    ) {
      return;
    }
    this.host.guidanceInbox.push(this.run.runId, note);

    const terminal = batch.events.some((event) =>
      event.kind === "run_finished" ||
      event.kind === "run_failed" ||
      event.kind === "run_cancelled",
    );
    if (this.mode === "gate" && note.severity === "blocker" && !terminal) {
      await this.host.runManager.pause(
        this.run.runId,
        `advisor ${note.advisorId}: ${note.message}`,
      );
    }
  }

  private async waitForCatchup(
    threshold: number,
    maxWaitMs: number,
  ): Promise<void> {
    const startedAt = Date.now();
    while (this.backlog >= threshold && Date.now() - startedAt < maxWaitMs) {
      await Promise.race([
        this.tail,
        new Promise<void>((resolve) => setTimeout(resolve, 10)),
      ]);
    }
  }
}

function normalize(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
