import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqliteClient from "./nodeSqliteClient.ts";

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

it.effect("serves interactive reads while every bulk reader transaction is held", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>();
      // One held transaction per pool reader, so only the reserved lane is free.
      const bulk = yield* Effect.forEach(
        Array.from({ length: SqliteClient.READER_POOL_SIZE }),
        () =>
          Effect.gen(function* () {
            const held = yield* Deferred.make<void>();
            const fiber = yield* sql
              .withTransaction(
                countEntries(sql).pipe(
                  Effect.andThen(Deferred.succeed(held, undefined)),
                  Effect.andThen(Deferred.await(release)),
                ),
              )
              .pipe(SqliteClient.readOnly, Effect.forkChild);
            yield* Deferred.await(held);
            return fiber;
          }),
      );
      const count = yield* SqliteClient.readOnly(countEntries(sql), {
        priority: "interactive",
      }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
      assert.equal(count, 1);
      yield* Fiber.joinAll(bulk);
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
