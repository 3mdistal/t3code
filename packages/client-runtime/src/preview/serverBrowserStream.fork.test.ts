import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { createPreviewStreamClient } from "./serverBrowserStream.ts";

class FakeSocket extends EventTarget {
  static readonly OPEN = 1;
  static current: FakeSocket;
  readyState = 1;
  binaryType = "";
  constructor() {
    super();
    FakeSocket.current = this;
  }
  send() {}
  close() {
    this.readyState = 3;
  }
  message(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

beforeEach(() => vi.stubGlobal("WebSocket", FakeSocket));
afterEach(() => vi.unstubAllGlobals());

// fork: see "A viewer of a hidden tab" in FORK.md.
it("reports a tab that has painted nothing, and its frames once it does", () => {
  const onUnpainted = vi.fn();
  const onFrame = vi.fn();
  const client = createPreviewStreamClient(
    {
      access: { httpBase: "http://t.test", wsBase: "ws://t.test", query: {}, credentials: true },
      threadId: "thread",
      tabId: "tab",
      maxWidth: 800,
      maxHeight: 600,
    },
    {
      onFrame,
      onUnpainted,
      onViewport: vi.fn(),
      onConnectedChange: vi.fn(),
      onUnauthorized: vi.fn(),
    },
  );
  const socket = FakeSocket.current;

  socket.message(JSON.stringify({ type: "unpainted" }));
  expect(onUnpainted).toHaveBeenCalledOnce();
  const frame = new ArrayBuffer(3);
  socket.message(frame);
  expect(onFrame).toHaveBeenCalledWith(frame);
  expect(onUnpainted).toHaveBeenCalledOnce();
  client.stop();
});
