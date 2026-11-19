// @effect-diagnostics nodeBuiltinImport:off - Stands in for an Electron debugger.
import { describe, expect, it } from "@effect/vitest";
import { DesktopBrowserEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as NodeEvents from "node:events";

import * as DesktopBrowserHost from "./DesktopBrowserHost.ts";

const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(DesktopBrowserEvent));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeCdpReply = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ id: Schema.Number })),
);
const key = { threadId: "thread-1", tabId: "tab-1" };

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

/**
 * A guest whose screenshots wait for a frame, which only capturePage() brings while hidden.
 * With `holdCapture`, the capture itself settles only on `finishCapture`; with `frameless`, it
 * brings no frame.
 */
const makeHiddenGuest = (
  options: {
    readonly destroyed?: boolean;
    readonly deferFocus?: boolean;
    readonly holdCapture?: boolean;
    readonly frameless?: boolean;
  } = {},
) => {
  const pending: Array<() => void> = [];
  const focusChanges: Array<() => void> = [];
  const capturesPending: Array<() => void> = [];
  const sent: Array<unknown> = [];
  let captures = 0;
  const debuggee = Object.assign(new NodeEvents.EventEmitter(), {
    sendCommand: (method: string, params?: { id?: number }) =>
      new Promise((resolve) => {
        if (method === "Target.getTargetInfo") resolve({ targetInfo: { targetId: "GUEST" } });
        else if (method === "Emulation.setFocusEmulationEnabled") {
          if (options.deferFocus) focusChanges.push(() => resolve({}));
          else resolve({});
        } else {
          sent.push(params?.id);
          pending.push(() => resolve({ method }));
        }
      }),
  });
  const webContents = Object.assign(new NodeEvents.EventEmitter(), {
    getURL: () => "http://localhost/",
    getTitle: () => "Page",
    getUserAgent: () => "Electron",
    isDestroyed: () => options.destroyed === true,
    capturePage: () => {
      captures++;
      if (!options.frameless) pending.splice(0).forEach((resolve) => resolve());
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
    /** Ids of the page commands the debugger received, in order. */
    sent,
    captures: () => captures,
    /** A frame that arrives on its own, as it does while the window shows. */
    paint: () => pending.splice(0).forEach((resolve) => resolve()),
    finishCapture: () => capturesPending.splice(0).forEach((resolve) => resolve()),
    settleFocus: () => focusChanges.splice(0).forEach((resolve) => resolve()),
    navigate: () => webContents.emit("did-navigate"),
  };
};

// oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- a zero-delay macrotask boundary, not a wait for time
const settle = Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));

const watchReplies = (host: DesktopBrowserHost.DesktopBrowserHost["Service"]) =>
  Effect.gen(function* () {
    const replies = yield* Queue.unbounded<number>();
    yield* host.events.pipe(
      Stream.map((line) => decodeEvent(new TextDecoder().decode(line))),
      Stream.runForEach((event) =>
        event.type === "cdp" ? Queue.offer(replies, decodeCdpReply(event.message).id) : Effect.void,
      ),
      Effect.forkScoped,
    );
    yield* Effect.yieldNow;
    return replies;
  });

