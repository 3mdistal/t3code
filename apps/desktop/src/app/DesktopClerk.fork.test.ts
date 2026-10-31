import * as NodePath from "@effect/platform-node/NodePath";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

vi.mock("@clerk/electron", () => ({
  createClerkBridge: () => ({ cleanup: () => undefined, isPrimaryInstance: true }),
}));
vi.mock("@clerk/electron/storage", () => ({ storage: () => ({}) }));

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopClerk from "./DesktopClerk.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopWebLinks from "./DesktopWebLinks.ts";

const threadLink = "t3-thread://v1/mcp:00f23a02-b745-4264-bf60-2e35f4e1ade8";

const runClerk = (input: {
  readonly isPackaged: boolean;
  readonly platform: NodeJS.Platform;
  readonly argv?: ReadonlyArray<string>;
  readonly drive: (listeners: Map<string, (...args: unknown[]) => void>) => void;
}) => {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const received: Array<string> = [];
  const registered: Array<string> = [];
  const electronApp = {
    setPath: () => Effect.void,
    requestSingleInstanceLock: Effect.succeed(true),
    quit: Effect.void,
    whenReady: Effect.void,
    setAsDefaultProtocolClient: (scheme: string) =>
      Effect.sync(() => {
        registered.push(scheme);
        return true;
      }),
    on: (name: string, listener: (...args: unknown[]) => void) =>
      Effect.sync(() => void listeners.set(name, listener)),
  } as unknown as ElectronApp.ElectronApp["Service"];
  const environment = {
    stateDir: "/tmp/t3-state",
    appDataDirectory: "/tmp/app-data",
    isDevelopment: !input.isPackaged,
    isPackaged: input.isPackaged,
    platform: input.platform,
  } as unknown as DesktopEnvironment.DesktopEnvironment["Service"];
  return Effect.gen(function* () {
    const clerk = yield* DesktopClerk.DesktopClerk;
    yield* clerk.configure;
    input.drive(listeners);
    yield* Effect.yieldNow;
    return { received, registered };
  }).pipe(
    Effect.provide(
      DesktopClerk.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            NodePath.layerPosix,
            Layer.succeed(DesktopEnvironment.DesktopEnvironment, environment),
            Layer.succeed(ElectronApp.ElectronApp, electronApp),
            Layer.succeed(
              ElectronShell.ElectronShell,
              {} as ElectronShell.ElectronShell["Service"],
            ),
            FileSystem.layerNoop({ exists: () => Effect.succeed(false) }),
          ),
        ),
      ),
    ),
    Effect.provideService(HostProcess.Arguments, ["t3", ...(input.argv ?? [])]),
    Effect.provideService(ElectronApp.ElectronApp, electronApp),
    Effect.provideService(
      ElectronWindow.ElectronWindow,
      {} as ElectronWindow.ElectronWindow["Service"],
    ),
    Effect.provideService(
      DesktopWebLinks.DesktopWebLinks,
      DesktopWebLinks.DesktopWebLinks.of({
        receive: (url) => Effect.sync(() => void received.push(url)),
        setRendererReady: () => Effect.void,
      }),
    ),
    Effect.scoped,
  );
};

describe("DesktopClerk thread links", () => {
  it.effect("hands a thread link to the renderer from launch, open-url and a second instance", () =>
    Effect.gen(function* () {
      const opened: Array<number> = [];
      const { received } = yield* runClerk({
        isPackaged: true,
        platform: "win32",
        argv: [threadLink],
        drive: (listeners) => {
          const event = { preventDefault: vi.fn() };
          listeners.get("open-url")!(event, `${threadLink}#item-2`);
          opened.push(event.preventDefault.mock.calls.length);
          listeners.get("second-instance")!({}, ["t3", "t3-thread://v2/env-1/thread-1"]);
        },
      });
      assert.deepStrictEqual(opened, [1]);
      assert.deepStrictEqual(received, [
        threadLink,
        `${threadLink}#item-2`,
        "t3-thread://v2/env-1/thread-1",
      ]);
    }),
  );

  it.effect("leaves a malformed thread link alone", () =>
    Effect.gen(function* () {
      const opened: Array<number> = [];
      const { received } = yield* runClerk({
        isPackaged: true,
        platform: "darwin",
        drive: (listeners) => {
          const event = { preventDefault: vi.fn() };
          listeners.get("open-url")!(event, "t3-thread://v1/not a thread");
          opened.push(event.preventDefault.mock.calls.length);
        },
      });
      assert.deepStrictEqual(opened, [0]);
      assert.deepStrictEqual(received, []);
    }),
  );

  it.effect.each([
    { platform: "win32" as const, isPackaged: true, expected: ["t3-thread"] },
    { platform: "darwin" as const, isPackaged: true, expected: ["t3-thread"] },
    { platform: "linux" as const, isPackaged: true, expected: [] },
    { platform: "win32" as const, isPackaged: false, expected: [] },
  ])(
    "registers t3-thread on $platform when packaged is $isPackaged",
    ({ platform, isPackaged, expected }) =>
      Effect.gen(function* () {
        const { registered } = yield* runClerk({ isPackaged, platform, drive: () => undefined });
        assert.deepStrictEqual(registered, expected);
      }),
  );
});
