// @effect-diagnostics nodeBuiltinImport:off - Holds the lock check's asynchronous stat open.
import * as NodeFS from "node:fs";

import { assert, describe, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

import * as ProcessRunner from "./processRunner.ts";
import * as ServerOwnership from "./serverOwnership.ts";
import { statOwnershipLockOffEventLoop } from "./serverOwnershipLockStat.ts";

const errorWithCode = (code: string) => Object.assign(new Error(code), { code });

/** Leaves each stat of `lockPath` pending until the test settles it. */
const holdLockStats = (lockPath: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const held: Array<PromiseWithResolvers<NodeFS.BigIntStats>> = [];
      const stat = NodeFS.promises.stat;
      const spy = vi.spyOn(NodeFS.promises, "stat").mockImplementation(((
        path: NodeFS.PathLike,
        options?: NodeFS.StatOptions,
      ) => {
        if (path !== lockPath) return stat(path, options);
        const pending = Promise.withResolvers<NodeFS.BigIntStats>();
        held.push(pending);
        return pending.promise;
      }) as typeof NodeFS.promises.stat);
      return { held, spy };
    }),
    ({ spy }) => Effect.sync(() => spy.mockRestore()),
  );

describe("ownership lock check off the event loop", () => {
  const layerOwnership = (platform: NodeJS.Platform) =>
    Layer.mergeAll(
      ProcessRunner.layer,
      Layer.effect(
        HostProcess.HomeDirectory,
        Effect.gen(function* () {
          return yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
        }),
      ),
      Layer.succeed(HostProcess.Environment, {}),
      Layer.succeed(HostProcess.Platform, platform),
    ).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

  const makeLogs = () => {
    const errors: unknown[] = [];
    const warnings: unknown[] = [];
    const firstError = Promise.withResolvers<void>();
    const logger = Logger.make(({ message, logLevel }) => {
      if (logLevel === "Warn") warnings.push(message);
      if (logLevel === "Error") {
        errors.push(message);
        firstError.resolve();
      }
    });
    return {
      errors,
      warnings,
      awaitFirstError: Effect.promise(() => firstError.promise),
      layer: Logger.layer([logger], { mergeWithExisting: false }),
    };
  };

  const startOwner = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-owner-fork-" });
    const lockPath = path.join(root, "server-owner.sqlite");
    const { held } = yield* holdLockStats(lockPath);
    yield* ServerOwnership.acquireServerOwnership(path.join(root, "server-runtime.json"));
    return { held, lockPath };
  });

  describe("on Windows", () => {
    it.effect("waits on the stat with the server free, one stat at a time", () => {
      const logs = makeLogs();
      return Effect.gen(function* () {
        const { held, lockPath } = yield* startOwner;
        yield* TestClock.adjust("5 seconds");
        assert.lengthOf(held, 1);

        // A stat stuck on the disk: this test keeps running, and no second stat piles up.
        yield* TestClock.adjust("60 seconds");
        assert.lengthOf(held, 1);
        assert.deepEqual(logs.errors, []);

        held[0]?.reject(errorWithCode("ENOENT"));
        yield* logs.awaitFirstError;
        assert.lengthOf(logs.errors, 1);
        assert.include(String(logs.errors[0]), `Server ownership lock at ${lockPath} was deleted`);
      }).pipe(Effect.provide(Layer.merge(layerOwnership("win32"), logs.layer)));
    });

    it.effect("warns once while the stat fails, then keeps checking", () => {
      const logs = makeLogs();
      return Effect.gen(function* () {
        const { held, lockPath } = yield* startOwner;
        for (const count of [1, 2, 3]) {
          // The check resumes from a promise, so keep moving the clock until it sleeps and stats again.
          while (held.length < count) yield* TestClock.adjust("5 seconds");
          if (count < 3) held[count - 1]?.reject(errorWithCode("EACCES"));
        }
        assert.deepEqual(logs.warnings, [
          [`Cannot check server ownership lock at ${lockPath} (EACCES).`],
        ]);
        assert.deepEqual(logs.errors, []);
      }).pipe(Effect.provide(Layer.merge(layerOwnership("win32"), logs.layer)));
    });
  });

  it.effect("keeps upstream's stat on other platforms", () =>
    Effect.gen(function* () {
      const { held } = yield* startOwner;
      yield* TestClock.adjust("15 seconds");
      assert.lengthOf(held, 0);
    }).pipe(Effect.provide(layerOwnership("linux"))),
  );

  describe("the stat", () => {
    it.effect("matches statSync for a file, by path", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-owner-fork-stat-" });
        const file = path.join(root, "lock");
        yield* fs.writeFileString(file, "");
        const stats = yield* statOwnershipLockOffEventLoop(file);
        const expected = NodeFS.statSync(file, { bigint: true });
        assert.isTrue(typeof stats === "object");
        if (typeof stats !== "object") return;
        assert.equal(stats.dev, expected.dev);
        assert.equal(stats.ino, expected.ino);
      }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
    );

    it.effect("finds nothing at a missing path or beneath a file", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-owner-fork-stat-" });
        const file = path.join(root, "file");
        yield* fs.writeFileString(file, "");
        assert.isUndefined(yield* statOwnershipLockOffEventLoop(path.join(root, "missing")));
        assert.isUndefined(yield* statOwnershipLockOffEventLoop(path.join(file, "beneath")));
      }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
    );

    it.effect("reports the code of any other failure", () =>
      Effect.gen(function* () {
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            vi.spyOn(NodeFS.promises, "stat").mockRejectedValueOnce(errorWithCode("EBUSY")),
          ),
          (spy) => Effect.sync(() => spy.mockRestore()),
        );
        assert.equal(yield* statOwnershipLockOffEventLoop("locked"), "EBUSY");
      }),
    );
  });
});
