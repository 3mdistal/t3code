// fork: see FORK.md.
/**
 * Node's recursive `rm` queues an async request per entry on the four-thread pool that every file
 * read and DNS lookup shares, so deleting a pnpm `node_modules` stalled the server for a minute.
 * This walks from a worker thread with synchronous calls, which never use that pool. Not
 * `fs.rmSync`: under Electron 44 it can return without deleting, and a worker can't stop it.
 */
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import * as NodeWorkerThreads from "node:worker_threads";

const workerSource = `
const { parentPort, workerData } = require("node:worker_threads");
const fs = require("node:fs");
const path = require("node:path");
const unlink = (target, isLink) => {
  try {
    fs.unlinkSync(target);
  } catch (error) {
    if (error.code !== "EPERM") throw error;
    // Windows: a directory link goes with rmdir, and a read-only file once it is writable.
    if (isLink) return fs.rmdirSync(target);
    fs.chmodSync(target, 0o666);
    fs.unlinkSync(target);
  }
};
// Links are unlinked, never entered.
const remove = (target, last) => {
  const stats = fs.lstatSync(target);
  if (!stats.isDirectory()) return unlink(target, stats.isSymbolicLink());
  const names = fs.readdirSync(target);
  // Windows reads a \`.GIT\` file as \`.git\`.
  const isLast = (name) => name.toLowerCase() === last;
  for (const name of names) if (!isLast(name)) remove(path.join(target, name));
  for (const name of names) if (isLast(name)) remove(path.join(target, name));
  fs.rmdirSync(target);
};
try {
  // \`.git\` goes last, so a delete stopped partway leaves a worktree a retry recognizes.
  remove(workerData.target, ".git");
  parentPort.postMessage({ ok: true });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    message: String((error && error.message) || error),
    code: error && error.code,
    path: error && error.path,
  });
}
`;

interface WorkerResult {
  readonly ok: boolean;
  readonly message?: string;
  readonly code?: string;
  readonly path?: string;
}

export class WorktreeDeleteError extends Data.TaggedError("WorktreeDeleteError")<{
  readonly message: string;
  readonly code?: string | undefined;
  readonly path?: string | undefined;
}> {}

export type CreateWorker = (source: string, target: string) => NodeWorkerThreads.Worker;

/** Starts the delete worker. Tests provide one they can pause. */
export const DeleteWorkerFactory = Context.Reference<CreateWorker>(
  "t3/vcs/worktreeDeleteWorkerFactory",
  {
    defaultValue: () => (source, target) =>
      new NodeWorkerThreads.Worker(source, { eval: true, workerData: { target } }),
  },
);

const oneAtATime = Semaphore.makeUnsafe(1);

/**
 * Runs Windows worktree removals one at a time, so a cleanup sweep doesn't compete for the disk.
 * The slot covers a removal's checks too: one queued behind a long delete checks after waiting.
 */
export const oneRemovalAtATime = <A, E, R>(removal: Effect.Effect<A, E, R>) =>
  Effect.flatMap(HostProcess.isWindows, (windows) =>
    windows ? oneAtATime.withPermit(removal) : removal,
  );

/** Deletes `target`. Interrupting it terminates the worker before it completes. */
export const deleteWorktreeFolder = Effect.fn("WorktreeRemoval.deleteWorktreeFolder")(function* (
  target: string,
) {
  const createWorker = yield* DeleteWorkerFactory;
  yield* Effect.callback<void, WorktreeDeleteError>((resume) => {
    const worker = createWorker(workerSource, target);
    // A server that exits mid-delete still leaves a worktree that a retry can finish.
    worker.unref();
    let outcome: Effect.Effect<void, WorktreeDeleteError> | undefined;
    worker.once("message", (result: WorkerResult) => {
      outcome = result.ok
        ? Effect.void
        : Effect.fail(
            new WorktreeDeleteError({
              message: result.message ?? "delete failed",
              code: result.code,
              path: result.path,
            }),
          );
    });
    worker.once("error", (error) => {
      outcome ??= Effect.fail(new WorktreeDeleteError({ message: error.message }));
    });
    // Resuming on exit, not on the reply, means the thread is gone before removal continues.
    worker.once("exit", (code) =>
      resume(
        outcome ??
          Effect.fail(
            new WorktreeDeleteError({ message: `delete worker exited with code ${code}` }),
          ),
      ),
    );
    return Effect.promise(() => worker.terminate());
  });
});
