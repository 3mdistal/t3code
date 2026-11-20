import {
  MessageId,
  type OrchestratorMcpFailure,
  RunId,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  effectiveLimits,
  orphanedProcesses,
  stoppedWorkNoteQueued,
  withDescendants,
  GiB,
  hasPhrase,
  heldLaunchesNote,
  idleSessionsToClose,
  type HostReading,
  checkoutFreePlan,
  checkoutFreeRepository,
  isAlicesMessage,
  isDefiniteRefusal,
  interruptible,
  latestUserMessage,
  launchAnyway,
  lostWake,
  lostWakeNote,
  manualPause,
  MAX_BRIEF_LENGTH,
  moveBlocker,
  moveBrief,
  type MoveCandidate,
  movedBranchName,
  movePlan,
  type MoveTarget,
  remoteHeadBlocker,
  type ThreadThere,
  threadThere,
  upstreamOf,
  newestInterruptible,
  nextState,
  offUntil,
  pauseOrder,
  pauseOrderNotice,
  priorityRanks,
  releaseDue,
  releaseOrder,
  SESSION_GIB,
  stoppableWork,
  TIMING,
  writtenDuringPause,
} from "./policy.ts";

const pc = effectiveLimits({}, "win32", 128 * GiB)!;

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
  it("gives the PC the memory gate's lines from 80% of its RAM", () => {
    expect(pc).toEqual({
      pauseHeadroomGiB: 25.6,
      pauseAvailableGiB: 8.2,
      releaseHeadroomGiB: 35.8,
      releaseAvailableGiB: 12.3,
      criticalHeadroomGiB: 10.2,
      pauseCpuPercent: null,
      usesMemoryPressure: false,
    });
  });

  it("moves every memory line with the percentage, and a saved line wins over its own", () => {
    expect(effectiveLimits({ usePercent: 70 }, "win32", 128 * GiB)).toMatchObject({
      pauseHeadroomGiB: 38.4,
      pauseAvailableGiB: 12.3,
      releaseHeadroomGiB: 53.8,
      releaseAvailableGiB: 18.4,
      criticalHeadroomGiB: 15.4,
    });
    expect(
      effectiveLimits(
        { usePercent: 90, pauseHeadroomGiB: 30, pauseCpuPercent: 90 },
        "win32",
        128 * GiB,
      ),
    ).toMatchObject({
      pauseHeadroomGiB: 30,
      pauseAvailableGiB: 4.1,
      releaseHeadroomGiB: 17.9,
      pauseCpuPercent: 90,
    });
  });

  it("keeps macOS on memory pressure alone until a percentage is saved", () => {
    expect(effectiveLimits({}, "darwin", 64 * GiB)).toMatchObject({
      pauseAvailableGiB: null,
      releaseAvailableGiB: null,
      usesMemoryPressure: true,
    });
    expect(effectiveLimits({ usePercent: 80 }, "darwin", 64 * GiB)).toEqual({
      pauseHeadroomGiB: null,
      pauseAvailableGiB: 12.8,
      releaseHeadroomGiB: null,
      releaseAvailableGiB: 17.9,
      criticalHeadroomGiB: null,
      pauseCpuPercent: null,
      usesMemoryPressure: true,
    });
  });

  it("ignores commit lines on macOS, which has no commit charge", () => {
    expect(
      effectiveLimits({ pauseHeadroomGiB: 30, pauseAvailableGiB: 4 }, "darwin", 64 * GiB),
    ).toMatchObject({ pauseHeadroomGiB: null, pauseAvailableGiB: 4, criticalHeadroomGiB: null });
  });

  it("has no limits on Linux, which keeps upstream's cap", () => {
    expect(effectiveLimits({ usePercent: 80 }, "linux", 128 * GiB)).toBeNull();
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
    const mac = effectiveLimits({}, "darwin", 64 * GiB)!;
    const at = (memoryPressure: HostReading["memoryPressure"]) =>
      reading(0, 1, { commitLimitBytes: null, committedBytes: null, memoryPressure });
    expect(nextState("ok", at("normal"), mac, null)).toBe("ok");
    expect(nextState("ok", at("warn"), mac, null)).toBe("paused");
    expect(nextState("paused", at("warn"), mac, null)).toBe("paused");
    expect(nextState("ok", at("critical"), mac, null)).toBe("critical");
    expect(nextState("critical", at("normal"), mac, null)).toBe("ok");
  });
});

