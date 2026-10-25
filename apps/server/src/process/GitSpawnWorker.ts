// fork: see FORK.md.
/**
 * Node's Windows spawn is a synchronous `CreateProcessW` that can take hundreds of milliseconds for
 * a busy `git.exe`, and git is the only program the server starts often enough to stall the event
 * loop on it. So git starts from this worker; more worker threads did not raise throughput.
 */
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeWorkerThreads from "node:worker_threads";

// Output a child may leave unread in the parent before the worker pauses it, like a pipe buffer.
export const UNREAD_LIMIT_BYTES = 1024 * 1024;

const workerSource = (taskkill: string) => `
const { parentPort } = require("node:worker_threads");
const { spawn, execFile } = require("node:child_process");
const { finished } = require("node:stream");
const children = new Map();
const describe = (error) => ({
  message: String((error && error.message) || error),
  code: error && error.code,
  errno: error && error.errno,
  syscall: error && error.syscall,
  path: error && error.path,
});
const post = (message, transfer) => parentPort.postMessage(message, transfer);
const reply = (requestId) => (error) =>
  post({ type: "replied", requestId, error: error ? describe(error) : undefined });
const relay = (id, fd, stream) => {
  let unread = 0;
  stream.on("data", (chunk) => {
    // A chunk can be a view into a larger reused buffer; a copy can be transferred.
    const copy = new Uint8Array(chunk);
    unread += copy.byteLength;
    post({ type: "data", id, fd, chunk: copy }, [copy.buffer]);
    if (unread >= ${UNREAD_LIMIT_BYTES}) stream.pause();
  });
  finished(stream, (error) => post({ type: "end", id, fd, error: error ? describe(error) : undefined }));
  return (bytes) => {
    unread -= bytes;
    if (unread < ${UNREAD_LIMIT_BYTES} && stream.isPaused()) stream.resume();
  };
};
const isRunning = (proc) => proc.exitCode === null && proc.signalCode === null;
const kill = (proc, signal, done) => {
  // Once the child has exited its PID may belong to an unrelated process.
  if (!isRunning(proc)) return done();
  const signalChild = () => {
    try {
      proc.kill(signal);
      done();
    } catch (error) {
      done(error);
    }
  };
  if (process.platform !== "win32") return signalChild();
  // As in Effect's Node spawner: only taskkill ends a tree on Windows, and a signal is the fallback.
  execFile(${JSON.stringify(taskkill)}, ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true }, (error) =>
    error ? signalChild() : done(),
  );
};
parentPort.on("message", (message) => {
  const child = children.get(message.id);
  switch (message.type) {
    case "spawn": {
      const id = message.id;
      let spawned;
      try {
        spawned = spawn(message.command, message.args, {
          cwd: message.cwd,
          env: message.env,
          stdio: "pipe",
          windowsHide: message.windowsHide,
        });
      } catch (error) {
        post({ type: "error", id, error: describe(error) });
        return;
      }
      children.set(id, {
        proc: spawned,
        read: { 1: relay(id, 1, spawned.stdout), 2: relay(id, 2, spawned.stderr) },
      });
      let started = false;
      spawned.on("error", (error) => {
        if (started) return;
        children.delete(id);
        post({ type: "error", id, error: describe(error) });
      });
      spawned.once("spawn", () => {
        started = true;
        post({ type: "spawned", id, pid: spawned.pid });
      });
      // A child that exits before reading its input fails later writes; their replies report it.
      spawned.stdin.on("error", () => {});
      spawned.once("exit", (code, signal) => post({ type: "exit", id, code, signal }));
      spawned.once("close", () => children.delete(id));
      return;
    }
    case "read":
      if (child) child.read[message.fd](message.bytes);
      return;
    case "stdin": {
      const done = reply(message.requestId);
      if (!child) return done();
      child.proc.stdin.write(message.chunk, done);
      return;
    }
    case "stdin-end": {
      const done = reply(message.requestId);
      if (!child) return done();
      child.proc.stdin.end();
      finished(child.proc.stdin, done);
      return;
    }
    case "kill": {
      const done = reply(message.requestId);
      if (!child) return done();
      kill(child.proc, message.signal, done);
      return;
    }
    case "release":
      // Output nobody will read would otherwise hold the child's pipes paused forever.
      if (child) {
        child.proc.stdout.destroy();
        child.proc.stderr.destroy();
      }
      return;
    case "stop": {
      const done = reply(message.requestId);
      const running = [...children.values()]
        .map((entry) => entry.proc)
        .filter((proc) => proc.pid !== undefined && isRunning(proc));
      let remaining = running.length;
      if (remaining === 0) return done();
      for (const proc of running) {
        proc.once("exit", () => {
          remaining -= 1;
          if (remaining === 0) done();
        });
        kill(proc, "SIGKILL", () => {});
      }
      return;
    }
  }
});
`;

