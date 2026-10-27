// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeWorkerThreads from "node:worker_threads";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import { deleteWorktreeFolder, type CreateWorker } from "./worktreeDeleteWorker.ts";
import { removeLinkedWorktree } from "./worktreeRemoval.ts";

// oxlint-disable-next-line t3code/no-global-process-runtime -- A held folder needs a real Windows host.
const onWindowsHost = process.platform === "win32";
// Root ignores folder permissions.
const runsAsRoot = process.getuid?.() === 0;

const layerTest = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-worktree-delete-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

/** Every path below `root` with its contents, without following links. */
const snapshot = (root: string): string => {
  const lines: Array<string> = [];
  const visit = (dir: string) => {
    for (const name of NodeFS.readdirSync(dir).toSorted()) {
      const file = `${dir}/${name}`;
      const stats = NodeFS.lstatSync(file);
      if (stats.isSymbolicLink()) lines.push(`${file} -> ${NodeFS.readlinkSync(file)}`);
      else if (stats.isDirectory()) {
        lines.push(`${file}/`);
        visit(file);
      } else lines.push(`${file} = ${NodeFS.readFileSync(file, "utf8")}`);
    }
  };
  visit(root);
  return lines.join("\n");
};

/** A folder shaped like a worktree with a pnpm `node_modules`, and a folder outside it. */
const makeFolders = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-worktree-delete-" });
  const outside = path.join(root, "outside");
  const worktree = path.join(root, "worktree");
  for (const [file, contents] of [
    ["keep.txt", "keep\n"],
    ["dir/nested.txt", "nested\n"],
  ] as const) {
    yield* fileSystem.makeDirectory(path.dirname(path.join(outside, file)), { recursive: true });
    yield* fileSystem.writeFileString(path.join(outside, file), contents);
  }
  yield* fileSystem.makeDirectory(worktree);
  yield* fileSystem.writeFileString(path.join(worktree, ".git"), "gitdir: elsewhere\n");
  for (let index = 0; index < 20; index++) {
    const store = path.join(worktree, "node_modules", ".pnpm", `pkg${index}@1.0.0`, "lib");
    yield* fileSystem.makeDirectory(store, { recursive: true });
    yield* fileSystem.writeFileString(path.join(store, "index.js"), `${index}\n`);
  }
  return { root, outside, worktree, path };
});

/** Runs the real walk, but pauses it after its first unlink until `resume`. */
const pausingWorkers = () => {
  const gate = new Int32Array(new SharedArrayBuffer(8));
  const workers: Array<NodeWorkerThreads.Worker> = [];
  let live = 0;
  let maxLive = 0;
  const create: CreateWorker = (source, target) => {
    const prelude = `{
  const gate = require("node:worker_threads").workerData.gate;
  const fs = require("node:fs");
  const unlinkSync = fs.unlinkSync;
  fs.unlinkSync = (file) => {
    unlinkSync(file);
    Atomics.store(gate, 0, 1);
    Atomics.notify(gate, 0);
    Atomics.wait(gate, 1, 0);
  };
}
`;
    const worker = new NodeWorkerThreads.Worker(prelude + source, {
      eval: true,
      workerData: { target, gate },
    });
    workers.push(worker);
    maxLive = Math.max(maxLive, ++live);
    worker.once("exit", () => live--);
    return worker;
  };
  return {
    create,
    workers,
    maxLive: () => maxLive,
    paused: Effect.promise(async () => {
      await Atomics.waitAsync(gate, 0, 0).value;
    }),
    resume: Effect.sync(() => {
      Atomics.store(gate, 1, 1);
      Atomics.notify(gate, 1);
    }),
  };
};

/** Makes deleting inside `directory` fail until the returned effect runs. */
const holdFolder = (directory: string) =>
  Effect.acquireRelease(
    onWindowsHost
      ? // Windows refuses to delete a process's current folder.
        Effect.callback<() => Promise<void>>((resume) => {
          const child = NodeChildProcess.spawn(
            process.execPath,
            ["-e", "process.stdout.write('held'); process.stdin.resume()"],
            { cwd: directory, stdio: ["pipe", "pipe", "ignore"], windowsHide: true },
          );
          const exited = new Promise<void>((done) => child.once("exit", () => done()));
          child.stdout.once("data", () =>
            resume(
              Effect.succeed(() => {
                child.stdin.end();
                return exited;
              }),
            ),
          );
        })
      : Effect.sync(() => {
          NodeFS.chmodSync(directory, 0o555);
          return async () => NodeFS.chmodSync(directory, 0o755);
        }),
    (release) => Effect.promise(release),
  ).pipe(Effect.map((release) => Effect.promise(release)));

