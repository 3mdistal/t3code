// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeEvents from "node:events";
import * as NodeStreamConsumers from "node:stream/consumers";

import * as NodeStyleChild from "./NodeStyleChild.ts";
import * as ProcessSpawnWorker from "./ProcessSpawnWorker.ts";

// oxlint-disable-next-line t3code/no-global-process-runtime -- The worker and tree kills need a real Windows host.
const onWindowsHost = process.platform === "win32";
const env = { ...process.env };

const IDLE = "setInterval(() => {}, 1 << 30)";
// A detached grandchild is outside the child's own kill-on-close job, so only a tree kill ends it.
const STARTS_A_GRANDCHILD = `const { spawn } = require("node:child_process");
const grandchild = spawn(process.execPath, ["-e", ${JSON.stringify(IDLE)}], { detached: true, stdio: "ignore" });
process.stdout.write(grandchild.pid + "\\n");
${IDLE}`;

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// A grandchild has no handle to wait on, so its end is polled.
const gone = (pid: number) =>
  Effect.promise(() => expect.poll(() => isAlive(pid), { timeout: 2_000 }).toBe(false)).pipe(
    Effect.as(true),
  );

const once = <A extends Array<unknown>>(child: NodeStyleChild.NodeStyleChild, event: string) => {
  const fired = NodeEvents.once(child, event);
  return Effect.promise(() => fired as Promise<A>);
};

const workerLayer = Layer.effect(
  ChildProcessSpawner.ChildProcessSpawner,
  ProcessSpawnWorker.make(),
).pipe(Layer.provideMerge(NodeServices.layer));

const spawners = [
  ["Node's spawner", NodeServices.layer],
  ...(onWindowsHost ? [["the spawn worker", workerLayer] as const] : []),
] as const;

describe.each(spawners)("a Node-style child from %s", (_name, layer) => {
  const live = (
    name: string,
    test: () => Effect.Effect<void, never, ChildProcessSpawner.ChildProcessSpawner | Scope.Scope>,
  ) => it.live(name, () => test().pipe(Effect.scoped, Effect.provide(layer)));

  live("relays input and output, then reports the exit and close", () =>
    Effect.gen(function* () {
      const spawn = yield* NodeStyleChild.make;
      const child = spawn(
        process.execPath,
        [
          "-e",
          'process.stdin.pipe(process.stdout); process.stdin.on("end", () => { process.stdout.write(" world"); process.exitCode = 3; });',
        ],
        { env },
      );
      const events: Array<string> = [];
      for (const event of ["spawn", "exit", "close", "error"])
        child.on(event, () => events.push(event));
      const exited = once<[number | null, NodeJS.Signals | null]>(child, "exit");
      const closed = once(child, "close");
      const output = NodeStreamConsumers.text(child.stdout);
      child.stdin.end("hello");

      expect(yield* exited).toEqual([3, null]);
      yield* closed;
      expect(yield* Effect.promise(() => output)).toBe("hello world");
      expect(events).toEqual(["spawn", "exit", "close"]);
      expect(child.pid).toBeTypeOf("number");
      expect([child.exitCode, child.signalCode]).toEqual([3, null]);
    }),
  );

  live("reports a kill as the signal it asked for, as Node does on Windows", () =>
    Effect.gen(function* () {
      const spawn = yield* NodeStyleChild.make;
      const child = spawn(process.execPath, ["-e", IDLE], { env });
      yield* once(child, "spawn");
      const exited = once<[number | null, NodeJS.Signals | null]>(child, "exit");

      expect(child.kill()).toBe(true);
      expect(yield* exited).toEqual([null, "SIGTERM"]);
      expect(child.killed).toBe(true);
      expect(child.kill()).toBe(false);
      expect(yield* gone(child.pid!)).toBe(true);
    }),
  );

  live("kills the program once it starts when its signal aborts first", () =>
    Effect.gen(function* () {
      const spawn = yield* NodeStyleChild.make;
      const controller = new AbortController();
      const child = spawn(process.execPath, ["-e", IDLE], { env, signal: controller.signal });
      const spawned = once(child, "spawn");
      const exited = once<[number | null, NodeJS.Signals | null]>(child, "exit");
      controller.abort();

      yield* spawned;
      expect(yield* exited).toEqual([null, "SIGTERM"]);
      expect(yield* gone(child.pid!)).toBe(true);
    }),
  );

  live("reports a program that cannot start with Node's error, and no exit", () =>
    Effect.gen(function* () {
      const spawn = yield* NodeStyleChild.make;
      const child = spawn("t3-no-such-program", [], { env });
      const exits: Array<unknown> = [];
      child.on("exit", (...args) => exits.push(args));
      const [error] = yield* once<[NodeJS.ErrnoException]>(child, "error");

      expect(error.code).toBe("ENOENT");
      expect(error.syscall).toMatch(/^spawn/);
      expect(child.pid).toBeUndefined();
      expect(exits).toEqual([]);
    }),
  );
});

describe("a Node-style child from the spawn worker", () => {
  const withGrandchild = Effect.gen(function* () {
    const spawn = yield* NodeStyleChild.make;
    const child = spawn(process.execPath, ["-e", STARTS_A_GRANDCHILD], { env });
    const firstLine = new Promise<number>((resolve) => {
      let text = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        text += chunk;
        if (text.includes("\n")) resolve(Number(text.split("\n")[0]));
      });
    });
    const grandchild = yield* Effect.promise(() => firstLine);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const pid of [child.pid!, grandchild]) {
          if (isAlive(pid)) process.kill(pid);
        }
      }),
    );
    return { child, grandchild };
  });

  it.live.runIf(onWindowsHost)("killing the program ends what it started too", () =>
    Effect.gen(function* () {
      const { child, grandchild } = yield* withGrandchild;
      const exited = once(child, "exit");

      child.kill("SIGKILL");
      yield* exited;
      expect(yield* gone(child.pid!)).toBe(true);
      expect(yield* gone(grandchild)).toBe(true);
    }).pipe(
      Effect.scoped,
      Effect.provide(workerLayer),
      Effect.provideService(HostProcess.Platform, "win32"),
    ),
  );

  it.live.runIf(onWindowsHost)(
    "stopping the server ends a running program and what it started",
    () =>
      Effect.gen(function* () {
        const layerScope = yield* Scope.make();
        const spawner = yield* ProcessSpawnWorker.make().pipe(
          Effect.provideService(Scope.Scope, layerScope),
        );
        const { child, grandchild } = yield* withGrandchild.pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        const exited = once(child, "exit");

        yield* Scope.close(layerScope, Exit.void);
        yield* exited;
        expect(yield* gone(child.pid!)).toBe(true);
        expect(yield* gone(grandchild)).toBe(true);
      }).pipe(
        Effect.scoped,
        Effect.provide(NodeServices.layer),
        Effect.provideService(HostProcess.Platform, "win32"),
      ),
  );
});
