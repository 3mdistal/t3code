// fork: limits. What each governor pass decided, and where the one under way is, kept in `passes.json` so a stall
// can be read after the fact; see FORK.md.
import type {
  ProviderSessionId,
  ResourceLimitsPause,
  ResourceLimitsState,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Ref from "effect/Ref";

import { makeJsonFiles } from "./jsonFiles.ts";

const RECORD_VERSION = 1;
// A pass runs every 15 s, and a run of passes that decide the same thing is one entry, so this covers days.
export const MAX_PASSES = 1_024;
// An await shows in the file once it has lasted this long, so a quick pass writes nothing while it runs.
export const PHASE_WRITE_MS = 1_000;
// A run of passes that decide the same thing is written again at most this often.
const REPEAT_WRITE_MS = 60_000;
// A write that failed is tried again, in full, after this long.
const RETRY_WRITE_MS = 15_000;
const MAX_LISTED = 10;
const MAX_ERROR_CHARS = 1_000;
const MAX_FILE_BYTES = 8 * 1024 * 1024;

/** The await a pass is in. Each is set just before it, with the thread or session it's about. */
export type PassPhase =
  | "read"
  | "runtime"
  | "idle-sessions"
  | "inspect"
  | "lost-wake"
  | "unsnooze"
  | "snooze"
  | "sessions"
  | "inbox"
  | "interrupt"
  | "ranks"
  | "resume"
  | "overflow"
  | "state-file";

export interface PassTarget {
  readonly threadId?: ThreadId;
  readonly sessionId?: ProviderSessionId;
}

interface InFlight extends PassTarget {
  readonly server: string;
  readonly pass: number;
  readonly startedAt: number;
  readonly phase: PassPhase;
  readonly since: number;
}

export interface PassStart {
  readonly threadId: ThreadId;
  /** Null when no rank applies, or when the limits are off and everything starts unranked. */
  readonly rank: number | null;
  /** The thread the board ranks: itself, or the nearest ranked thread above it. */
  readonly rankFrom: ThreadId | null;
  readonly heldMs: number;
  readonly unsnooze: "none" | "ok" | "failed";
  readonly resume: "ok" | "failed";
}

export interface PassBlocked {
  readonly threadId: ThreadId;
  readonly runId: string;
  readonly status: string;
  /** When the blocking run started, or was asked for. */
  readonly since: number;
}

export type PassResult = "released" | "start failed" | "nothing held" | "none ready" | "not due";

export interface PassDecision {
  readonly readingAt: number | null;
  readonly headroomGiB: number | null;
  readonly availableGiB: number | null;
  /** The state the readings put the machine in. */
  readonly state: ResourceLimitsState;
  /** The state the pass acted on, which is "ok" without a fresh reading or while switched off. */
  readonly acting: ResourceLimitsState;
  readonly pause: ResourceLimitsPause["mode"] | null;
  readonly offUntil: number | null;
  readonly waiting: number;
  readonly held: number;
  readonly blocked: number;
  readonly dropped: number;
  readonly ready: number;
  readonly moving: number;
  readonly oldest: { readonly threadId: ThreadId; readonly heldMs: number } | null;
  readonly blockedBy: ReadonlyArray<PassBlocked>;
  /** How many threads the board's ranks file ranked, when the pass read it. */
  readonly ranks: number | null;
  readonly release: { readonly due: boolean; readonly why: string };
  readonly starts: ReadonlyArray<PassStart>;
  readonly result: PassResult;
}

interface RecordState {
  readonly current: InFlight | null;
  readonly passes: ReadonlyArray<object>;
  /** What the newest entry decided, when it can take more passes that decide the same. */
  readonly lastKey: string | null;
  readonly changed: boolean;
  readonly repeated: boolean;
  readonly written: {
    readonly current: InFlight | null;
    readonly at: number;
    readonly failed: boolean;
  };
}

const isObject = (value: unknown): value is object => typeof value === "object" && value !== null;

/** Passes that differ only in their times and readings share an entry. One that started anything is its own. */
const repeatKey = (server: string, decision: PassDecision) =>
  decision.starts.length > 0
    ? null
    : JSON.stringify([
        server,
        decision.readingAt === null,
        decision.state,
        decision.acting,
        decision.pause,
        decision.offUntil,
        decision.waiting,
        decision.held,
        decision.blocked,
        decision.dropped,
        decision.ready,
        decision.moving,
        decision.oldest?.threadId ?? null,
        decision.blockedBy.map((entry) => [entry.threadId, entry.runId, entry.status]),
        decision.ranks,
        decision.release,
        decision.result,
      ]);

/** One entry a line, so the file reads with grep and tail as well as a JSON parser. */
const encode = (
  at: number,
  server: object,
  current: InFlight | null,
  passes: ReadonlyArray<object>,
) =>
  `{"version":${RECORD_VERSION},"source":"t3","at":${at},"server":${JSON.stringify(server)},` +
  `"current":${JSON.stringify(current)},"passes":[\n${passes.map((entry) => JSON.stringify(entry)).join(",\n")}\n]}\n`;

export const makePassRecord = Effect.fn("makePassRecord")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const { readJson, writeText } = yield* makeJsonFiles;
  const startedAt = yield* Clock.currentTimeMillis;
  const server = { id: `${process.pid}@${startedAt}`, pid: process.pid, startedAt };
  const passCount = yield* Ref.make(0);
  const record = yield* Ref.make<RecordState>({
    current: null,
    passes: [],
    lastKey: null,
    changed: false,
    repeated: false,
    written: { current: null, at: startedAt, failed: false },
  });

  /** Keeps the last server's passes, and marks the one it never finished. */
  const load = Effect.gen(function* () {
    const size = yield* fs.stat(file).pipe(
      Effect.map((info) => Number(info.size)),
      Effect.orElseSucceed(() => 0),
    );
    if (size === 0 || size > MAX_FILE_BYTES) return;
    const saved = yield* readJson(file);
    if (!isObject(saved)) return;
    const { version, at, passes, current } = saved as Record<string, unknown>;
    if (version !== RECORD_VERSION) return;
    const kept = Array.isArray(passes) ? passes.filter(isObject) : [];
    const unfinished = isObject(current)
      ? [{ ...current, result: "unfinished", seenAt: typeof at === "number" ? at : null }]
      : [];
    yield* Ref.update(record, (state) => ({
      ...state,
      passes: [...kept, ...unfinished, ...state.passes].slice(-MAX_PASSES),
      changed: state.changed || unfinished.length > 0,
    }));
  });

  const begin = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const pass = yield* Ref.updateAndGet(passCount, (count) => count + 1);
    yield* Ref.update(record, (state): RecordState => ({
      ...state,
      current: { server: server.id, pass, startedAt: now, phase: "read", since: now },
    }));
    return { pass, startedAt: now };
  });

  // No file work here: the pass only notes where it is, and `flush` writes from its own loop.
  const phase = (name: PassPhase, target: PassTarget = {}) =>
    Effect.flatMap(Clock.currentTimeMillis, (now) =>
      Ref.update(record, (state) =>
        state.current === null
          ? state
          : {
              ...state,
              current: {
                server: state.current.server,
                pass: state.current.pass,
                startedAt: state.current.startedAt,
                phase: name,
                since: now,
                ...target,
              },
            },
      ),
    );

  /** Null is a pass on a platform with no limits, which records nothing. */
  const finish = Effect.fn("ResourceLimitsPassRecord.finish")(function* (
    begun: { readonly pass: number; readonly startedAt: number },
    exit: Exit.Exit<PassDecision | null, unknown>,
  ) {
    // An interrupted pass stays in flight, and the next server marks it unfinished.
    if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) return;
    const now = yield* Clock.currentTimeMillis;
    const timing = {
      server: server.id,
      pass: begun.pass,
      startedAt: begun.startedAt,
      endedAt: now,
      ms: now - begun.startedAt,
    };
    yield* Ref.update(record, (state) => {
      const current = state.current?.pass === begun.pass ? null : state.current;
      if (Exit.isFailure(exit)) {
        const where = state.current?.pass === begun.pass ? state.current : null;
        const failed = {
          ...timing,
          result: "failed",
          phase: where?.phase ?? null,
          ...(where?.threadId === undefined ? {} : { threadId: where.threadId }),
          ...(where?.sessionId === undefined ? {} : { sessionId: where.sessionId }),
          error: Cause.pretty(exit.cause).slice(0, MAX_ERROR_CHARS),
        };
        return {
          ...state,
          current,
          passes: [...state.passes, failed].slice(-MAX_PASSES),
          lastKey: null,
          changed: true,
        };
      }
      if (exit.value === null) return { ...state, current };
      const decision = {
        ...exit.value,
        blockedBy: exit.value.blockedBy.slice(0, MAX_LISTED),
        starts: exit.value.starts.slice(0, MAX_LISTED),
      };
      const key = repeatKey(server.id, decision);
      const last = state.passes.at(-1) as Record<string, unknown> | undefined;
      if (key !== null && key === state.lastKey && last !== undefined) {
        const lastMs = typeof last.maxMs === "number" ? last.maxMs : Number(last.ms);
        const repeat = {
          server: server.id,
          pass: last.pass,
          lastPass: begun.pass,
          count: (typeof last.count === "number" ? last.count : 1) + 1,
          startedAt: last.startedAt,
          endedAt: now,
          ms: timing.ms,
          maxMs: Math.max(lastMs, timing.ms),
          ...decision,
        };
        return {
          ...state,
          current,
          passes: [...state.passes.slice(0, -1), repeat],
          repeated: true,
        };
      }
      return {
        ...state,
        current,
        passes: [...state.passes, { ...timing, ...decision }].slice(-MAX_PASSES),
        lastKey: key,
        changed: true,
      };
    });
  });

  /**
   * Writes the record when a pass has added to it, when the pass under way has waited a while, or now and then
   * through a run of repeats. It runs every second, so it has no span.
   */
  const flush = Effect.fnUntraced(function* (force = false) {
    const now = yield* Clock.currentTimeMillis;
    const text = yield* Ref.modify(record, (state): readonly [string | null, RecordState] => {
      const { current, written } = state;
      const due =
        force ||
        ((!written.failed || now - written.at >= RETRY_WRITE_MS) &&
          (state.changed ||
            (current !== written.current &&
              (current === null || now - current.since >= PHASE_WRITE_MS)) ||
            (state.repeated && now - written.at >= REPEAT_WRITE_MS)));
      return due
        ? [
            encode(now, server, current, state.passes),
            {
              ...state,
              changed: false,
              repeated: false,
              written: { current, at: now, failed: false },
            },
          ]
        : [null, state];
    });
    if (text === null || (yield* writeText(file, text))) return;
    yield* Ref.update(record, (state) => ({
      ...state,
      changed: true,
      written: { ...state.written, failed: true },
    }));
  });

  return { load, begin, phase, finish, flush };
});
