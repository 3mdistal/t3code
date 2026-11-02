import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Scheduler from "effect/Scheduler";
import * as SqlClient from "effect/sql/SqlClient";
import type * as NodeWorkerThreads from "node:worker_threads";
import { vi } from "vite-plus/test";

import * as SqliteClient from "./nodeSqliteClient.ts";

const startedWorkers = vi.hoisted((): Array<NodeWorkerThreads.Worker> => []);
const replaced = vi.hoisted(() => ({
  checkpointSilent: false,
  writerThrows: undefined as string | undefined,
}));

vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeWorkerThreads>();
  class RecordedWorker extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      const source = String(args[0]);
      super(
        ...((replaced.checkpointSilent && source.includes("wal_checkpoint(TRUNCATE)")
          ? ["setInterval(() => {}, 1 << 30);", { eval: true }]
          : replaced.writerThrows !== undefined && source.includes("setAuthorizer(authorize)")
            ? [`throw new Error(${JSON.stringify(replaced.writerThrows)});`, { eval: true }]
            : args) as ConstructorParameters<typeof actual.Worker>),
      );
      startedWorkers.push(this);
    }
  }
  return { ...actual, Worker: RecordedWorker };
});

// oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- counts event loop turns; a blocked loop gets none.
const eventLoopTurn = Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));

