// fork: thread tags, see FORK.md. The tag names the menu offers and new tags are spelled from.
import { listThreadTags, storedThreadTagsFromJson } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

/**
 * Every tag on this server's threads, archived ones too, read the way each thread's shell reads
 * them; a deleted thread's tags drop out. Read on a reader connection, so it never queues ahead of
 * commits. Required, so a missed provision fails typecheck instead of serving no names.
 */
export class ThreadTagNames extends Context.Service<
  ThreadTagNames,
  { readonly list: Effect.Effect<ReadonlyArray<string>, SqlError.SqlError> }
>()("t3/threadTags/ThreadTagNames") {}

export const layer = Layer.effect(
  ThreadTagNames,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return {
      list: sql<{ readonly tags: string }>`
        SELECT json_extract(payload_json, '$.tags') AS tags
        FROM orchestration_v2_projection_threads
        WHERE deleted_at IS NULL AND json_type(payload_json, '$.tags') = 'array'
      `.pipe(
        NodeSqliteClient.readOnly,
        Effect.map((rows) => listThreadTags(rows.map((row) => storedThreadTagsFromJson(row.tags)))),
        Effect.withSpan("ThreadTagNames.list"),
      ),
    };
  }),
);
