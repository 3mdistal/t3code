// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeChildProcess from "node:child_process";
import * as NodeNet from "node:net";
import * as NodeWorkerThreads from "node:worker_threads";

import * as ProcessSpawnWorker from "./ProcessSpawnWorker.ts";

// oxlint-disable-next-line t3code/no-global-process-runtime -- Ending an orphaned tree needs a real Windows host.
const onWindowsHost = process.platform === "win32";

const makeLayer = (
  ambientCommands: Array<string>,
  createWorker?: ProcessSpawnWorker.CreateWorker,
) =>
  Layer.effect(ChildProcessSpawner.ChildProcessSpawner, ProcessSpawnWorker.make(createWorker)).pipe(
    Layer.provide(
      Layer.effect(
        ChildProcessSpawner.ChildProcessSpawner,
        Effect.gen(function* () {
          const node = yield* ChildProcessSpawner.ChildProcessSpawner;
          return ChildProcessSpawner.make((command) => {
            if (command._tag === "StandardCommand") ambientCommands.push(command.command);
            return node.spawn(command);
          });
        }),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

const run = (command: ChildProcess.Command, stdin?: string | Uint8Array) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(command);
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        Stream.mkString(Stream.decodeText(handle.stdout)),
        Stream.mkString(Stream.decodeText(handle.stderr)),
        handle.exitCode,
        stdin === undefined
          ? Effect.void
          : Stream.run(
              typeof stdin === "string"
                ? Stream.encodeText(Stream.make(stdin))
                : Stream.make(stdin),
              handle.stdin,
            ),
      ],
      { concurrency: "unbounded" },
    );
    return { stdout, stderr, exitCode };
  }).pipe(Effect.scoped);

const tempDirectory = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-git-spawn-worker-" });
});

const recordingWorkers = (onMessage?: (message: unknown) => void) => {
  const workers: Array<NodeWorkerThreads.Worker> = [];
  const createWorker: ProcessSpawnWorker.CreateWorker = (source) => {
    const worker = new NodeWorkerThreads.Worker(source, { eval: true });
    if (onMessage !== undefined) worker.on("message", onMessage);
    workers.push(worker);
    return worker;
  };
  return { workers, createWorker };
};

/** Stands in for a git daemon that accepts a connection and never answers, so the client waits. */
const silentServer = (connected: Deferred.Deferred<void>) =>
  Effect.acquireRelease(
    Effect.callback<{ server: NodeNet.Server; sockets: Set<NodeNet.Socket> }>((resume) => {
      const sockets = new Set<NodeNet.Socket>();
      const server = NodeNet.createServer((socket) => {
        sockets.add(socket);
        socket.on("error", () => {});
        Deferred.doneUnsafe(connected, Exit.void);
      });
      server.listen(0, "127.0.0.1", () => resume(Effect.succeed({ server, sockets })));
    }),
    ({ server, sockets }) =>
      Effect.callback<void>((resume) => {
        sockets.forEach((socket) => socket.destroy());
        server.close(() => resume(Effect.void));
      }),
  ).pipe(Effect.map(({ server }) => (server.address() as NodeNet.AddressInfo).port));

/** An environment whose SystemRoot, named as MSYS may pass it, has no taskkill.exe. */
const withoutTaskkill = Effect.gen(function* () {
  const path = yield* Path.Path;
  const systemRoot = path.join(yield* tempDirectory, "missing");
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name.toUpperCase() !== "SYSTEMROOT"),
  );
  return {
    environment: { ...environment, SYSTEMROOT: systemRoot },
    taskkill: path.join(systemRoot, "System32", "taskkill.exe"),
  };
});

/** A process the test owns, so it can wait for the exit instead of polling for it. */
const ownedProcess = Effect.acquireRelease(
  Effect.callback<{ child: NodeChildProcess.ChildProcess; exited: Deferred.Deferred<void> }>(
    (resume) => {
      const exited = Deferred.makeUnsafe<void>();
      const child = NodeChildProcess.spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1 << 30)"],
        {
          stdio: "ignore",
        },
      );
      child.once("exit", () => Deferred.doneUnsafe(exited, Exit.void));
      child.once("spawn", () => resume(Effect.succeed({ child, exited })));
    },
  ),
  ({ child }) => Effect.sync(() => child.kill()),
);

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const IDLE = "setInterval(() => {}, 1 << 30)";
// A detached grandchild is outside the child's own kill-on-close job, so only a tree kill ends it.
const STARTS_A_GRANDCHILD = `const { spawn } = require("node:child_process");
const grandchild = spawn(process.execPath, ["-e", ${JSON.stringify(IDLE)}], { detached: true, stdio: "ignore" });
process.stdout.write(grandchild.pid + "\\n");
${IDLE}`;

