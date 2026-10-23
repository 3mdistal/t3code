import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import type {
  HighlightNativeReviewDiffVisibleRowsInput,
  NativeReviewDiffHighlightChunk,
} from "../diffs/nativeReviewDiffHighlighter";

const mocks = vi.hoisted(() => ({ highlight: vi.fn() }));
vi.mock("../diffs/nativeReviewDiffHighlighter", () => ({
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

import { useNativeReviewDiffHighlighting } from "./useNativeReviewDiffHighlighting";

function setup() {
  vi.useFakeTimers();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const rows = Array.from({ length: 1000 }, (_, index) => ({
    kind: "line" as const,
    id: `r${index}`,
  }));
  const files: Parameters<typeof useNativeReviewDiffHighlighting>[0]["files"] = [];
  mocks.highlight
    .mockReset()
    .mockImplementation(async (input: HighlightNativeReviewDiffVisibleRowsInput) => {
      const rowId = `r${input.firstRowIndex}`;
      const tokensByRowId = input.alreadyHighlightedRowIds?.has(rowId)
        ? {}
        : { [rowId]: [{ content: "const", color: "#ff0000", fontStyle: null }] };
      return {
        rowCount: Object.keys(tokensByRowId).length,
        durationMs: 1,
        retryableRowIds: [],
        tokensByRowId,
      };
    });
  const root = createRoot(document.createElement("div"));
  let result!: ReturnType<typeof useNativeReviewDiffHighlighting>;
  function Probe({ resetKey }: { resetKey: string }) {
    const current = useNativeReviewDiffHighlighting({
      rows,
      files,
      scheme: "light",
      resetKey,
      enabled: true,
    });
    useLayoutEffect(() => {
      result = current;
    });
    return null;
  }
  return {
    get result() {
      return result;
    },
    async render(resetKey = "a", reportViewport = true) {
      await act(async () => root.render(<Probe resetKey={resetKey} />));
      if (reportViewport)
        await act(async () => {
          result.updateVisibleRange({ firstRowIndex: 0, lastRowIndex: 80 });
          await vi.runOnlyPendingTimersAsync();
        });
    },
    async jump(firstRowIndex: number) {
      await act(async () => {
        result.updateVisibleRange({ firstRowIndex, lastRowIndex: firstRowIndex + 40 });
        await vi.runOnlyPendingTimersAsync();
      });
    },
    async flush() {
      await act(async () => vi.runOnlyPendingTimersAsync());
    },
    async acknowledge(patch: string) {
      const { resetKey, chunkIndex } = JSON.parse(patch);
      await act(async () => result.acknowledgeTokenPatch({ resetKey, chunkIndex }));
    },
    async reject(patch: string) {
      const { resetKey, chunkIndex } = JSON.parse(patch);
      await act(async () => result.rejectTokenPatch({ resetKey, chunkIndex }));
    },
    [Symbol.dispose]() {
      act(() => root.unmount());
      vi.useRealTimers();
    },
  };
}

it("waits for a native viewport on mount and reuses it when resetting without another native event", async () => {
  using screen = setup();
  await screen.render("a", false);
  expect(mocks.highlight).not.toHaveBeenCalled();
  await screen.jump(400);
  expect(mocks.highlight.mock.calls[0]![0]).toMatchObject({
    firstRowIndex: 400,
    lastRowIndex: 440,
  });
  mocks.highlight.mockClear();
  await screen.render("b", false);
  expect(mocks.highlight).not.toHaveBeenCalled();
  await screen.flush();
  expect(mocks.highlight.mock.calls[0]![0]).toMatchObject({
    firstRowIndex: 400,
    lastRowIndex: 440,
  });
  expect(JSON.parse(screen.result.tokensPatchJson)).toMatchObject({
    resetKey: "b",
    tokensByRowId: { r400: expect.any(Array) },
  });
});

it("retains each returned patch until native delivery, without resending all earlier rows", async () => {
  using screen = setup();
  await screen.render();
  const first = screen.result.tokensPatchJson;
  await screen.jump(400);
  expect(screen.result.tokensPatchJson).toBe(first);
  await screen.acknowledge(first);
  const second = screen.result.tokensPatchJson;
  expect(Object.keys(JSON.parse(second).tokensByRowId)).toEqual(["r400"]);
  await screen.acknowledge(first);
  expect(screen.result.tokensPatchJson).toBe(second);
  await screen.acknowledge(second);
  expect(JSON.parse(screen.result.tokensPatchJson).tokensByRowId).toEqual({});
});

it("delivers viewport colors before pending overscan and queues overscan without repeating visible rows", async () => {
  using screen = setup();
  await screen.render();
  await screen.acknowledge(screen.result.tokensPatchJson);
  const overscan = Promise.withResolvers<void>();
  mocks.highlight.mockImplementation(async (input: HighlightNativeReviewDiffVisibleRowsInput) => {
    const rowIds = (input.overscanRows === 0 ? ["r400"] : ["r399", "r400"]).filter(
      (rowId) => !input.alreadyHighlightedRowIds?.has(rowId),
    );
    if (input.overscanRows !== 0) await overscan.promise;
    return {
      rowCount: rowIds.length,
      durationMs: 1,
      retryableRowIds: [],
      tokensByRowId: Object.fromEntries(
        rowIds.map((rowId) => [rowId, [{ content: "const", color: "#ff0000", fontStyle: null }]]),
      ),
    };
  });

  await screen.jump(400);
  const visible = screen.result.tokensPatchJson;
  expect(JSON.parse(visible).tokensByRowId.r400?.[0].color).toBe("#ff0000");
  await act(async () => overscan.resolve());
  expect(screen.result.tokensPatchJson).toBe(visible);
  await screen.acknowledge(visible);
  expect(Object.keys(JSON.parse(screen.result.tokensPatchJson).tokensByRowId)).toEqual(["r399"]);
});

it.each([false, true])(
  "delivers progressive chunks once when the final aggregate has additional rows: %s",
  async (hasAdditionalRows) => {
    using screen = setup();
    await screen.render();
    await screen.acknowledge(screen.result.tokensPatchJson);
    const final = Promise.withResolvers<NativeReviewDiffHighlightChunk>();
    const chunk: NativeReviewDiffHighlightChunk = {
      rowCount: 1,
      durationMs: 1,
      retryableRowIds: [],
      tokensByRowId: { r400: [{ content: "const", color: "#ff0000", fontStyle: null }] },
    };
    const highlight = mocks.highlight.getMockImplementation()!;
    mocks.highlight.mockImplementation((input: HighlightNativeReviewDiffVisibleRowsInput) => {
      if (input.firstRowIndex !== 400 || input.overscanRows !== 0) return highlight(input);
      input.onChunk?.(chunk);
      return final.promise;
    });

    await screen.jump(400);
    expect(Object.keys(JSON.parse(screen.result.tokensPatchJson).tokensByRowId)).toEqual(["r400"]);
    await screen.acknowledge(screen.result.tokensPatchJson);
    expect(JSON.parse(screen.result.tokensPatchJson).tokensByRowId).toEqual({});
    await act(async () =>
      final.resolve({
        ...chunk,
        rowCount: hasAdditionalRows ? 2 : 1,
        tokensByRowId: {
          ...chunk.tokensByRowId,
          ...(hasAdditionalRows ? { r401: chunk.tokensByRowId.r400! } : {}),
        },
      }),
    );
    expect(Object.keys(JSON.parse(screen.result.tokensPatchJson).tokensByRowId)).toEqual(
      hasAdditionalRows ? ["r401"] : [],
    );
    await screen.acknowledge(screen.result.tokensPatchJson);
    expect(JSON.parse(screen.result.tokensPatchJson).tokensByRowId).toEqual({});
  },
);

it.each(["viewport", "reset"])(
  "ignores progressive callbacks from a cancelled %s generation",
  async (change) => {
    using screen = setup();
    await screen.render();
    await screen.acknowledge(screen.result.tokensPatchJson);
    const final = Promise.withResolvers<NativeReviewDiffHighlightChunk>();
    const chunk: NativeReviewDiffHighlightChunk = {
      rowCount: 1,
      durationMs: 1,
      retryableRowIds: [],
      tokensByRowId: { r400: [{ content: "const", color: "#ff0000", fontStyle: null }] },
    };
    let cancelledInput: HighlightNativeReviewDiffVisibleRowsInput | undefined;
    const highlight = mocks.highlight.getMockImplementation()!;
    mocks.highlight.mockImplementation((input: HighlightNativeReviewDiffVisibleRowsInput) => {
      if (input.firstRowIndex !== 400 || input.overscanRows !== 0) return highlight(input);
      cancelledInput = input;
      return final.promise;
    });

    await screen.jump(400);
    if (change === "reset") await screen.render("b");
    else await screen.jump(800);
    const current = screen.result.tokensPatchJson;
    expect(cancelledInput?.signal?.aborted).toBe(true);
    await act(async () => {
      cancelledInput?.onChunk?.(chunk);
      final.resolve(chunk);
    });
    expect(screen.result.tokensPatchJson).toBe(current);
    await screen.acknowledge(current);
    expect(JSON.parse(screen.result.tokensPatchJson).tokensByRowId).toEqual({});
    mocks.highlight.mockImplementation(highlight);
    await screen.jump(400);
    expect(Object.keys(JSON.parse(screen.result.tokensPatchJson).tokensByRowId)).toEqual(["r400"]);
  },
);

it("discards queued patches on reset and ignores an old acknowledgement", async () => {
  using screen = setup();
  await screen.render();
  const old = screen.result.tokensPatchJson;
  await screen.jump(400);
  await screen.render("b");
  const current = screen.result.tokensPatchJson;
  await screen.acknowledge(old);
  expect(screen.result.tokensPatchJson).toBe(current);
  expect(JSON.parse(current).resetKey).toBe("b");
  expect(Object.keys(JSON.parse(current).tokensByRowId)).toEqual(["r0"]);
});

it.each(["viewport", "reset"])("discards pending overscan after a %s change", async (change) => {
  using screen = setup();
  await screen.render();
  await screen.acknowledge(screen.result.tokensPatchJson);
  const overscan = Promise.withResolvers<void>();
  const highlight = mocks.highlight.getMockImplementation()!;
  let overscanSignal: AbortSignal | undefined;
  mocks.highlight.mockImplementation(async (input: HighlightNativeReviewDiffVisibleRowsInput) => {
    if (input.firstRowIndex !== 400 || input.overscanRows === 0) return highlight(input);
    overscanSignal = input.signal;
    await overscan.promise;
    return {
      rowCount: 1,
      durationMs: 1,
      retryableRowIds: [],
      tokensByRowId: { r399: [{ content: "let", color: "#ff0000", fontStyle: null }] },
    };
  });

  await screen.jump(400);
  await screen.acknowledge(screen.result.tokensPatchJson);
  if (change === "reset") await screen.render("b");
  else await screen.jump(800);
  const current = screen.result.tokensPatchJson;
  expect(overscanSignal?.aborted).toBe(true);
  await act(async () => overscan.resolve());
  expect(screen.result.tokensPatchJson).toBe(current);
  await screen.acknowledge(current);
  expect(JSON.parse(screen.result.tokensPatchJson).tokensByRowId).toEqual({});
});

it("releases a failed queued head and lets its rows be highlighted on a later visit", async () => {
  using screen = setup();
  await screen.render();
  const failed = screen.result.tokensPatchJson;
  await screen.jump(400);
  await screen.reject(failed);
  expect(Object.keys(JSON.parse(screen.result.tokensPatchJson).tokensByRowId)).toEqual(["r400"]);
  expect(mocks.highlight.mock.calls.at(-1)![0].alreadyHighlightedRowIds.has("r0")).toBe(false);
  await screen.jump(0);
  // The returned replacement is queued behind r400, without a retry loop.
  await screen.acknowledge(screen.result.tokensPatchJson);
  expect(Object.keys(JSON.parse(screen.result.tokensPatchJson).tokensByRowId)).toEqual(["r0"]);
});

it("reports a tokenization failure in Release and retries only on a later viewport request", async () => {
  using screen = setup();
  using warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const highlight = mocks.highlight.getMockImplementation()!;
  mocks.highlight.mockRejectedValue(new Error("Tokenizer failed"));
  await screen.render();
  expect(warning).toHaveBeenCalledWith(
    "[review-sheet] native visible highlight failed",
    expect.objectContaining({ resetKey: "a", firstRowIndex: 0, lastRowIndex: 80 }),
  );
  expect(mocks.highlight).toHaveBeenCalledTimes(1);
  expect(JSON.parse(screen.result.tokensPatchJson).tokensByRowId).toEqual({});
  mocks.highlight.mockImplementation(highlight);
  await screen.jump(400);
  await screen.acknowledge(screen.result.tokensPatchJson);
  await screen.jump(0);
  expect(Object.keys(JSON.parse(screen.result.tokensPatchJson).tokensByRowId)).toEqual(["r0"]);
});

it("retries transient plain rows on a viewport revisit after native accepts them", async () => {
  using screen = setup();
  let sourceReady = false;
  mocks.highlight.mockImplementation(async (input: HighlightNativeReviewDiffVisibleRowsInput) => {
    const rowId = `r${input.firstRowIndex}`;
    const retryable = rowId === "r0" && !sourceReady;
    const tokensByRowId = input.alreadyHighlightedRowIds?.has(rowId)
      ? {}
      : { [rowId]: [{ content: "const", color: retryable ? null : "#ff0000", fontStyle: null }] };
    return {
      rowCount: Object.keys(tokensByRowId).length,
      durationMs: 0,
      retryableRowIds: retryable ? [rowId] : [],
      tokensByRowId,
    };
  });
  await screen.render();
  const plain = screen.result.tokensPatchJson;
  expect(JSON.parse(plain).tokensByRowId.r0[0].color).toBeNull();
  await screen.acknowledge(plain);
  expect(JSON.parse(screen.result.tokensPatchJson).tokensByRowId).toEqual({});
  await screen.jump(400);
  await screen.acknowledge(screen.result.tokensPatchJson);

  sourceReady = true;
  await screen.jump(0);
  const highlighted = screen.result.tokensPatchJson;
  expect(JSON.parse(highlighted).tokensByRowId.r0?.[0].color).toBe("#ff0000");
  await screen.acknowledge(highlighted);
  await screen.jump(800);
  await screen.acknowledge(screen.result.tokensPatchJson);
  await screen.jump(0);
  expect(JSON.parse(screen.result.tokensPatchJson).tokensByRowId).toEqual({});
});
