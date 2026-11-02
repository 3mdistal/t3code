/**
 * fork: the SQLite writer on its own thread, so a stalled disk cannot stop the event loop. See FORK.md.
 *
 * The worker owns the writer's `DatabaseSync`. Each statement is one round trip, and the caller holds
 * the client's writer lock across it, so statements still run one at a time and in order.
 */
import * as NodeWorkerThreads from "node:worker_threads";

import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import { identity } from "effect/Function";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Client from "effect/sql/SqlClient";
import type { Connection } from "effect/sql/SqlConnection";
import type { SqlError } from "effect/sql/SqlError";

// Inline worker source also runs in bundles and single-executable builds without module files.
const writerWorkerSource = `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync, constants } = require("node:sqlite");
let db;
let frames;
let sizeLimit;
let active;
const statements = new Map();
const classifications = new WeakMap();
// Keep in step with the authorizer in nodeSqliteClient.ts, which classifies the main-thread writer.
const mutatingPragmasWithValues = new Set([
  "application_id",
  "auto_vacuum",
  "journal_mode",
  "schema_version",
  "user_version",
]);
const mutatesPragma = (name, value) => {
  if (name === null || name === undefined) return false;
  const pragma = name.toLowerCase();
  if (pragma === "incremental_vacuum" || pragma === "optimize") return true;
  if (pragma === "wal_checkpoint") return value === null || value.toLowerCase() !== "noop";
  return value !== null && mutatingPragmasWithValues.has(pragma);
};
const authorize = (actionCode, action, argument) => {
  const classification = active;
  if (classification === undefined) return constants.SQLITE_OK;
  if (actionCode === constants.SQLITE_PRAGMA) classification.pragma = true;
  if (actionCode === constants.SQLITE_TRANSACTION) {
    classification.backpressure ||= action === "BEGIN";
    classification.check ||= action === "COMMIT" || action === "ROLLBACK";
  } else if (actionCode === constants.SQLITE_SAVEPOINT) {
    classification.backpressure ||= action === "BEGIN";
    classification.check = true;
  } else if (actionCode === constants.SQLITE_PRAGMA && mutatesPragma(action, argument)) {
    classification.backpressure = true;
    classification.check = true;
  } else if (
    actionCode !== constants.SQLITE_READ &&
    actionCode !== constants.SQLITE_SELECT &&
    actionCode !== constants.SQLITE_FUNCTION &&
    actionCode !== constants.SQLITE_RECURSIVE &&
    actionCode !== constants.SQLITE_PRAGMA
  ) {
    classification.backpressure = true;
    classification.check = true;
  }
  return constants.SQLITE_OK;
};
const withClassification = (classification, f) => {
  const previous = active;
  active = classification;
  try {
    return f();
  } finally {
    active = previous;
  }
};
const failure = (operation, error) => ({
  operation,
  message: String(error && error.message ? error.message : error),
  code: error && error.code,
  errcode: error && error.errcode,
  errstr: error && error.errstr,
});
const measure = () => {
  const measured = {};
  try {
    const state = frames.get();
    measured.wal = { log: state.log, checkpointed: state.checkpointed };
  } catch {
    measured.wal = null;
  }
  try {
    measured.journalSizeLimit = sizeLimit.get().journal_size_limit;
  } catch {
    measured.journalSizeLimit = null;
  }
  return measured;
};
const prepareClassified = (sql) => {
  const classification = { backpressure: false, check: false, pragma: false };
  const statement = withClassification(classification, () => db.prepare(sql));
  classifications.set(statement, classification);
  return statement;
};
const prepare = (sql, cached) => {
  if (!cached) return prepareClassified(sql);
  let statement = statements.get(sql);
  if (statement === undefined) {
    statement = prepareClassified(sql);
    if (statements.size >= workerData.prepareCacheSize) statements.delete(statements.keys().next().value);
  } else {
    statements.delete(sql);
  }
  statements.set(sql, statement);
  return statement;
};
const state = (classification) => ({
  isTransaction: db.isTransaction,
  ...(frames !== undefined &&
  classification !== undefined &&
  !db.isTransaction &&
  (classification.check || classification.pragma)
    ? measure()
    : {}),
});
const execute = ({ id, sql, params, cached, values, raw, safeIntegers }) => {
  let classification;
  let result;
  let operation = "prepare";
  try {
    const statement = prepare(sql, cached);
    classification = classifications.get(statement);
    operation = "execute";
    result = withClassification(classification, () => {
      statement.setReadBigInts(safeIntegers);
      if (statement.columns().length > 0) {
        statement.setReturnArrays(values);
        return { rows: statement.all(...params) };
      }
      const outcome = statement.run(...params);
      return { rows: raw ? outcome : [] };
    });
  } catch (error) {
    result = { error: failure(operation, error) };
  }
  // OR FAIL may have committed earlier rows even when execution throws.
  parentPort.postMessage({
    id,
    ...result,
    ...(classification === undefined
      ? {}
      : { backpressure: classification.backpressure, check: classification.check }),
    ...state(classification),
  });
};
try {
  db = new DatabaseSync(workerData.filename, {
    readOnly: workerData.readOnly,
    allowExtension: false,
  });
  const version = String(db.prepare("SELECT sqlite_version() AS version").get().version);
  const [major = 0, minor = 0] = version.split(".").map(Number);
  const coordinated = typeof db.isTransaction === "boolean" && typeof db.setAuthorizer === "function";
  // Older SQLite treats NOOP as PASSIVE, which would checkpoint on this connection.
  if (coordinated && (major > 3 || (major === 3 && minor >= 51))) {
    frames = db.prepare("PRAGMA wal_checkpoint(NOOP)");
    sizeLimit = db.prepare("PRAGMA journal_size_limit");
  }
  parentPort.postMessage({
    type: "ready",
    version,
    coordinated,
    ...(frames === undefined ? {} : measure()),
  });
} catch (error) {
  parentPort.postMessage({ type: "unavailable", message: String(error && error.message ? error.message : error) });
}
parentPort.on("message", (message) => {
  switch (message.type) {
    case "authorize":
      db.setAuthorizer(authorize);
      return;
    case "exec":
      try {
        db.exec(message.sql);
      } catch {}
      return;
    case "classify":
      try {
        const classification = classifications.get(prepare(message.sql, true));
        parentPort.postMessage({
          id: message.id,
          rows: [],
          backpressure: classification.backpressure,
          check: classification.check,
          isTransaction: db.isTransaction,
        });
      } catch (error) {
        parentPort.postMessage({ id: message.id, error: failure("prepare", error) });
      }
      return;
    case "close":
      try {
        statements.clear();
        db.close();
        parentPort.postMessage({ id: message.id, rows: [] });
      } catch (error) {
        parentPort.postMessage({ id: message.id, error: failure("close", error) });
      }
      return;
    default:
      execute(message);
  }
});
`;

