import { MessageId, RunId, ScheduledTaskId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  effectiveLimits,
  GiB,
  hasPhrase,
  heldLaunchesNote,
  idleSessionsToClose,
  type HostReading,
  isAlicesMessage,
  latestUserMessage,
  launchAnyway,
  newestInterruptible,
  nextState,
  offUntil,
  TIMING,
} from "./policy.ts";

const pc = effectiveLimits({}, "win32")!;

const reading = (headroom: number, available: number, extra: Partial<HostReading> = {}) =>
  ({
    sampledAt: 0,
    availableBytes: available * GiB,
    totalBytes: 128 * GiB,
    commitLimitBytes: 135 * GiB,
    committedBytes: (135 - headroom) * GiB,
    memoryPressure: null,
    cpuUtilization: null,
    ...extra,
  }) satisfies HostReading;

describe("effectiveLimits", () => {
  it("prefills the PC with the memory gate's lines and lets saved values override them", () => {
    expect(pc).toEqual({
      pauseHeadroomGiB: 25,
      pauseAvailableGiB: 8,
      releaseHeadroomGiB: 35,
      releaseAvailableGiB: 12,
      criticalHeadroomGiB: 10,
      pauseCpuPercent: null,
      usesMemoryPressure: false,
    });
    expect(effectiveLimits({ pauseHeadroomGiB: 30, pauseCpuPercent: 90 }, "win32")).toMatchObject({
      pauseHeadroomGiB: 30,
      pauseAvailableGiB: 8,
      pauseCpuPercent: 90,
    });
  });

  it("lets macOS memory pressure decide and ignores commit lines, which macOS doesn't have", () => {
    expect(effectiveLimits({ pauseHeadroomGiB: 30, pauseAvailableGiB: 4 }, "darwin")).toMatchObject(
      {
        pauseHeadroomGiB: null,
        pauseAvailableGiB: 4,
        criticalHeadroomGiB: null,
        usesMemoryPressure: true,
      },
    );
  });

  it("has no limits on Linux, which keeps upstream's cap", () => {
    expect(effectiveLimits({ pauseHeadroomGiB: 30 }, "linux")).toBeNull();
  });
});

describe("nextState", () => {
  it("pauses under either pause line", () => {
    expect(nextState("ok", reading(40, 20), pc, null)).toBe("ok");
    expect(nextState("ok", reading(24, 20), pc, null)).toBe("paused");
    expect(nextState("ok", reading(40, 7), pc, null)).toBe("paused");
  });

  it("releases only when both readings are over their release lines", () => {
    expect(nextState("paused", reading(30, 20), pc, null)).toBe("paused");
    expect(nextState("paused", reading(40, 10), pc, null)).toBe("paused");
    expect(nextState("paused", reading(36, 13), pc, null)).toBe("ok");
  });

  it("goes critical under the critical line from any state, and leaves it only by releasing", () => {
    expect(nextState("ok", reading(9, 20), pc, null)).toBe("critical");
    expect(nextState("paused", reading(9, 20), pc, null)).toBe("critical");
    expect(nextState("critical", reading(20, 20), pc, null)).toBe("paused");
    expect(nextState("critical", reading(36, 13), pc, null)).toBe("ok");
  });

  it("pauses over the CPU line and releases ten points under it", () => {
    const limits = { ...pc, pauseCpuPercent: 90 };
    expect(nextState("ok", reading(40, 20), limits, 0.95)).toBe("paused");
    expect(nextState("paused", reading(40, 20), limits, 0.85)).toBe("paused");
    expect(nextState("paused", reading(40, 20), limits, 0.79)).toBe("ok");
  });

  it("never pauses on missing data", () => {
    const blank = reading(0, 20, { commitLimitBytes: null, committedBytes: null });
    expect(nextState("ok", blank, { ...pc, pauseCpuPercent: 90 }, null)).toBe("ok");
    expect(nextState("paused", blank, pc, null)).toBe("ok");
  });

  it("follows macOS memory pressure", () => {
    const mac = effectiveLimits({}, "darwin")!;
    const at = (memoryPressure: HostReading["memoryPressure"]) =>
      reading(0, 1, { commitLimitBytes: null, committedBytes: null, memoryPressure });
    expect(nextState("ok", at("normal"), mac, null)).toBe("ok");
    expect(nextState("ok", at("warn"), mac, null)).toBe("paused");
    expect(nextState("paused", at("warn"), mac, null)).toBe("paused");
    expect(nextState("ok", at("critical"), mac, null)).toBe("critical");
    expect(nextState("critical", at("normal"), mac, null)).toBe("ok");
  });
});

describe("isAlicesMessage", () => {
  const typed = { createdBy: "user", creationSource: "web" } as const;

  it("counts only what Alice typed in the web or mobile app", () => {
    expect(isAlicesMessage(typed)).toBe(true);
    expect(isAlicesMessage({ ...typed, creationSource: "mobile" })).toBe(true);
    expect(isAlicesMessage({ ...typed, creationSource: "mcp" })).toBe(false);
    expect(isAlicesMessage({ createdBy: "agent", creationSource: "web" })).toBe(false);
    expect(isAlicesMessage(undefined)).toBe(false);
  });

  it("doesn't count a schedule or a message relayed from another thread", () => {
    expect(isAlicesMessage({ ...typed, scheduledTaskId: ScheduledTaskId.make("task") })).toBe(
      false,
    );
    expect(isAlicesMessage({ ...typed, senderThreadId: ThreadId.make("thread:other") })).toBe(
      false,
    );
  });
});