const withWriterWorker = <A, E>(
  use: (sql: SqlClient.SqlClient, filename: string) => Effect.Effect<A, E, SqlClient.SqlClient>,
  options: { readonly checkpointWorker?: boolean } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-writer-" });
    const filename = path.join(directory, "state.sqlite");
    return yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA journal_mode = WAL`;
      yield* sql`CREATE TABLE entries(name TEXT NOT NULL)`;
      return yield* use(sql, filename);
    }).pipe(
      Effect.provide(
        SqliteClient.layer({
          filename,
          writerWorker: true,
          readerWorker: true,
          checkpointWorker: options.checkpointWorker ?? true,
        }),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const names = (sql: SqlClient.SqlClient) =>
  Effect.map(sql<{ name: string }>`SELECT name FROM entries ORDER BY name`, (rows) =>
    rows.map((row) => row.name),
  );

const slowRead = (sql: SqlClient.SqlClient) =>
  sql`WITH RECURSIVE counter(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM counter WHERE n < 3000000)
      SELECT COUNT(*) FROM counter`;

// Long enough on any machine to span many event loop turns, and it holds the writer the whole time.
const slowWrite = (sql: SqlClient.SqlClient) =>
  sql`WITH RECURSIVE counter(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM counter WHERE n < 3000000)
      INSERT INTO entries SELECT 'slow' FROM counter WHERE n = 3000000`;

it.effect("keeps the event loop turning while a write runs", () =>
  withWriterWorker((sql) =>
    Effect.gen(function* () {
      const write = yield* slowWrite(sql).pipe(Effect.forkChild({ startImmediately: true }));
      let turns = 0;
      while (write.pollUnsafe() === undefined) {
        yield* eventLoopTurn;
        turns++;
      }
      yield* Fiber.join(write);
      assert.isAbove(turns, 100);
      assert.deepEqual(yield* names(sql), ["slow"]);
    }),
  ),
);

it.effect("commits and rolls back a transaction on the worker", () =>
  withWriterWorker((sql) =>
    Effect.gen(function* () {
      yield* sql.withTransaction(sql`INSERT INTO entries VALUES ('kept')`);
      yield* sql
        .withTransaction(
          sql`INSERT INTO entries VALUES ('discarded')`.pipe(
            Effect.andThen(Effect.fail("undo" as const)),
          ),
        )
        .pipe(Effect.flip);
      assert.deepEqual(yield* names(sql), ["kept"]);
    }),
  ),
);

it.effect("finishes a write its caller stopped waiting for, in order", () =>
  withWriterWorker((sql) =>
    Effect.gen(function* () {
      // Once the statement is known, starting the fiber puts it on the worker straight away.
      yield* slowWrite(sql);
      const write = yield* slowWrite(sql).pipe(Effect.forkChild({ startImmediately: true }));
      yield* Fiber.interrupt(write);
      yield* sql`INSERT INTO entries VALUES ('after')`;
      assert.deepEqual(yield* names(sql), ["after", "slow", "slow"]);
    }),
  ),
);

it.effect("returns rows, values, integers and blobs as the main connection does", () =>
  withWriterWorker((sql) =>
    Effect.gen(function* () {
      yield* sql`CREATE TABLE typed(id INTEGER PRIMARY KEY, body BLOB, big INTEGER)`;
      const body = new Uint8Array([1, 2, 3]);
      yield* sql`INSERT INTO typed VALUES (${1}, ${body}, ${9007199254740993n})`;
      const row = (yield* sql<{ id: number; body: Uint8Array }>`SELECT id, body FROM typed`)[0];
      assert.equal(row?.id, 1);
      assert.deepEqual(Array.from(row?.body ?? []), [1, 2, 3]);
      assert.deepEqual(yield* sql`SELECT id FROM typed`.values, [[1]]);
      const big = yield* sql`SELECT big FROM typed`.values.pipe(
        Effect.provideService(SqlClient.SafeIntegers, true),
      );
      assert.deepEqual(big, [[9007199254740993n]]);
    }),
  ),
);

it.effect("reports a constraint failure like the main connection", () =>
  withWriterWorker((sql) =>
    Effect.gen(function* () {
      yield* sql`CREATE TABLE unique_names(name TEXT UNIQUE)`;
      yield* sql`INSERT INTO unique_names VALUES ('one')`;
      const failure = yield* sql`INSERT INTO unique_names VALUES ('one')`.pipe(Effect.flip);
      assert.equal(failure._tag, "SqlError");
      assert.equal(failure.reason._tag, "UniqueViolation");
    }),
  ),
);

it.effect("fails statements once the worker stops, and lets a transaction roll back", () =>
  withWriterWorker(
    (sql) =>
      Effect.gen(function* () {
        // Readers start on first use and this client has no checkpoint worker.
        const writerWorker = startedWorkers.at(-1);
        assert.isDefined(writerWorker);
        const outcome = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`INSERT INTO entries VALUES ('lost')`;
              yield* Effect.promise(() => writerWorker!.terminate());
              yield* sql`INSERT INTO entries VALUES ('never')`;
            }),
          )
          .pipe(Effect.flip);
        assert.equal(outcome._tag, "SqlError");
        const later = yield* sql`INSERT INTO entries VALUES ('later')`.pipe(Effect.flip);
        assert.equal(later._tag, "SqlError");
      }),
    { checkpointWorker: false },
  ),
);

const withSilentCheckpointWorker = <A, E>(
  use: (
    sql: SqlClient.SqlClient,
    acknowledged: () => number,
    worker: NodeWorkerThreads.Worker,
    writer: NodeWorkerThreads.Worker,
  ) => Effect.Effect<A, E, SqlClient.SqlClient>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      replaced.checkpointSilent = true;
    }),
    () =>
      withWriterWorker((sql) => {
        const worker = startedWorkers.at(-1)!;
        const posted = vi.spyOn(worker, "postMessage");
        const acknowledged = () =>
          posted.mock.calls.filter(([message]) => message?.type === "truncate").length;
        // The writer starts just before its checkpoint worker.
        return use(sql, acknowledged, worker, startedWorkers.at(-2)!);
      }),
    () =>
      Effect.sync(() => {
        replaced.checkpointSilent = false;
      }),
  );

const finishTruncate = (worker: NodeWorkerThreads.Worker, truncateId: number) =>
  worker.emit("message", {
    type: "checkpoint",
    truncateId,
    log: 0,
    checkpointed: 0,
    blocked: false,
  });

/** Counts the inserts sent to the writer from now on, which is what admission has to hold back. */
const countInserts = (writer: NodeWorkerThreads.Worker) => {
  const posted = vi.spyOn(writer, "postMessage");
  const before = posted.mock.calls.length;
  return () =>
    posted.mock.calls.slice(before).filter(([message]) => message?.sql?.startsWith("INSERT"))
      .length;
};

it.effect.each([
  { kind: "write", statement: slowWrite },
  { kind: "read", statement: slowRead },
] as const)("holds a truncate back until a $kind on the worker returns", ({ statement }) =>
  withSilentCheckpointWorker((sql, acknowledged, worker) =>
    Effect.gen(function* () {
      yield* statement(sql);
      const running = yield* statement(sql).pipe(Effect.forkChild({ startImmediately: true }));
      worker.emit("message", { type: "truncate-request", truncateId: 1 });
      assert.equal(acknowledged(), 0);
      yield* Fiber.join(running);
      assert.equal(acknowledged(), 1);
      finishTruncate(worker, 1);
    }),
  ),
);

it.effect("holds a truncate back through a transaction on the worker", () =>
  withSilentCheckpointWorker((sql, acknowledged, worker) =>
    Effect.gen(function* () {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT INTO entries VALUES ('inside')`;
          worker.emit("message", { type: "truncate-request", truncateId: 1 });
          yield* sql`INSERT INTO entries VALUES ('still inside')`;
          assert.equal(acknowledged(), 0);
        }),
      );
      assert.equal(acknowledged(), 1);
      finishTruncate(worker, 1);
      assert.deepEqual(yield* names(sql), ["inside", "still inside"]);
    }),
  ),
);

