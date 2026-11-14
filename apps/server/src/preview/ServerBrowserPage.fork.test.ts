// @effect-diagnostics nodeBuiltinImport:off - Runs the encoder script with fake browser globals.
import * as NodeVM from "node:vm";

import type { CDPSession } from "playwright-core";
import { describe, expect, it, vi } from "vite-plus/test";

import * as ServerBrowserPage from "./ServerBrowserPage.ts";

interface Bitmap {
  readonly id: number;
  readonly width: number;
  readonly height: number;
  closed: boolean;
  close(): void;
}

interface Recorder {
  frame(base64: string, cssWidth: number): Promise<boolean>;
}

const FRAME = "ZnJhbWU=";

const fakeTimers = () => {
  vi.useFakeTimers();
  return { [Symbol.dispose]: () => vi.useRealTimers() };
};

/** Runs the real encoder script on a fake canvas; each decode finishes when `decode(index)` says. */
function makeEncoder() {
  const drawn: Array<number> = [];
  const decodes: Array<PromiseWithResolvers<Bitmap>> = [];
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage: (image: Bitmap) => drawn.push(image.id), fillRect() {} }),
    captureStream: () => ({ getTracks: () => [] }),
  };
  class FakeMediaRecorder {
    static isTypeSupported = (type: string) => type === "video/webm";
    onstart: (() => void) | null = null;
    start() {
      this.onstart?.();
    }
  }
  const sandbox: Record<string, unknown> = {
    document: { createElement: () => canvas },
    Path2D: function Path2D() {},
    MediaRecorder: FakeMediaRecorder,
    createImageBitmap: () => {
      const decoded = Promise.withResolvers<Bitmap>();
      decodes.push(decoded);
      return decoded.promise;
    },
    atob,
    Blob,
    performance,
    setInterval,
    clearInterval,
  };
  sandbox.window = sandbox;
  NodeVM.runInContext(ServerBrowserPage.recordingEncoderScript(30), NodeVM.createContext(sandbox));
  const decode = (index: number) => {
    const bitmap: Bitmap = {
      id: index + 1,
      width: 1280,
      height: 800,
      closed: false,
      close() {
        this.closed = true;
      },
    };
    decodes[index]!.resolve(bitmap);
    return bitmap;
  };
  return { recorder: sandbox.__t3Recorder as Recorder, drawn, decode };
}

describe("agent recording encoder", () => {
  it("repaints the newest frame at the frame rate while the page is still", async () => {
    using _timers = fakeTimers();
    const encoder = makeEncoder();
    const first = encoder.recorder.frame(FRAME, 1280);
    encoder.decode(0);
    await first;
    encoder.drawn.length = 0;

    vi.advanceTimersByTime(1_000);

    expect(encoder.drawn).toEqual(Array.from({ length: 30 }, () => 1));
  });

  it("never paints a frame over a newer one whose decode finished first", async () => {
    using _timers = fakeTimers();
    const encoder = makeEncoder();
    const first = encoder.recorder.frame(FRAME, 1280);
    encoder.decode(0);
    await first;
    const older = encoder.recorder.frame(FRAME, 1280);
    const newer = encoder.recorder.frame(FRAME, 1280);

    encoder.decode(2);
    await newer;
    const late = encoder.decode(1);
    await older;

    expect(encoder.drawn).toEqual([1, 3]);
    expect(late.closed).toBe(true);
  });
});

it("gives up on a recording's first frame when the tab paints none", async () => {
  using _timers = fakeTimers();
  const cdp = { send: () => new Promise<never>(() => {}) } as unknown as CDPSession;
  const firstFrame = expect(ServerBrowserPage.recordingFirstFrame(cdp, 90)).rejects.toMatchObject({
    tag: "PreviewAutomationExecutionError",
    message: ServerBrowserPage.RECORDING_NO_FRAME,
  });

  await vi.advanceTimersByTimeAsync(5_000);

  await firstFrame;
});