describe("launch anyway", () => {
  it("matches the phrase in any case and punctuation, as whole words", () => {
    expect(hasPhrase("Launch anyway.")).toBe(true);
    expect(hasPhrase("ok, LAUNCH-anyway!")).toBe(true);
    expect(hasPhrase("launch\n  anyway")).toBe(true);
    expect(hasPhrase("relaunch anyway")).toBe(false);
    expect(hasPhrase("launch anyways")).toBe(false);
    expect(hasPhrase("launch it anyway")).toBe(false);
  });

  const message = (id: string, at: number, runId: string, text: string, typedByAlice = true) => ({
    id: MessageId.make(id),
    role: "user" as const,
    runId: RunId.make(runId),
    createdAt: DateTime.makeUnsafe(at),
    text,
    createdBy: typedByAlice ? ("user" as const) : ("agent" as const),
    creationSource: typedByAlice ? ("web" as const) : ("mcp" as const),
  });

  it("holds only while Alice's message is the thread's latest", () => {
    const hers = message("a", 1, "run:a", "launch anyway");
    const runs = [
      { id: "run:a", status: "completed" },
      { id: "run:b", status: "completed" },
    ];
    expect(launchAnyway(latestUserMessage([hers], runs))).toBe(true);
    const later = message("b", 2, "run:b", "thanks");
    expect(launchAnyway(latestUserMessage([hers, later], runs))).toBe(false);
  });

  it("ignores a queued message, and an agent writing the phrase", () => {
    const hers = message("a", 1, "run:a", "launch anyway");
    const queued = message("b", 2, "run:b", "something else");
    const runs = [
      { id: "run:a", status: "completed" },
      { id: "run:b", status: "queued" },
    ];
    expect(launchAnyway(latestUserMessage([hers, queued], runs))).toBe(true);
    const agent = message("c", 3, "run:c", "launch anyway", false);
    expect(
      launchAnyway(latestUserMessage([hers, agent], [{ id: "run:c", status: "completed" }])),
    ).toBe(false);
  });
});

describe("idleSessionsToClose", () => {
  const session = (id: string, lastActivityAtMs: number, busy = 0) => ({
    id,
    busyTurns: { size: busy },
    attachedThreadIds: new Set([ThreadId.make(`thread:${id}`)]),
    lastActivityAtMs,
  });

  it("closes idle sessions oldest first, keeping busy ones and ones waiting on Alice", () => {
    const sessions = [
      session("new", 3),
      session("busy", 1, 1),
      session("asking", 0),
      session("old", 2),
    ];
    expect(
      idleSessionsToClose(sessions, new Set([ThreadId.make("thread:asking")])).map(({ id }) => id),
    ).toEqual(["old", "new"]);
  });
});

describe("newestInterruptible", () => {
  const turn = (id: string, startedAt: number, extra = {}) => ({
    threadId: ThreadId.make(`thread:${id}`),
    runId: RunId.make(`run:${id}`),
    startedAt,
    waitingOnUser: false,
    stopRequested: false,
    ...extra,
  });

  it("picks the newest turn, skipping ones waiting on Alice, stopping, or already interrupted", () => {
    const turns = [
      turn("old", 1),
      turn("asking", 5, { waitingOnUser: true }),
      turn("stopping", 4, { stopRequested: true }),
      turn("done", 3),
      turn("new", 2),
    ];
    expect(newestInterruptible(turns, new Set(["run:done"]))?.runId).toBe("run:new");
    expect(newestInterruptible(turns, new Set(["run:done", "run:new", "run:old"]))).toBeUndefined();
  });
});

describe("offUntil", () => {
  it("reads the override file, never past a day after it was written", () => {
    expect(offUntil({ at: 0, until: 2 * 3_600_000 }, 1)).toBe(2 * 3_600_000);
    expect(offUntil({ at: 0, until: 48 * 3_600_000 }, 1)).toBe(TIMING.maxOffMs);
  });

  it("treats a past, malformed or missing switch as none", () => {
    expect(offUntil({ at: 0, until: 1_000 }, 1_000)).toBeNull();
    expect(offUntil({ at: "0", until: 5_000 }, 1)).toBeNull();
    expect(offUntil(null, 1)).toBeNull();
  });
});

describe("heldLaunchesNote", () => {
  it("bounds what a hook record can put in the prompt", () => {
    const note = heldLaunchesNote(
      Array.from({ length: 8 }, (_, index) => `task ${index} ${"x".repeat(500)}`),
      0,
    );
    expect(note.summary).toBe("The memory limits held 8 launches");
    expect(note.text).toContain("; and 3 more");
    expect(note.text.length).toBeLessThan(5 * 200 + 300);
  });
});
