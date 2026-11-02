import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { vi } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as Sqlite from "./Sqlite.ts";

const configs = vi.hoisted((): Array<NodeSqliteClient.SqliteClientConfig> => []);

vi.mock("@t3tools/shared/nodeSqliteClient", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeSqliteClient>();
  return {
    ...actual,
    layer: (config: NodeSqliteClient.SqliteClientConfig) => {
      configs.push(config);
      return actual.layer(config);
    },
  };
});

it.effect.each([
  { platform: "win32", environment: {}, expected: true },
  { platform: "win32", environment: { T3CODE_SQLITE_WRITER_WORKER: "0" }, expected: false },
  { platform: "linux", environment: {}, expected: false },
] as const)(
  "chooses the writer's thread on $platform with $environment",
  ({ platform, environment, expected }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-layer-" });
      yield* Layer.build(Sqlite.layerFromPath(path.join(directory, "state.sqlite"))).pipe(
        Effect.provideService(HostProcess.Platform, platform),
        Effect.provideService(HostProcess.Environment, environment),
        Effect.scoped,
        Effect.ignore,
      );
      assert.equal(configs.at(-1)?.writerWorker, expected);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-sqlite-layer-home-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
);
