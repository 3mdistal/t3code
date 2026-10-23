import { expect, it, vi } from "vite-plus/test";

import { createReviewDiffHighlightScheduler } from "./reviewDiffHighlightScheduler";

it("coalesces the pre-jump native range into the initial destination before requesting source", async () => {
  vi.useFakeTimers();
  const request = vi.fn();
  const scheduler = createReviewDiffHighlightScheduler(request);
  try {
    scheduler.update({ firstRowIndex: 0, lastRowIndex: 28 });
    scheduler.update({ firstRowIndex: 2376, lastRowIndex: 2409 });
    expect(request).not.toHaveBeenCalled();
    await vi.runOnlyPendingTimersAsync();
    expect(request.mock.calls).toEqual([[{ firstRowIndex: 2376, lastRowIndex: 2409 }]]);
    scheduler.reset();
    request.mockClear();
    scheduler.update({ firstRowIndex: 0, lastRowIndex: 80 });
    await vi.runOnlyPendingTimersAsync();
    expect(request.mock.calls).toEqual([[{ firstRowIndex: 0, lastRowIndex: 80 }]]);
  } finally {
    scheduler.cancel();
    vi.useRealTimers();
  }
});