interface WorkerError {
  readonly message: string;
  readonly code?: string | undefined;
  readonly errno?: number | undefined;
  readonly syscall?: string | undefined;
  readonly path?: string | undefined;
}

type WorkerMessage =
  | { readonly type: "spawned"; readonly id: number; readonly pid: number }
  | { readonly type: "error"; readonly id: number; readonly error: WorkerError }
  | { readonly type: "data"; readonly id: number; readonly fd: 1 | 2; readonly chunk: Uint8Array }
  | {
      readonly type: "end";
      readonly id: number;
      readonly fd: 1 | 2;
      readonly error?: WorkerError | undefined;
    }
  | {
      readonly type: "exit";
      readonly id: number;
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    }
  | {
      readonly type: "replied";
      readonly requestId: number;
      readonly error?: WorkerError | undefined;
    };

type WorkerRequest =
  | { readonly type: "kill"; readonly id: number; readonly signal: ChildProcess.Signal }
  | { readonly type: "stdin"; readonly id: number; readonly chunk: Uint8Array }
  | { readonly type: "stdin-end"; readonly id: number }
  | { readonly type: "stop" };

type OutputQueue = Queue.Queue<Uint8Array, PlatformError.PlatformError | Cause.Done>;
type ExitCodeWithSignal = readonly [code: number | null, signal: NodeJS.Signals | null];

interface WorkerChild {
  readonly command: ChildProcess.StandardCommand;
  readonly stdout: OutputQueue;
  readonly stderr: OutputQueue;
  readonly exit: Deferred.Deferred<ExitCodeWithSignal, PlatformError.PlatformError>;
  readonly settleSpawn: (
    result: Exit.Exit<ChildProcessSpawner.ProcessId, PlatformError.PlatformError>,
  ) => void;
  pid: number | undefined;
  /** Exit plus the end of stdout and stderr; data can trail the exit. */
  pendingEvents: number;
}

export type CreateWorker = (source: string) => NodeWorkerThreads.Worker;

const createEvalWorker: CreateWorker = (source) =>
  new NodeWorkerThreads.Worker(source, { eval: true });

const GIT_EXECUTABLE = /(?:^|[\\/])git(?:\.exe)?$/i;
// Effect's Node spawner waits this long for a signalled process before kill returns.
const KILL_GRACE_MILLIS = 1_000;
// Bounds each shutdown step: the worker's own kills, then the server's.
const STOP_GRACE = Duration.seconds(5);

const isPipe = (option: unknown) => option === undefined || option === "pipe";

// Pipelines, shell commands, `git.cmd` shims, detached runs and non-pipe stdio keep the ambient spawner.
const runsOnWorker = (command: ChildProcess.Command): command is ChildProcess.StandardCommand =>
  command._tag === "StandardCommand" &&
  GIT_EXECUTABLE.test(command.command) &&
  !command.options.shell &&
  command.options.detached !== true &&
  command.options.additionalFds === undefined &&
  isPipe(command.options.stdin) &&
  isPipe(command.options.stdout) &&
  isPipe(command.options.stderr);

const systemErrorTag = (code: string | undefined): PlatformError.SystemErrorTag => {
  switch (code) {
    case "ENOENT":
      return "NotFound";
    case "EACCES":
      return "PermissionDenied";
    case "EEXIST":
      return "AlreadyExists";
    case "EISDIR":
    case "ENOTDIR":
    case "ELOOP":
      return "BadResource";
    case "EBUSY":
      return "Busy";
    default:
      return "Unknown";
  }
};