it.effect("makes a write wait for an acknowledged truncate", () =>
  withSilentCheckpointWorker((sql, acknowledged, worker, writer) =>
    Effect.gen(function* () {
      yield* sql`INSERT INTO entries VALUES ('known')`;
      const inserts = countInserts(writer);
      worker.emit("message", { type: "truncate-request", truncateId: 1 });
      assert.equal(acknowledged(), 1);
      const write = yield* sql`INSERT INTO entries VALUES ('known')`.pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* eventLoopTurn;
      assert.isUndefined(write.pollUnsafe());
      assert.equal(inserts(), 0);
      finishTruncate(worker, 1);
      yield* Fiber.join(write);
      assert.equal(inserts(), 1);
      assert.deepEqual(yield* names(sql), ["known", "known"]);
    }),
  ),
);

// Runs one operation per step and nothing between steps, so a message can land between any two.
class SteppingScheduler implements Scheduler.Scheduler {
  readonly executionMode = "async";
  private readonly tasks: Array<() => void> = [];
  private running = false;
  get idle() {
    return this.tasks.length === 0;
  }
  shouldYield(fiber: Fiber.Fiber<unknown, unknown>) {
    // A resumed fiber spends its first operation getting back to what it yielded before.
    return fiber.currentOpCount > 2;
  }
  makeDispatcher() {
    return {
      scheduleTask: (task: () => void) => {
        if (this.running) setImmediate(task);
        else this.tasks.push(task);
      },
      flush: () => {},
    };
  }
  step() {
    this.tasks.shift()?.();
  }
  /** Lets a failed test stop what it left on this scheduler, with nothing left to step it. */
  run() {
    this.running = true;
    for (const task of this.tasks.splice(0)) setImmediate(task);
  }
}

it.effect.each([
  { kind: "write", elected: false },
  { kind: "write elected after a wait", elected: true },
] as const)(
  "acknowledges no truncate between admitting a $kind and sending it to the worker",
  ({ elected }) =>
    withSilentCheckpointWorker((sql, acknowledged, worker, writer) => {
      let scheduler = new SteppingScheduler();
      return Effect.gen(function* () {
        const insert = sql`INSERT INTO entries VALUES ('known')`;
        yield* insert;
        let truncateId = 0;
        let everyStepTried = false;
        for (let steps = 0; !everyStepTried; steps++) {
          assert.isBelow(steps, 1000);
          scheduler = new SteppingScheduler();
          const runUntil = (done: () => boolean) =>
            Effect.gen(function* () {
              while (!done()) {
                if (scheduler.idle) yield* eventLoopTurn;
                else scheduler.step();
              }
            });
          if (elected)
            worker.emit("message", { type: "truncate-request", truncateId: ++truncateId });
          const write = yield* insert.pipe(
            Effect.provideService(Scheduler.Scheduler, scheduler),
            Effect.forkChild({ startImmediately: true }),
          );
          if (elected) {
            yield* runUntil(() => scheduler.idle);
            finishTruncate(worker, truncateId);
          }
          for (let step = 0; step < steps; step++) scheduler.step();
          everyStepTried = scheduler.idle;

          const inserts = countInserts(writer);
          const acknowledgedBefore = acknowledged();
          worker.emit("message", { type: "truncate-request", truncateId: ++truncateId });
          const finished = () => write.pollUnsafe() !== undefined;
          if (acknowledged() > acknowledgedBefore) {
            // Nothing was on the worker, so the write has to wait for the truncate.
            yield* runUntil(() => scheduler.idle);
            assert.equal(inserts(), 0);
            assert.isFalse(finished());
            finishTruncate(worker, truncateId);
            yield* runUntil(finished);
          } else {
            // The write got there first, so the truncate waits for it.
            yield* runUntil(finished);
            assert.equal(acknowledged(), acknowledgedBefore + 1);
            finishTruncate(worker, truncateId);
          }
          yield* Fiber.join(write);
          // The writer lock's next holder is woken through this scheduler.
          yield* runUntil(() => scheduler.idle);
        }
      }).pipe(Effect.onError(() => Effect.sync(() => scheduler.run())));
    }),
);

