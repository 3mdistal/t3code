// fork: limits. Moves a thread held here to the linked machine in the overflow settings, and forwards what's sent to
// it afterwards; see FORK.md.
import {
  CommandId,
  type EnvironmentId,
  MessageId,
  type ModelSelection,
  OrchestratorMcpCapabilitiesResult,
  OrchestratorMcpFailure,
  OrchestratorMcpThreadListResult,
  OrchestratorMcpThreadReadResult,
  OrchestratorMcpThreadSendResult,
  type OrchestratorMcpThreadStatus,
  OVERFLOW_DEFAULTS,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  type ProviderInteractionMode,
  RunId,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import {
  DEFAULT_HANDOFF_TOKEN_CAP,
  handoffCoverage,
  historicalMessage,
  renderHistory,
  selectHistory,
} from "@t3tools/provider-core/server/handoffBudget";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { ProjectToolkit } from "../mcp/toolkits/project/tools.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ServerSettings from "../serverSettings.ts";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { makeJsonFiles } from "./jsonFiles.ts";
import {
  BUSY_THERE,
  busyThere,
  checkoutFreePlan,
  checkoutFreeRepository,
  isBufferedWake,
  isDefiniteRefusal,
  type MoveCandidate,
  moveBlocker,
  moveBrief,
  movedBranchName,
  movePlan,
  type MoveTarget,
  remoteHeadBlocker,
  threadThere,
  TIMING,
  type Upstream,
  upstreamOf,
} from "./policy.ts";
import {
  type MovedThread,
  type MoveLaunch,
  moveRetries,
  movedThreads,
  type Outgoing,
  type OverflowMover,
  ResourceLimits,
} from "./ResourceLimits.ts";

/** The modes a call to the linked machine carries, which it enforces with the link's own access. */
interface Modes {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

/** What a move reads and calls outside the orchestrator: this machine's git and projects, and the linked machine. */
export interface OverflowHost {
  readonly project: (projectId: ProjectId) => Effect.Effect<{
    readonly workspaceRoot: string;
    readonly repositoryKey: string | null;
  } | null>;
  readonly gitStatus: (cwd: string) => Effect.Effect<MoveCandidate["git"]>;
  readonly label: (environmentId: EnvironmentId) => Effect.Effect<string>;
  readonly projectsThere: (
    environmentId: EnvironmentId,
    modes: Modes,
    repositoryKey: string,
  ) => Effect.Effect<
    ReadonlyArray<{ readonly id: ProjectId; readonly remotes: ReadonlyMap<string, string> }>,
    OrchestratorMcpFailure
  >;
  /** Projects there with this ID, or else with this title. */
  readonly projectsNamed: (
    environmentId: EnvironmentId,
    modes: Modes,
    name: string,
  ) => Effect.Effect<ReadonlyArray<{ readonly id: ProjectId }>, OrchestratorMcpFailure>;
  readonly providersThere: (
    environmentId: EnvironmentId,
    modes: Modes,
  ) => Effect.Effect<MoveTarget["providers"], OrchestratorMcpFailure>;
  readonly launch: (
    environmentId: EnvironmentId,
    modes: Modes,
    input: MoveLaunch,
  ) => Effect.Effect<
    { readonly threadId: string; readonly link: string | null },
    OrchestratorMcpFailure
  >;
  readonly readThere: (
    environmentId: EnvironmentId,
    modes: Modes,
    threadId: string,
  ) => Effect.Effect<OrchestratorMcpThreadReadResult, OrchestratorMcpFailure>;
  /** The first page of threads there, in every project, with one of these statuses. */
  readonly threadsThere: (
    environmentId: EnvironmentId,
    modes: Modes,
    statuses: ReadonlyArray<OrchestratorMcpThreadStatus>,
  ) => Effect.Effect<OrchestratorMcpThreadListResult, OrchestratorMcpFailure>;
  readonly send: (
    environmentId: EnvironmentId,
    modes: Modes,
    input: {
      readonly threadId: string;
      readonly message: string;
      readonly clientRequestId: string;
    },
  ) => Effect.Effect<void, OrchestratorMcpFailure>;
  /** The branch's head on its remote (`git ls-remote`), and whether it contains `head`, read from this checkout. */
  readonly remoteHead: (
    cwd: string,
    upstream: Upstream,
    head: string,
  ) => Effect.Effect<
    { readonly remoteHead: string | null; readonly containsHead: boolean | null },
    OrchestratorMcpFailure
  >;
}

/** The notification a move queues, so its notice is the thread's last item; it's cancelled, never sent. */
const MOVE_NOTE_PREFIX = "limits:moved:";

/** Run statuses that mean the thread is working here. */
const LIVE_RUN = new Set(["preparing", "starting", "running", "waiting"]);

/**
 * A read there is allowed in any modes and comes from no thread, so it carries approval-required, the narrowest runtime
 * mode, and the default interaction mode.
 */
const READ_MODES: Modes = { runtimeMode: "approval-required", interactionMode: "default" };

const modesOf = (shell: OrchestrationV2ThreadShell): Modes => ({
  runtimeMode: shell.runtimeMode,
  interactionMode: shell.interactionMode,
});

const failureMessage = (failure: OrchestratorMcpFailure) => failure.message;

/** How the thread a move launched is doing there, from its `t3_thread_read` answer. */
const threadThereFrom = ({ thread, recentRuns }: OrchestratorMcpThreadReadResult) =>
  threadThere({
    worktreePath: thread.worktreePath,
    firstRun: recentRuns.find((run) => run.ordinal === 1) ?? null,
  });

const linkFailure = (message: string) =>
  new OrchestratorMcpFailure({ code: "orchestration_error", message });

export const makeOverflowMover = Effect.fn("makeOverflowMover")(function* (host: OverflowHost) {
  const limits = yield* ResourceLimits;
  const settings = yield* ServerSettings.ServerSettingsService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const threadLocks = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const { readJson, writeJson } = yield* makeJsonFiles;
  const environment = yield* Effect.serviceOption(ServerEnvironment.ServerEnvironment);
  const hereId = Option.isSome(environment)
    ? yield* environment.value.getEnvironmentId
    : "this environment";
  const movedFile = path.join(config.stateDir, "resource-limits", "moved.json");
  // The file is the record: what a restart left under way carries on from its phase, and skipped threads keep waiting.
  const file = yield* readJson(movedFile);
  const saved = movedThreads(file);
  yield* limits.update((snapshot) => ({ ...snapshot, moved: saved }));
  const retryAt = yield* Ref.make(moveRetries(file));
  // When each moved thread there was last seen busy, or landed, by its ID there, for `busyThere`. A restart starts
  // from each move's start time, the only one moved.json keeps, so a thread that just moved still counts.
  const lastBusy = yield* Ref.make<ReadonlyMap<string, number>>(
    new Map(
      [...saved.values()].flatMap((entry) =>
        entry.phase === "moved" && entry.threadId !== null ? [[entry.threadId, entry.at]] : [],
      ),
    ),
  );
  /** Marks these threads there busy at `now`, dropping marks too old to count. */
  const sawBusy = (threadIds: Iterable<string>, now: number) =>
    Ref.update(
      lastBusy,
      (current) =>
        new Map(
          [...current, ...[...threadIds].map((threadId) => [threadId, now] as const)].filter(
            ([, at]) => now - at < TIMING.movedSessionMs,
          ),
        ),
    );
  // Once a call to the linked machine times out, the rest of the pass doesn't wait on it again.
  const stalled = yield* Ref.make(false);

  /** A call to the linked machine, bounded so a stall can't hold the governor's pass. */
  const call = Effect.fn("Overflow.call")(function* <A>(
    effect: Effect.Effect<A, OrchestratorMcpFailure>,
  ) {
    if (yield* Ref.get(stalled)) {
      return yield* linkFailure("The linked environment stopped answering earlier this pass.");
    }
    return yield* effect.pipe(
      Effect.timeoutOrElse({
        duration: Duration.millis(TIMING.overflowCallMs),
        orElse: () =>
          Ref.set(stalled, true).pipe(
            Effect.andThen(
              Effect.fail(
                linkFailure(
                  `The linked environment didn't answer within ${TIMING.overflowCallMs / 1000} s.`,
                ),
              ),
            ),
          ),
      }),
    );
  });

  const dispatch = (
    command: Parameters<ThreadManagement.ThreadManagementService["Service"]["dispatch"]>[0],
  ) =>
    threads.dispatch(command).pipe(
      Effect.as(true),
      Effect.catchCause((cause) =>
        Effect.logWarning("resource-limits.dispatch-failed", { type: command.type, cause }).pipe(
          Effect.as(false),
        ),
      ),
    );

  const write = (
    moved: ReadonlyMap<ThreadId, MovedThread>,
    retries: ReadonlyMap<ThreadId, number>,
  ) =>
    writeJson(movedFile, {
      version: 2,
      // A claim has sent nothing yet, so a restart forgets it.
      threads: Object.fromEntries([...moved].filter(([, entry]) => entry.phase !== "claiming")),
      retryAt: Object.fromEntries(retries),
    });

  const skip = Effect.fn("Overflow.skip")(function* (
    threadId: ThreadId,
    reason: string,
    now: number,
  ) {
    yield* Effect.logInfo("resource-limits.move-skipped", { threadId, reason });
    const retries = yield* Ref.updateAndGet(
      retryAt,
      (current) =>
        new Map(
          [...current, [threadId, now + TIMING.moveRetryMs] as const].filter(([, at]) => at > now),
        ),
    );
    // Kept in memory even when the file can't be written; a restart then looks at the thread again.
    yield* write((yield* limits.read).moved, retries);
  });

  /** Saves the change to `moved.json`, then applies it here; nothing changes when the file can't be written. */
  const save = Effect.fn("Overflow.save")(function* (
    threadId: ThreadId,
    entry: MovedThread | null,
  ) {
    const next = new Map((yield* limits.read).moved);
    if (entry === null) next.delete(threadId);
    else next.set(threadId, entry);
    if (!(yield* write(next, yield* Ref.get(retryAt)))) return false;
    yield* limits.update((snapshot) => {
      const moved = new Map(snapshot.moved);
      if (entry === null) moved.delete(threadId);
      else moved.set(threadId, entry);
      return { ...snapshot, moved };
    });
    return true;
  });

  /** Ends a claim that didn't become a move; admission holds nothing more for it. */
  const release = (threadId: ThreadId) =>
    limits.update((snapshot) => {
      if (snapshot.moved.get(threadId)?.phase !== "claiming") return snapshot;
      const moved = new Map(snapshot.moved);
      moved.delete(threadId);
      return { ...snapshot, moved };
    });

  const runsOf = (threadId: ThreadId) =>
    Effect.map(projections.getThreadRecords(threadId, ["runs"]), ({ runs }) => runs);

  const queuedOf = Effect.fn("Overflow.queuedOf")(function* (threadId: ThreadId) {
    const queued = (yield* runsOf(threadId))
      .filter((run) => run.status === "queued")
      .toSorted(
        (left, right) =>
          (left.queuePosition ?? left.ordinal) - (right.queuePosition ?? right.ordinal),
      );
    const { messages } =
      queued.length === 0
        ? { messages: [] }
        : yield* projections.getThreadRecords(threadId, ["messages"], {
            messageIds: queued.map((run) => run.userMessageId),
          });
    return queued.flatMap((run) => {
      const message = messages.find((candidate) => candidate.id === run.userMessageId);
      return message === undefined ? [] : [{ run, message }];
    });
  });

  const messageOfRun = Effect.fn("Overflow.messageOfRun")(function* (
    threadId: ThreadId,
    runId: string,
  ) {
    const run = (yield* runsOf(threadId)).find((candidate) => candidate.id === runId);
    if (run === undefined) return undefined;
    const { messages } = yield* projections.getThreadRecords(threadId, ["messages"], {
      messageIds: [run.userMessageId],
    });
    return messages.find((candidate) => candidate.id === run.userMessageId);
  });

  // fork: thread tags, see FORK.md. Tags still in settings count until they move onto the thread.
  const tagsOf = Effect.fn("Overflow.tagsOf")(function* (threadId: ThreadId) {
    const shell = yield* projections.getThreadShell(threadId);
    const { threadTags } = yield* settings.getSettings;
    return [...(shell?.tags ?? []), ...(threadTags[threadId] ?? [])];
  });

  /**
   * Installs the guard and reads the batch under the thread's command lock, which admission and Resume take too: a
   * run admitted before the claim has started by the time this reads, and one after it is held.
   */
  const claim = Effect.fn("Overflow.claim")(function* (
    threadId: ThreadId,
    entry: MovedThread,
    tagBlocker: (tags: ReadonlyArray<string>) => string | null,
  ) {
    return yield* threadLocks.withLock(
      threadId,
      Effect.gen(function* () {
        // fork: thread tags, see FORK.md. `thread.tag.set` takes this lock, so a tag set since the first look counts.
        const blocker = tagBlocker(yield* tagsOf(threadId));
        if (blocker !== null) return { blocker };
        yield* limits.update((snapshot) => ({
          ...snapshot,
          moved: new Map(snapshot.moved).set(threadId, entry),
        }));
        const live = (yield* runsOf(threadId)).some((run) => LIVE_RUN.has(run.status));
        const held = (yield* queuedOf(threadId)).filter(({ message }) => !isBufferedWake(message));
        return { live, held };
      }),
    );
  });

  /** The thread's history, as a provider switch hands it on. */
  const summaryOf = Effect.fn("Overflow.summaryOf")(function* (threadId: ThreadId) {
    const { runs, turnItems } = yield* projections.getThreadRecords(threadId, [
      "runs",
      "turnItems",
    ]);
    const executed = runs.filter((run) => run.status !== "queued");
    if (executed.length === 0) return "";
    const ordinals = executed.map((run) => run.ordinal);
    const executedIds = new Set(executed.map((run) => run.id));
    const items = turnItems.filter((item) => item.runId === null || executedIds.has(item.runId));
    const selected = selectHistory({
      messages: items.flatMap((item) => {
        const message = historicalMessage(item);
        return message === null ? [] : [message];
      }),
      coverage: handoffCoverage({
        threadId,
        coveredRunOrdinals: { from: Math.min(...ordinals), to: Math.max(...ordinals) },
        items,
      }),
      budget: DEFAULT_HANDOFF_TOKEN_CAP,
    });
    return renderHistory(selected.messages, selected.context);
  });

  /**
   * Cancels a run here under a key, so repeating a cancel that already went through succeeds. False when it failed:
   * `ours` says whether the run is still queued for this machine to cancel later, rather than cancelled or started by
   * someone else.
   */
  const cancel = Effect.fn("Overflow.cancel")(function* (
    threadId: ThreadId,
    runId: string,
    key: string,
  ) {
    const cancelled = yield* dispatch({
      type: "queued-run.cancel",
      commandId: CommandId.make(`${key}:${runId}`),
      threadId,
      runId: RunId.make(runId),
    });
    if (cancelled) return { cancelled: true, retry: false };
    const run = (yield* runsOf(threadId)).find((candidate) => candidate.id === runId);
    return { cancelled: false, retry: run?.status === "queued" };
  });

  const outgoingText = (
    entry: MovedThread,
    out: Outgoing,
    message: {
      readonly text: string;
      readonly attachments: ReadonlyArray<{ readonly name: string }>;
    },
  ) => {
    const attached = message.attachments.map((attachment) => attachment.name);
    const text =
      attached.length === 0
        ? message.text
        : `${message.text}\n\n[Attachments left on the original machine: ${attached.join(", ")}]`;
    return out.edited
      ? `A message this thread started with was edited on ${entry.machine} before the move finished. It now reads:\n\n${text}`
      : text;
  };

  /**
   * Sends what's queued on a moved thread there, in order. Each run joins the outbox in `moved.json`, is cancelled
   * here, and only then is its text read and sent, so an edit can't land between the send and the cancel, and a crash
   * between them still sends it. Stops at the first failure.
   */
  const forward = Effect.fn("Overflow.forward")(function* (
    threadId: ThreadId,
    start: MovedThread,
    shell: OrchestrationV2ThreadShell,
  ) {
    let entry = start;
    const batch = new Set(entry.batch.map(({ runId }) => runId));
    const waiting = new Set(entry.outbox.map(({ runId }) => runId));
    const queued = yield* queuedOf(threadId);
    const arrived = queued.filter(
      ({ run, message }) =>
        // Its turn already started here; holdQueuedRun lets it run.
        !isBufferedWake(message) &&
        !batch.has(run.id) &&
        !message.id.startsWith(MOVE_NOTE_PREFIX) &&
        !waiting.has(run.id),
    );
    if (arrived.length > 0) {
      const next: MovedThread = {
        ...entry,
        outbox: [...entry.outbox, ...arrived.map(({ run }) => ({ runId: run.id, edited: false }))],
      };
      if (!(yield* save(threadId, next))) return;
      entry = next;
    }
    // The move's note leaves only its notice; a batch run still queued went with the launch.
    for (const { run, message } of queued) {
      if (batch.has(run.id) || message.id.startsWith(MOVE_NOTE_PREFIX)) {
        yield* cancel(threadId, run.id, "limits:forward-cancel");
      }
    }
    for (const out of entry.outbox) {
      const cancelled = yield* cancel(
        threadId,
        out.runId,
        out.edited ? "limits:move-cancel" : "limits:forward-cancel",
      );
      if (!cancelled.cancelled && cancelled.retry) return;
      const message = cancelled.cancelled ? yield* messageOfRun(threadId, out.runId) : undefined;
      if (message !== undefined) {
        const sent = yield* call(
          host.send(entry.environmentId as EnvironmentId, modesOf(shell), {
            threadId: entry.threadId!,
            message: outgoingText(entry, out, message),
            // A retry after a lost reply finds the same message there; cancelled, its text no longer changes.
            clientRequestId: `${out.edited ? "limits-edit" : "limits-forward"}:${out.runId}`,
          }),
        ).pipe(Effect.result);
        if (sent._tag === "Failure") {
          yield* Effect.logWarning("resource-limits.forward-failed", {
            threadId,
            reason: failureMessage(sent.failure),
          });
          return;
        }
        yield* Effect.logInfo("resource-limits.forwarded", { threadId, runId: out.runId });
      }
      // Someone else cancelled or started it, so it isn't this machine's to send.
      const next: MovedThread = {
        ...entry,
        outbox: entry.outbox.filter((candidate) => candidate.runId !== out.runId),
      };
      if (!(yield* save(threadId, next))) return;
      entry = next;
    }
  });

  /** Gives up a move whose thread there didn't start: the batch stays held here, and the thread waits to try again. */
  const abandon = Effect.fn("Overflow.abandon")(function* (
    threadId: ThreadId,
    reason: string,
    now: number,
  ) {
    if (!(yield* save(threadId, null))) return;
    yield* skip(threadId, reason, now);
  });

  /** One step of one move, from its saved phase, carrying on while each succeeds. True when it launched or landed. */
  const step = Effect.fn("Overflow.step")(function* (
    threadId: ThreadId,
    now: number,
    paused: boolean,
  ) {
    let entry = (yield* limits.read).moved.get(threadId);
    if (entry === undefined || entry.phase === "claiming") return false;
    const shell = yield* projections
      .getThreadShell(threadId)
      .pipe(Effect.orElseSucceed(() => null));
    if (shell === null || shell.deletedAt !== null) {
      if (entry.phase !== "moved") yield* abandon(threadId, "the thread is gone", now);
      return false;
    }
    const target = entry.environmentId as EnvironmentId;
    const modes = modesOf(shell);
    let stepped = false;
    if (entry.phase === "pending") {
      // Pause all quiets this machine's work, and a move that hasn't launched is new work; the switch is read again
      // since the pass began.
      if (paused || (yield* limits.refreshPause) !== null) return false;
      const launched = yield* call(host.launch(target, modes, entry.launch!)).pipe(Effect.result);
      if (launched._tag === "Failure") {
        if (isDefiniteRefusal(launched.failure)) {
          yield* abandon(
            threadId,
            `the linked machine refused the launch: ${failureMessage(launched.failure)}`,
            now,
          );
          return false;
        }
        // It may have taken the launch and lost the reply, so the batch stays held here until it answers. The same
        // key finds the same thread there, however long that takes.
        yield* Effect.logWarning("resource-limits.move-launch-waiting", {
          threadId,
          waitingMs: now - entry.at,
          reason: failureMessage(launched.failure),
        });
        return false;
      }
      const next: MovedThread = {
        ...entry,
        phase: "launched",
        launch: null,
        threadId: launched.success.threadId,
        link: launched.success.link,
      };
      if (!(yield* save(threadId, next))) return false;
      entry = next;
      stepped = true;
    }
    if (entry.phase === "launched") {
      const there = yield* call(host.readThere(target, modes, entry.threadId!)).pipe(
        Effect.map(threadThereFrom),
        Effect.result,
      );
      if (there._tag === "Failure") {
        yield* Effect.logWarning("resource-limits.move-read-failed", {
          threadId,
          reason: failureMessage(there.failure),
        });
        return stepped;
      }
      if (there.success.state === "starting") return stepped;
      if (there.success.state === "failed") {
        yield* abandon(threadId, `the thread there failed: ${there.success.reason}`, now);
        return stepped;
      }
      const next: MovedThread = { ...entry, phase: "confirmed" };
      if (!(yield* save(threadId, next))) return stepped;
      entry = next;
    }
    if (entry.phase === "confirmed") {
      // What it carried there leaves the queue here. A batch message edited since the launch goes there again as it
      // now reads; cancelled, it can't change after this.
      const runs = yield* runsOf(threadId);
      const edited: Array<Outgoing> = [];
      for (const { runId, text } of entry.batch) {
        const run = runs.find((candidate) => candidate.id === runId);
        if (run === undefined || (run.status !== "queued" && run.status !== "cancelled")) continue;
        const cancelled = yield* cancel(threadId, runId, "limits:move-cancel");
        if (!cancelled.cancelled) {
          if (cancelled.retry) return stepped;
          continue;
        }
        const message = text === null ? undefined : yield* messageOfRun(threadId, runId);
        if (message !== undefined && message.text !== text) edited.push({ runId, edited: true });
      }
      // Held with the moved notice, which stays as the thread's last item once forwarding cancels it.
      const noted = yield* dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`${MOVE_NOTE_PREFIX}${threadId}:${entry.at}`),
        messageId: MessageId.make(`${MOVE_NOTE_PREFIX}${threadId}:${entry.at}`),
        threadId,
        text: `Moved to ${entry.machine}.`,
        notification: {
          source: { kind: "system" },
          outcome: "updated",
          summary: `Continues on ${entry.machine}`,
          detail: entry.link ?? entry.threadId!,
        },
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
      });
      if (!noted) return stepped;
      const next: MovedThread = {
        ...entry,
        phase: "moved",
        outbox: [...edited, ...entry.outbox],
      };
      if (!(yield* save(threadId, next))) return stepped;
      entry = next;
      stepped = true;
      yield* sawBusy([entry.threadId!], now);
      yield* Effect.logInfo("resource-limits.moved", {
        threadId,
        environmentId: target,
        threadIdThere: entry.threadId,
      });
    }
    yield* forward(threadId, entry, shell);
    return stepped;
  });

  /** A failed read or write leaves the move in its phase for the next pass. */
  const stepOrLog = (threadId: ThreadId, now: number, paused: boolean) =>
    step(threadId, now, paused).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("resource-limits.move-step-failed", { threadId, cause }).pipe(
          Effect.as(false),
        ),
      ),
    );

  const advance: OverflowMover["advance"] = Effect.fn("Overflow.advance")(function* (now, paused) {
    yield* Ref.set(stalled, false);
    let stepped = false;
    for (const threadId of (yield* limits.read).moved.keys()) {
      if (yield* stepOrLog(threadId, now, paused)) stepped = true;
    }
    return stepped;
  });

  /**
   * Claims a thread that passed the checks needing no batch, reads its batch under the claim, and starts the move.
   * "next" looks at the next candidate, "stop" ends moving for this pass.
   */
  const start = Effect.fn("Overflow.start")(function* (input: {
    readonly threadId: ThreadId;
    readonly shell: OrchestrationV2ThreadShell;
    /** The pushed branch it starts from there, or the project it starts in there without a checkout. */
    readonly from:
      | {
          readonly cwd: string;
          readonly upstream: Upstream;
          readonly head: string;
          readonly remote: string;
        }
      | {
          readonly checkoutFree: {
            readonly repository: string;
            readonly project: string;
            readonly note: string | null;
          };
        };
    readonly target: EnvironmentId;
    readonly projectId: ProjectId;
    readonly modelSelection: ModelSelection;
    readonly now: number;
    /** fork: thread tags, see FORK.md. The move rules again, on the tags read under the claim. */
    readonly tagBlocker: (tags: ReadonlyArray<string>) => string | null;
  }) {
    const { threadId, shell, now } = input;
    const claimed: MovedThread = {
      phase: "claiming",
      environmentId: input.target,
      machine: yield* host.label(input.target),
      at: now,
      batch: [],
      launch: null,
      threadId: null,
      link: null,
      outbox: [],
    };
    const underClaim = yield* claim(threadId, claimed, input.tagBlocker);
    if ("blocker" in underClaim) {
      return yield* skip(threadId, underClaim.blocker, now).pipe(Effect.as("next" as const));
    }
    const { live, held } = underClaim;
    if (live) return yield* skip(threadId, "it started here", now).pipe(Effect.as("next" as const));
    if (held.length === 0) {
      return yield* skip(threadId, "nothing is held", now).pipe(Effect.as("next" as const));
    }
    if (held.some(({ message }) => message.attachments.length > 0)) {
      return yield* skip(threadId, "a held message has attachments", now).pipe(
        Effect.as("next" as const),
      );
    }
    const from = input.from;
    const localBranch =
      "checkoutFree" in from ? null : movedBranchName(from.upstream.branch, threadId, now);
    const brief = moveBrief({
      title: shell.title,
      threadId,
      environmentId: hereId,
      machine: (yield* limits.read).machine,
      summary: yield* summaryOf(threadId).pipe(Effect.orElseSucceed(() => "")),
      held: held.map(({ message }) => message.text),
      ...("checkoutFree" in from
        ? { checkoutFree: from.checkoutFree }
        : {
            remote: from.remote,
            remoteBranch: from.upstream.branch,
            localBranch: localBranch!,
            head: from.head,
          }),
    });
    if (brief === null) {
      return yield* skip(
        threadId,
        "its held messages are too long to send in one message",
        now,
      ).pipe(Effect.as("next" as const));
    }
    if (!("checkoutFree" in from)) {
      // The thread there starts from the branch on its remote, which a rewind or force-push may have taken this
      // checkout's commit out of. The brief still has the thread there check it.
      const remoteHead = yield* call(host.remoteHead(from.cwd, from.upstream, from.head)).pipe(
        Effect.result,
      );
      if (remoteHead._tag === "Failure") {
        return yield* skip(
          threadId,
          `its remote couldn't be read: ${failureMessage(remoteHead.failure)}`,
          now,
        ).pipe(Effect.as("next" as const));
      }
      const rewound = remoteHeadBlocker({ head: from.head, ...remoteHead.success });
      if (rewound !== null)
        return yield* skip(threadId, rewound, now).pipe(Effect.as("next" as const));
    }
    // Pause all may have been switched on during the reads.
    if ((yield* limits.refreshPause) !== null) return "stop" as const;
    const pending: MovedThread = {
      ...claimed,
      phase: "pending",
      batch: held.map(({ run, message }) => ({ runId: run.id, text: message.text })),
      launch: {
        projectId: input.projectId,
        title: shell.title,
        modelSelection: input.modelSelection,
        // Without a strategy it starts in the project's own folder there.
        ...("checkoutFree" in from
          ? {}
          : {
              // Named as a remote branch there, so the launch fetches it rather than following a local branch's
              // tracking.
              workspaceStrategy: {
                type: "worktree" as const,
                baseRef: `${from.remote}/${from.upstream.branch}`,
                branch: localBranch!,
                startFromOrigin: true,
              },
            }),
        message: brief,
        // A retry after a lost reply finds the same thread there; a later move of this thread is a new one.
        clientRequestId: `limits-move:${threadId}:${now}`,
      },
    };
    if (!(yield* save(threadId, pending))) {
      yield* skip(threadId, "moved.json couldn't be written", now);
      return "stop" as const;
    }
    yield* stepOrLog(threadId, now, false);
    return "started" as const;
  });

  /**
   * True when `maxBusy` moves to `target` are busy there, which a capped pass logs. Unread, every moved thread counts
   * as busy, so the linked machine is asked only once there are `maxBusy` of them, in one read however many have
   * moved; a failed or partial read counts them all.
   */
  const capped = Effect.fn("Overflow.capped")(function* (
    target: EnvironmentId,
    maxBusy: number,
    now: number,
  ) {
    const moves = [...(yield* limits.read).moved.values()];
    if (busyThere(moves, target, null) < maxBusy) return false;
    const listed = yield* call(host.threadsThere(target, READ_MODES, BUSY_THERE)).pipe(
      Effect.result,
    );
    const page = listed._tag === "Success" ? listed.success : null;
    const busy = new Set<string>(page?.threads.map((thread) => thread.threadId));
    // A partial page still saw the threads it lists busy.
    yield* sawBusy(
      moves.flatMap(({ phase, threadId }) =>
        phase === "moved" && threadId !== null && busy.has(threadId) ? [threadId] : [],
      ),
      now,
    );
    const count = busyThere(
      moves,
      target,
      page?.nextCursor === null ? { busy, lastBusy: yield* Ref.get(lastBusy), now } : null,
    );
    if (count < maxBusy) return false;
    // Not a skip: every thread keeps its place, with no wait, for the pass that finds room.
    yield* Effect.logInfo("resource-limits.move-capped", {
      busy: count,
      maxBusy,
      ...(listed._tag === "Failure"
        ? { reason: failureMessage(listed.failure) }
        : listed.success.nextCursor !== null
          ? { reason: "more threads are busy there than one read lists" }
          : {}),
    });
    return true;
  });

  const move: OverflowMover["move"] = Effect.fn("Overflow.move")(function* (candidates, now) {
    const current = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => null));
    const overflow = current?.resourceLimits.overflow;
    if (current === null) return null;
    if (overflow === undefined || overflow.mode === "off") return null;
    const { moved } = yield* limits.read;
    // One move at a time.
    if ([...moved.values()].some((entry) => entry.phase !== "moved")) return null;
    const moveAfterMs = overflow.moveAfterMs ?? OVERFLOW_DEFAULTS.moveAfterMs;
    const rules = {
      provides: overflow.provides ?? [],
      assumeNeeds: overflow.assumeNeeds ?? OVERFLOW_DEFAULTS.assumeNeeds,
    };
    const waitUntil = yield* Ref.get(retryAt);
    const due = candidates.filter(
      (candidate) =>
        !moved.has(candidate.threadId) &&
        now - candidate.heldAt >= moveAfterMs &&
        (waitUntil.get(candidate.threadId) ?? 0) <= now,
    );
    const target = overflow.environmentId;
    const maxBusy = overflow.maxBusy ?? OVERFLOW_DEFAULTS.maxBusy;
    let room = false;
    let providers: MoveTarget["providers"] | undefined;
    for (const { threadId } of due) {
      const shell = yield* projections
        .getThreadShell(threadId)
        .pipe(Effect.orElseSucceed(() => null));
      if (shell === null) continue;
      const project = yield* host.project(shell.projectId);
      // A first look; the batch itself is read again under the claim.
      const held = (yield* queuedOf(threadId).pipe(Effect.orElseSucceed(() => []))).filter(
        ({ message }) => !isBufferedWake(message),
      );
      if (project === null || held.length === 0) {
        yield* skip(threadId, project === null ? "its project is gone" : "nothing is held", now);
        continue;
      }
      const cwd = shell.worktreePath ?? project.workspaceRoot;
      const checkoutFree =
        overflow.checkoutFree === undefined
          ? null
          : checkoutFreeRepository(
              { repositoryKey: project.repositoryKey, worktree: shell.worktreePath !== null },
              overflow.checkoutFree.repositories,
            );
      const git = checkoutFree === null ? yield* host.gitStatus(cwd) : null;
      const candidate: MoveCandidate = {
        topLevel: shell.lineage.parentThreadId == null && shell.delegatedFrom === undefined,
        // fork: thread tags, see FORK.md. Tags still in settings count until they move onto the thread.
        tags: [...(shell.tags ?? []), ...(current.threadTags[threadId] ?? [])],
        git,
        worktree: shell.worktreePath !== null,
        checkoutFree: checkoutFree !== null,
        heldAttachments: held.reduce((sum, { message }) => sum + message.attachments.length, 0),
        model: shell.modelSelection,
      };
      const blocker = moveBlocker(candidate, rules);
      if (blocker !== null) {
        yield* skip(threadId, blocker, now);
        continue;
      }
      // Only a thread that may move asks the linked machine, and its answer stands for the rest of the pass.
      if (!room) {
        if (yield* capped(target, maxBusy, now)) return null;
        room = true;
      }
      const modes = modesOf(shell);
      const there = yield* Effect.gen(function* () {
        providers ??= yield* call(host.providersThere(target, modes));
        const rest = { providers, fallbackModel: overflow.fallbackModel ?? null };
        if (checkoutFree !== null && overflow.checkoutFree !== undefined) {
          const { project: name, note } = overflow.checkoutFree;
          const projects = yield* call(host.projectsNamed(target, modes, name));
          const plan = checkoutFreePlan(
            { model: candidate.model, project: name },
            { ...rest, projects },
          );
          if ("blocker" in plan) return plan;
          return {
            use: plan.use,
            projectId: projects[0]!.id,
            from: { checkoutFree: { repository: checkoutFree, project: name, note: note ?? null } },
          };
        }
        // moveBlocker checked the branch, its upstream and its commit.
        const { upstream, head } = git! as { readonly upstream: Upstream; readonly head: string };
        const projects =
          project.repositoryKey === null
            ? []
            : yield* call(host.projectsThere(target, modes, project.repositoryKey));
        const plan = movePlan({ model: candidate.model, upstream }, { ...rest, projects });
        if ("blocker" in plan) return plan;
        return {
          use: plan.use,
          projectId: projects[0]!.id,
          from: { cwd, upstream, head, remote: plan.remote },
        };
      }).pipe(Effect.result);
      if (there._tag === "Failure") {
        // The machine isn't answering, so nothing else moves this pass.
        yield* skip(threadId, `the linked machine: ${failureMessage(there.failure)}`, now);
        return null;
      }
      const plan = there.success;
      if ("blocker" in plan) {
        yield* skip(threadId, plan.blocker, now);
        continue;
      }
      const started = yield* start({
        threadId,
        shell,
        from: plan.from,
        target,
        projectId: plan.projectId,
        modelSelection:
          plan.use === "fallback" && overflow.fallbackModel !== undefined
            ? overflow.fallbackModel
            : shell.modelSelection,
        now,
        tagBlocker: (tags) => moveBlocker({ ...candidate, tags }, rules),
      }).pipe(
        Effect.ensuring(release(threadId)),
        Effect.catchCause((cause) =>
          Effect.logWarning("resource-limits.move-failed", { threadId, cause }).pipe(
            Effect.as("stop" as const),
          ),
        ),
      );
      if (started === "started") return threadId;
      if (started === "stop") return null;
    }
    return null;
  });

  return { move, advance } satisfies OverflowMover;
});