const makeWorktree = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const driver = yield* GitVcsDriver.GitVcsDriver;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-worktree-delete-git-" });
  const repo = path.join(root, "repo");
  const worktree = path.join(root, "worktree");
  const git = (cwd: string, args: ReadonlyArray<string>) =>
    driver
      .execute({ operation: "worktreeDeleteWorker.test", cwd, args })
      .pipe(Effect.map((result) => result.stdout.trim()));
  yield* fileSystem.makeDirectory(repo);
  yield* driver.initRepo({ cwd: repo });
  yield* git(repo, ["config", "user.email", "test@test.com"]);
  yield* git(repo, ["config", "user.name", "Test"]);
  yield* fileSystem.writeFileString(path.join(repo, ".gitignore"), "node_modules\n");
  yield* git(repo, ["add", "."]);
  yield* git(repo, ["commit", "-m", "initial commit"]);
  const branch = yield* git(repo, ["branch", "--show-current"]);
  yield* driver.createWorktree({ cwd: repo, path: worktree, refName: branch, newRefName: "big" });
  for (let index = 0; index < 20; index++) {
    const store = path.join(worktree, "node_modules", ".pnpm", `pkg${index}@1.0.0`, "lib");
    yield* fileSystem.makeDirectory(store, { recursive: true });
    yield* fileSystem.writeFileString(path.join(store, "index.js"), `${index}\n`);
  }
  const gitFile = path.join(worktree, ".git");
  // The Windows path runs on every host: Git does the checks there, and this module the delete.
  const remove = (force: boolean) =>
    removeLinkedWorktree({
      operation: "worktreeDeleteWorker.test",
      cwd: repo,
      worktreePath: worktree,
      force,
      execute: driver.execute,
      run: (args) => git(repo, args),
    }).pipe(Effect.provideService(HostProcess.Platform, "win32"));
  const registered = git(repo, ["worktree", "list", "--porcelain"]).pipe(
    Effect.map((list) => list.includes("branch refs/heads/big")),
  );
  return { worktree, gitFile, path, remove, registered };
});