const toError = (error: WorkerError | Error): Error =>
  error instanceof Error ? error : Object.assign(new Error(error.message), error);

/** Matches the errors Effect's Node spawner raises, which callers inspect. */
const toPlatformError = (
  method: string,
  error: WorkerError | Error,
  command: ChildProcess.StandardCommand,
): PlatformError.PlatformError => {
  const cause = toError(error) as NodeJS.ErrnoException;
  return PlatformError.systemError({
    _tag: systemErrorTag(cause.code),
    module: "ChildProcess",
    method,
    pathOrDescriptor: `${command.command} ${command.args.join(" ")}`,
    syscall: cause.syscall,
    cause,
  });
};

export const make = Effect.fn("GitSpawnWorker.make")(function* (
  createWorker: CreateWorker = createEvalWorker,
) {
  const fallback = yield* ChildProcessSpawner.ChildProcessSpawner;
  if ((yield* HostProcess.Platform) !== "win32") {
    return fallback;
  }
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  // PATH need not include System32. A parent such as MSYS may pass the name upper-cased.
  const systemRoot = Object.entries(yield* HostProcess.Environment).find(
    ([name]) => name.toUpperCase() === "SYSTEMROOT",
  )?.[1];
  const taskkill = path.join(systemRoot ?? "C:\\Windows", "System32", "taskkill.exe");

  let worker: NodeWorkerThreads.Worker | undefined;
  const children = new Map<number, WorkerChild>();
  const replies = new Map<number, (error: WorkerError | undefined) => void>();
  let nextId = 0;

  const untrack = (id: number) => {
    children.delete(id);
    if (children.size === 0) worker?.unref();
  };

  const settleEvent = (id: number, child: WorkerChild) => {
    child.pendingEvents -= 1;
    if (child.pendingEvents === 0) untrack(id);
  };

  // Children outlive the worker thread that started them, so the parent ends their trees itself.
  const killTree = (pid: number) =>
    fallback.spawn(ChildProcess.make(taskkill, ["/pid", String(pid), "/T", "/F"])).pipe(
      Effect.flatMap((handle) => handle.exitCode),
      Effect.scoped,
      Effect.exit,
      Effect.flatMap((exit) =>
        Exit.isSuccess(exit) && exit.value === 0
          ? Effect.void
          : Effect.ignore(Effect.try(() => process.kill(pid))),
      ),
    );

  // A child whose spawn reply is still in flight has no PID here and is left running, and a
  // child that exited just before the worker went may have had its PID reused.
  const abandon = (error: Error) => {
    const orphans = [...children.values()];
    children.clear();
    for (const reply of replies.values()) reply({ message: error.message });
    replies.clear();
    return Effect.forEach(
      orphans,
      (child) => {
        child.settleSpawn(Exit.fail(toPlatformError("spawn", error, child.command)));
        for (const [queue, method] of [
          [child.stdout, "fromReadable(stdout)"],
          [child.stderr, "fromReadable(stderr)"],
        ] as const) {
          Queue.failCauseUnsafe(queue, Cause.fail(toPlatformError(method, error, child.command)));
        }
        const fail = Effect.sync(() =>
          Deferred.doneUnsafe(
            child.exit,
            Exit.fail(toPlatformError("exitCode", error, child.command)),
          ),
        );
        return child.pid === undefined || Deferred.isDoneUnsafe(child.exit)
          ? fail
          : Effect.ensuring(killTree(child.pid), fail);
      },
      { concurrency: "unbounded", discard: true },
    ).pipe(Effect.timeoutOption(STOP_GRACE), Effect.asVoid);
  };

  const onMessage = (message: WorkerMessage) => {
    if (message.type === "replied") {
      const reply = replies.get(message.requestId);
      replies.delete(message.requestId);
      reply?.(message.error);
      return;
    }
    const child = children.get(message.id);
    if (child === undefined) return;
    switch (message.type) {
      case "spawned":
        child.pid = message.pid;
        child.settleSpawn(Exit.succeed(ChildProcessSpawner.ProcessId(message.pid)));
        return;
      case "error":
        untrack(message.id);
        child.settleSpawn(Exit.fail(toPlatformError("spawn", message.error, child.command)));
        return;
      case "data":
        Queue.offerUnsafe(message.fd === 1 ? child.stdout : child.stderr, message.chunk);
        return;
      case "end": {
        const queue = message.fd === 1 ? child.stdout : child.stderr;
        if (message.error === undefined) {
          Queue.endUnsafe(queue);
        } else {
          const method = message.fd === 1 ? "fromReadable(stdout)" : "fromReadable(stderr)";
          Queue.failCauseUnsafe(
            queue,
            Cause.fail(toPlatformError(method, message.error, child.command)),
          );
        }
        settleEvent(message.id, child);
        return;
      }
      case "exit":
        Deferred.doneUnsafe(child.exit, Exit.succeed([message.code, message.signal] as const));
        settleEvent(message.id, child);
        return;
    }
  };

  const currentWorker = () => {
    if (worker !== undefined) return worker;
    const created = createWorker(workerSource(taskkill));
    created.unref();
    created.on("message", onMessage);
    const lost = (error: Error) => {
      if (worker !== created) return;
      worker = undefined;
      runFork(abandon(error));
    };
    created.on("error", lost);
    created.on("exit", (code) => lost(new Error(`Git spawn worker exited with code ${code}`)));
    worker = created;
    return created;
  };

  const post = (
    target: NodeWorkerThreads.Worker | undefined,
    message: object,
    transfer?: ReadonlyArray<NodeWorkerThreads.Transferable>,
  ) => target?.postMessage(message, transfer);

  const request = (
    message: WorkerRequest,
    transfer?: ReadonlyArray<NodeWorkerThreads.Transferable>,
  ) =>
    Effect.callback<void, WorkerError>((resume) => {
      if (worker === undefined) {
        resume(Effect.void);
        return;
      }
      const requestId = nextId++;
      replies.set(requestId, (error) =>
        resume(error === undefined ? Effect.void : Effect.fail(error)),
      );
      post(worker, { ...message, requestId }, transfer);
      return Effect.sync(() => replies.delete(requestId));
    });

  yield* Effect.addFinalizer(() => {
    const current = worker;
    if (current === undefined) return Effect.void;
    return request({ type: "stop" }).pipe(
      Effect.timeoutOption(STOP_GRACE),
      Effect.ignore,
      Effect.andThen(
        Effect.suspend(() => {
          worker = undefined;
          return abandon(new Error("Git spawn worker stopped"));
        }),
      ),
      Effect.ensuring(Effect.promise(() => current.terminate())),
    );
  });

  // Untraced: each spawn already runs inside its caller's command span.
  const spawnOnWorker = Effect.fnUntraced(function* (command: ChildProcess.StandardCommand) {
    const options = command.options;
    // Like Effect's Node spawner, so a missing cwd fails the same way.
    let cwd: string | undefined;
    if (options.cwd !== undefined) {
      yield* fileSystem.access(options.cwd);
      cwd = path.resolve(options.cwd);
    }
    // The worker has its own copy of process.env, so send the effective one.
    const env = options.extendEnv
      ? { ...process.env, ...options.env }
      : (options.env ?? { ...process.env });
    const stdout = yield* Queue.make<Uint8Array, PlatformError.PlatformError | Cause.Done>();
    const stderr = yield* Queue.make<Uint8Array, PlatformError.PlatformError | Cause.Done>();
    const exit = Deferred.makeUnsafe<ExitCodeWithSignal, PlatformError.PlatformError>();
    const id = nextId++;
    const failedWith = (method: string) => (error: WorkerError) =>
      toPlatformError(method, error, command);

    const signal = (killSignal: ChildProcess.Signal) =>
      request({ type: "kill", id, signal: killSignal }).pipe(Effect.mapError(failedWith("kill")));
    const exitWithin = (millis: number) =>
      Effect.exit(Deferred.await(exit)).pipe(
        Effect.timeoutOption(millis),
        Effect.map(Option.isSome),
      );
    const kill = Effect.fnUntraced(function* (killOptions?: ChildProcess.KillOptions) {
      yield* signal(killOptions?.killSignal ?? "SIGTERM");
      if (killOptions?.forceKillAfter === undefined) {
        yield* exitWithin(KILL_GRACE_MILLIS);
      } else if (!(yield* exitWithin(Duration.toMillis(killOptions.forceKillAfter)))) {
        yield* signal("SIGKILL");
        yield* exitWithin(KILL_GRACE_MILLIS);
      }
      yield* Effect.ignore(Deferred.await(exit));
    });

    const pid = yield* Effect.acquireRelease(
      Effect.callback<ChildProcessSpawner.ProcessId, PlatformError.PlatformError>((resume) => {
        let settled = false;
        const settleSpawn: WorkerChild["settleSpawn"] = (result) => {
          if (settled) return;
          settled = true;
          resume(result);
        };
        let target: NodeWorkerThreads.Worker;
        try {
          target = currentWorker();
        } catch (error) {
          settleSpawn(Exit.fail(toPlatformError("spawn", toError(error as Error), command)));
          return;
        }
        if (children.size === 0) target.ref();
        children.set(id, {
          command,
          stdout,
          stderr,
          exit,
          settleSpawn,
          pid: undefined,
          pendingEvents: 3,
        });
        post(target, {
          type: "spawn",
          id,
          command: command.command,
          args: command.args,
          cwd,
          env,
          windowsHide: options.windowsHide ?? true,
        });
        // Interrupted before the spawn reply: the worker handles messages in
        // order, so these reach the child once it exists.
        return Effect.sync(() => {
          settled = true;
          post(worker, { type: "kill", id, requestId: -1 });
          post(worker, { type: "release", id });
        });
      }),
      () =>
        Effect.gen(function* () {
          if (!Deferred.isDoneUnsafe(exit)) yield* Effect.ignore(kill(options));
          post(worker, { type: "release", id });
        }),
    );

    // Taking a chunk returns its bytes to the worker's budget for this stream.
    const output = (queue: OutputQueue, fd: 1 | 2) =>
      Stream.fromQueue(queue).pipe(
        Stream.tap((chunk) =>
          Effect.sync(() => post(worker, { type: "read", id, fd, bytes: chunk.byteLength })),
        ),
      );
    const stdoutStream = output(stdout, 1);
    const stderrStream = output(stderr, 2);
    const stdin = Sink.forEach((chunk: Uint8Array) => {
      // A Buffer can be a view into a shared pool, so the worker gets its own copy.
      const copy = new Uint8Array(chunk);
      return request({ type: "stdin", id, chunk: copy }, [copy.buffer]).pipe(
        Effect.mapError(failedWith("fromWritable(stdin)")),
      );
    }).pipe(
      Sink.mapEffect(() =>
        request({ type: "stdin-end", id }).pipe(Effect.mapError(failedWith("fromWritable(stdin)"))),
      ),
    );

    return ChildProcessSpawner.makeHandle({
      pid,
      exitCode: Effect.flatMap(Deferred.await(exit), ([code, exitSignal]) =>
        code === null
          ? Effect.fail(
              toPlatformError(
                "exitCode",
                new Error(`Process interrupted due to receipt of signal: '${exitSignal}'`),
                command,
              ),
            )
          : Effect.succeed(ChildProcessSpawner.ExitCode(code)),
      ),
      isRunning: Effect.sync(() => !Deferred.isDoneUnsafe(exit)),
      kill,
      stdin,
      stdout: stdoutStream,
      stderr: stderrStream,
      all: Stream.merge(stdoutStream, stderrStream),
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
      // Git runs to completion; nothing detaches it from the server's lifetime.
      unref: Effect.succeed(Effect.void),
    });
  });

  return ChildProcessSpawner.make((command) =>
    runsOnWorker(command) ? spawnOnWorker(command) : fallback.spawn(command),
  );
});

export const layer = Layer.effect(ChildProcessSpawner.ChildProcessSpawner, make());
