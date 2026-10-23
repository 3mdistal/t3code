import {
  act,
  useLayoutEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import type { HighlightNativeReviewDiffVisibleRowsInput } from "./nativeReviewDiffHighlighter";
import type { NativeReviewDiffViewProps } from "./nativeReviewDiffSurface";
import type { NativeReviewDiffData } from "../review/nativeReviewDiffAdapter";

const mocks = vi.hoisted(() => ({
  rejectRows: false,
  registrationFailures: 0,
  rowCompletion: null as Promise<void> | null,
  tokenRegistrationFailures: 0,
  tokenAccepted: true as boolean | undefined,
  tokenFailure: null as Error | null,
  tokenCompletion: null as Promise<boolean> | null,
  debugEvents: [] as Record<string, unknown>[],
  onDebug: undefined as NativeReviewDiffViewProps["onDebug"],
  autoViewport: false,
  scroll: vi.fn(),
  rows: vi.fn(),
  tokens: vi.fn(),
  highlight: vi.fn(),
}));

function RawView({
  ref: nativeRef,
  onDebug,
  initialFileId,
  contentResetKey,
}: NativeReviewDiffViewProps & { ref: Ref<unknown> }) {
  const [rows, setRows] = useState("");
  const [tokenRowIds, setTokenRowIds] = useState<string[]>([]);
  useLayoutEffect(() => {
    setRows("");
  }, [contentResetKey]);
  useLayoutEffect(() => {
    mocks.onDebug = onDebug;
  });
  useImperativeHandle(nativeRef, () => ({
    async setRowsJson(value: string) {
      mocks.rows(value);
      if (mocks.registrationFailures > 0) {
        mocks.registrationFailures -= 1;
        throw new Error("Unable to find the 'T3ReviewDiffSurface' view for this native tag");
      }
      if (mocks.rowCompletion) await mocks.rowCompletion;
      if (mocks.rejectRows) throw new Error("Row delivery failed");
      setRows(value);
      if (mocks.autoViewport) {
        const decoded = JSON.parse(value) as NativeReviewDiffData["rows"];
        onDebug?.({
          nativeEvent: { message: "rows-decoded", rows: decoded.length },
        } as unknown as Parameters<NonNullable<typeof onDebug>>[0]);
        const index = decoded.findIndex(
          (row) => row.kind === "file" && row.fileId === initialFileId,
        );
        onDebug?.({
          nativeEvent: {
            message: "visible-range",
            firstRowIndex: Math.max(0, index),
            lastRowIndex: Math.max(0, index) + 40,
            totalRows: decoded.length,
          },
        } as unknown as Parameters<NonNullable<typeof onDebug>>[0]);
      }
    },
    async scrollToFile(fileId: string) {
      mocks.scroll(fileId);
    },
    async setTokensPatchJson(value: string) {
      mocks.tokens(value);
      if (mocks.tokenFailure) throw mocks.tokenFailure;
      if (mocks.tokenRegistrationFailures-- > 0)
        throw new Error("Unable to find the 'T3ReviewDiffSurface' view for this native tag");
      const accepted = mocks.tokenCompletion ? await mocks.tokenCompletion : mocks.tokenAccepted;
      if (accepted === true) {
        const patch = JSON.parse(value);
        setTokenRowIds((current) => [
          ...new Set([...current, ...Object.keys(patch.tokensByRowId)]),
        ]);
      }
      return accepted;
    },
  }));
  return (
    <div data-token-rows={tokenRowIds.join(",")}>
      {rows ? "Rendered diff" : "Blank native surface"}
    </div>
  );
}

vi.mock("expo", () => ({ requireNativeView: () => RawView }));
vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../components/ui/EmptyState", () => ({
  EmptyState: ({
    title,
    actionLabel,
    onAction,
  }: {
    title: string;
    actionLabel: string;
    onAction: () => void;
  }) => (
    <div>
      {title}
      <button onClick={onAction}>{actionLabel}</button>
    </div>
  ),
}));
vi.mock("./nativeReviewDiffHighlighter", () => ({
  highlightNativeReviewDiffVisibleRows: mocks.highlight,
}));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  settlePromise: async (execute: () => Promise<unknown>) => {
    try {
      return AsyncResult.success(await execute());
    } catch (error) {
      return AsyncResult.failure(Cause.die(error));
    }
  },
  squashAtomCommandFailure: () => "tokenization failed",
}));
vi.mock("../review/nativeReviewDiffAdapter", () => ({ createNativeReviewDiffTheme: () => ({}) }));
vi.mock("../settings/appearance/useAppearanceCodeSurface", () => ({
  useAppearanceCodeSurface: () => ({ nativeReviewDiffStyle: {} }),
}));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeAppearance: "light", themeId: "test" }),
}));
vi.mock("../../lib/useUniwindTheme", () => ({ useUniwindTheme: () => ({}) }));

