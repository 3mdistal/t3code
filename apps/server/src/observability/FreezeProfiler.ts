// fork: see FORK.md.
/**
 * A freeze leaves only the spans that were waiting when the event loop stopped, never the call that
 * held it. On Windows a worker thread keeps a rolling CPU profile of the main thread and saves it
 * when the main thread misses its heartbeat for several seconds. The profile is only read back once
 * the main thread is free again, so the saved file covers the freeze and the minutes before it.
 */
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as NodeWorkerThreads from "node:worker_threads";

import * as ServerConfig from "../config.ts";

export interface FreezeProfilerOptions {
  readonly dir: string;
  /** A main thread silent this long has frozen. */
  readonly freezeMs: number;
  /** A profile with no freeze is dropped and restarted this often, which bounds its memory. */
  readonly rotateMs: number;
  readonly beatMs: number;
  readonly pollMs: number;
  readonly samplingIntervalUs: number;
  /** Profiles kept; the oldest go first. */
  readonly keep: number;
}

export const DEFAULT_OPTIONS: Omit<FreezeProfilerOptions, "dir"> = {
  freezeMs: 3000,
  rotateMs: 2 * 60_000,
  beatMs: 250,
  pollMs: 250,
  samplingIntervalUs: 10_000,
  keep: 20,
};

export type FreezeProfilerEvent =
  | { readonly type: "started" }
  | {
      readonly type: "saved";
      readonly file: string;
      readonly freezeMs: number;
      readonly workerPauseMs: number;
    }
  | { readonly type: "failed"; readonly message: string };

const workerSource = `
const { parentPort, workerData } = require("node:worker_threads");
const inspector = require("node:inspector");
const fs = require("node:fs");
const path = require("node:path");
const { dir, beatBuffer, freezeMs, rotateMs, pollMs, samplingIntervalUs, keep } = workerData;
const beat = new Int32Array(beatBuffer);
const session = new inspector.Session();
const post = (method, params) =>
  new Promise((resolve, reject) =>
    session.post(method, params || {}, (error, result) => (error ? reject(error) : resolve(result))),
  );
const fail = (error) => {
  parentPort.postMessage({ type: "failed", message: String((error && error.message) || error) });
};
let lastCount = Atomics.load(beat, 0);
let lastBeatAt = Date.now();
let lastPollAt = lastBeatAt;
// The longest this thread itself was paused since the last beat. As long as the freeze, the whole
// process was suspended (a sleeping PC), not blocked.
let workerPauseMs = 0;
let profileStartedAt = 0;
// Busy until the first profile starts.
let busy = true;
const restart = async (keepAs) => {
  const { profile } = await post("Profiler.stop");
  if (keepAs) {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, keepAs);
    fs.writeFileSync(file, JSON.stringify(profile));
    const saved = fs.readdirSync(dir).filter((name) => name.endsWith(".cpuprofile")).sort();
    for (const name of saved.slice(0, Math.max(0, saved.length - keep))) {
      fs.rmSync(path.join(dir, name), { force: true });
    }
  }
  await post("Profiler.start");
  profileStartedAt = Date.now();
  return keepAs && path.join(dir, keepAs);
};
const poll = async () => {
  const now = Date.now();
  workerPauseMs = Math.max(workerPauseMs, now - lastPollAt - pollMs);
  lastPollAt = now;
  if (busy) return;
  const count = Atomics.load(beat, 0);
  if (count === lastCount) return;
  const silentMs = now - lastBeatAt;
  const pausedMs = workerPauseMs;
  lastCount = count;
  lastBeatAt = now;
  workerPauseMs = 0;
  const froze = silentMs >= freezeMs && pausedMs < freezeMs;
  if (!froze && now - profileStartedAt < rotateMs) return;
  busy = true;
  try {
    const stamp = new Date(now - silentMs).toISOString().replace(/[:.]/g, "-");
    const file = await restart(froze ? "freeze-" + stamp + "-" + silentMs + "ms.cpuprofile" : undefined);
    if (file) parentPort.postMessage({ type: "saved", file, freezeMs: silentMs, workerPauseMs: pausedMs });
  } catch (error) {
    fail(error);
  } finally {
    busy = false;
  }
};
// A pending inspector reply doesn't keep a worker alive, so the timer starts first.
setInterval(poll, pollMs);
(async () => {
  try {
    session.connectToMainThread();
    await post("Profiler.enable");
    await post("Profiler.setSamplingInterval", { interval: samplingIntervalUs });
    await post("Profiler.start");
    profileStartedAt = Date.now();
    busy = false;
    parentPort.postMessage({ type: "started" });
  } catch (error) {
    fail(error);
    process.exit(1);
  }
})();
`;

export interface FreezeProfilerHandle {
  readonly stop: () => Promise<void>;
}

/** Starts the heartbeat and the profiling worker. Neither keeps the process alive. */
export function startFreezeProfiler(
  options: FreezeProfilerOptions,
  onEvent: (event: FreezeProfilerEvent) => void,
): FreezeProfilerHandle {
  const beatBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const beat = new Int32Array(beatBuffer);
  // @effect-diagnostics-next-line globalTimers:off - A plain timer, so the beat stops exactly when the event loop does.
  const heartbeat = setInterval(() => Atomics.add(beat, 0, 1), options.beatMs);
  heartbeat.unref();
  const worker = new NodeWorkerThreads.Worker(workerSource, {
    eval: true,
    workerData: { ...options, beatBuffer },
  });
  worker.unref();
  worker.on("message", onEvent);
  worker.on("error", (error) => onEvent({ type: "failed", message: error.message }));
  return {
    stop: async () => {
      clearInterval(heartbeat);
      await worker.terminate();
    },
  };
}

const disabled = () => process.env.T3CODE_FREEZE_PROFILES?.trim() === "0";

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    if (!(yield* HostProcess.isWindows) || disabled()) return;
    const { serverTracePath } = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    const dir = path.join(path.dirname(serverTracePath), "freeze-profiles");
    const events = yield* Queue.unbounded<FreezeProfilerEvent>();
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        startFreezeProfiler({ ...DEFAULT_OPTIONS, dir }, (event) => {
          Queue.offerUnsafe(events, event);
        }),
      ),
      (profiler) => Effect.promise(() => profiler.stop()),
    );
    yield* Queue.take(events).pipe(
      Effect.flatMap((event) => {
        switch (event.type) {
          case "started":
            return Effect.logInfo("freeze profiler started", { dir });
          case "saved":
            return Effect.logWarning("freeze profile saved", {
              file: event.file,
              freezeMs: event.freezeMs,
              workerPauseMs: event.workerPauseMs,
            });
          case "failed":
            return Effect.logWarning("freeze profiler failed", { message: event.message });
        }
      }),
      Effect.forever,
      Effect.forkScoped,
    );
  }),
);
