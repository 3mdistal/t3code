import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionStore from "./SessionStore.ts";

// Both cases matter: stable uses the writer and newer upstream uses the bulk reader.
it.effect.each(["writer", "reader"] as const)(
  "verifies auth, sessions and websocket tickets while the bulk %s is held",
  (connection) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-auth-read-lane-" });
      const persistence = SqlitePersistence.layerFromPath(path.join(directory, "state.sqlite"));
      const services = SessionStore.layer.pipe(
        Layer.provideMerge(persistence),
        Layer.provide(ServerSecretStore.layer),
        Layer.provide(
          Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
            getEnvironmentId: Effect.succeed(EnvironmentId.make("auth-read-lane")),
          }),
        ),
        Layer.provide(ServerConfig.layerTest(directory, { prefix: "t3-auth-read-config-" })),
      );
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const sessions = yield* SessionStore.SessionStore;
        const repository = yield* AuthSessions.AuthSessionRepository;
        const issued = yield* sessions.issue({ subject: "connection-recovery-fixture" });
        const ticket = yield* sessions.issueWebSocketToken(issued.sessionId);
        const held = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const transaction = sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`SELECT COUNT(*) FROM auth_sessions`;
            yield* Deferred.succeed(held, undefined);
            yield* Deferred.await(release);
          }),
        );
        const bulk = yield* (
          connection === "reader" ? NodeSqliteClient.readOnly(transaction) : transaction
        ).pipe(Effect.forkChild);
        yield* Deferred.await(held);
        yield* Effect.gen(function* () {
          expect(Option.isSome(yield* repository.getById({ sessionId: issued.sessionId }))).toBe(
            true,
          );
          expect((yield* sessions.verify(issued.token)).sessionId).toBe(issued.sessionId);
          expect((yield* sessions.verifyWebSocketToken(ticket.token)).sessionId).toBe(
            issued.sessionId,
          );
        }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
        yield* Fiber.join(bulk);
      }).pipe(Effect.provide(services));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