import { resolveNativeReviewDiffView } from "./nativeReviewDiffSurface";
import { useNativeReviewDiffBridge } from "../review/useNativeReviewDiffBridge";
import {
  handlePullRequestDiffDebugEvent,
  pullRequestDiffInitialPosition,
} from "../pull-requests/pullRequestDiffDebug";

function setup(integrated = false) {
  vi.useFakeTimers();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.rejectRows = false;
  mocks.registrationFailures = 0;
  mocks.rowCompletion = null;
  mocks.tokenRegistrationFailures = 0;
  mocks.tokenAccepted = true;
  mocks.tokenFailure = null;
  mocks.tokenCompletion = null;
  mocks.debugEvents = [];
  mocks.onDebug = undefined;
  mocks.autoViewport = false;
  mocks.scroll.mockClear();
  mocks.rows.mockClear();
  mocks.tokens.mockClear();
  mocks.highlight
    .mockReset()
    .mockImplementation(async (input: HighlightNativeReviewDiffVisibleRowsInput) => {
      const rowId = `r${input.firstRowIndex}`;
      const tokensByRowId = input.alreadyHighlightedRowIds?.has(rowId)
        ? {}
        : { [rowId]: [{ content: "const", color: "#ff0000", fontStyle: null }] };
      return {
        rowCount: Object.keys(tokensByRowId).length,
        durationMs: 0,
        retryableRowIds: [],
        tokensByRowId,
      };
    });
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  const requestFrame = vi
    .spyOn(globalThis, "requestAnimationFrame")
    .mockImplementation((callback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
  const cancelFrame = vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation((id) => {
    if (id != null) frames.delete(id);
  });
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const expo = Object.getOwnPropertyDescriptor(globalThis, "expo");
  Object.defineProperty(globalThis, "expo", {
    configurable: true,
    value: { getViewConfig: () => ({}) },
  });
  const NativeDiff = resolveNativeReviewDiffView()!;
  const container = document.createElement("div");
  const root = createRoot(container);
  let data: NativeReviewDiffData = {
    rows: Array.from({ length: 1000 }, (_, index) =>
      index === 999
        ? { kind: "comment", id: `r${index}`, commentText: "Original comment" }
        : index === 900
          ? { kind: "file", id: `r${index}`, fileId: "last-file" }
          : { kind: "line", id: `r${index}` },
    ),
    files: [],
    additions: 0,
    deletions: 0,
    commentTargetsByRowId: new Map(),
    rowIdByCommentLineId: new Map(),
  };
  const ids: string[] = [];
  function PullRequestDiff({
    targetFileId,
    imperativeEntry = false,
  }: {
    targetFileId?: string;
    imperativeEntry?: boolean;
  }) {
    const bridge = useNativeReviewDiffBridge({
      threadKey: null,
      sectionId: "pull-request:test:1:all",
      diff: "test diff",
      data,
      collapsedFileIds: ids,
      viewedFileIds: ids,
      selectedRowIds: ids,
      canHighlight: true,
    });
    const nativeView = useRef(null);
    const jumpStarted = useRef(!imperativeEntry);
    const onDebug: NonNullable<NativeReviewDiffViewProps["onDebug"]> = (event) =>
      handlePullRequestDiffDebugEvent(event, {
        rowCount: data.rows.length,
        targetFileId,
        focusIndex: -1,
        isIos: true,
        nativeView,
        jumpStarted,
        loadMore: () => {},
        onDebug: bridge.onDebug,
      });
    return (
      <NativeDiff
        {...bridge}
        {...pullRequestDiffInitialPosition(imperativeEntry ? undefined : targetFileId, -1)}
        nativeViewRef={nativeView}
        appearanceScheme="light"
        rowHeight={20}
        contentWidth={300}
        onDebug={(event) => {
          mocks.debugEvents.push(event.nativeEvent);
          onDebug(event);
        }}
      />
    );
  }
  const render = (
    rowsJson = "[]",
    tokensPatchJson = '{"tokensByRowId":{}}',
    contentResetKey?: string,
  ) =>
    act(() =>
      root.render(
        <NativeDiff
          rowsJson={rowsJson}
          contentResetKey={contentResetKey}
          tokensPatchJson={tokensPatchJson}
          onDebug={(event) => mocks.debugEvents.push(event.nativeEvent)}
          appearanceScheme="light"
          themeJson="{}"
          rowHeight={20}
          contentWidth={300}
        />,
      ),
    );
  if (!integrated) {
    render();
    mocks.debugEvents = [];
  }
  return {
    container,
    render,
    async mountPullRequest(targetFileId?: string, imperativeEntry = false) {
      await act(async () =>
        root.render(
          <PullRequestDiff targetFileId={targetFileId} imperativeEntry={imperativeEntry} />,
        ),
      );
    },
    async updateComment() {
      data = {
        ...data,
        rows: data.rows.map((row) =>
          row.kind === "comment" ? { ...row, commentText: "Updated comment" } : row,
        ),
      };
      await act(async () => root.render(<PullRequestDiff />));
    },
    get tokenRows() {
      return container.querySelector("[data-token-rows]")?.getAttribute("data-token-rows");
    },
    async jump(firstRowIndex: number, totalRows = 1000) {
      await act(async () => {
        mocks.onDebug?.({
          nativeEvent: {
            message: "visible-range",
            firstRowIndex,
            lastRowIndex: firstRowIndex + 40,
            totalRows,
          },
        } as unknown as Parameters<NonNullable<NativeReviewDiffViewProps["onDebug"]>>[0]);
        await vi.runOnlyPendingTimersAsync();
      });
    },
    async deliverPayloads() {
      const callbacks = [...frames.values()];
      frames.clear();
      await act(async () => {
        for (const callback of callbacks) callback(0);
        await vi.runOnlyPendingTimersAsync();
      });
    },
    retry() {
      const button = container.querySelector("button");
      expect(button?.textContent).toBe("Retry diff");
      act(() => button!.click());
    },
    decodeFailure() {
      act(() =>
        mocks.onDebug?.({
          nativeEvent: { message: "rows-decode-failed", error: "Decode failed" },
        } as unknown as Parameters<NonNullable<NativeReviewDiffViewProps["onDebug"]>>[0]),
      );
    },
    [Symbol.dispose]() {
      act(() => root.unmount());
      requestFrame.mockRestore();
      cancelFrame.mockRestore();
      errors.mockRestore();
      vi.useRealTimers();
      if (expo) Object.defineProperty(globalThis, "expo", expo);
      else Reflect.deleteProperty(globalThis, "expo");
    },
  };
}

it("offers recovery after rejected row delivery and replays rows and tokens on retry", async () => {
  using screen = setup();
  mocks.rejectRows = true;
  await screen.deliverPayloads();
  expect(screen.container.textContent).toContain("Could not display diff");
  mocks.rejectRows = false;
  screen.retry();
  await screen.deliverPayloads();
  expect(screen.container.textContent).toBe("Rendered diff");
  expect(mocks.rows).toHaveBeenCalledTimes(2);
  expect(mocks.tokens).toHaveBeenCalledTimes(2);
});

it("recovers from a native decode failure even when the row payload is unchanged", async () => {
  using screen = setup();
  await screen.deliverPayloads();
  screen.decodeFailure();
  expect(screen.container.textContent).toContain("Could not display diff");
  screen.retry();
  await screen.deliverPayloads();
  expect(screen.container.textContent).toBe("Rendered diff");
  expect(mocks.rows).toHaveBeenCalledTimes(2);
});

it("restores identical rows after resetting a reused native surface", async () => {
  using screen = setup();
  const rowsJson = '[{"kind":"notice","id":"unchanged"}]';
  screen.render(rowsJson, undefined, "all-commits");
  await screen.deliverPayloads();
  expect(screen.container.textContent).toBe("Rendered diff");
  expect(mocks.rows).toHaveBeenCalledTimes(1);

  screen.render(rowsJson, undefined, "all-commits");
  await screen.deliverPayloads();
  expect(mocks.rows).toHaveBeenCalledTimes(1);

  screen.render(rowsJson, undefined, "only-commit");
  expect(screen.container.textContent).toBe("Blank native surface");
  await screen.deliverPayloads();
  expect(screen.container.textContent).toBe("Rendered diff");
  expect(mocks.rows.mock.calls).toEqual([[rowsJson], [rowsJson]]);
});

it("retries transient native registration without replacing the diff with an error", async () => {
  using screen = setup();
  mocks.registrationFailures = 1;
  await screen.deliverPayloads();
  expect(screen.container.textContent).toBe("Blank native surface");
  await screen.deliverPayloads();
  expect(screen.container.textContent).toBe("Rendered diff");
});

it("ignores a superseded row delivery failure after a new payload succeeds", async () => {
  using screen = setup();
  let rejectOldRows!: (error: Error) => void;
  mocks.rowCompletion = new Promise<void>((_resolve, reject) => {
    rejectOldRows = reject;
  });
  await screen.deliverPayloads();
  mocks.rowCompletion = null;
  screen.render('[{"kind":"notice","id":"new"}]');
  await screen.deliverPayloads();
  await act(async () => {
    rejectOldRows(new Error("Old delivery failed"));
  });
  expect(screen.container.textContent).toBe("Rendered diff");
  expect(screen.container.querySelector("button")).toBeNull();
});

it("automatically tries a changed row payload after a decode failure", async () => {
  using screen = setup();
  await screen.deliverPayloads();
  screen.decodeFailure();
  screen.render('[{"kind":"notice","id":"new"}]');
  await screen.deliverPayloads();
  expect(screen.container.textContent).toBe("Rendered diff");
});

it("offers retry when native registration never becomes ready", async () => {
  using screen = setup();
  mocks.registrationFailures = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt <= 60; attempt += 1) await screen.deliverPayloads();
  expect(screen.container.textContent).toContain("Could not display diff");
  mocks.registrationFailures = 0;
  screen.retry();
  await screen.deliverPayloads();
  expect(screen.container.textContent).toBe("Rendered diff");
});

it("does not remember an old decode failure after switching payloads and returning", async () => {
  using screen = setup();
  await screen.deliverPayloads();
  screen.decodeFailure();
  screen.render('[{"kind":"notice","id":"new"}]');
  await screen.deliverPayloads();
  screen.render();
  await screen.deliverPayloads();
  expect(screen.container.textContent).toBe("Rendered diff");
});

it("acknowledges token delivery only after registration succeeds", async () => {
  using screen = setup();
  mocks.tokenRegistrationFailures = 1;
  screen.render("[]", '{"resetKey":"a","chunkIndex":7,"tokensByRowId":{"r0":[]}}');
  await screen.deliverPayloads();
  expect(mocks.debugEvents.filter((event) => event.message === "tokens-patch-delivered")).toEqual(
    [],
  );
  await screen.deliverPayloads();
  expect(mocks.debugEvents).toContainEqual({
    message: "tokens-patch-delivered",
    resetKey: "a",
    chunkIndex: 7,
  });
});

it.each([false, undefined])(
  "does not acknowledge an unaccepted native token patch (%s)",
  async (accepted) => {
    using screen = setup();
    mocks.tokenAccepted = accepted;
    screen.render("[]", '{"resetKey":"a","chunkIndex":8,"tokensByRowId":{"r0":[]}}');
    await screen.deliverPayloads();
    expect(mocks.debugEvents).toEqual([
      { message: "tokens-patch-failed", resetKey: "a", chunkIndex: 8 },
    ]);
  },
);

it("reports exhausted registration once so the hook can release the queued head", async () => {
  using screen = setup();
  mocks.tokenRegistrationFailures = Number.POSITIVE_INFINITY;
  screen.render("[]", '{"resetKey":"a","chunkIndex":9,"tokensByRowId":{"r0":[]}}');
  for (let attempt = 0; attempt <= 60; attempt += 1) await screen.deliverPayloads();
  await screen.deliverPayloads();
  expect(mocks.debugEvents).toEqual([
    { message: "tokens-patch-failed", resetKey: "a", chunkIndex: 9 },
  ]);
  expect(mocks.tokens).toHaveBeenCalledTimes(61);
});

it("waits for native merge completion before acknowledging a patch", async () => {
  using screen = setup();
  let accept!: (accepted: boolean) => void;
  mocks.tokenCompletion = new Promise((resolve) => {
    accept = resolve;
  });
  screen.render("[]", '{"resetKey":"a","chunkIndex":10,"tokensByRowId":{"r0":[]}}');
  await screen.deliverPayloads();
  expect(mocks.debugEvents).toEqual([]);
  await act(async () => accept(true));
  expect(mocks.debugEvents).toEqual([
    { message: "tokens-patch-delivered", resetKey: "a", chunkIndex: 10 },
  ]);
});

it("fails a transport error once and can deliver the next chunk", async () => {
  using screen = setup();
  mocks.tokenFailure = new Error("Native transport failed");
  screen.render("[]", '{"resetKey":"a","chunkIndex":11,"tokensByRowId":{"r0":[]}}');
  await screen.deliverPayloads();
  await screen.deliverPayloads();
  expect(mocks.tokens).toHaveBeenCalledTimes(1);
  expect(mocks.debugEvents).toEqual([
    { message: "tokens-patch-failed", resetKey: "a", chunkIndex: 11 },
  ]);
  mocks.tokenFailure = null;
  screen.render("[]", '{"resetKey":"a","chunkIndex":12,"tokensByRowId":{"r1":[]}}');
  await screen.deliverPayloads();
  expect(mocks.debugEvents.at(-1)).toEqual({
    message: "tokens-patch-delivered",
    resetKey: "a",
    chunkIndex: 12,
  });
});

it("ignores a late native acceptance after the token patch is superseded", async () => {
  using screen = setup();
  let acceptOld!: (accepted: boolean) => void;
  mocks.tokenCompletion = new Promise((resolve) => {
    acceptOld = resolve;
  });
  screen.render("[]", '{"resetKey":"old","chunkIndex":13,"tokensByRowId":{"r0":[]}}');
  await screen.deliverPayloads();
  mocks.tokenCompletion = null;
  screen.render("[]", '{"resetKey":"new","chunkIndex":14,"tokensByRowId":{"r0":[]}}');
  await screen.deliverPayloads();
  await act(async () => acceptOld(true));
  expect(mocks.debugEvents).toEqual([
    { message: "tokens-patch-delivered", resetKey: "new", chunkIndex: 14 },
  ]);
});

it("routes native acceptance and failure through the PR filter to release queued chunks", async () => {
  using screen = setup(true);
  await screen.mountPullRequest();
  let accept!: (accepted: boolean) => void;
  mocks.tokenCompletion = new Promise((resolve) => {
    accept = resolve;
  });
  mocks.tokens.mockClear();
  await screen.jump(0);
  await screen.deliverPayloads();
  await screen.jump(400);
  await screen.deliverPayloads();
  expect(
    mocks.tokens.mock.calls.map(([json]) => Object.keys(JSON.parse(json).tokensByRowId)),
  ).toEqual([["r0"]]);
  await act(async () => accept(true));

  mocks.tokenCompletion = null;
  mocks.tokenAccepted = false;
  await screen.deliverPayloads();
  expect(mocks.debugEvents).toContainEqual(
    expect.objectContaining({ message: "tokens-patch-failed" }),
  );
  expect(screen.tokenRows).toBe("r0");

  mocks.tokenAccepted = true;
  await screen.jump(800);
  await screen.deliverPayloads();
  expect(screen.tokenRows).toBe("r0,r800");
  await screen.jump(400);
  await screen.deliverPayloads();
  expect(screen.tokenRows).toBe("r0,r800,r400");

  const requests = mocks.highlight.mock.calls.length;
  await screen.jump(600, 999);
  expect(mocks.highlight).toHaveBeenCalledTimes(requests);
});

it.each(["retry", "comment update"])(
  "re-highlights accepted rows after a native row failure, PR %s, and viewport revisit",
  async (recovery) => {
    using screen = setup(true);
    await screen.mountPullRequest();
    mocks.tokens.mockClear();
    await screen.jump(0);
    await screen.deliverPayloads();
    await screen.jump(400);
    await screen.deliverPayloads();
    expect(screen.tokenRows).toBe("r0,r400");
    const originalPatch = JSON.parse(mocks.tokens.mock.calls[0]![0]);
    expect(originalPatch.resetKey.endsWith(":0")).toBe(true);

    screen.decodeFailure();
    expect(screen.container.textContent).toContain("Could not display diff");
    if (recovery === "retry") await act(async () => screen.retry());
    else await screen.updateComment();
    await screen.deliverPayloads();
    expect(screen.container.textContent).toBe("Rendered diff");
    await screen.jump(800);
    await screen.deliverPayloads();
    await screen.jump(400);
    await screen.deliverPayloads();
    expect(screen.tokenRows?.split(",")).toContain("r400");
    expect(mocks.tokens.mock.calls.map(([json]) => JSON.parse(json))).toContainEqual(
      expect.objectContaining({
        resetKey: `${originalPatch.resetKey.slice(0, -1)}1`,
        tokensByRowId: { r400: expect.any(Array) },
      }),
    );
    expect(
      mocks.debugEvents.filter((event) => event.message === "surface-content-mounted"),
    ).toHaveLength(2);
  },
);

it("delivers the selected file first with a warm highlighter and no startup command", async () => {
  using screen = setup(true);
  mocks.autoViewport = true;
  await screen.mountPullRequest("last-file");
  await screen.deliverPayloads();
  await screen.deliverPayloads();
  expect(mocks.highlight.mock.calls.map(([input]) => input.firstRowIndex)).toEqual([900, 900]);
  expect(screen.tokenRows).toBe("r900");
  expect(mocks.scroll).not.toHaveBeenCalled();
});

it("reproduces the warm-engine top RPC when the entry jump travels through JS", async () => {
  using screen = setup(true);
  mocks.autoViewport = true;
  await screen.mountPullRequest("last-file", true);
  // Native emits its top viewport while the separate file jump is in flight.
  await screen.deliverPayloads();
  expect(mocks.scroll).toHaveBeenCalledWith("last-file");
  expect(mocks.highlight.mock.calls.map(([input]) => input.firstRowIndex)).toEqual([0, 0]);
  await screen.jump(900);
  expect(mocks.highlight.mock.calls.map(([input]) => input.firstRowIndex)).toEqual([
    0, 0, 900, 900,
  ]);
});
