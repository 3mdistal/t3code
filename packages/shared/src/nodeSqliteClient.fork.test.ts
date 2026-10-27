import * as NodeSqlite from "node:sqlite";
import type * as NodeWorkerThreads from "node:worker_threads";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import { vi } from "vite-plus/test";

import * as SqliteClient from "./nodeSqliteClient.ts";

const startedWorkers = vi.hoisted((): Array<NodeWorkerThreads.Worker> => []);
const silentWorkers = vi.hoisted(() => ({ on: false, readyOnTerminate: false }));
const failingWorkers = vi.hoisted(() => ({ message: undefined as string | undefined }));

vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeWorkerThreads>();
  class RecordedWorker extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      super(
        ...((silentWorkers.on
          ? ["setInterval(() => {}, 1 << 30);", { eval: true }]
          : failingWorkers.message !== undefined
            ? [`throw new Error(${JSON.stringify(failingWorkers.message)});`, { eval: true }]
            : args) as ConstructorParameters<typeof actual.Worker>),
      );
      startedWorkers.push(this);
    }
    override terminate() {
      // A "ready" already queued when termination starts reaches the parent before "exit".
      if (silentWorkers.readyOnTerminate) this.emit("message", { type: "ready" });
      return super.terminate();
    }
  }
  return { ...actual, Worker: RecordedWorker };
});

const withReaderClient = <A, E>(
  use: (sql: SqlClient.SqlClient) => Effect.Effect<A, E, SqlClient.SqlClient>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-reader-" });
    const filename = path.join(directory, "state.sqlite");
    return yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA journal_mode = WAL`;
      yield* sql`CREATE TABLE entries(name TEXT NOT NULL)`;
      yield* sql`INSERT INTO entries VALUES ('first')`;
      return yield* use(sql);
    }).pipe(Effect.provide(SqliteClient.layer({ filename, readerWorker: true })));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const countEntries = (sql: SqlClient.SqlClient) =>
  Effect.map(
    sql<{ count: number }>`SELECT COUNT(*) AS count FROM entries`,
    (rows) => rows[0]?.count,
  );

it.effect("serves interactive reads while a bulk reader transaction is held", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const bulk = yield* sql
        .withTransaction(
          countEntries(sql).pipe(
            Effect.andThen(Deferred.succeed(held, undefined)),
            Effect.andThen(Deferred.await(release)),
          ),
        )
        .pipe(SqliteClient.readOnly, Effect.forkChild);
      yield* Deferred.await(held);
      const count = yield* SqliteClient.readOnly(countEntries(sql), {
        priority: "interactive",
      }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
      assert.equal(count, 1);
      yield* Fiber.join(bulk);
    }),
  ),
);

it.effect("keeps interactive reads inside a write transaction on its writer", () =>
  withReaderClient((sql) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`INSERT INTO entries VALUES ('uncommitted')`;
        assert.equal(
          yield* SqliteClient.readOnly(countEntries(sql), { priority: "interactive" }),
          2,
        );
      }),
    ),
  ),
);

it.effect("admits a write after a busy truncate copied every WAL frame", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-checkpoint-admission-" });
    silentWorkers.on = true;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA journal_mode = WAL`;
      yield* sql`CREATE TABLE entries(name TEXT NOT NULL)`;
      const worker = startedWorkers.at(-1)!;
      using _postMessage = vi.spyOn(worker, "postMessage").mockImplementation((message) => {
        if (message.type === "truncate") {
          worker.emit("message", {
            type: "checkpoint",
            truncateId: message.truncateId,
            log: 10_000,
            checkpointed: 10_000,
            blocked: true,
          });
        }
      });
      worker.emit("message", { type: "truncate-request", truncateId: 1 });
      const write = yield* sql`INSERT INTO entries VALUES ('available')`.pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      assert.equal(write.pollUnsafe()?._tag, "Success");
      assert.equal(yield* countEntries(sql), 1);
    }).pipe(
      Effect.provide(
        SqliteClient.layer({
          filename: path.join(directory, "state.sqlite"),
          checkpointWorker: true,
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          silentWorkers.on = false;
        }),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("keeps writes available during a pinned reset, then checkpoints and truncates", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-wal-recovery-" });
    const filename = path.join(directory, "state.sqlite");
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA journal_mode = WAL`;
      yield* sql`PRAGMA journal_size_limit = 65536`;
      yield* sql`CREATE TABLE entries(name BLOB)`;
      const worker = startedWorkers.at(-1)!;
      const barrier = Effect.callback<void>((resume) => {
        const receive = (message: unknown) => {
          if (message !== "barrier") return;
          worker.off("message", receive);
          resume(Effect.void);
        };
        worker.on("message", receive);
        worker.postMessage({ type: "check", journalSizeLimit: 65536, force: true });
        worker.postMessage("barrier");
        return Effect.sync(() => worker.off("message", receive));
      });
      let reader: NodeSqlite.DatabaseSync | undefined;
      yield* Effect.addFinalizer(() => Effect.sync(() => reader?.close()));
      yield* barrier;
      yield* sql`INSERT INTO entries VALUES (zeroblob(1024 * 1024))`;
      reader = new NodeSqlite.DatabaseSync(filename, { readOnly: true });
      reader.exec("BEGIN");
      reader.prepare("SELECT COUNT(*) FROM entries").get();
      yield* barrier;
      const allocated = (yield* fs.stat(filename + "-wal")).size;
      assert.isTrue(allocated > 65536);
      // A reader prevents reset and later checkpoints, but this small backlog has room.
      yield* sql`INSERT INTO entries VALUES ('second')`;
      yield* sql`INSERT INTO entries VALUES ('third')`;
      assert.equal(yield* countEntries(sql), 3);
      // One statement may exceed the ceiling; the next writer must wait for the pinned snapshot.
      yield* sql`INSERT INTO entries VALUES (zeroblob(42 * 1024 * 1024))`;
      const waiting = yield* sql`INSERT INTO entries VALUES ('after-backpressure')`.pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      assert.equal(waiting.pollUnsafe(), undefined);
      reader!.close();
      reader = undefined;
      yield* barrier;
      yield* Fiber.join(waiting);
      yield* barrier;
      assert.isTrue((yield* fs.stat(filename + "-wal")).size <= 65536n);
      let maxBytes = 0n;
      for (let i = 0; i < 300; i++) {
        yield* sql`INSERT INTO entries VALUES (zeroblob(8192))`;
        const size = (yield* fs.stat(filename + "-wal")).size;
        if (size > maxBytes) maxBytes = size;
      }
      yield* barrier;
      assert.equal(yield* countEntries(sql), 305);
      assert.isTrue(maxBytes < 42_000_000n);
      assert.isTrue((yield* fs.stat(filename + "-wal")).size <= 65536n);
    }).pipe(Effect.provide(SqliteClient.layer({ filename, checkpointWorker: true })));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
