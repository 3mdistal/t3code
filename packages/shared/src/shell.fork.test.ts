// @effect-diagnostics nodeBuiltinImport:off - The test installs plain files on a temporary PATH.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { SpawnExecutableResolution } from "./shell.ts";

describe("spawn executable resolution", () => {
  let root: string;
  let first: string;
  let second: string;
  let env: NodeJS.ProcessEnv;
  // oxlint-disable-next-line t3code/no-global-process-runtime -- It installs real files on this host.
  const platform = process.platform;
  // The resolver appends PATHEXT as written, and NTFS answers to either case.
  const name = platform === "win32" ? "fork-tool.EXE" : "fork-tool";
  const install = (directory: string) => {
    const file = NodePath.join(directory, name);
    NodeFS.writeFileSync(file, "#!/bin/sh\n", { mode: 0o755 });
    return file;
  };

  beforeEach(() => {
    root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-path-"));
    first = NodePath.join(root, "first");
    second = NodePath.join(root, "second");
    NodeFS.mkdirSync(first);
    NodeFS.mkdirSync(second);
    env = { PATH: [first, second].join(NodePath.delimiter), PATHEXT: ".EXE" };
  });

  afterEach(() => {
    NodeFS.rmSync(root, { recursive: true, force: true });
  });

  it.effect("answers a repeat lookup from memory instead of walking PATH", () =>
    Effect.gen(function* () {
      const resolve = yield* SpawnExecutableResolution;
      const later = install(second);
      assert.equal(resolve("fork-tool", platform, env), later);

      // A walk would now find this one first.
      install(first);
      assert.equal(resolve("fork-tool", platform, env), later);
    }),
  );

  it.effect("walks PATH again when the file it remembered is gone", () =>
    Effect.gen(function* () {
      const resolve = yield* SpawnExecutableResolution;
      const earlier = install(first);
      assert.equal(resolve("fork-tool", platform, env), earlier);

      NodeFS.rmSync(earlier);
      const later = install(second);
      assert.equal(resolve("fork-tool", platform, env), later);

      NodeFS.rmSync(later);
      assert.equal(resolve("fork-tool", platform, env), undefined);
    }),
  );

  it.effect("keeps separate answers for separate PATHs", () =>
    Effect.gen(function* () {
      const resolve = yield* SpawnExecutableResolution;
      const inFirst = install(first);
      const inSecond = install(second);
      assert.equal(resolve("fork-tool", platform, { ...env, PATH: first }), inFirst);
      assert.equal(resolve("fork-tool", platform, { ...env, PATH: second }), inSecond);
    }),
  );
});
