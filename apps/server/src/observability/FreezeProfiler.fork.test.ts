// @effect-diagnostics nodeBuiltinImport:off - The profiler writes plain files from a worker; the test reads them the same way.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, assert, describe, it } from "@effect/vitest";

import * as FreezeProfiler from "./FreezeProfiler.ts";

interface ProfileNode {
  readonly callFrame: { readonly functionName: string };
}

const options = (dir: string): FreezeProfiler.FreezeProfilerOptions => ({
  dir,
  freezeMs: 400,
  rotateMs: 60_000,
  beatMs: 20,
  pollMs: 20,
  samplingIntervalUs: 1_000,
  keep: 2,
});

/** Blocks the main thread in a native call, as a slow process start or file call would. */
function holdTheMainThread(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** One turn of the event loop, through its timers, so the heartbeat can beat. */
const turn = async () => {
  // oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- The heartbeat is a timer on this thread, and no event marks that it ran.
  await new Promise((resolve) => setImmediate(resolve));
  // oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- As above; the second turn makes sure the loop passed its timers.
  await new Promise((resolve) => setImmediate(resolve));
};

const running: Array<FreezeProfiler.FreezeProfilerHandle> = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((profiler) => profiler.stop()));
});

function start() {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-freeze-"));
  const events: Array<FreezeProfiler.FreezeProfilerEvent> = [];
  let wake: (() => void) | undefined;
  const profiler = FreezeProfiler.startFreezeProfiler(options(dir), (event) => {
    events.push(event);
    wake?.();
  });
  running.push(profiler);
  let read = 0;
  /** The worker's next event, in order. */
  const next = async (): Promise<FreezeProfiler.FreezeProfilerEvent> => {
    while (read >= events.length) await new Promise<void>((resolve) => (wake = resolve));
    return events[read++]!;
  };
  const nextSave = async () => {
    const event = await next();
    if (event.type !== "saved")
      assert.fail(`expected a saved profile, got ${JSON.stringify(event)}`);
    return event;
  };
  return { dir, next, nextSave };
}

describe("FreezeProfiler", () => {
  it("saves a profile naming the function that held the main thread", async () => {
    const { next, nextSave } = start();
    assert.deepStrictEqual(await next(), { type: "started" });

    holdTheMainThread(1_000);
    const saved = await nextSave();
    assert.isAtLeast(saved.freezeMs, 900);
    assert.isBelow(saved.workerPauseMs, 400);
    const profile = JSON.parse(NodeFS.readFileSync(saved.file, "utf8")) as {
      readonly nodes: ReadonlyArray<ProfileNode>;
    };
    assert.isTrue(
      profile.nodes.some((node) => node.callFrame.functionName === "holdTheMainThread"),
    );
  });

  it("ignores a main thread that keeps beating", async () => {
    const { next, nextSave } = start();
    assert.deepStrictEqual(await next(), { type: "started" });

    // Busy for a second and a half in all, but never silent for long.
    for (let step = 0; step < 15; step += 1) {
      holdTheMainThread(100);
      await turn();
    }
    holdTheMainThread(1_000);
    // A save for one of the short holds would come first.
    assert.isAtLeast((await nextSave()).freezeMs, 900);
  });

  it("keeps only the newest profiles", async () => {
    const { dir, next, nextSave } = start();
    assert.deepStrictEqual(await next(), { type: "started" });

    for (let freeze = 0; freeze < 3; freeze += 1) {
      holdTheMainThread(600);
      await nextSave();
    }
    assert.lengthOf(
      NodeFS.readdirSync(dir).filter((name) => name.endsWith(".cpuprofile")),
      2,
    );
  });
});