/** Starts a program that starts a grandchild, and ends both when the test ends whatever happens. */
const spawnWithGrandchild = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const handle = yield* spawner.spawn(
    ChildProcess.make(process.execPath, ["-e", STARTS_A_GRANDCHILD]),
  );
  const line = yield* handle.stdout.pipe(Stream.decodeText, Stream.splitLines, Stream.runHead);
  const grandchild = Number(Option.getOrThrow(line));
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const pid of [handle.pid, grandchild]) if (isAlive(pid)) process.kill(pid);
    }),
  );
  return { handle, grandchild };
});

/** A tree kill can report before Windows has ended every process in the tree. */
// A grandchild has no handle to wait on, so its end is polled.
const gone = (pid: number) =>
  Effect.promise(() => expect.poll(() => isAlive(pid), { timeout: 2_000 }).toBe(false)).pipe(
    Effect.as(true),
  );

describe("ProcessSpawnWorker", () => {
  it.live("runs git on the worker and relays output, input and exit codes", () => {
    const ambientCommands: Array<string> = [];
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* tempDirectory;
      const emptyConfig = path.join(directory, "empty.gitconfig");
      yield* fileSystem.writeFileString(emptyConfig, "");

      const version = yield* run(ChildProcess.make("git", ["--version"]));
      expect(version.stdout).toMatch(/^git version /);
      expect(version.exitCode).toBe(0);

      const hashed = yield* run(ChildProcess.make("git", ["hash-object", "--stdin"]), "hello\n");
      expect(hashed.stdout.trim()).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
      // A small Buffer is a view into Node's shared pool, which cannot be transferred as is.
      const fromBuffer = yield* run(
        ChildProcess.make("git", ["hash-object", "--stdin"]),
        Buffer.from("hello\n"),
      );
      expect(fromBuffer.stdout.trim()).toBe("ce013625030ba8dba906f756967f9e9ca394464a");

      const missingKey = yield* run(
        ChildProcess.make("git", ["config", "--file", emptyConfig, "--get", "t3code.missing"]),
      );
      expect(missingKey).toEqual({ stdout: "", stderr: "", exitCode: 1 });

      const badFlag = yield* run(ChildProcess.make("git", ["hash-object", "--not-a-flag"]));
      expect(badFlag.exitCode).toBe(129);
      expect(badFlag.stderr).toContain("git hash-object");

      expect(ambientCommands).toEqual([]);
    }).pipe(
      Effect.provide(makeLayer(ambientCommands)),
      Effect.provideService(HostProcess.Platform, "win32"),
    );
  });

  it.live(
    "starts every plain program on the worker, and leaves the rest and other platforms",
    () => {
      const windowsCommands: Array<string> = [];
      const linuxCommands: Array<string> = [];
      return Effect.gen(function* () {
        const onWindows = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          effect.pipe(
            Effect.provide(makeLayer(windowsCommands)),
            Effect.provideService(HostProcess.Platform, "win32"),
          );
        const node = yield* onWindows(
          run(ChildProcess.make(process.execPath, ["-e", "process.stdout.write('ok')"])),
        );
        expect(node.stdout).toBe("ok");
        expect(windowsCommands).toEqual([]);

        // Ignored stdio is how launches meant to outlive the server are made.
        const ignoresInput = yield* onWindows(
          run(
            ChildProcess.make(process.execPath, ["-e", "process.stdout.write('ok')"], {
              stdin: "ignore",
            }),
          ),
        );
        expect(ignoresInput.stdout).toBe("ok");
        expect(windowsCommands).toEqual([process.execPath]);

        yield* run(ChildProcess.make("git", ["--version"])).pipe(
          Effect.provide(makeLayer(linuxCommands)),
          Effect.provideService(HostProcess.Platform, "linux"),
        );
        expect(linuxCommands).toEqual(["git"]);
      });
    },
  );

  it.live("relays a long-running program's input and output both ways", () =>
    Effect.gen(function* () {
      const input = "x".repeat(4 * ProcessSpawnWorker.UNREAD_LIMIT_BYTES);
      const echoed = yield* run(
        ChildProcess.make(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"]),
        input,
      );
      expect(echoed.stdout.length).toBe(input.length);
      expect(echoed.exitCode).toBe(0);
      const failed = yield* run(ChildProcess.make(process.execPath, ["-e", "process.exit(7)"]));
      expect(failed.exitCode).toBe(7);
    }).pipe(Effect.provide(makeLayer([])), Effect.provideService(HostProcess.Platform, "win32")),
  );

  it.live("fails a missing working directory the way Node's spawner does", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const cwd = path.join(yield* tempDirectory, "missing");
      const spawnIn = (platform: NodeJS.Platform) =>
        run(ChildProcess.make("git", ["--version"], { cwd })).pipe(
          Effect.flip,
          Effect.provide(makeLayer([])),
          Effect.provideService(HostProcess.Platform, platform),
        );

      const fromWorker = yield* spawnIn("win32");
      const fromNode = yield* spawnIn("linux");
      expect(fromWorker).toBeInstanceOf(PlatformError.PlatformError);
      expect(fromWorker.reason._tag).toBe("NotFound");
      expect(fromWorker.reason).toMatchObject({ pathOrDescriptor: cwd });
      expect(fromNode.reason).toMatchObject({ _tag: "NotFound", pathOrDescriptor: cwd });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("reports a git executable that does not exist as a spawn failure", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const missingGit = path.join(yield* tempDirectory, "git");
      const error = yield* run(ChildProcess.make(missingGit, ["--version"])).pipe(Effect.flip);
      expect(error.reason).toMatchObject({
        _tag: "NotFound",
        module: "ChildProcess",
        method: "spawn",
      });
    }).pipe(Effect.provide(makeLayer([])), Effect.provideService(HostProcess.Platform, "win32")),
  );

  it.live("closing the scope ends a git process that is still running", () =>
    Effect.gen(function* () {
      const handle = yield* Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        // Waits for stdin to end, which never happens here.
        const handle = yield* spawner.spawn(ChildProcess.make("git", ["hash-object", "--stdin"]));
        expect(yield* handle.isRunning).toBe(true);
        expect(isAlive(handle.pid)).toBe(true);
        return handle;
      }).pipe(Effect.scoped);

      expect(yield* handle.isRunning).toBe(false);
      expect(isAlive(handle.pid)).toBe(false);
    }).pipe(Effect.provide(makeLayer([])), Effect.provideService(HostProcess.Platform, "win32")),
  );

  it.live.runIf(onWindowsHost)("losing the worker ends the git processes it started", () => {
    const { workers, createWorker } = recordingWorkers();
    return Effect.gen(function* () {
      const connected = yield* Deferred.make<void>();
      const port = yield* silentServer(connected);
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const handle = yield* spawner.spawn(
        ChildProcess.make("git", ["ls-remote", `git://127.0.0.1:${port}/repository`]),
      );
      yield* Deferred.await(connected);

      yield* Effect.promise(() => Promise.all(workers.map((worker) => worker.terminate())));

      yield* Effect.flip(handle.exitCode);
      expect(isAlive(handle.pid)).toBe(false);
    }).pipe(
      Effect.scoped,
      Effect.provide(makeLayer([], createWorker)),
      Effect.provideService(HostProcess.Platform, "win32"),
    );
  });

  it.live.runIf(onWindowsHost)("losing the worker ends every program and what each started", () => {
    const { workers, createWorker } = recordingWorkers();
    return Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const { handle, grandchild } = yield* spawnWithGrandchild;
      const idle = yield* spawner.spawn(ChildProcess.make(process.execPath, ["-e", IDLE]));
      expect([handle.pid, grandchild, idle.pid].map(isAlive)).toEqual([true, true, true]);

      yield* Effect.promise(() => Promise.all(workers.map((worker) => worker.terminate())));

      yield* Effect.flip(handle.exitCode);
      yield* Effect.flip(idle.exitCode);
      expect(isAlive(handle.pid)).toBe(false);
      expect(isAlive(idle.pid)).toBe(false);
      expect(yield* gone(grandchild)).toBe(true);
    }).pipe(
      Effect.scoped,
      Effect.provide(makeLayer([], createWorker)),
      Effect.provideService(HostProcess.Platform, "win32"),
    );
  });

  it.live.runIf(onWindowsHost)(
    "a worker that crashes just after starting a program still ends it",
    () => {
      const report = 'if (started) post({ type: "spawned", id, pid: spawned.pid });';
      // The worker dies before it handles anything else, as an uncaught error there would.
      const createWorker: ProcessSpawnWorker.CreateWorker = (source) => {
        expect(source).toContain(report);
        return new NodeWorkerThreads.Worker(
          source.replace(report, `${report} throw new Error("worker crashed");`),
          { eval: true },
        );
      };
      return Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const handle = yield* spawner.spawn(ChildProcess.make(process.execPath, ["-e", IDLE]));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => (isAlive(handle.pid) ? process.kill(handle.pid) : undefined)),
        );

        yield* Effect.flip(handle.exitCode);
        expect(yield* gone(handle.pid)).toBe(true);
      }).pipe(
        Effect.scoped,
        Effect.provide(makeLayer([], createWorker)),
        Effect.provideService(HostProcess.Platform, "win32"),
      );
    },
  );

  it.live.runIf(onWindowsHost)("stopping ends every running program and starts no more", () =>
    Effect.gen(function* () {
      const layerScope = yield* Scope.make();
      const spawner = yield* ProcessSpawnWorker.make().pipe(
        Effect.provideService(Scope.Scope, layerScope),
      );
      const { handle, grandchild } = yield* spawnWithGrandchild.pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      yield* Scope.close(layerScope, Exit.void);

      expect(isAlive(handle.pid)).toBe(false);
      expect(yield* gone(grandchild)).toBe(true);
      const refused = yield* spawner
        .spawn(ChildProcess.make(process.execPath, ["-e", IDLE]))
        .pipe(Effect.scoped, Effect.flip);
      expect(refused.reason).toMatchObject({ module: "ChildProcess", method: "spawn" });
    }).pipe(
      Effect.scoped,
      Effect.provide(NodeServices.layer),
      Effect.provideService(HostProcess.Platform, "win32"),
    ),
  );

  it.live("holds unread output at the limit and resumes once it is read", () => {
    let received = 0;
    let largestChunk = 0;
    const reachedLimit = Deferred.makeUnsafe<void>();
    const { createWorker } = recordingWorkers((message) => {
      const { type, chunk } = message as { type: string; chunk?: Uint8Array };
      if (type !== "data" || chunk === undefined) return;
      received += chunk.byteLength;
      largestChunk = Math.max(largestChunk, chunk.byteLength);
      if (received >= ProcessSpawnWorker.UNREAD_LIMIT_BYTES)
        Deferred.doneUnsafe(reachedLimit, Exit.void);
    });
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repository = yield* tempDirectory;
      const blobSize = 8 * ProcessSpawnWorker.UNREAD_LIMIT_BYTES;
      yield* fileSystem.writeFileString(path.join(repository, "large.txt"), "x".repeat(blobSize));
      const initialized = yield* run(ChildProcess.make("git", ["init", "-q"], { cwd: repository }));
      expect(initialized.exitCode).toBe(0);
      const stored = yield* run(
        ChildProcess.make("git", ["hash-object", "-w", "large.txt"], { cwd: repository }),
      );

      received = 0;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const handle = yield* spawner.spawn(
        ChildProcess.make("git", ["cat-file", "blob", stored.stdout.trim()], { cwd: repository }),
      );
      yield* Deferred.await(reachedLimit);
      // The worker answers in order, so this round trip delivers every chunk it had sent.
      yield* Stream.run(Stream.empty, handle.stdin);
      expect(received).toBeLessThan(ProcessSpawnWorker.UNREAD_LIMIT_BYTES + largestChunk);

      const read = yield* Stream.runFold(
        handle.stdout,
        () => 0,
        (total, chunk) => total + chunk.byteLength,
      );
      expect(read).toBe(blobSize);
      expect(yield* handle.exitCode).toBe(0);
    }).pipe(
      Effect.scoped,
      Effect.provide(makeLayer([], createWorker)),
      Effect.provideService(HostProcess.Platform, "win32"),
    );
  });

  it.live("ends a child with a signal when taskkill cannot start", () =>
    Effect.gen(function* () {
      const { environment } = yield* withoutTaskkill;
      yield* Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        // Waits for stdin to end, which never happens here.
        const handle = yield* spawner.spawn(ChildProcess.make("git", ["hash-object", "--stdin"]));
        yield* handle.kill();
        expect(yield* handle.isRunning).toBe(false);
      }).pipe(
        Effect.scoped,
        Effect.provide(makeLayer([])),
        Effect.provideService(HostProcess.Environment, environment),
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(NodeServices.layer),
      Effect.provideService(HostProcess.Platform, "win32"),
    ),
  );

  it.live("ends a lost worker's children with a signal when taskkill cannot start", () =>
    Effect.gen(function* () {
      const { environment, taskkill } = yield* withoutTaskkill;
      const ambientCommands: Array<string> = [];
      const owned = yield* ownedProcess;
      let worker: NodeWorkerThreads.Worker | undefined;
      // Reports the owned process as the child it started.
      const createWorker: ProcessSpawnWorker.CreateWorker = () => {
        worker = new NodeWorkerThreads.Worker(
          `const { parentPort } = require("node:worker_threads");
parentPort.on("message", (message) => {
  if (message.type === "spawn") parentPort.postMessage({ type: "spawned", id: message.id, pid: ${owned.child.pid} });
});`,
          { eval: true },
        );
        return worker;
      };
      yield* Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const handle = yield* spawner.spawn(ChildProcess.make("git", ["--version"]));
        yield* Effect.promise(() => worker!.terminate());
        yield* Effect.flip(handle.exitCode);
        yield* Deferred.await(owned.exited);
        expect(ambientCommands).toEqual([taskkill]);
      }).pipe(
        Effect.scoped,
        Effect.provide(makeLayer(ambientCommands, createWorker)),
        Effect.provideService(HostProcess.Environment, environment),
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(NodeServices.layer),
      Effect.provideService(HostProcess.Platform, "win32"),
    ),
  );

  it.effect("stopping is bounded when neither the worker nor taskkill answers", () =>
    Effect.gen(function* () {
      const stopSent = yield* Deferred.make<void>();
      const taskkillStarted = yield* Deferred.make<void>();
      const workerExited = yield* Deferred.make<void>();
      const createWorker: ProcessSpawnWorker.CreateWorker = (source) => {
        const worker = new NodeWorkerThreads.Worker(source, { eval: true });
        const post = worker.postMessage.bind(worker);
        // The worker never hears the stop, as if it were stuck.
        worker.postMessage = (message: { type: string }, transfer) =>
          message.type === "stop"
            ? Deferred.doneUnsafe(stopSent, Exit.void)
            : post(message, transfer);
        worker.once("exit", () => Deferred.doneUnsafe(workerExited, Exit.void));
        return worker;
      };
      const node = yield* ChildProcessSpawner.ChildProcessSpawner;
      const hangingTaskkill = ChildProcessSpawner.make((command) =>
        command._tag === "StandardCommand" && command.command.endsWith("taskkill.exe")
          ? Deferred.succeed(taskkillStarted, undefined).pipe(Effect.andThen(Effect.never))
          : node.spawn(command),
      );
      const layerScope = yield* Scope.make();
      const spawner = yield* ProcessSpawnWorker.make(createWorker).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, hangingTaskkill),
        Effect.provideService(Scope.Scope, layerScope),
      );
      const handle = yield* spawner.spawn(ChildProcess.make("git", ["hash-object", "--stdin"]));

      const stopping = yield* Effect.forkChild(Scope.close(layerScope, Exit.void));
      yield* Deferred.await(stopSent);
      yield* TestClock.adjust("5 seconds");
      yield* Deferred.await(taskkillStarted);
      yield* TestClock.adjust("5 seconds");

      yield* Fiber.join(stopping);
      yield* Deferred.await(workerExited);
      yield* Effect.flip(handle.exitCode);
    }).pipe(
      Effect.scoped,
      Effect.provide(NodeServices.layer),
      Effect.provideService(HostProcess.Platform, "win32"),
    ),
  );
});