/** What the checkpoint coordinator reads from its writer. A `DatabaseSync` already fits. */
export interface CheckpointWriter {
  readonly isTransaction: boolean;
  readonly setAuthorizer: unknown;
  prepare(sql: string): { get(): Record<string, unknown> | undefined };
  exec(sql: string): void;
}

interface CheckpointCoordinator {
  readonly check: () => void;
  readonly settle: () => void;
  readonly retire: () => void;
  readonly runWithAdmission: <A, E>(execute: () => Effect.Effect<A, E>) => Effect.Effect<A, E>;
}

// Passed in because nodeSqliteClient.ts imports this file.
interface WriterWorkerDependencies {
  readonly startCheckpointWorker: (
    filename: string,
    writer: CheckpointWriter,
  ) => Effect.Effect<CheckpointCoordinator | undefined, never, Scope.Scope>;
  readonly failed: (cause: unknown, message: string, operation: string) => SqlError;
  readonly hasLargeBinding: (params: ReadonlyArray<unknown>) => boolean;
  readonly unsupportedStream: () => unknown;
}

type WalState = { readonly log: unknown; readonly checkpointed: unknown } | null;

type Startup =
  | {
      readonly type: "ready";
      readonly version: string;
      readonly coordinated: boolean;
      readonly wal?: WalState;
      readonly journalSizeLimit?: unknown;
    }
  | { readonly type: "unavailable"; readonly message: string };

