// @effect-diagnostics nodeBuiltinImport:off - Stands in for an Electron debugger.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as NodeEvents from "node:events";

import * as DesktopBrowserHost from "./DesktopBrowserHost.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const key = { threadId: "thread-1", tabId: "tab-1" };
/** A host whose client already drew `key` at full detail, so a screenshot goes out at once. */
const makeDrawnHost = Effect.tap(DesktopBrowserHost.make, (host) =>
  Effect.sync(() => host.setCaptureDrawn(key, true)),
);

const command = (
  host: DesktopBrowserHost.DesktopBrowserHost["Service"],
  id: number,
  method: string,
) =>
  host.handleCommandLine(
    encodeJson({
      type: "cdp",
      ...key,
      message: encodeJson({ id, method, params: { id }, sessionId: "t3-preview-page" }),
    }),
  );

// oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- a zero-delay macrotask boundary, not a wait for time
const settle = Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));

/**
 * A hidden guest that answers commands at once, except screenshots, which wait for a frame.
 * Each capturePage() draws one, which also reaches a screencast unless the page is `still`.
 * With `holdCapture`, the capture itself settles only on `finishCapture`.
 */
const makeStreamedGuest = (options: {
  readonly still?: boolean;
  readonly holdCapture?: boolean;
}) => {
  const screenshots: Array<() => void> = [];
  const capturesPending: Array<() => void> = [];
  const sent: Array<unknown> = [];
  let captures = 0;
  const debuggee = Object.assign(new NodeEvents.EventEmitter(), {
    sendCommand: (method: string, params?: { id?: number }) =>
      new Promise((resolve) => {
        if (method === "Target.getTargetInfo") resolve({ targetInfo: { targetId: "GUEST" } });
        else if (method === "Page.captureScreenshot") {
          sent.push(params?.id);
          screenshots.push(() => resolve({ data: "" }));
        } else resolve({});
      }),
  });
  const frame = () => debuggee.emit("message", {}, "Page.screencastFrame", { sessionId: 1 }, "");
  const webContents = Object.assign(new NodeEvents.EventEmitter(), {
    getURL: () => "http://localhost/",
    getTitle: () => "Page",
    getUserAgent: () => "Electron",
    isLoadingMainFrame: () => false,
    isDestroyed: () => false,
    capturePage: () => {
      captures++;
      screenshots.splice(0).forEach((resolve) => resolve());
      if (!options.still) frame();
      return options.holdCapture
        ? new Promise((resolve) => capturesPending.push(() => resolve({})))
        : Promise.resolve({});
    },
  });
  return {
    tab: {
      webContents: webContents as unknown as Electron.WebContents,
      debugger: debuggee as unknown as Electron.Debugger,
    },
    /** Ids of the screenshots the debugger received, in order. */
    sent,
    captures: () => captures,
    /** A frame the page draws on its own, as it does while the window shows. */
    frame,
    /** Answers waiting screenshots with a frame drawn on its own. */
    paint: () => screenshots.splice(0).forEach((resolve) => resolve()),
    finishCapture: () => capturesPending.splice(0).forEach((resolve) => resolve()),
  };
};

const ticks = (count: number) =>
  Effect.gen(function* () {
    for (let tick = 0; tick < count; tick++) {
      yield* TestClock.adjust("250 millis");
      yield* settle;
    }
  });