/** The host the server runs with: git and projects here, and the linked machine's T3 tools. */
const makeLiveHost = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const identities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const links = yield* PeerLinks.PeerLinks;
  const peers = yield* PeerMcpClient.PeerMcpClient;

  const requireLinks = links.enabled.pipe(
    Effect.flatMap((enabled) =>
      enabled
        ? Effect.void
        : Effect.fail(
            new OrchestratorMcpFailure({
              code: "capability_denied",
              message: "Linked environments are turned off here.",
            }),
          ),
    ),
  );

  const listThere = Effect.fn("Overflow.listThere")(function* (
    environmentId: EnvironmentId,
    modes: Modes,
  ) {
    yield* requireLinks;
    const tool = ProjectToolkit.tools.t3_project_list;
    const found: Array<(typeof tool.successSchema.Type)["projects"][number]> = [];
    let cursor: number | null = 0;
    while (cursor !== null) {
      const listed: typeof tool.successSchema.Type = yield* peers.call({
        environmentId,
        tool: tool.name,
        arguments: { cursor, limit: 100 },
        limits: modes,
        success: tool.successSchema,
      });
      found.push(...listed.projects);
      cursor = listed.nextCursor;
    }
    return found;
  });

  return {
    project: (projectId) =>
      projects.getById(projectId).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.flatMap((project) =>
          project === undefined
            ? Effect.succeed(null)
            : identities.resolve(project.workspaceRoot).pipe(
                Effect.map((identity) => ({
                  workspaceRoot: project.workspaceRoot,
                  repositoryKey: identity?.canonicalKey ?? null,
                })),
              ),
        ),
        Effect.orElseSucceed(() => null),
      ),
    gitStatus: Effect.fn("Overflow.gitStatus")(
      function* (cwd) {
        const status = yield* git.statusDetails(cwd);
        if (!status.isRepo) return null;
        const read = (args: ReadonlyArray<string>) =>
          git
            .execute({ operation: "Overflow.gitStatus", cwd, args, allowNonZeroExit: true })
            .pipe(Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : null)));
        // The branch's own config, not `<remote>/<branch>` split at a slash, since remote names may hold one.
        const tracked =
          status.branch === null
            ? null
            : upstreamOf({
                remote: yield* read(["config", "--get", `branch.${status.branch}.remote`]),
                merge: yield* read(["config", "--get", `branch.${status.branch}.merge`]),
              });
        const url =
          tracked === null ? null : yield* read(["remote", "get-url", "--", tracked.remote]);
        return {
          branch: status.branch,
          isDefaultBranch: status.isDefaultBranch,
          hasWorkingTreeChanges: status.hasWorkingTreeChanges,
          upstream:
            tracked === null || !status.hasUpstream
              ? null
              : {
                  ...tracked,
                  repositoryKey:
                    url === null || url === ""
                      ? null
                      : sourceControlDefinitions.repositoryKeyFromRemote(url),
                },
          aheadCount: status.aheadCount,
          head: yield* read(["rev-parse", "--verify", "HEAD^{commit}"]),
        };
      },
      Effect.orElseSucceed(() => null),
    ),
    remoteHead: Effect.fn("Overflow.remoteHead")(
      function* (cwd, upstream, head) {
        const run = (args: ReadonlyArray<string>) =>
          git.execute({
            operation: "Overflow.remoteHead",
            cwd,
            args,
            allowNonZeroExit: true,
            timeoutMs: TIMING.overflowCallMs,
          });
        const ref = `refs/heads/${upstream.branch}`;
        const listed = yield* run(["ls-remote", "--", upstream.remote, ref]);
        if (listed.exitCode !== 0) {
          return yield* linkFailure(
            `git ls-remote ${upstream.remote} failed: ${listed.stderr.trim()}`,
          );
        }
        const remoteHead =
          listed.stdout
            .split("\n")
            .map((line) => line.split("\t"))
            .find(([, name]) => name?.trim() === ref)?.[0]
            ?.trim() ?? null;
        if (remoteHead === null || remoteHead === head) {
          return { remoteHead, containsHead: remoteHead === head };
        }
        const known = yield* run(["cat-file", "-e", `${remoteHead}^{commit}`]);
        if (known.exitCode !== 0) return { remoteHead, containsHead: null };
        const contains = yield* run(["merge-base", "--is-ancestor", head, remoteHead]);
        return {
          remoteHead,
          containsHead: contains.exitCode === 0 ? true : contains.exitCode === 1 ? false : null,
        };
      },
      Effect.catchTags({
        GitCommandError: (error) => Effect.fail(linkFailure(error.message)),
      }),
    ),
    label: (environmentId) =>
      links.get(environmentId).pipe(
        Effect.map((link) => (Option.isSome(link) ? link.value.label : environmentId)),
        Effect.orElseSucceed(() => environmentId),
      ),
    projectsThere: Effect.fn("Overflow.projectsThere")(function* (environmentId, modes, key) {
      return (yield* listThere(environmentId, modes)).flatMap((project) => {
        const identity = project.repositoryIdentity;
        if (identity?.canonicalKey !== key) return [];
        // The remotes the identity names: its primary one, and origin when that's another repository.
        const remotes = new Map([[identity.canonicalKey, identity.locator.remoteName]]);
        if (identity.origin !== undefined) remotes.set(identity.origin.canonicalKey, "origin");
        return [{ id: project.id, remotes }];
      });
    }),
    projectsNamed: Effect.fn("Overflow.projectsNamed")(function* (environmentId, modes, name) {
      // Archived projects are out of use, and a project a shifting page listed twice is still one.
      const listed = [
        ...new Map(
          (yield* listThere(environmentId, modes))
            .filter((project) => !project.archivedAt)
            .map((project) => [project.id, project]),
        ).values(),
      ];
      const byId = listed.filter((project) => project.id === name);
      return (byId.length > 0 ? byId : listed.filter((project) => project.title === name)).map(
        (project) => ({ id: project.id }),
      );
    }),
    providersThere: (environmentId, modes) =>
      requireLinks.pipe(
        Effect.andThen(
          peers.call({
            environmentId,
            tool: "orchestrator_capabilities",
            arguments: {},
            limits: modes,
            success: OrchestratorMcpCapabilitiesResult,
          }),
        ),
        Effect.map((result) =>
          result.providers.map((provider) => ({
            instanceId: provider.providerInstanceId,
            models: provider.models.map((model) => model.id),
            omittedModels: provider.omittedModels ?? 0,
          })),
        ),
      ),
    launch: (environmentId, modes, input) =>
      requireLinks.pipe(
        // A link removed here reads as an unknown one, which isn't the linked machine refusing the launch.
        Effect.andThen(
          links.get(environmentId).pipe(
            Effect.orElseSucceed(() => Option.none()),
            Effect.flatMap((link) =>
              Option.isSome(link)
                ? Effect.void
                : Effect.fail(linkFailure("The link to that environment is gone.")),
            ),
          ),
        ),
        Effect.andThen(
          peers.call({
            environmentId,
            tool: ProjectToolkit.tools.t3_thread_launch.name,
            arguments: {
              ...input,
              runtimeMode: modes.runtimeMode,
              interactionMode: modes.interactionMode,
            },
            limits: modes,
            success: ProjectToolkit.tools.t3_thread_launch.successSchema,
          }),
        ),
        Effect.map((launched) => ({ threadId: launched.threadId, link: launched.link ?? null })),
      ),
    readThere: (environmentId, modes, threadId) =>
      requireLinks.pipe(
        Effect.andThen(
          peers.call({
            environmentId,
            tool: "t3_thread_read",
            arguments: { threadId, view: "messages", limit: 1, maxCharsPerItem: 1, runLimit: 50 },
            limits: modes,
            success: OrchestratorMcpThreadReadResult,
          }),
        ),
      ),
    threadsThere: (environmentId, modes, statuses) =>
      requireLinks.pipe(
        Effect.andThen(
          peers.call({
            environmentId,
            tool: "t3_thread_list",
            arguments: { allProjects: true, statuses, limit: 100 },
            limits: modes,
            success: OrchestratorMcpThreadListResult,
          }),
        ),
      ),
    send: (environmentId, modes, input) =>
      requireLinks.pipe(
        Effect.andThen(
          peers.call({
            environmentId,
            tool: "t3_thread_send",
            arguments: { ...input, mode: "queue" },
            limits: modes,
            success: OrchestratorMcpThreadSendResult,
          }),
        ),
        Effect.asVoid,
      ),
  } satisfies OverflowHost;
});

/** Hands the governor a mover once the links are up; without this layer nothing moves. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const limits = yield* ResourceLimits;
    const mover = yield* makeOverflowMover(yield* makeLiveHost);
    yield* limits.setOverflow(mover);
  }),
);
