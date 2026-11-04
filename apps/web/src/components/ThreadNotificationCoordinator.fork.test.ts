import { WORKING_EXIT_GRACE_MS } from "@t3tools/client-runtime/state/thread-inbox";
import type { AnyRouter } from "@tanstack/react-router";
import { ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/reactivity";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import type { WakeNoticeItems } from "./ThreadWakeNotices.fork";

const state = vi.hoisted(() => ({
  mode: "off",
  inApp: true,
  toast: vi.fn((_options: unknown) => "toast"),
  read: vi.fn(),
}));

vi.mock("./ui/toast", () => ({ toastManager: { add: state.toast, close: vi.fn() } }));
vi.mock("./ThreadWakeNoticeRead.fork", () => ({ readWakeNoticeItems: state.read }));
vi.mock("../hooks/useSettings", () => ({
  subscribeClientSettings: () => () => undefined,
  getClientSettings: () => ({
    notificationMode: state.mode,
    inAppNotificationsEnabled: state.inApp,
  }),
}));
vi.mock("../threadNotifications", () => ({
  hasDesktopNotifications: (mode: string) => mode === "notifications",
  hasNotificationSound: () => false,
  playNotificationSound: vi.fn(),
  setNotificationBadge: vi.fn(),
  threadNotificationTag: (environmentId: string, threadId: string) =>
    `${environmentId}:${threadId}`,
  unlockNotificationAudio: vi.fn(),
}));
// Read lazily: these factories run before this module's own bindings exist.
vi.mock("../state/shell", () => ({
  environmentShell: { stateValueAtom: () => shellAtom },
}));
vi.mock("../state/presentation", () => ({
  environmentSummaries: {
    get environmentIdsAtom() {
      return environmentIdsAtom;
    },
  },
}));
vi.mock("../state/threads", () => ({
  environmentThreadShells: {
    pendingSubagentRequestsAtom: () => flagsAtom,
    childThreadInputsAtom: () => childrenAtom,
    environmentThreadIndexAtom: () => indexAtom,
    get delegatedUnderParentAtom() {
      return delegatedAtom;
    },
  },
}));

import { startThreadNotifications } from "./ThreadNotificationCoordinator";

const shellAtom = Atom.make<unknown>(null);
const environmentIdsAtom = Atom.make<ReadonlyArray<string>>(["env"]);
const flagsAtom = Atom.make(new Map<string, "approval" | "user_input">());
const delegatedAtom = Atom.make<ReadonlySet<string>>(new Set<string>());
const childrenAtom = Atom.make<ReadonlyArray<{ environmentId: string; id: string }>>([]);
const indexAtom = Atom.make(new Map<string, unknown>());

const THREAD = ThreadId.make("thread");
const at = (seconds: number) => DateTime.makeUnsafe(1_800_000_000_000 + seconds * 1_000);
const awaitedTask = { id: "task", kind: "command", awaited: true, status: "running" };
const pending = (id: string, seconds: number) => ({
  id,
  kind: "command",
  createdAt: at(seconds),
});

const thread = (overrides: Record<string, unknown> = {}) => ({
  id: THREAD,
  projectId: "project",
  title: "Nightly research",
  providerInstanceId: "claude",
  modelSelection: { instanceId: "claude", model: "claude-opus" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { rootThreadId: THREAD, parentThreadId: null, relationshipToParent: null },
  forkedFrom: null,
  createdBy: "user",
  creationSource: "web",
  latestRunId: "run",
  activeRunId: null,
  status: "completed",
  pendingRuntimeRequest: null,
  pendingBackgroundTasks: [],
  latestVisibleMessage: null,
  latestUserMessageAt: null,
  hasActionableProposedPlan: false,
  itemCount: 1,
  visibleItemCount: 1,
  createdAt: at(0),
  updatedAt: at(0),
  latestRunRequestedAt: at(0),
  latestRunStartedAt: at(0),
  latestRunCompletedAt: at(0),
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
  ...overrides,
});
const working = { status: "running", activeRunId: "run", latestRunCompletedAt: undefined };

const wakeNotice = (seconds: number, runId = "run") =>
  [
    {
      position: 1,
      visibility: "local",
      sourceThreadId: THREAD,
      sourceItemId: "notice",
      item: {
        id: "notice",
        runId,
        type: "system_notice",
        title: "Background wake cancelled",
        message: "Lost.",
        updatedAt: at(seconds),
      },
    },
  ] as unknown as WakeNoticeItems;

let registry: AtomRegistry.AtomRegistry;
let stop: () => void;
let focused: boolean;
let params: Record<string, string>;
const desktop: string[] = [];

const showThreads = (...threads: ReadonlyArray<unknown>) =>
  registry.set(shellAtom, { status: "live", snapshot: Option.some({ threads }) });
const toasts = () =>
  state.toast.mock.calls.map(([options]) => {
    const { title, type, description } = options as Record<string, string>;
    return { title, type, description };
  });
const titles = () => toasts().map((toast) => toast.title);
const answerRead = async (items: WakeNoticeItems | null) => {
  state.read.mock.results.at(-1)!.value.resolve(items);
  await vi.advanceTimersByTimeAsync(0);
};
const start = () => {
  stop = startThreadNotifications(registry, {
    state: { matches: [{ params }] },
    navigate: vi.fn(),
  } as unknown as AnyRouter);
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  state.mode = "off";
  state.inApp = true;
  state.read.mockImplementation(() => {
    let resolve!: (items: WakeNoticeItems | null) => void;
    const promise = new Promise((done) => {
      resolve = done;
    });
    return Object.assign(promise, { resolve });
  });
  registry = AtomRegistry.make();
  stop = () => undefined;
  focused = true;
  params = {};
  desktop.length = 0;
  vi.stubGlobal("document", {
    visibilityState: "visible",
    hasFocus: () => focused,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal(
    "Notification",
    class {
      static permission = "granted";
      tag = "";
      close = vi.fn();
      addEventListener = vi.fn();
      constructor(title: string) {
        desktop.push(title);
      }
    },
  );
});

afterEach(() => {
  stop();
  registry.dispose();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("gives a released thread's lost wake one warning toast and no completion", async () => {
  showThreads(thread({ pendingBackgroundTasks: [awaitedTask] }));
  start();
  showThreads(thread({ itemCount: 2, updatedAt: at(5) }));
  expect(state.read.mock.calls).toEqual([[registry, "env", THREAD]]);
  // The completion's grace ends first, so it is held rather than sent.
  await vi.advanceTimersByTimeAsync(WORKING_EXIT_GRACE_MS);
  expect(toasts()).toEqual([]);
  await answerRead(wakeNotice(5));
  await vi.advanceTimersByTimeAsync(WORKING_EXIT_GRACE_MS * 2);
  expect(toasts()).toEqual([
    {
      title: "Background wake cancelled",
      type: "warning",
      description: "Nightly research",
    },
  ]);
});

it("sends a lost wake to a configured desktop alert when the app is in the background", async () => {
  state.mode = "notifications";
  focused = false;
  showThreads(thread({ pendingBackgroundTasks: [awaitedTask] }));
  start();
  showThreads(thread({ itemCount: 2, updatedAt: at(5) }));
  await answerRead(wakeNotice(5));
  await vi.advanceTimersByTimeAsync(WORKING_EXIT_GRACE_MS * 2);
  expect(desktop).toEqual(["Background wake cancelled"]);
  expect(toasts()).toEqual([]);
});

it("does not toast a lost wake on the thread already open", async () => {
  params = { environmentId: "env", threadId: THREAD };
  showThreads(thread({ pendingBackgroundTasks: [awaitedTask] }));
  start();
  showThreads(thread({ itemCount: 2, updatedAt: at(5) }));
  await answerRead(wakeNotice(5));
  await vi.advanceTimersByTimeAsync(WORKING_EXIT_GRACE_MS * 2);
  expect(toasts()).toEqual([]);
  expect(desktop).toEqual([]);
});

it("leaves an ordinary end of awaited work as a completion", async () => {
  showThreads(thread({ pendingBackgroundTasks: [awaitedTask] }));
  start();
  showThreads(thread({ updatedAt: at(5) }));
  await answerRead([]);
  await vi.advanceTimersByTimeAsync(WORKING_EXIT_GRACE_MS);
  expect(titles()).toEqual(["Thread completed"]);
});

it("detects completion and wake loss in one coalesced shell update", async () => {
  showThreads(thread(working));
  start();
  showThreads(thread({ itemCount: 2, updatedAt: at(5), latestRunCompletedAt: at(5) }));
  expect(state.read).toHaveBeenCalledTimes(1);
  await answerRead(wakeNotice(5));
  await vi.advanceTimersByTimeAsync(WORKING_EXIT_GRACE_MS * 2);
  expect(titles()).toEqual(["Background wake cancelled"]);
});

it.each(["no notice", "failed read"])(
  "drops a held completion after another run starts, even with %s",
  async (result) => {
    showThreads(thread({ pendingBackgroundTasks: [awaitedTask] }));
    start();
    showThreads(thread({ itemCount: 2, updatedAt: at(5), latestRunCompletedAt: at(5) }));
    await vi.advanceTimersByTimeAsync(WORKING_EXIT_GRACE_MS);
    showThreads(thread({ ...working, latestRunId: "next-run", activeRunId: "next-run" }));
    await answerRead(result === "no notice" ? [] : null);
    expect(titles()).toEqual([]);
  },
);

it.each(["pending", "held"])(
  "preserves a later run's %s completion when an older wake read returns",
  async (phase) => {
    showThreads(thread({ pendingBackgroundTasks: [awaitedTask] }));
    start();
    showThreads(thread({ itemCount: 2, updatedAt: at(5), latestRunCompletedAt: at(5) }));
    await vi.advanceTimersByTimeAsync(WORKING_EXIT_GRACE_MS);
    showThreads(thread({ ...working, latestRunId: "next-run", activeRunId: "next-run" }));
    const later = {
      latestRunId: "next-run",
      latestRunCompletedAt: at(9),
      itemCount: 3,
      updatedAt: at(9),
    };
    showThreads(thread(later));
    showThreads(thread({ ...later, itemCount: 4, updatedAt: at(10) }));
    if (phase === "held") await vi.advanceTimersByTimeAsync(WORKING_EXIT_GRACE_MS);
    await answerRead(wakeNotice(5));
    expect(state.read).toHaveBeenCalledTimes(2);
    await answerRead([]);
    await vi.advanceTimersByTimeAsync(WORKING_EXIT_GRACE_MS);
    expect(titles()).toEqual(["Background wake cancelled", "Thread completed"]);
  },
);

it("does not read for a historical notice on first sight, or while a run streams", () => {
  showThreads(thread({ itemCount: 9 }));
  start();
  showThreads(thread({ ...working, itemCount: 10 }));
  showThreads(thread({ ...working, itemCount: 11 }));
  expect(state.read).not.toHaveBeenCalled();
});

it("alerts for each new approval in one run, even in one update", () => {
  showThreads(thread(working));
  start();
  showThreads(thread({ ...working, pendingRuntimeRequest: pending("first", 1) }));
  showThreads(thread({ ...working, pendingRuntimeRequest: pending("second", 2) }));
  showThreads(
    thread({ ...working, pendingRuntimeRequest: pending("second", 2), updatedAt: at(3) }),
  );
  expect(titles()).toEqual(["Approval needed", "Approval needed"]);
});

it("alerts a parent for each new approval from a linked task in one run", () => {
  const task = (request: ReturnType<typeof pending>) =>
    new Map([["task", { id: "task", lineage: {}, pendingRuntimeRequest: request }]]);
  showThreads(thread(working));
  start();
  registry.set(indexAtom, task(pending("first", 1)));
  registry.set(childrenAtom, [{ environmentId: "linked", id: "task" }]);
  registry.set(flagsAtom, new Map([[THREAD, "approval" as const]]));
  expect(titles()).toEqual(["Approval needed"]);
  // Neither this environment's shell nor the parent's flag changes.
  registry.set(indexAtom, task(pending("second", 2)));
  expect(titles()).toEqual(["Approval needed", "Approval needed"]);
  registry.set(indexAtom, task(pending("second", 2)));
  expect(titles()).toEqual(["Approval needed", "Approval needed"]);
});