type Operation = "prepare" | "execute" | "close";

type Reply = {
  readonly id: number;
  readonly rows?: ReadonlyArray<any>;
  readonly error?: {
    readonly operation: Operation;
    readonly message: string;
    readonly code?: unknown;
    readonly errcode?: unknown;
    readonly errstr?: unknown;
  };
  readonly backpressure?: boolean;
  readonly check?: boolean;
  readonly isTransaction?: boolean;
  readonly wal?: WalState;
  readonly journalSizeLimit?: unknown;
};

type Message =
  | {
      readonly type?: undefined;
      readonly sql: string;
      readonly params: ReadonlyArray<unknown>;
      readonly cached: boolean;
      readonly values: boolean;
      readonly raw: boolean;
    }
  | { readonly type: "classify"; readonly sql: string }
  | { readonly type: "close" };

const failureMessages = {
  prepare: "Failed to prepare statement",
  execute: "Failed to execute statement",
  close: "Failed to close database",
} as const;

const CLASSIFICATION_CACHE_SIZE = 1000;

// A transaction on a stopped worker is already gone, so its cleanup has nothing left to do. A COMMIT
// still fails, because nothing was saved.
const endsWithoutWriter = (sql: string) => /^\s*ROLLBACK\b/i.test(sql);

/** Returns `undefined` when the worker cannot start, so the caller opens the writer as usual. */
export const makeWriterWorkerConnection = Effect.fnUntraced(function* (
  options: {
    readonly filename: string;
    readonly readonly?: boolean | undefined;
    readonly checkpointWorker?: boolean | undefined;
  },
  dependencies: WriterWorkerDependencies,
) {
  const { failed, hasLargeBinding, startCheckpointWorker, unsupportedStream } = dependencies;
  const unavailable = (reason: string) =>
    Effect.logWarning("SQLite writer worker unavailable; writes run on the main connection", {
      reason,
    }).pipe(Effect.as(undefined));

  // Cleaned up from here on, so cancelling startup can't leave the worker holding the database open.
  const spawned = yield* Effect.acquireRelease(
    Effect.result(
      Effect.try(
        () =>
          new NodeWorkerThreads.Worker(writerWorkerSource, {
            eval: true,
            workerData: {
              filename: options.filename,
              readOnly: options.readonly ?? false,
              prepareCacheSize: 200,
            },
          }),
      ),
    ),
    (result) =>
      Result.isSuccess(result) ? Effect.promise(() => result.success.terminate()) : Effect.void,
  );
  if (Result.isFailure(spawned)) return yield* unavailable(String(spawned.failure.cause));
  const worker = spawned.success;

  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  let announce: (startup: Startup) => void = () => {};
  const started = new Promise<Startup>((resolve) => {
    announce = resolve;
  });
  let coordinator: CheckpointCoordinator | undefined;
  let serving = false;
  let closing = false;
  let stoppedMessage: string | undefined;
  let nextRequestId = 0;
  let inTransaction = false;
  let wal: WalState | undefined;
  let journalSizeLimit: unknown;
  const classifications = new Map<string, { backpressure: boolean; check: boolean }>();
  const pending = new Map<
    number,
    {
      readonly message: Message;
      readonly done: Deferred.Deferred<ReadonlyArray<any>, SqlError>;
    }
  >();

  const remember = (sql: string, classification: { backpressure: boolean; check: boolean }) => {
    classifications.delete(sql);
    if (classifications.size >= CLASSIFICATION_CACHE_SIZE) {
      classifications.delete(classifications.keys().next().value!);
    }
    classifications.set(sql, classification);
  };

  const stoppedFailure = (message: string) =>
    failed(new Error(message), failureMessages.execute, "execute");

  const stop = (message: string) => {
    if (stoppedMessage !== undefined) return;
    stoppedMessage = message;
    inTransaction = false;
    announce({ type: "unavailable", message });
    for (const request of pending.values()) {
      Deferred.doneUnsafe(
        request.done,
        "sql" in request.message && endsWithoutWriter(request.message.sql)
          ? Effect.succeed([])
          : Effect.fail(stoppedFailure(message)),
      );
    }
    pending.clear();
    coordinator?.retire();
    if (serving && !closing) {
      runFork(
        Effect.logError("SQLite writer worker stopped; database writes fail until T3 restarts", {
          reason: message,
        }),
      );
    }
  };

  worker.on("message", (reply: Reply | Startup) => {
    if ("type" in reply) {
      announce(reply);
      return;
    }
    const request = pending.get(reply.id);
    if (request === undefined) return;
    pending.delete(reply.id);
    if (pending.size === 0) worker.unref();
    if (reply.isTransaction !== undefined) inTransaction = reply.isTransaction;
    if (reply.wal !== undefined) wal = reply.wal;
    if (reply.journalSizeLimit !== undefined) journalSizeLimit = reply.journalSizeLimit;
    if ("sql" in request.message && reply.backpressure !== undefined) {
      remember(request.message.sql, {
        backpressure: reply.backpressure,
        check: reply.check === true,
      });
    }
    try {
      // The coordinator sees the new WAL state before the caller or the next writer continues.
      if (request.message.type === undefined && reply.check === true) coordinator?.check();
      else coordinator?.settle();
    } finally {
      if (reply.error === undefined) {
        Deferred.doneUnsafe(request.done, Effect.succeed(reply.rows ?? []));
      } else {
        const { operation, message, ...codes } = reply.error;
        Deferred.doneUnsafe(
          request.done,
          Effect.fail(
            failed(Object.assign(new Error(message), codes), failureMessages[operation], operation),
          ),
        );
      }
    }
  });
  worker.on("error", (cause) => stop(`Database writer failed: ${cause.message}`));
  worker.on("exit", (code) => stop(`Database writer exited with code ${code}`));

  // Posts right away, as a synchronous statement would run: nothing can happen between the checkpoint
  // coordinator admitting a statement and the statement counting as on the worker. Waiting is
  // uninterruptible, so the caller keeps the writer lock until the worker has finished. The worker runs
  // messages in order, so nothing can overtake a statement either way.
  const start = (
    message: Message,
    safeIntegers: boolean,
  ): Effect.Effect<ReadonlyArray<any>, SqlError> => {
    if (stoppedMessage !== undefined) {
      return "sql" in message && endsWithoutWriter(message.sql)
        ? Effect.succeed([])
        : Effect.fail(stoppedFailure(stoppedMessage));
    }
    const done = Deferred.makeUnsafe<ReadonlyArray<any>, SqlError>();
    const id = nextRequestId++;
    pending.set(id, { message, done });
    if (pending.size === 1) worker.ref();
    try {
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
      worker.postMessage({ id, safeIntegers, ...message });
    } catch (cause) {
      pending.delete(id);
      if (pending.size === 0) worker.unref();
      return Effect.fail(failed(cause, failureMessages.execute, "execute"));
    }
    return Effect.uninterruptible(Deferred.await(done));
  };

  const usesSafeIntegers = (fiber: Fiber.Fiber<unknown, unknown>) =>
    Boolean(Context.get(fiber.context, Client.SafeIntegers));

  const send = (message: Message) =>
    Effect.withFiber<ReadonlyArray<any>, SqlError>((fiber) =>
      start(message, usesSafeIntegers(fiber)),
    );

  const post = (message: { readonly type: "authorize" | "exec"; readonly sql?: string }) => {
    if (stoppedMessage !== undefined) return;
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
    worker.postMessage(message);
  };

  const startupTimeout = Duration.seconds(10);
  const startup = yield* Effect.timeoutOption(
    Effect.promise(() => started),
    startupTimeout,
  );
  if (Option.isNone(startup) || startup.value.type !== "ready") {
    void worker.terminate();
    return yield* unavailable(
      Option.isSome(startup) && startup.value.type === "unavailable"
        ? startup.value.message
        : `worker did not open the database within ${Duration.toMillis(startupTimeout)} ms`,
    );
  }
  const { coordinated, version } = startup.value;
  wal = startup.value.wal;
  journalSizeLimit = startup.value.journalSizeLimit;
  serving = true;
  worker.unref();

  // Added before the coordinator starts, so its worker stops before the writer closes.
  yield* Effect.addFinalizer(() =>
    Effect.suspend(() => {
      closing = true;
      if (stoppedMessage !== undefined) return Effect.void;
      return send({ type: "close" }).pipe(
        Effect.ensuring(Effect.promise(() => worker.terminate())),
        Effect.orDie,
      );
    }),
  );

  // Answers the coordinator's synchronous reads from what the worker last reported. While a statement
  // is on the worker the state is unknown, so it counts as a transaction: nothing checkpoints against
  // it and no truncate is acknowledged until it returns.
  const writer: CheckpointWriter = {
    get isTransaction() {
      return (coordinated ? inTransaction || pending.size > 0 : undefined) as boolean;
    },
    setAuthorizer: coordinated ? () => {} : undefined,
    prepare(sql) {
      switch (sql) {
        case "SELECT sqlite_version() AS version":
          return { get: () => ({ version }) };
        case "PRAGMA wal_checkpoint(NOOP)":
          return { get: () => wal ?? undefined };
        case "PRAGMA journal_size_limit":
          return { get: () => ({ journal_size_limit: journalSizeLimit }) };
        default:
          throw new Error(`The SQLite writer worker does not report: ${sql}`);
      }
    },
    exec(sql) {
      post({ type: "exec", sql });
    },
  };
  coordinator = options.checkpointWorker
    ? yield* startCheckpointWorker(options.filename, writer)
    : undefined;
  if (coordinator !== undefined) post({ type: "authorize" });

  const needsAdmission = (sql: string) => {
    const known = classifications.get(sql);
    if (known !== undefined) return Effect.succeed(known.backpressure);
    return Effect.map(send({ type: "classify", sql }), () => {
      return classifications.get(sql)?.backpressure ?? true;
    });
  };

  const run = (
    sql: string,
    params: ReadonlyArray<unknown>,
    mode: { readonly cached: boolean; readonly values: boolean; readonly raw: boolean },
  ) =>
    Effect.withFiber<ReadonlyArray<any>, SqlError>((fiber) => {
      const safeIntegers = usesSafeIntegers(fiber);
      const message: Message = {
        sql,
        params,
        cached: mode.cached && !hasLargeBinding(params),
        values: mode.values,
        raw: mode.raw,
      };
      const running = coordinator;
      // A stopped worker fails its statements at once, whatever the checkpoint gate is doing.
      if (running === undefined || stoppedMessage !== undefined) {
        return start(message, safeIntegers);
      }
      return Effect.flatMap(needsAdmission(sql), (admit) =>
        admit
          ? running.runWithAdmission(() => start(message, safeIntegers))
          : start(message, safeIntegers),
      );
    });

  return identity<Connection>({
    execute(sql, params, rowTransform) {
      const effect = run(sql, params, { cached: true, values: false, raw: false });
      return rowTransform ? Effect.map(effect, rowTransform) : effect;
    },
    executeRaw(sql, params) {
      return run(sql, params, { cached: true, values: false, raw: true });
    },
    executeValues(sql, params) {
      return run(sql, params, { cached: true, values: true, raw: false });
    },
    executeValuesUnprepared(sql, params) {
      return run(sql, params ?? [], { cached: false, values: true, raw: false });
    },
    executeUnprepared(sql, params, rowTransform) {
      const effect = run(sql, params ?? [], { cached: false, values: false, raw: false });
      return rowTransform ? Effect.map(effect, rowTransform) : effect;
    },
    executeStream(_sql, _params) {
      return Stream.die(unsupportedStream());
    },
  });
});