describe("DesktopBrowserHost, a streamed tab in a hidden window", () => {
  it.effect("captures a frame each tick while each capture brings one", () =>
    Effect.gen(function* () {
      const host = yield* makeDrawnHost;
      const guest = makeStreamedGuest({});
      host.attach(key, guest.tab);

      yield* command(host, 1, "Page.startScreencast");
      yield* settle;
      yield* TestClock.adjust("249 millis");
      expect(guest.captures()).toBe(0);
      yield* TestClock.adjust("1 millis");
      yield* settle;
      expect(guest.captures()).toBe(1);

      // Past the 3 s a quiet stream gets, since each capture's frame counts.
      yield* ticks(19);
      expect(guest.captures()).toBe(20);
    }).pipe(Effect.scoped),
  );

  it.effect("leaves a tab that draws on its own alone, even once a second", () =>
    Effect.gen(function* () {
      const host = yield* makeDrawnHost;
      const guest = makeStreamedGuest({});
      host.attach(key, guest.tab);

      yield* command(host, 1, "Page.startScreencast");
      yield* settle;
      for (let tick = 0; tick < 4; tick++) {
        guest.frame();
        guest.frame();
        yield* ticks(1);
      }
      // A clock that ticks each second.
      for (let second = 0; second < 4; second++) {
        guest.frame();
        yield* ticks(4);
      }
      expect(guest.captures()).toBe(0);

      // The window hides, and 1.5 s after the last frame captures start.
      yield* ticks(2);
      expect(guest.captures()).toBe(0);
      yield* ticks(1);
      expect(guest.captures()).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.effect("leaves alone a clock whose first tick comes after captures start", () =>
    Effect.gen(function* () {
      const host = yield* makeDrawnHost;
      // The window shows, so a capture brings no frame of its own.
      const guest = makeStreamedGuest({ still: true });
      host.attach(key, guest.tab);

      yield* command(host, 1, "Page.startScreencast");
      yield* settle;
      yield* ticks(1);
      expect(guest.captures()).toBe(1);
      // Each tick of the clock lands just after a capture, so it can pass for that capture's.
      for (let second = 0; second < 10; second++) {
        guest.frame();
        yield* ticks(4);
      }
      expect(guest.captures()).toBe(11);
      for (let second = 0; second < 10; second++) {
        guest.frame();
        yield* ticks(4);
      }
      expect(guest.captures()).toBe(11);
    }).pipe(Effect.scoped),
  );

  it.effect("slows to a capture every 2 s on a still page, until an input", () =>
    Effect.gen(function* () {
      const host = yield* makeDrawnHost;
      const guest = makeStreamedGuest({ still: true });
      host.attach(key, guest.tab);

      yield* command(host, 1, "Page.startScreencast");
      yield* settle;
      yield* ticks(11);
      expect(guest.captures()).toBe(11);
      yield* ticks(7);
      expect(guest.captures()).toBe(11);
      yield* ticks(1);
      expect(guest.captures()).toBe(12);
      yield* ticks(8);
      expect(guest.captures()).toBe(13);

      yield* command(host, 2, "Input.dispatchMouseEvent");
      yield* settle;
      yield* ticks(3);
      expect(guest.captures()).toBe(16);
    }).pipe(Effect.scoped),
  );

  it.effect("stops with the stream, and starts again with the next", () =>
    Effect.gen(function* () {
      const host = yield* makeDrawnHost;
      const guest = makeStreamedGuest({});
      host.attach(key, guest.tab);

      yield* command(host, 1, "Page.startScreencast");
      yield* settle;
      yield* ticks(1);
      expect(guest.captures()).toBe(1);
      yield* command(host, 2, "Page.stopScreencast");
      yield* settle;
      yield* ticks(4);
      expect(guest.captures()).toBe(1);

      yield* command(host, 3, "Page.startScreencast");
      yield* settle;
      yield* ticks(1);
      expect(guest.captures()).toBe(2);
    }).pipe(Effect.scoped),
  );

  it.effect("starts a stream restarted within a tick at the full rate", () =>
    Effect.gen(function* () {
      const host = yield* makeDrawnHost;
      const guest = makeStreamedGuest({ still: true });
      host.attach(key, guest.tab);

      yield* command(host, 1, "Page.startScreencast");
      yield* settle;
      yield* ticks(12);
      expect(guest.captures()).toBe(11);

      yield* command(host, 2, "Page.stopScreencast");
      yield* command(host, 3, "Page.startScreencast");
      yield* settle;
      yield* ticks(2);
      expect(guest.captures()).toBe(13);
    }).pipe(Effect.scoped),
  );

  it.effect("starts no capture while an earlier one still runs, past its 5 s", () =>
    Effect.gen(function* () {
      const host = yield* makeDrawnHost;
      const guest = makeStreamedGuest({ still: true, holdCapture: true });
      host.attach(key, guest.tab);

      yield* command(host, 1, "Page.startScreencast");
      yield* settle;
      yield* ticks(1);
      expect(guest.captures()).toBe(1);
      yield* TestClock.adjust("5 seconds");
      yield* settle;
      yield* ticks(2);
      expect(guest.captures()).toBe(1);

      guest.finishCapture();
      yield* settle;
      yield* ticks(1);
      expect(guest.captures()).toBe(2);
    }).pipe(Effect.scoped),
  );

  it.effect("starts no capture on a guest attached again while its earlier one runs", () =>
    Effect.gen(function* () {
      const host = yield* makeDrawnHost;
      const guest = makeStreamedGuest({ still: true, holdCapture: true });
      host.attach(key, guest.tab);

      yield* command(host, 1, "Page.startScreencast");
      yield* settle;
      yield* ticks(1);
      expect(guest.captures()).toBe(1);

      host.detach(key);
      host.attach(key, guest.tab);
      yield* command(host, 2, "Page.startScreencast");
      yield* settle;
      yield* ticks(2);
      expect(guest.captures()).toBe(1);
      guest.finishCapture();
      yield* settle;
      yield* ticks(1);
      expect(guest.captures()).toBe(2);
    }).pipe(Effect.scoped),
  );

  it.effect("skips its ticks while a screenshot runs", () =>
    Effect.gen(function* () {
      const host = yield* makeDrawnHost;
      const guest = makeStreamedGuest({ still: true });
      host.attach(key, guest.tab);

      yield* command(host, 1, "Page.startScreencast");
      yield* settle;
      yield* ticks(1);
      expect(guest.captures()).toBe(1);

      // Sent between ticks, so the stream's next tick comes before upstream's first prod.
      yield* TestClock.adjust("50 millis");
      yield* command(host, 2, "Page.captureScreenshot");
      yield* settle;
      expect(guest.sent).toEqual([2]);
      yield* TestClock.adjust("200 millis");
      yield* settle;
      expect(guest.captures()).toBe(1);

      guest.paint();
      yield* settle;
      yield* ticks(1);
      expect(guest.captures()).toBe(2);
    }).pipe(Effect.scoped),
  );
});