it.layer(NodeServices.layer)("deleteWorktreeFolder", (it) => {
  it.effect("deletes through junctions without touching what they point to", () =>
    Effect.gen(function* () {
      const { root, outside, worktree, path } = yield* makeFolders;
      const before = snapshot(outside);
      NodeFS.symlinkSync(path.join(outside, "dir"), path.join(worktree, "junction"), "junction");
      NodeFS.symlinkSync(root, path.join(worktree, "node_modules", "parent"), "junction");
      NodeFS.symlinkSync(path.join(outside, "gone"), path.join(worktree, "dangling"), "junction");
      const spy = pausingWorkers();
      yield* spy.resume;

      yield* deleteWorktreeFolder(worktree, spy.create);

      assert.isFalse(NodeFS.existsSync(worktree));
      assert.equal(snapshot(outside), before);
      assert.equal(spy.workers[0]?.threadId, -1);
    }),
  );

  it.effect.skipIf(!symlinksSupported)(
    "deletes directory and file symlinks without touching their targets",
    () =>
      Effect.gen(function* () {
        const { outside, worktree, path } = yield* makeFolders;
        const before = snapshot(outside);
        NodeFS.symlinkSync(path.join(outside, "dir"), path.join(worktree, "dirlink"), "dir");
        NodeFS.symlinkSync(path.join("..", "outside", "dir"), path.join(worktree, "rel"), "dir");
        NodeFS.symlinkSync(path.join(outside, "keep.txt"), path.join(worktree, "file"), "file");

        yield* deleteWorktreeFolder(worktree);

        assert.isFalse(NodeFS.existsSync(worktree));
        assert.equal(snapshot(outside), before);
      }),
  );

  it.effect("deletes read-only files", () =>
    Effect.gen(function* () {
      const { worktree, path } = yield* makeFolders;
      const readOnly = path.join(
        worktree,
        "node_modules",
        ".pnpm",
        "pkg0@1.0.0",
        "lib",
        "index.js",
      );
      NodeFS.chmodSync(readOnly, 0o444);
      NodeFS.writeFileSync(path.join(worktree, "top.txt"), "top\n", { mode: 0o444 });

      yield* deleteWorktreeFolder(worktree);

      assert.isFalse(NodeFS.existsSync(worktree));
    }),
  );

  it.effect.skipIf(runsAsRoot)("keeps .git when the delete fails partway", () =>
    Effect.gen(function* () {
      const { worktree, path } = yield* makeFolders;
      const held = path.join(worktree, "node_modules", "held");
      NodeFS.mkdirSync(held);
      NodeFS.writeFileSync(path.join(held, "busy.txt"), "busy\n");
      yield* holdFolder(held).pipe(Effect.asVoid);

      const result = yield* Effect.result(deleteWorktreeFolder(worktree));

      assert.isTrue(Result.isFailure(result));
      assert.equal(NodeFS.readFileSync(path.join(worktree, ".git"), "utf8"), "gitdir: elsewhere\n");
    }),
  );

  it.effect("runs one delete at a time", () =>
    Effect.gen(function* () {
      const first = yield* makeFolders;
      const second = yield* makeFolders;
      const spy = pausingWorkers();
      const both = yield* Effect.forkChild(
        Effect.all(
          [
            deleteWorktreeFolder(first.worktree, spy.create),
            deleteWorktreeFolder(second.worktree, spy.create),
          ],
          { concurrency: 2 },
        ),
      );
      yield* spy.paused;
      assert.equal(spy.workers.length, 1);

      yield* spy.resume;
      yield* Fiber.join(both);

      assert.equal(spy.workers.length, 2);
      assert.equal(spy.maxLive(), 1);
      assert.isFalse(NodeFS.existsSync(first.worktree));
      assert.isFalse(NodeFS.existsSync(second.worktree));
    }),
  );
});

it.layer(layerTest)("removeLinkedWorktree with the delete worker", (it) => {
  it.effect.each(["interrupted", "shut down"] as const)(
    "leaves a worktree a retry removes when %s mid-delete",
    (how) =>
      Effect.gen(function* () {
        const { worktree, gitFile, remove, registered } = yield* makeWorktree;
        const gitFileContents = NodeFS.readFileSync(gitFile, "utf8");
        const spy = pausingWorkers();
        const scope = yield* Scope.make();
        const deleting = yield* deleteWorktreeFolder(worktree, spy.create).pipe(
          Effect.forkIn(scope),
        );
        yield* spy.paused;

        if (how === "interrupted") yield* Fiber.interrupt(deleting);
        yield* Scope.close(scope, Exit.void);

        assert.equal(spy.workers[0]?.threadId, -1);
        assert.equal(NodeFS.readFileSync(gitFile, "utf8"), gitFileContents);
        // Tracked files are already gone, so the retry forces, as the UI and agents do.
        yield* remove(true);
        assert.isFalse(NodeFS.existsSync(worktree));
        assert.isFalse(yield* registered);
      }),
  );

  it.effect.skipIf(runsAsRoot)(
    "fails cleanly while a folder is held, and a retry removes the worktree once it is released",
    () =>
      Effect.gen(function* () {
        const { worktree, gitFile, path, remove, registered } = yield* makeWorktree;
        const gitFileContents = NodeFS.readFileSync(gitFile, "utf8");
        const held = path.join(worktree, "node_modules", "held");
        NodeFS.mkdirSync(held);
        NodeFS.writeFileSync(path.join(held, "busy.txt"), "busy\n");
        const release = yield* holdFolder(held);

        const error = yield* Effect.flip(remove(false));

        assert.include(error.message, "failed to delete");
        assert.equal(NodeFS.readFileSync(gitFile, "utf8"), gitFileContents);
        assert.isTrue(yield* registered);

        yield* release;
        yield* remove(true);

        assert.isFalse(NodeFS.existsSync(worktree));
        assert.isFalse(yield* registered);
      }),
  );
});