it.effect("fails writes held by a checkpoint once the worker stops", () =>
  withSilentCheckpointWorker((sql, _acknowledged, worker, writer) =>
    Effect.gen(function* () {
      const insert = sql`INSERT INTO entries VALUES ('known')`;
      yield* insert;
      worker.emit("message", { type: "truncate-request", truncateId: 1 });
      const held = yield* insert.pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
      yield* eventLoopTurn;
      assert.isUndefined(held.pollUnsafe());
      yield* Effect.promise(() => writer.terminate());
      assert.equal((yield* Fiber.join(held))._tag, "SqlError");
      assert.equal((yield* insert.pipe(Effect.flip))._tag, "SqlError");
    }),
  ),
);

it.effect("keeps a statement's class after its prepare fails", () =>
  withSilentCheckpointWorker((sql, _acknowledged, worker, writer) =>
    Effect.gen(function* () {
      yield* sql`CREATE TABLE vanishing(name TEXT)`;
      yield* sql`INSERT INTO vanishing VALUES ('before')`;
      yield* sql`DROP TABLE vanishing`;
      // Still cached, it would fail while executing. Out of the worker's cache, it fails to prepare.
      yield* Effect.forEach(
        Array.from({ length: 200 }, (_, index) => index),
        (index) => sql.unsafe(`DELETE FROM entries WHERE rowid = ${index}`),
        { discard: true },
      );
      const failure = yield* sql`INSERT INTO vanishing VALUES ('before')`.pipe(Effect.flip);
      assert.include(failure.message, "Failed to prepare statement");
      yield* sql`CREATE TABLE vanishing(name TEXT)`;
      const inserts = countInserts(writer);
      worker.emit("message", { type: "truncate-request", truncateId: 1 });
      const write = yield* sql`INSERT INTO vanishing VALUES ('before')`.pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* eventLoopTurn;
      assert.isUndefined(write.pollUnsafe());
      assert.equal(inserts(), 0);
      finishTruncate(worker, 1);
      yield* Fiber.join(write);
      assert.equal(inserts(), 1);
    }),
  ),
);

it.effect("falls back to the main connection when the worker can't start", () =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      replaced.writerThrows = "no thread for you";
    }),
    () =>
      withWriterWorker((sql) =>
        Effect.gen(function* () {
          yield* sql`INSERT INTO entries VALUES ('on main')`;
          assert.deepEqual(yield* names(sql), ["on main"]);
        }),
      ),
    () =>
      Effect.sync(() => {
        replaced.writerThrows = undefined;
      }),
  ),
);

it.effect("stops the worker when startup is interrupted", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-writer-" });
    const before = startedWorkers.length;
    const starting = yield* Effect.void.pipe(
      Effect.provide(
        SqliteClient.layer({ filename: path.join(directory, "state.sqlite"), writerWorker: true }),
      ),
      Effect.forkChild({ startImmediately: true }),
    );
    while (startedWorkers.length === before) yield* eventLoopTurn;
    yield* Fiber.interrupt(starting);
    assert.equal(startedWorkers[before]?.threadId, -1);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("reports a database that can't open as the main connection does", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-writer-" });
    const failure = yield* Effect.void.pipe(
      Effect.provide(
        SqliteClient.layer({
          filename: path.join(directory, "missing", "state.sqlite"),
          writerWorker: true,
        }),
      ),
      Effect.flip,
    );
    assert.equal(failure._tag, "SqlError");
    assert.include(failure.message, "Failed to open database");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