describe("DesktopBrowserHost, hidden window", () => {
  it.effect("captures the page once when a screenshot waits half a second", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const guest = makeHiddenGuest();
      host.attach(key, guest.tab);
      const replies = yield* watchReplies(host);

      yield* command(host, 1, "Page.captureScreenshot");
      yield* settle;
      yield* TestClock.adjust("499 millis");
      expect(guest.captures()).toBe(0);

      yield* TestClock.adjust("1 millis");
      expect(yield* Queue.take(replies)).toBe(1);
      expect(guest.captures()).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.effect("leaves a screenshot answered in time alone", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const guest = makeHiddenGuest();
      host.attach(key, guest.tab);
      const replies = yield* watchReplies(host);

      yield* command(host, 1, "Page.captureScreenshot");
      yield* settle;
      guest.paint();
      expect(yield* Queue.take(replies)).toBe(1);
      yield* TestClock.adjust("1 second");
      expect(guest.captures()).toBe(0);
    }).pipe(Effect.scoped),
  );

  it.effect("nudges only screenshots, and not a guest that is gone", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const shown = makeHiddenGuest();
      host.attach(key, shown.tab);
      yield* watchReplies(host);
      yield* command(host, 1, "DOM.enable");
      yield* settle;
      yield* TestClock.adjust("1 second");
      expect(shown.captures()).toBe(0);

      const gone = makeHiddenGuest({ destroyed: true });
      host.attach(key, gone.tab);
      yield* watchReplies(host);
      yield* command(host, 2, "Page.captureScreenshot");
      yield* settle;
      yield* TestClock.adjust("1 second");
      expect(gone.captures()).toBe(0);
    }).pipe(Effect.scoped),
  );
  it.effect("sends the next screenshot only once the capture settles", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const guest = makeHiddenGuest({ holdCapture: true });
      host.attach(key, guest.tab);
      const replies = yield* watchReplies(host);

      yield* command(host, 1, "Page.captureScreenshot");
      yield* command(host, 2, "Page.captureScreenshot");
      yield* settle;
      yield* TestClock.adjust("500 millis");
      expect(yield* Queue.take(replies)).toBe(1);
      yield* settle;
      expect(guest.captures()).toBe(1);
      expect(guest.sent).toEqual([1]);

      guest.finishCapture();
      yield* settle;
      expect(guest.sent).toEqual([1, 2]);
    }).pipe(Effect.scoped),
  );

  it.effect("sends the next screenshot only once the capture settles, past a navigation", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const guest = makeHiddenGuest({ holdCapture: true, frameless: true });
      host.attach(key, guest.tab);
      yield* watchReplies(host);

      yield* command(host, 1, "Page.captureScreenshot");
      yield* command(host, 2, "Page.captureScreenshot");
      yield* settle;
      yield* TestClock.adjust("500 millis");
      expect(guest.captures()).toBe(1);
      guest.navigate();
      yield* settle;
      expect(guest.sent).toEqual([1]);

      guest.finishCapture();
      yield* settle;
      expect(guest.sent).toEqual([1, 2]);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "holds the next screenshot for a capture that never settles for five seconds at most",
    () =>
      Effect.gen(function* () {
        const host = yield* DesktopBrowserHost.make;
        const guest = makeHiddenGuest({ holdCapture: true });
        host.attach(key, guest.tab);
        yield* watchReplies(host);

        yield* command(host, 1, "Page.captureScreenshot");
        yield* command(host, 2, "Page.captureScreenshot");
        yield* settle;
        yield* TestClock.adjust("500 millis");
        yield* TestClock.adjust("4999 millis");
        yield* settle;
        expect(guest.sent).toEqual([1]);

        yield* TestClock.adjust("1 millis");
        yield* settle;
        expect(guest.sent).toEqual([1, 2]);
      }).pipe(Effect.scoped),
  );

  it.effect("times a screenshot from when it's sent, after focus emulation", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const guest = makeHiddenGuest({ deferFocus: true });
      host.attach(key, guest.tab);
      const replies = yield* watchReplies(host);

      yield* command(host, 1, "Page.captureScreenshot");
      yield* settle;
      yield* TestClock.adjust("1 second");
      expect(guest.sent).toEqual([]);
      expect(guest.captures()).toBe(0);

      guest.settleFocus();
      yield* settle;
      expect(guest.sent).toEqual([1]);
      yield* TestClock.adjust("499 millis");
      expect(guest.captures()).toBe(0);
      yield* TestClock.adjust("1 millis");
      expect(yield* Queue.take(replies)).toBe(1);
      expect(guest.captures()).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.effect("leaves a screenshot the page navigated away from alone", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const guest = makeHiddenGuest();
      host.attach(key, guest.tab);
      yield* watchReplies(host);

      yield* command(host, 1, "Page.captureScreenshot");
      yield* settle;
      guest.navigate();
      yield* TestClock.adjust("1 second");
      expect(guest.captures()).toBe(0);
    }).pipe(Effect.scoped),
  );
});

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
      const host = yield* DesktopBrowserHost.make;
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
      const host = yield* DesktopBrowserHost.make;
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

      // The window hides.
      yield* ticks(1);
      expect(guest.captures()).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.effect("slows to a capture every 2 s on a still page, until an input", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
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
      const host = yield* DesktopBrowserHost.make;
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
      const host = yield* DesktopBrowserHost.make;
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
      const host = yield* DesktopBrowserHost.make;
      const guest = makeStreamedGuest({ still: true, holdCapture: true });
      host.attach(key, guest.tab);

      yield* command(host, 1, "Page.startScreencast");
      yield* settle;
      yield* ticks(1);
      expect(guest.captures()).toBe(1);
      yield* TestClock.adjust("5 seconds");
      yield* settle;

      // The screenshot no longer waits, but its nudge starts no second capture.
      yield* command(host, 2, "Page.captureScreenshot");
      yield* settle;
      expect(guest.sent).toEqual([2]);
      yield* ticks(2);
      guest.paint();
      yield* settle;
      yield* ticks(1);
      expect(guest.captures()).toBe(1);

      guest.finishCapture();
      yield* settle;
      yield* ticks(1);
      expect(guest.captures()).toBe(2);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps a guest attached again waiting on its earlier capture", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const guest = makeStreamedGuest({ still: true, holdCapture: true });
      host.attach(key, guest.tab);

      yield* command(host, 1, "Page.startScreencast");
      yield* settle;
      yield* ticks(1);
      expect(guest.captures()).toBe(1);

      host.detach(key);
      host.attach(key, guest.tab);
      yield* command(host, 2, "Page.captureScreenshot");
      yield* settle;
      expect(guest.sent).toEqual([]);
      guest.finishCapture();
      yield* settle;
      expect(guest.sent).toEqual([2]);
    }).pipe(Effect.scoped),
  );

  it.effect("takes turns with screenshots, one frame copy at a time", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const guest = makeStreamedGuest({ still: true, holdCapture: true });
      host.attach(key, guest.tab);

      yield* command(host, 1, "Page.startScreencast");
      yield* settle;
      yield* ticks(1);
      expect(guest.captures()).toBe(1);

      // A screenshot waits for the stream's capture.
      yield* command(host, 2, "Page.captureScreenshot");
      yield* settle;
      expect(guest.sent).toEqual([]);
      yield* ticks(1);
      expect(guest.captures()).toBe(1);
      guest.finishCapture();
      yield* settle;
      expect(guest.sent).toEqual([2]);

      // The stream waits for the screenshot.
      yield* ticks(1);
      expect(guest.captures()).toBe(1);
      guest.paint();
      yield* settle;
      yield* ticks(1);
      expect(guest.captures()).toBe(2);
    }).pipe(Effect.scoped),
  );
});
