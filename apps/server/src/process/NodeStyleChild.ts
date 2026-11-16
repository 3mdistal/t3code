// fork: see FORK.md.
/**
 * For spawn hooks that need a Node `ChildProcess` back at once, such as the Claude Agent SDK's. The
 * program starts through the server's spawner, so on Windows from the spawn worker. Events follow
 * Node's: "spawn", "exit", then "close" once output drains, or "error" alone if it cannot start.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeEvents from "node:events";
import * as NodeStream from "node:stream";

import * as PlatformNodeStream from "@effect/platform-node/NodeStream";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import type * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

// Output can trail the exit. A pipe a grandchild still holds would never close, so past this the
// streams end anyway.
const TRAILING_OUTPUT_GRACE = "5 seconds";

export interface NodeStyleSpawnOptions {
  readonly cwd?: string | undefined;
  readonly env: Record<string, string | undefined>;
  /** Like Node's `signal` option: aborting it kills the program. */
  readonly signal?: AbortSignal | undefined;
}

export class NodeStyleChild extends NodeEvents.EventEmitter {
  readonly stdin = new NodeStream.PassThrough();
  readonly stdout = new NodeStream.PassThrough();
  readonly stderr = new NodeStream.PassThrough();
  pid: number | undefined = undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  /** The signal of the first kill, which Node reports at exit in place of the code on Windows. */
  requestedSignal: NodeJS.Signals | undefined = undefined;
  handle: ChildProcessSpawner.ChildProcessHandle | undefined = undefined;

  constructor(private readonly runFork: (effect: Effect.Effect<void>) => unknown) {
    super();
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    if (this.exitCode !== null || this.signalCode !== null) return false;
    this.killed = true;
    this.requestedSignal ??= signal;
    if (this.handle !== undefined) this.sendKill(this.handle, signal);
    return true;
  }

  sendKill(handle: ChildProcessSpawner.ChildProcessHandle, signal: NodeJS.Signals) {
    this.runFork(Effect.ignore(handle.kill({ killSignal: signal as ChildProcess.Signal })));
  }
}

const drained = (target: NodeStream.Writable) =>
  Effect.callback<void>((resume) => {
    const done = () => {
      target.off("drain", done);
      target.off("close", done);
      resume(Effect.void);
    };
    target.on("drain", done);
    target.on("close", done);
    return Effect.sync(() => {
      target.off("drain", done);
      target.off("close", done);
    });
  });

// A slow reader holds the program back until it exits. What is left then is bounded by the pipe and
// the worker's unread limit, so it is buffered for the reader rather than dropped.
const writeChunk = (
  target: NodeStream.Writable,
  chunk: Uint8Array,
  exited: Deferred.Deferred<void>,
) =>
  target.destroyed || target.write(chunk) || Deferred.isDoneUnsafe(exited)
    ? Effect.void
    : Effect.raceFirst(drained(target), Deferred.await(exited));

const relay = (
  from: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
  target: NodeStream.PassThrough,
  exited: Deferred.Deferred<void>,
) =>
  Stream.runForEach(from, (chunk) => writeChunk(target, chunk, exited)).pipe(
    Effect.ignore,
    Effect.ensuring(Effect.sync(() => target.end())),
  );

/** The spawn error Node would raise, which callers check for `code` and `syscall`. */
const nodeError = (error: PlatformError.PlatformError): Error =>
  error.reason.cause instanceof Error ? error.reason.cause : error;

export const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const runFork = Effect.runForkWith(yield* Effect.context<never>());

  return (
    command: string,
    args: ReadonlyArray<string>,
    options: NodeStyleSpawnOptions,
  ): NodeStyleChild => {
    const child = new NodeStyleChild(runFork);
    const abort = () => child.kill();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();

    const sendInput = (handle: ChildProcessSpawner.ChildProcessHandle) =>
      Stream.run(
        PlatformNodeStream.fromReadable<Uint8Array>({
          evaluate: () => child.stdin,
          closeOnDone: false,
        }),
        handle.stdin,
      ).pipe(
        // As when Node's pipe breaks: later writes fail, and the caller hears it on stdin.
        Effect.catchCause((cause) =>
          Effect.sync(() => child.stdin.destroy(Cause.squash(cause) as Error)),
        ),
      );

    const run = Effect.gen(function* () {
      // The caller attaches its listeners after this returns.
      yield* Effect.yieldNow;
      const handle = yield* spawner.spawn(
        ChildProcess.make(command, [...args], {
          cwd: options.cwd,
          env: options.env,
          extendEnv: false,
        }),
      );
      child.handle = handle;
      child.pid = handle.pid;
      child.emit("spawn");
      if (child.requestedSignal !== undefined) child.sendKill(handle, child.requestedSignal);
      yield* Effect.forkScoped(sendInput(handle));
      const exited = Deferred.makeUnsafe<void>();
      const output = yield* Effect.forkScoped(
        Effect.all(
          [relay(handle.stdout, child.stdout, exited), relay(handle.stderr, child.stderr, exited)],
          { concurrency: "unbounded", discard: true },
        ),
      );
      const exit = yield* Effect.exit(handle.exitCode);
      // Node ends a child on Windows with TerminateProcess and reports the signal it was asked for.
      if (Exit.isSuccess(exit) && child.requestedSignal === undefined) {
        child.exitCode = exit.value;
      } else {
        child.signalCode = child.requestedSignal ?? "SIGKILL";
      }
      // As Node does, so later writes fail instead of piling up.
      child.stdin.destroy();
      Deferred.doneUnsafe(exited, Exit.void);
      child.emit("exit", child.exitCode, child.signalCode);
      yield* Fiber.join(output).pipe(Effect.timeoutOption(TRAILING_OUTPUT_GRACE));
      child.stdout.end();
      child.stderr.end();
      child.emit("close", child.exitCode, child.signalCode);
    }).pipe(
      Effect.scoped,
      Effect.catch((error) =>
        Effect.sync(() => {
          child.stdin.destroy();
          child.stdout.end();
          child.stderr.end();
          child.emit("error", nodeError(error));
        }),
      ),
      Effect.ensuring(Effect.sync(() => options.signal?.removeEventListener("abort", abort))),
    );
    runFork(run);
    return child;
  };
});
