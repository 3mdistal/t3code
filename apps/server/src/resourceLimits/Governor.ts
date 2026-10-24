// fork: limits. Acts on each host reading: closes idle sessions, interrupts on the critical line,
// releases waiting threads, and publishes the state the session hook reads; see FORK.md.
import {
  CommandId,
  MessageId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { HostReadings } from "./HostReadings.ts";
import {
  averageCpu,
  effectiveLimits,
  GiB,
  headroomGiB,
  heldLaunchesNote,
  type HostReading,
  interruptedNote,
  latestUserMessage,
  launchAnyway,
  newestInterruptible,
  nextState,
  offUntil,
  type ResumeNote,
  type RunningTurn,
  TIMING,
} from "./policy.ts";
import { isOff, liveState, ResourceLimits, type WaitingThread } from "./ResourceLimits.ts";

/** A running session the hook may ask about, keyed by its provider's session id. */
interface SessionInfo {
  readonly threadId: ThreadId;
  readonly launchAnyway: boolean;
}

interface Memory {
  readonly cpuWindow: ReadonlyArray<number | null>;
  readonly lastReleaseAt: number | null;
  readonly lastInterruptAt: number | null;
  readonly interruptedRunIds: ReadonlyArray<string>;
  /** Per running turn and its latest message, so the transcript is read once per change. */
  readonly sessionCache: ReadonlyMap<
    string,
    { readonly nativeIds: ReadonlyArray<string> } & SessionInfo
  >;
}

interface Inspected {
  readonly entry: WaitingThread;
  readonly shell: OrchestrationV2ThreadShell | null;
  readonly queued: boolean;
  readonly held: boolean;
  readonly blocked: boolean;
  /** Upstream snoozes a thread with a queue only when every queued message is a notification. */
  readonly snoozable: boolean;
}

const STATE_VERSION = 1;
const Json = Schema.fromJsonString(Schema.Unknown, { space: 2 });
const decodeJson = Schema.decodeUnknownOption(Json);
const encodeJson = Schema.encodeEffect(Json);
const MAX_INTERRUPTED_RUN_IDS = 50;

const waitsOnAlice = (shell: OrchestrationV2ThreadShell) =>
  shell.pendingRuntimeRequest !== null && shell.pendingRuntimeRequest.blocking !== false;

const epoch = (value: DateTime.Utc | null | undefined) =>
  value === null || value === undefined ? null : DateTime.toEpochMillis(value);

export const make = Effect.fn("makeResourceLimitsGovernor")(function* () {
  const limits = yield* ResourceLimits;
  const settings = yield* ServerSettings.ServerSettingsService;
  const platform = yield* HostProcess.Platform;
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const environment = yield* Effect.serviceOption(ServerEnvironment.ServerEnvironment);

  // The memory gate's hook and CLI read and write these; see teenylilconfig docs/memgate.md.
  const dir = path.join(config.stateDir, "resource-limits");
  const files = {
    state: path.join(dir, "state.json"),
    off: path.join(dir, "off.json"),
    inbox: path.join(dir, "inbox"),
  };

  const memory = yield* Ref.make<Memory>({
    cpuWindow: [],
    lastReleaseAt: null,
    lastInterruptAt: null,
    interruptedRunIds: [],
    sessionCache: new Map(),
  });

  const readJson = (file: string) =>
    fs.readFileString(file).pipe(
      Effect.map((text) => Option.getOrNull(decodeJson(text))),
      Effect.orElseSucceed((): unknown => null),
    );

  // A temporary file and a rename, so the hook never reads half a file.
  const writeJson = Effect.fn("ResourceLimitsGovernor.writeJson")(
    function* (file: string, value: unknown) {
      yield* fs.makeDirectory(path.dirname(file), { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      yield* fs.writeFileString(temporary, `${yield* encodeJson(value)}\n`);
      yield* fs.rename(temporary, file);
    },
    (effect, file) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("resource-limits.write-failed", { file, cause }),
        ),
      ),
  );

  const dispatch = (
    command: Extract<OrchestrationV2ServerCommand, { readonly threadId: ThreadId }>,
  ) =>
    threads.dispatch(command).pipe(
      Effect.as(true),
      Effect.catchCause((cause) =>
        Effect.logWarning("resource-limits.dispatch-failed", {
          type: command.type,
          threadId: command.threadId,
          cause,
        }).pipe(Effect.as(false)),
      ),
    );

  // Sent like the restart continuation: a system notification, which doesn't end a snooze and
  // which upstream's snooze accepts in a queue.
  const queueNote = (threadId: ThreadId, id: string, note: ResumeNote) =>
    dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(id),
      messageId: MessageId.make(id),
      threadId,
      text: note.text,
      notification: {
        source: { kind: "system" },
        outcome: "updated",
        summary: note.summary,
        detail: note.text,
      },
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "agent",
      creationSource: "server",
    });

  /** Threads with a live run, a pending request, or a live session. */
  const runtimeShells = projections.getRecoveryThreadIds("runtime").pipe(
    Effect.flatMap((ids) =>
      Effect.forEach(ids, (id) =>
        projections.getThreadShell(id).pipe(Effect.orElseSucceed(() => null)),
      ),
    ),
    Effect.map((shells) =>
      shells.filter(
        (shell): shell is OrchestrationV2ThreadShell =>
          shell !== null && shell.archivedAt === null && shell.deletedAt === null,
      ),
    ),
    Effect.orElseSucceed((): ReadonlyArray<OrchestrationV2ThreadShell> => []),
  );

  const inspect = Effect.fn("ResourceLimitsGovernor.inspect")(function* (entry: WaitingThread) {
    const shell = yield* projections
      .getThreadShell(entry.threadId)
      .pipe(Effect.orElseSucceed(() => null));
    if (shell === null || shell.archivedAt !== null || shell.deletedAt !== null) {
      return {
        entry,
        shell: null,
        queued: false,
        held: false,
        blocked: false,
        snoozable: false,
      } satisfies Inspected;
    }
    const runs = yield* projections.getThreadRecords(entry.threadId, ["runs"]).pipe(
      Effect.map((records) => records.runs),
      Effect.orElseSucceed(() => []),
    );
    const queued = runs.filter((run) => run.status === "queued");
    const snoozable =
      queued.length > 0 &&
      !entry.snoozeTried &&
      shell.snoozedUntil == null &&
      (yield* projections
        .getThreadRecords(entry.threadId, ["messages"], {
          messageIds: queued.map((run) => run.userMessageId),
        })
        .pipe(
          Effect.map(
            ({ messages }) =>
              messages.length === queued.length &&
              messages.every(
                (message) =>
                  message.notification !== undefined || message.delegatedCompletion !== undefined,
              ),
          ),
          Effect.orElseSucceed(() => false),
        ));
    return {
      entry,
      shell,
      queued: queued.length > 0,
      held: queued.some((run) => run.queueHeld === true),
      blocked: runs.some((run) =>
        ["preparing", "starting", "running", "waiting"].includes(run.status),
      ),
      snoozable,
    } satisfies Inspected;
  });

  const ourSnooze = (inspected: Inspected) => {
    const ours =
      inspected.entry.snoozedUntil === null
        ? Option.none()
        : DateTime.make(inspected.entry.snoozedUntil);
    return (
      Option.isSome(ours) &&
      inspected.shell?.snoozedUntil != null &&
      epoch(inspected.shell.snoozedUntil) === DateTime.toEpochMillis(ours.value)
    );
  };

  const unsnooze = (inspected: Inspected, now: number) =>
    ourSnooze(inspected)
      ? dispatch({
          type: "thread.unsnooze",
          commandId: CommandId.make(`limits:unsnooze:${inspected.entry.threadId}:${now}`),
          threadId: inspected.entry.threadId,
          reason: "user",
        })
      : Effect.succeed(true);

  const sessionsFor = Effect.fn("ResourceLimitsGovernor.sessionsFor")(function* (
    shells: ReadonlyArray<OrchestrationV2ThreadShell>,
  ) {
    const cache = (yield* Ref.get(memory)).sessionCache;
    const next = new Map<string, { readonly nativeIds: ReadonlyArray<string> } & SessionInfo>();
    for (const shell of shells) {
      if (shell.activeRunId === null) continue;
      const key = `${shell.id}:${shell.activeRunId}:${epoch(shell.latestUserMessageAt) ?? ""}`;
      const known = cache.get(key);
      if (known !== undefined) {
        next.set(key, known);
        continue;
      }
      const records = yield* projections
        .getThreadRecords(shell.id, ["providerThreads", "messages", "runs"], {
          messageRoles: ["user"],
        })
        .pipe(Effect.option);
      if (Option.isNone(records)) continue;
      next.set(key, {
        threadId: shell.id,
        nativeIds: records.value.providerThreads.flatMap((thread) =>
          thread.nativeThreadRef?.nativeId ? [thread.nativeThreadRef.nativeId] : [],
        ),
        launchAnyway: launchAnyway(latestUserMessage(records.value.messages, records.value.runs)),
      });
    }
    yield* Ref.update(memory, (current) => ({ ...current, sessionCache: next }));
    const bySession: Record<string, SessionInfo> = {};
    for (const info of next.values()) {
      for (const nativeId of info.nativeIds) {
        bySession[nativeId] = { threadId: info.threadId, launchAnyway: info.launchAnyway };
      }
    }
    return bySession;
  });

  // The hook leaves one record per refused launch; each becomes part of a note its thread resumes with.
  const ingestInbox = Effect.fn("ResourceLimitsGovernor.ingestInbox")(function* (
    names: ReadonlyArray<string>,
    bySession: Readonly<Record<string, SessionInfo>>,
    now: number,
  ) {
    const launches = new Map<ThreadId, Array<string>>();
    for (const name of names) {
      const file = path.join(files.inbox, name);
      const record = yield* readJson(file);
      yield* fs.remove(file).pipe(Effect.ignore);
      const { sessionId, about, tool } = (record ?? {}) as {
        readonly sessionId?: unknown;
        readonly about?: unknown;
        readonly tool?: unknown;
      };
      const thread = typeof sessionId === "string" ? bySession[sessionId] : undefined;
      if (thread === undefined) {
        yield* Effect.logInfo("resource-limits.inbox-unmatched", { name });
        continue;
      }
      const label =
        typeof about === "string" && about.trim() !== ""
          ? about
          : typeof tool === "string"
            ? tool
            : "a subagent";
      launches.set(thread.threadId, [...(launches.get(thread.threadId) ?? []), label]);
    }
    for (const [threadId, labels] of launches) {
      yield* queueNote(
        threadId,
        `limits:launches:${threadId}:${now}`,
        heldLaunchesNote(labels, now),
      );
    }
  });

  const listInbox = fs.readDirectory(files.inbox).pipe(
    Effect.map((names) => names.filter((name) => name.endsWith(".json")).toSorted()),
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
  );

  const machineName = Option.match(environment, {
    onNone: () => Effect.succeed("This machine"),
    onSome: (service) => service.getDescriptor.pipe(Effect.map((descriptor) => descriptor.label)),
  });

  /** One pass over a reading, or over none when the sampler went quiet. */
  const pass = Effect.fn("ResourceLimitsGovernor.pass")(function* (reading: HostReading | null) {
    const now = yield* Clock.currentTimeMillis;
    const saved = yield* settings.getSettings.pipe(
      Effect.map((current) => current.resourceLimits),
      Effect.orElseSucceed(() => ({})),
    );
    const effective = effectiveLimits(saved, platform);
    if (effective === null) return;
    const switchedOffUntil = offUntil(yield* readJson(files.off), now);
    const remembered = yield* Ref.get(memory);
    const cpuWindow =
      reading === null
        ? remembered.cpuWindow
        : [...remembered.cpuWindow, reading.cpuUtilization].slice(-TIMING.cpuWindow);
    const cpuAverage = averageCpu(cpuWindow);
    const machine = yield* machineName;
    const previous = yield* limits.read;
    const next = {
      ...previous,
      limits: effective,
      reading,
      cpuAverage,
      offUntil: switchedOffUntil,
      machine,
      state: reading === null ? "ok" : nextState(previous.state, reading, effective, cpuAverage),
    } as const;
    const state = liveState(next, now);
    const off = isOff(next, now);

    const inbox = yield* listInbox;
    const runtime =
      state !== "ok" || previous.waiting.length > 0 || inbox.length > 0 ? yield* runtimeShells : [];

    // Every pass while over the limits, and before admission sees the new state, so idle sessions
    // go before any work waits.
    if (state !== "ok" && sessions.releaseIdleSessions !== undefined) {
      const closed = yield* sessions.releaseIdleSessions({
        keepThreadIds: new Set(runtime.filter(waitsOnAlice).map((shell) => shell.id)),
      });
      if (closed.length > 0) {
        yield* Effect.logInfo("resource-limits.closed-idle-sessions", { count: closed.length });
      }
    }
    const current = yield* limits.update((snapshot) => ({
      ...snapshot,
      limits: next.limits,
      reading: next.reading,
      cpuAverage: next.cpuAverage,
      offUntil: next.offUntil,
      machine: next.machine,
      state: next.state,
    }));

    // Drop threads with nothing left waiting, and snooze the rest out of Alice's inbox.
    const inspected = yield* Effect.forEach(current.waiting, inspect);
    const dropped = new Set<ThreadId>();
    const changed = new Map<ThreadId, WaitingThread>();
    for (const item of inspected) {
      if (item.shell === null || !item.queued) {
        dropped.add(item.entry.threadId);
        if (item.shell !== null) yield* unsnooze(item, now);
        continue;
      }
      if (item.held && !item.blocked && item.snoozable && !waitsOnAlice(item.shell)) {
        const until = DateTime.formatIso(DateTime.makeUnsafe(now + TIMING.snoozeMs));
        const snoozed = yield* dispatch({
          type: "thread.snooze",
          commandId: CommandId.make(`limits:snooze:${item.entry.threadId}:${item.entry.heldAt}`),
          threadId: item.entry.threadId,
          snoozedUntil: until,
        });
        changed.set(item.entry.threadId, {
          ...item.entry,
          snoozeTried: true,
          snoozedUntil: snoozed ? until : null,
        });
      }
    }

    const bySession = state !== "ok" || inbox.length > 0 ? yield* sessionsFor(runtime) : {};
    if (inbox.length > 0) yield* ingestInbox(inbox, bySession, now);

    // Critical: stop the newest running turn, one per interval, until memory is back.
    let lastInterruptAt = remembered.lastInterruptAt;
    let interruptedRunIds = remembered.interruptedRunIds;
    if (
      state === "critical" &&
      (lastInterruptAt === null || now - lastInterruptAt >= TIMING.interruptSpacingMs)
    ) {
      const turns: Array<RunningTurn> = runtime.flatMap((shell) =>
        shell.activeRunId !== null &&
        (shell.activityRunStatus === "starting" || shell.activityRunStatus === "running")
          ? [
              {
                threadId: shell.id,
                runId: shell.activeRunId,
                startedAt: epoch(shell.activityRunStartedAt ?? shell.latestRunStartedAt) ?? now,
                waitingOnUser: waitsOnAlice(shell),
                stopRequested:
                  shell.latestRunStopRequested === true && shell.latestRunId === shell.activeRunId,
              },
            ]
          : [],
      );
      const turn = newestInterruptible(turns, new Set(interruptedRunIds));
      if (turn !== undefined) {
        const { threadId, runId } = turn;
        // Interrupt only; holding the queue would also stop delegated tasks.
        const interrupted = yield* dispatch({
          type: "run.interrupt",
          commandId: CommandId.make(`limits:interrupt:${runId}`),
          threadId,
          runId,
          reason: `${machine} was critically low on memory.`,
        });
        if (interrupted) {
          yield* Effect.logWarning("resource-limits.interrupted", { threadId, runId });
          yield* queueNote(threadId, `limits:interrupted:${runId}`, interruptedNote(machine, now));
          lastInterruptAt = now;
          interruptedRunIds = [...interruptedRunIds, runId].slice(-MAX_INTERRUPTED_RUN_IDS);
        }
      }
    }

    // Release oldest first, spaced out, once the reading this pass took is back under the limits.
    let lastReleaseAt = remembered.lastReleaseAt;
    const released = new Set<ThreadId>();
    if (
      state === "ok" &&
      (off || lastReleaseAt === null || now - lastReleaseAt >= TIMING.releaseSpacingMs)
    ) {
      const ready = inspected.filter(
        (item) => !dropped.has(item.entry.threadId) && item.held && !item.blocked,
      );
      // Switched off, everything waiting goes at once.
      for (const item of off ? ready : ready.slice(0, 1)) {
        yield* unsnooze({ ...item, entry: changed.get(item.entry.threadId) ?? item.entry }, now);
        yield* dispatch({
          type: "queue.resume",
          commandId: CommandId.make(`limits:release:${item.entry.threadId}:${now}`),
          threadId: item.entry.threadId,
        });
        yield* Effect.logInfo("resource-limits.released", { threadId: item.entry.threadId });
        released.add(item.entry.threadId);
        lastReleaseAt = now;
      }
    }

    // Admission may have added threads during this pass, so only the ones handled here change.
    const published = yield* limits.update((snapshot) => ({
      ...snapshot,
      waiting: snapshot.waiting
        .filter((entry) => !dropped.has(entry.threadId) && !released.has(entry.threadId))
        .map((entry) => changed.get(entry.threadId) ?? entry),
    }));
    yield* Ref.update(memory, (latest) => ({
      ...latest,
      cpuWindow,
      lastReleaseAt,
      lastInterruptAt,
      interruptedRunIds,
    }));

    const headroom = reading === null ? null : headroomGiB(reading);
    yield* writeJson(files.state, {
      version: STATE_VERSION,
      source: "t3",
      at: now,
      machine,
      state,
      off: off ? switchedOffUntil : null,
      headroomGiB: headroom === null ? null : Math.round(headroom * 10) / 10,
      availableGiB: reading === null ? null : Math.round((reading.availableBytes / GiB) * 10) / 10,
      waiting: published.waiting,
      sessions: bySession,
      lastReleaseAt,
      lastInterruptAt,
      interruptedRunIds,
    });
  });

  /** Picks up the waiting list and timers a restart left behind. */
  const restore = Effect.gen(function* () {
    const saved = (yield* readJson(files.state)) as {
      readonly version?: unknown;
      readonly waiting?: unknown;
      readonly lastReleaseAt?: unknown;
      readonly lastInterruptAt?: unknown;
      readonly interruptedRunIds?: unknown;
    } | null;
    if (saved === null || saved.version !== STATE_VERSION) return;
    const number = (value: unknown) => (typeof value === "number" ? value : null);
    const waiting = Array.isArray(saved.waiting)
      ? saved.waiting.flatMap((entry: unknown): Array<WaitingThread> => {
          const { threadId, heldAt, snoozedUntil, snoozeTried } = (entry ?? {}) as Record<
            string,
            unknown
          >;
          return typeof threadId === "string" && typeof heldAt === "number"
            ? [
                {
                  threadId: threadId as ThreadId,
                  heldAt,
                  snoozedUntil: typeof snoozedUntil === "string" ? snoozedUntil : null,
                  snoozeTried: snoozeTried === true,
                },
              ]
            : [];
        })
      : [];
    yield* limits.update((snapshot) => ({ ...snapshot, waiting }));
    yield* Ref.update(memory, (current) => ({
      ...current,
      lastReleaseAt: number(saved.lastReleaseAt),
      lastInterruptAt: number(saved.lastInterruptAt),
      interruptedRunIds: Array.isArray(saved.interruptedRunIds)
        ? saved.interruptedRunIds.filter((id): id is string => typeof id === "string")
        : [],
    }));
  });

  return { pass, restore };
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const platform = yield* HostProcess.Platform;
    if (effectiveLimits({}, platform) === null) return;
    const readings = yield* HostReadings;
    const governor = yield* make();
    yield* governor.restore;
    yield* readings.next.pipe(
      // A sampler that goes quiet counts as no reading, which lets everything through.
      Effect.timeoutOption(Duration.millis(TIMING.staleReadingMs)),
      Effect.flatMap((reading) => governor.pass(Option.getOrNull(reading))),
      Effect.catchCause((cause) => Effect.logWarning("resource-limits.pass-failed", { cause })),
      Effect.forever,
      Effect.forkScoped,
    );
  }),
);