describe("releaseDue", () => {
  const due = (
    now: number,
    growingSince: ReadonlyArray<number>,
    at: HostReading | null,
    limits = pc,
  ) =>
    releaseDue({
      now,
      lastReleaseAt: growingSince.at(-1) ?? null,
      growingSince,
      reading: at,
      limits,
    }).due;

  it("releases 90 s apart just over the release lines", () => {
    expect(due(0, [], reading(36, 13))).toBe(true);
    expect(due(89_000, [0], reading(36, 13))).toBe(false);
    expect(due(TIMING.releaseSpacingMs, [0], reading(36, 13))).toBe(true);
  });

  it("releases every pass while each session from the last two minutes still has room to grow", () => {
    expect(SESSION_GIB).toBe(2);
    // Room for three sessions over the 12.3 GiB available line, and four over the 35.8 GiB one.
    const roomy = reading(44, 20);
    expect(due(15_000, [0], roomy)).toBe(true);
    expect(due(30_000, [0, 15_000], roomy)).toBe(true);
    expect(due(45_000, [0, 15_000, 30_000], roomy)).toBe(false);
    // Two minutes on, the first session counts as grown.
    expect(due(115_000, [0, 60_000, 70_000], roomy)).toBe(false);
    expect(due(TIMING.sessionGrowthMs + 5_000, [0, 60_000, 70_000], roomy)).toBe(true);
  });

  it("keeps the 90 s spacing without a reading, a release line or normal memory pressure", () => {
    expect(due(15_000, [0], null)).toBe(false);
    expect(
      due(15_000, [0], reading(44, 20, { commitLimitBytes: null, committedBytes: null })),
    ).toBe(false);
    const mac = (usePercent?: number) =>
      effectiveLimits(usePercent === undefined ? {} : { usePercent }, "darwin", 128 * GiB)!;
    const at = (memoryPressure: HostReading["memoryPressure"]) =>
      reading(0, 60, { commitLimitBytes: null, committedBytes: null, memoryPressure });
    expect(due(15_000, [0], at("normal"), mac())).toBe(false);
    expect(due(15_000, [0], at("warn"), mac(80))).toBe(false);
    expect(due(15_000, [0], at("normal"), mac(80))).toBe(true);
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

describe("withDescendants", () => {
  const row = (pid: number, parentPid: number, createdAt: number) => ({
    pid,
    parentPid,
    createdAt,
    name: "a.exe",
  });
  const pids = (rows: ReadonlyArray<{ readonly pid: number }>) => rows.map((found) => found.pid);

  it("finds everything under a process, it first", () => {
    const root = row(300, 1, 50);
    const table = [row(1, 0, 1), row(7, 8, 70), root, row(8, 300, 60), row(9, 2, 90)];
    expect(pids(withDescendants([root], table))).toEqual([300, 8, 7]);
  });

  it("doesn't follow a process older than the parent it names, or what's under that", () => {
    // 200 outlived the parent that first held 300, and a Codex command got the ID later.
    const root = row(300, 1, 50);
    const table = [root, row(200, 300, 40), row(201, 200, 60), row(301, 300, 50)];
    expect(pids(withDescendants([root], table))).toEqual([300, 301]);
  });

  it("names a process once, and survives a loop", () => {
    const [first, second] = [row(10, 11, 5), row(11, 10, 5)];
    expect(pids(withDescendants([first, second], [first, second]))).toEqual([10, 11]);
  });
});

describe("stoppedWorkNoteQueued", () => {
  const note = { id: "limits:stopped-work:thread:1", runId: "note-run" };
  it("counts a note only while its run waits in the queue", () => {
    const run = (status: string) => [{ id: "note-run", status }];
    expect(stoppedWorkNoteQueued([note], run("queued"))).toBe(true);
    expect(stoppedWorkNoteQueued([note], run("completed"))).toBe(false);
    expect(stoppedWorkNoteQueued([note], run("cancelled"))).toBe(false);
    expect(stoppedWorkNoteQueued([{ ...note, id: "limits:stopped:run:1" }], run("queued"))).toBe(
      false,
    );
    expect(stoppedWorkNoteQueued([{ ...note, runId: null }], run("queued"))).toBe(false);
  });
});

describe("orphanedProcesses", () => {
  const ROOT = 1;
  const row = (pid: number, parentPid: number, createdAt = pid, name = "a.exe") => ({
    pid,
    parentPid,
    createdAt,
    name,
  });
  const provider = row(10, ROOT, 10, "codex.exe");
  const pids = (rows: ReadonlyArray<{ readonly pid: number }>) => rows.map((found) => found.pid);
  const keptServer = row(11, 10);
  const shell = row(12, 10);
  const command = row(13, 12);
  const commandChild = row(14, 13);
  const before = [row(ROOT, 0), provider, keptServer, shell, command, commandChild];
  const without = (...pids: number[]) => before.filter((one) => !pids.includes(one.pid));

  it("finds what a dead shell left running, and not what's under it, which ends with it", () => {
    expect(pids(orphanedProcesses(before, without(12), ROOT))).toEqual([13]);
  });

  it("finds nothing when no parent died", () => {
    expect(orphanedProcesses(before, before, ROOT)).toEqual([]);
  });

  it("doesn't count a process that ended along with its parent", () => {
    expect(orphanedProcesses(before, without(12, 13, 14), ROOT)).toEqual([]);
  });

  it("leaves a process outside this server alone", () => {
    const outside = [row(20, 99), row(21, 20)];
    expect(orphanedProcesses([...before, ...outside], [row(21, 20)], ROOT)).toEqual([]);
  });

  it("doesn't take a process whose id has been reused for one that survived", () => {
    const reused = without(12, 14).map((one) =>
      one.pid === 13 ? { ...one, createdAt: 500 } : one,
    );
    expect(orphanedProcesses(before, reused, ROOT)).toEqual([]);
  });

  it("takes a parent whose id has been reused as dead", () => {
    const reused = before.map((one) => (one.pid === 12 ? { ...one, createdAt: 500 } : one));
    expect(pids(orphanedProcesses(before, reused, ROOT))).toEqual([13]);
  });

  it("doesn't treat a newer process holding a dead parent's id as the parent", () => {
    const stale = [row(ROOT, 0), row(30, ROOT, 50), row(31, 30, 40)];
    expect(orphanedProcesses(stale, [row(ROOT, 0), row(31, 30, 40)], ROOT)).toEqual([]);
  });

  it("touches nothing that isn't under Codex", () => {
    const terminal = [row(ROOT, 0, 0), row(20, ROOT), row(21, 20), row(22, 21)];
    expect(
      orphanedProcesses(terminal, [row(ROOT, 0, 0), row(20, ROOT), row(22, 21)], ROOT),
    ).toEqual([]);
  });

  it("finds a command whose Codex died with it, in any case", () => {
    const codex = [row(ROOT, 0, 0), row(10, ROOT, 10, "CODEX.EXE"), row(11, 10)];
    expect(pids(orphanedProcesses(codex, [row(ROOT, 0, 0), row(11, 10)], ROOT))).toEqual([11]);
  });

  it("gives back what the process was, for the check before it's ended", () => {
    expect(orphanedProcesses(before, without(12), ROOT)).toEqual([row(13, 12)]);
  });

  it("survives a loop in the readings", () => {
    const loop = [row(40, 41), row(41, 40)];
    expect(orphanedProcesses(loop, [row(41, 40)], ROOT)).toEqual([]);
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

  it("ignores a message cancelled from the queue, as a typed order is", () => {
    const hers = message("a", 1, "run:a", "launch anyway");
    const order = message("b", 2, "run:b", "stop all");
    const runs = [
      { id: "run:a", status: "completed" },
      { id: "run:b", status: "cancelled" },
    ];
    expect(launchAnyway(latestUserMessage([hers, order], runs))).toBe(true);
  });

  it("counts a message whose run a restart cancelled after it started", () => {
    const hers = message("a", 1, "run:a", "launch anyway");
    const later = message("b", 2, "run:b", "something else");
    const runs = [
      { id: "run:a", status: "completed" },
      { id: "run:b", status: "cancelled", startedAt: DateTime.makeUnsafe(3) },
    ];
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

describe("interruptible", () => {
  const turn = { threadId: ThreadId.make("t"), runId: RunId.make("r"), startedAt: 0 };

  it("leaves turns waiting on Alice, and turns already stopping, alone", () => {
    expect(interruptible({ ...turn, waitingOnUser: false, stopRequested: false })).toBe(true);
    expect(interruptible({ ...turn, waitingOnUser: true, stopRequested: false })).toBe(false);
    expect(interruptible({ ...turn, waitingOnUser: false, stopRequested: true })).toBe(false);
  });
});

describe("stoppableWork", () => {
  it("keeps what's really running", () => {
    const tasks = [
      { taskId: "a", kind: "command" },
      { taskId: "b", kind: "monitor" },
      { taskId: "c", kind: "background_task" },
      { taskId: "d", kind: "subagent" },
      { taskId: "e", kind: "subagent", childThreadId: "native-child" },
    ];
    expect(stoppableWork(tasks, new Set())).toEqual(tasks);
  });

  it("leaves delegated tasks and pull request watches alone", () => {
    const delegated = { taskId: "a", kind: "subagent", childThreadId: "child" };
    const watch = { taskId: "pull-request-watch:github.com/a/b#1", kind: "monitor" };
    expect(stoppableWork([delegated, watch], new Set(["child"]))).toEqual([]);
  });
});

describe("lostWake", () => {
  const wake = {
    id: MessageId.make("wake"),
    text: "Background command finished",
    createdBy: "agent",
    creationSource: "provider",
    notification: { source: { kind: "command" }, outcome: "updated", summary: "s" },
  } as const;
  const run = (ordinal: number, status: string, userMessageId: string) => ({
    ordinal,
    status,
    userMessageId,
  });

  it("finds the wake behind the thread's cancelled latest run", () => {
    expect(lostWake([wake], [run(1, "completed", "x"), run(2, "cancelled", "wake")])).toBe(wake);
  });

  it("needs the latest run to be the cancelled one", () => {
    expect(
      lostWake([wake], [run(1, "cancelled", "wake"), run(2, "completed", "x")]),
    ).toBeUndefined();
    expect(lostWake([wake], [run(1, "queued", "wake")])).toBeUndefined();
    expect(lostWake([wake], [])).toBeUndefined();
  });

  it("only counts a provider's own wake", () => {
    const runs = [run(1, "cancelled", "wake")];
    expect(lostWake([{ ...wake, createdBy: "user" }], runs)).toBeUndefined();
    expect(lostWake([{ ...wake, creationSource: "server" }], runs)).toBeUndefined();
    expect(lostWake([{ ...wake, notification: undefined }], runs)).toBeUndefined();
  });
});

describe("lostWakeNote", () => {
  it("carries what the wake said, bounded", () => {
    expect(lostWakeNote("done", 0).text).toContain("It said: done");
    expect(lostWakeNote("x".repeat(5000), 0).text.length).toBeLessThan(800);
  });
});

describe("manualPause", () => {
  it("reads the switch and keeps only what it knows", () => {
    expect(manualPause({ version: 1, mode: "finish", at: 5, by: "board" })).toEqual({
      mode: "finish",
      at: 5,
    });
    expect(manualPause({ version: 1, mode: "stop", at: 0 })).toEqual({ mode: "stop", at: 0 });
  });

  it("has no expiry: an old switch still holds", () => {
    expect(manualPause({ version: 1, mode: "finish", at: 1 })?.at).toBe(1);
  });

  it.each([
    null,
    undefined,
    "pause",
    [],
    {},
    { version: 2, mode: "finish", at: 5 },
    { version: 1, mode: "resume", at: 5 },
    { version: 1, mode: "finish" },
    { version: 1, mode: "finish", at: "5" },
    { version: 1, mode: "finish", at: -1 },
    { version: 1, mode: "finish", at: 1.5 },
    { version: 1, mode: "finish", at: Number.NaN },
  ])("treats %j as no pause", (file) => {
    expect(manualPause(file)).toBeNull();
  });
});

describe("pauseOrder", () => {
  const alice = { createdBy: "user", creationSource: "web", attachments: [] } as const;

  it.each([
    ["pause all", "finish"],
    ["stop all", "stop"],
    ["resume all", "resume"],
    ["  Pause   ALL. ", "finish"],
    ["STOP ALL!", "stop"],
    ["resume\nall", "resume"],
  ] as const)("reads %j", (text, order) => {
    expect(pauseOrder({ ...alice, text })).toBe(order);
    expect(pauseOrder({ ...alice, creationSource: "mobile", text })).toBe(order);
  });

  it.each(["pause", "stop", "stop now", "please pause all", "pause all?", "pause all agents", ""])(
    "leaves %j as an ordinary message",
    (text) => {
      expect(pauseOrder({ ...alice, text })).toBeNull();
    },
  );

  it("doesn't read inherited names as orders", () => {
    expect(pauseOrder({ ...alice, text: "constructor" })).toBeNull();
    expect(pauseOrder({ ...alice, text: "__proto__" })).toBeNull();
  });

  it("counts only what Alice typed herself, with nothing attached", () => {
    const text = "stop all";
    expect(pauseOrder({ ...alice, createdBy: "agent", text })).toBeNull();
    expect(pauseOrder({ ...alice, creationSource: "mcp", text })).toBeNull();
    expect(pauseOrder({ ...alice, senderThreadId: ThreadId.make("t"), text })).toBeNull();
    expect(pauseOrder({ ...alice, scheduledTaskId: ScheduledTaskId.make("s"), text })).toBeNull();
    expect(pauseOrder({ ...alice, attachments: [{}], text })).toBeNull();
  });
});

describe("writtenDuringPause", () => {
  const pause = { mode: "finish", at: 100 } as const;
  const alice = { createdBy: "user", creationSource: "web" } as const;

  it("counts her messages from the moment the pause began", () => {
    expect(writtenDuringPause(alice, 99, pause)).toBe(false);
    expect(writtenDuringPause(alice, 100, pause)).toBe(true);
  });

  it("never counts an agent's", () => {
    expect(writtenDuringPause({ createdBy: "agent", creationSource: "mcp" }, 200, pause)).toBe(
      false,
    );
  });
});

describe("pauseOrderNotice", () => {
  const input = { saved: true, wasPaused: false, at: 0 };

  it("says what each order did and how to undo it", () => {
    expect(pauseOrderNotice("finish", input)).toContain("resume all");
    expect(pauseOrderNotice("finish", input)).toContain("Running turns finish");
    expect(pauseOrderNotice("stop", input)).toContain("Running turns are being interrupted");
    expect(pauseOrderNotice("resume", { ...input, wasPaused: true })).toContain(
      "one thread at a time",
    );
    expect(pauseOrderNotice("resume", input)).toBe("Nothing was paused.");
  });

  it("owns up when the switch couldn't be saved", () => {
    expect(pauseOrderNotice("stop", { ...input, saved: false })).toContain("stop all");
    expect(pauseOrderNotice("stop", { ...input, saved: false })).toContain("couldn't save");
  });
});

describe("heldLaunchesNote", () => {
  it("names the pause when that's what held the launch", () => {
    expect(heldLaunchesNote(["a child"], 0).text).toContain("The memory limits held this launch");
    const paused = heldLaunchesNote(["a child"], 0, true);
    expect(paused.summary).toBe("The pause on all agents held a launch");
    expect(paused.text).toContain("The pause on all agents held this launch");
  });

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

describe("priorityRanks", () => {
  const at = 10 * 3_600_000;

  it("reads the board's positive ranks from a fresh file", () => {
    const ranks = priorityRanks(
      { version: 1, at, source: "task-wake", ranks: { "thread:a": 2, "mcp:b": 1, "thread:c": 0 } },
      at + 60_000,
    );
    expect([...ranks]).toEqual([
      ["thread:a", 2],
      ["mcp:b", 1],
    ]);
  });

  it("treats a day-old, future, malformed or missing file as no ranks", () => {
    const ranks = { "thread:a": 1 };
    expect(priorityRanks({ version: 1, at, ranks }, at + TIMING.priorityStaleMs + 1).size).toBe(0);
    expect(priorityRanks({ version: 1, at, ranks }, at - TIMING.priorityAheadMs - 1).size).toBe(0);
    expect(priorityRanks({ version: 2, at, ranks }, at).size).toBe(0);
    expect(priorityRanks({ version: 1, at: String(at), ranks }, at).size).toBe(0);
    expect(priorityRanks({ version: 1, at, ranks: [1, 2] }, at).size).toBe(0);
    expect(priorityRanks(null, at).size).toBe(0);
  });

  it("drops ranks that aren't positive finite numbers", () => {
    const ranks = priorityRanks(
      {
        version: 1,
        at,
        ranks: { a: "1", b: -3, c: Number.POSITIVE_INFINITY, d: null, e: 1.5 },
      },
      at,
    );
    expect([...ranks]).toEqual([["e", 1.5]]);
  });

  it("skips thread IDs longer than any T3 makes", () => {
    const ranks = priorityRanks({ version: 1, at, ranks: { ["x".repeat(513)]: 1, ok: 2 } }, at);
    expect([...ranks]).toEqual([["ok", 2]]);
  });
});

describe("releaseOrder", () => {
  it("puts ranked threads first, best rank first, and keeps arrival order otherwise", () => {
    const ranks = new Map([
      ["d", 3],
      ["b", 1],
      ["e", 3],
    ]);
    expect(releaseOrder(["a", "b", "c", "d", "e"], (id) => ranks.get(id) ?? null)).toEqual([
      "b",
      "d",
      "e",
      "a",
      "c",
    ]);
  });

  it("leaves the order alone when nothing is ranked", () => {
    expect(releaseOrder(["a", "b", "c"], () => null)).toEqual(["a", "b", "c"]);
  });
});

describe("moving a held thread", () => {
  const upstream = {
    remote: "origin",
    branch: "feature/x",
    repositoryKey: "github.com/alice/repo",
  };
  const movable: MoveCandidate = {
    topLevel: true,
    tags: ["needs:none"],
    git: {
      branch: "feature/x",
      isDefaultBranch: false,
      hasWorkingTreeChanges: false,
      upstream,
      aheadCount: 0,
      head: "abc123",
    },
    worktree: true,
    checkoutFree: false,
    heldAttachments: 0,
    model: { instanceId: "claude", model: "claude-opus-5-5" },
  };
  const cloud: MoveTarget = {
    projects: [{ remotes: new Map([["github.com/alice/repo", "origin"]]) }],
    providers: [{ instanceId: "claude", models: ["claude-opus-5-5"], omittedModels: 0 }],
    fallbackModel: null,
  };
  const rules = { provides: ["notion"], assumeNeeds: ["vault", "content", "gateway"] };
  const git = movable.git!;

  it.each<[string, Partial<MoveCandidate>, string | null]>([
    ["a clean, pushed worktree thread that needs nothing", {}, null],
    [
      "a root checkout on the default branch",
      { worktree: false, git: { ...git, isDefaultBranch: true } },
      null,
    ],
    ["needs only what the target provides", { tags: ["Needs:Notion", "urgent"] }, null],
    [
      "an untagged thread, under the default assumeNeeds",
      { tags: [] },
      "it needs vault, content, gateway",
    ],
    [
      "a capability the target lacks",
      { tags: ["needs:windows", "needs:notion"] },
      "it needs windows",
    ],
    ["another thread's task", { topLevel: false }, "it's another thread's task"],
    ["a held message with attachments", { heldAttachments: 1 }, "a held message has attachments"],
    ["a detached checkout", { git: { ...git, branch: null } }, "its checkout isn't on a branch"],
    ["no repository", { git: null }, "its checkout isn't on a branch"],
    [
      "a root checkout off the default branch",
      { worktree: false },
      "it works in the project checkout off the default branch",
    ],
    [
      "uncommitted changes",
      { git: { ...git, hasWorkingTreeChanges: true } },
      "it has uncommitted changes",
    ],
    ["a branch never pushed", { git: { ...git, upstream: null } }, "its branch isn't pushed"],
    [
      "a remote that names no repository",
      { git: { ...git, upstream: { ...upstream, repositoryKey: null } } },
      "its branch's remote isn't a known repository",
    ],
    ["unpushed commits", { git: { ...git, aheadCount: 2 } }, "it has unpushed commits"],
    [
      "a checkout-free thread whose checkout has no git status at all",
      { checkoutFree: true, worktree: false, git: null },
      null,
    ],
    [
      "a checkout-free thread that needs what the target lacks",
      { checkoutFree: true, worktree: false, git: null, tags: [] },
      "it needs vault, content, gateway",
    ],
    [
      "a checkout-free thread with held attachments",
      { checkoutFree: true, worktree: false, git: null, heldAttachments: 1 },
      "a held message has attachments",
    ],
    [
      "a checkout-free thread that's another thread's task",
      { checkoutFree: true, worktree: false, git: null, topLevel: false },
      "it's another thread's task",
    ],
  ])("moveBlocker: %s", (_name, candidate, expected) => {
    expect(moveBlocker({ ...movable, ...candidate }, rules)).toBe(expected);
  });

  const fallbackModel = { instanceId: "codex", model: "gpt-6.1" };
  it.each<[string, Partial<MoveTarget>, ReturnType<typeof movePlan>]>([
    ["its model there", {}, { use: "thread", remote: "origin" }],
    ["no project there", { projects: [] }, { blocker: "no project there has its repository" }],
    [
      "several projects there",
      { projects: [...cloud.projects, ...cloud.projects] },
      { blocker: "several projects there have its repository" },
    ],
    [
      "a fork remote there under another name",
      {
        projects: [
          {
            remotes: new Map([
              ["github.com/upstream/repo", "upstream"],
              ["github.com/alice/repo", "mine/fork"],
            ]),
          },
        ],
      },
      { use: "thread", remote: "mine/fork" },
    ],
    [
      "no remote there for the branch's repository",
      { projects: [{ remotes: new Map([["github.com/upstream/repo", "origin"]]) }] },
      { blocker: "the project there has no remote for github.com/alice/repo" },
    ],
    [
      "its provider isn't there",
      { providers: [] },
      { blocker: "claude claude-opus-5-5 isn't there" },
    ],
    [
      "a fallback model the target lists",
      {
        providers: [{ instanceId: "codex", models: ["gpt-6.1"], omittedModels: 0 }],
        fallbackModel,
      },
      { use: "fallback", remote: "origin" },
    ],
    [
      "a fallback model the target doesn't list",
      { providers: [{ instanceId: "codex", models: [], omittedModels: 4 }], fallbackModel },
      { blocker: "claude claude-opus-5-5 isn't there" },
    ],
    [
      "an unlisted model the provider may have",
      { providers: [{ instanceId: "claude", models: [], omittedModels: 3 }] },
      { use: "thread", remote: "origin" },
    ],
  ])("movePlan: %s", (_name, target, expected) => {
    expect(movePlan({ model: movable.model, upstream }, { ...cloud, ...target })).toEqual(expected);
  });

  it.each<[string, { repositoryKey: string | null; worktree: boolean }, string | null]>([
    [
      "the project checkout of a listed repository",
      { repositoryKey: "github.com/alice/vault", worktree: false },
      "github.com/alice/vault",
    ],
    [
      "a listed repository written in another case",
      { repositoryKey: "github.com/Alice/Vault", worktree: false },
      "github.com/alice/vault",
    ],
    [
      "a worktree of its own keeps the usual checks",
      { repositoryKey: "github.com/alice/vault", worktree: true },
      null,
    ],
    ["another repository", { repositoryKey: "github.com/alice/repo", worktree: false }, null],
    ["no repository", { repositoryKey: null, worktree: false }, null],
  ])("checkoutFreeRepository: %s", (_name, thread, expected) => {
    expect(checkoutFreeRepository(thread, ["GitHub.com/alice/vault"])).toBe(expected);
  });

  it.each([
    "github.com/alice/vault/",
    " github.com/alice/vault.git ",
    "github.com/alice/vault.git/",
  ])("checkoutFreeRepository: the listed repository written as %j still matches", (listed) => {
    expect(
      checkoutFreeRepository({ repositoryKey: "github.com/alice/vault", worktree: false }, [
        listed,
      ]),
    ).toBe("github.com/alice/vault");
  });

  it.each<[string, { projects: ReadonlyArray<unknown> }, ReturnType<typeof checkoutFreePlan>]>([
    ["its model in the named project", { projects: ["vault"] }, { use: "thread" }],
    [
      "no project there by that name",
      { projects: [] },
      { blocker: "its checkout-free project Vault isn't there" },
    ],
    [
      "several projects there by that name",
      { projects: ["vault", "vault"] },
      { blocker: "several projects there are named Vault" },
    ],
  ])("checkoutFreePlan: %s", (_name, target, expected) => {
    expect(
      checkoutFreePlan({ model: movable.model, project: "Vault" }, { ...cloud, ...target }),
    ).toEqual(expected);
  });

  it.each<[string, { remote: string | null; merge: string | null }, unknown]>([
    [
      "origin",
      { remote: "origin", merge: "refs/heads/main" },
      { remote: "origin", branch: "main" },
    ],
    [
      "a remote other than origin, and a branch with a slash",
      { remote: "fork", merge: "refs/heads/feature/x" },
      { remote: "fork", branch: "feature/x" },
    ],
    [
      "a remote name with a slash",
      { remote: "alice/fork", merge: "refs/heads/feature/x" },
      { remote: "alice/fork", branch: "feature/x" },
    ],
    ["another local branch", { remote: ".", merge: "refs/heads/main" }, null],
    ["a tag", { remote: "origin", merge: "refs/tags/v1" }, null],
    ["nothing tracked", { remote: null, merge: null }, null],
  ])("upstreamOf: %s", (_name, config, expected) => {
    expect(upstreamOf(config)).toEqual(expected);
  });

  const brief = {
    title: "Fix it",
    threadId: "thread:1",
    environmentId: "environment:pc",
    machine: "PC",
    remote: "alice/fork",
    remoteBranch: "feature/x",
    localBranch: "t3-moved/feature/x-1",
    head: "abc123",
    summary: "",
    held: ["do the thing"],
  };

  it("moveBrief pins the commit and pushes to the branch on the remote there", () => {
    const text = moveBrief(brief)!;
    expect(text).toContain("started from alice/fork/feature/x");
    expect(text).toContain("git merge-base --is-ancestor abc123 HEAD");
    expect(text).toContain("git push alice/fork HEAD:feature/x");
  });

  it("moveBrief without a checkout forbids cloning the repository, then gives the note", () => {
    const { remote: _r, remoteBranch: _b, localBranch: _l, head: _h, ...rest } = brief;
    const text = moveBrief({
      ...rest,
      checkoutFree: {
        repository: "github.com/alice/vault",
        project: "Vault",
        note: "Read the vault through its tools.",
      },
    })!;
    expect(text).toContain("github.com/alice/vault, which isn't on this machine");
    // The note comes straight after what the move forbids.
    expect(text).toContain(
      "must not be cloned, fetched or copied here.\n\nRead the vault through its tools.",
    );
    expect(text).not.toContain("git push");
    expect(text).toContain("do the thing");
  });

  it("moveBrief cuts the history short, but refuses held messages that don't fit", () => {
    const long = moveBrief({ ...brief, summary: "h".repeat(MAX_BRIEF_LENGTH) })!;
    expect(long.length).toBeLessThanOrEqual(MAX_BRIEF_LENGTH);
    expect(long).toContain("[History cut short.]");
    expect(long).toContain("do the thing");
    expect(moveBrief({ ...brief, held: ["a", "m".repeat(MAX_BRIEF_LENGTH)] })).toBeNull();
  });

  it.each<[string, Parameters<typeof threadThere>[0], ThreadThere["state"]]>([
    ["no run yet", { worktreePath: null, firstRun: null }, "starting"],
    [
      "setting up",
      { worktreePath: null, firstRun: { status: "preparing", startedAt: null } },
      "starting",
    ],
    [
      "its worktree failed",
      { worktreePath: null, firstRun: { status: "failed", startedAt: null } },
      "failed",
    ],
    // Held by that machine's own Pause all, or its queue: not started, so the batch stays guarded here.
    [
      "queued there with its worktree ready",
      { worktreePath: "/w", firstRun: { status: "queued", startedAt: null } },
      "starting",
    ],
    [
      "starting",
      { worktreePath: "/w", firstRun: { status: "starting", startedAt: null } },
      "starting",
    ],
    [
      "running",
      { worktreePath: "/w", firstRun: { status: "running", startedAt: null } },
      "started",
    ],
    [
      "failed after it started",
      { worktreePath: "/w", firstRun: { status: "failed", startedAt: "2026-11-17T00:00:00Z" } },
      "started",
    ],
    [
      "finished",
      { worktreePath: "/w", firstRun: { status: "completed", startedAt: null } },
      "started",
    ],
  ])("threadThere: %s", (_name, input, expected) => {
    expect(threadThere(input).state).toBe(expected);
  });

  it("checks out a branch name of its own there, which a retry of the same move repeats", () => {
    expect(movedBranchName("feature/x", "thread:3f2a-91BC77", 36)).toBe(
      "t3-moved/feature/x-91bc77-10",
    );
    expect(movedBranchName("feature/x", "thread:3f2a-91BC77", 37)).not.toBe(
      movedBranchName("feature/x", "thread:3f2a-91BC77", 36),
    );
  });

  it.each<[string, Parameters<typeof remoteHeadBlocker>[0], boolean]>([
    ["the same commit", { head: "a", remoteHead: "a", containsHead: true }, true],
    ["pushed to since", { head: "a", remoteHead: "b", containsHead: true }, true],
    ["rewound or force-pushed", { head: "a", remoteHead: "b", containsHead: false }, false],
    ["moved to a commit not here", { head: "a", remoteHead: "b", containsHead: null }, false],
    ["the branch is gone", { head: "a", remoteHead: null, containsHead: null }, false],
  ])("remoteHeadBlocker: %s", (_name, input, moves) => {
    expect(remoteHeadBlocker(input) === null).toBe(moves);
  });

  it.each<[OrchestratorMcpFailure["code"], boolean]>([
    ["orchestration_error", false],
    ["capability_denied", false],
    ["invalid_request", true],
    ["model_unavailable", true],
    ["provider_unavailable", true],
    ["target_required", true],
    ["runtime_mode_escalation_denied", true],
    ["thread_credential_required", false],
    ["thread_not_found", false],
    ["task_not_found", false],
  ])("isDefiniteRefusal: %s", (code, definite) => {
    expect(isDefiniteRefusal({ code })).toBe(definite);
  });
});
