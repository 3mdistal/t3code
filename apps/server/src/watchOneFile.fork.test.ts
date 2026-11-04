import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { watchOneFile } from "./watchOneFile.ts";

// oxlint-disable-next-line t3code/no-global-process-runtime -- libuv's file watch needs a real Windows host.
const onWindowsHost = process.platform === "win32";

const watched = (platform: NodeJS.Platform, watchedFile: "exists" | "missing") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped();
    const file = path.join(directory, "settings.json");
    if (watchedFile === "exists") yield* fs.writeFileString(file, "{}");
    const events = yield* Queue.unbounded<string>();
    const ready = yield* Deferred.make<void>();
    yield* watchOneFile(fs, file, directory, {
      onReady: () => Deferred.doneUnsafe(ready, Effect.void),
    }).pipe(
      Stream.runForEach((event) => Queue.offer(events, event.path)),
      Effect.provideService(HostProcess.Platform, platform),
      Effect.forkScoped,
    );
    yield* Deferred.await(ready);
    const next = (wait: number) =>
      Queue.take(events).pipe(Effect.timeoutOption(Duration.millis(wait)));
    const saveNeighbour = fs.writeFileString(path.join(directory, "statev2.sqlite"), "changed");
    return { directory, file, fs, next, path, saveNeighbour };
  });

describe.runIf(onWindowsHost)("watchOneFile on Windows", () => {
  it.live("sees an atomic save of the file and nothing from its neighbours", () =>
    Effect.gen(function* () {
      const { directory, file, fs, next, path, saveNeighbour } = yield* watched("win32", "exists");
      yield* saveNeighbour;
      assert.isTrue(Option.isNone(yield* next(500)));

      const temporary = path.join(directory, "settings.json.tmp");
      yield* fs.writeFileString(temporary, `{ "saved": true }`);
      yield* fs.rename(temporary, file);
      assert.equal(Option.getOrThrow(yield* next(5000)), "settings.json");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("sees a second save after the first replaced the file", () =>
    Effect.gen(function* () {
      const { directory, file, fs, next, path } = yield* watched("win32", "exists");
      for (const contents of ["first", "second"]) {
        const temporary = path.join(directory, "settings.json.tmp");
        yield* fs.writeFileString(temporary, contents);
        yield* fs.rename(temporary, file);
        assert.equal(Option.getOrThrow(yield* next(5000)), "settings.json");
        // Drain the events from this save, so the next one has to come from the next save.
        while (Option.isSome(yield* next(300)));
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("keeps the directory for a file that doesn't exist yet", () =>
    Effect.gen(function* () {
      const { file, fs, next } = yield* watched("win32", "missing");
      yield* fs.writeFileString(file, "{}");
      assert.equal(Option.getOrThrow(yield* next(5000)), "settings.json");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("watchOneFile elsewhere", () => {
  it.live("keeps the directory, so the caller's name filter decides", () =>
    Effect.gen(function* () {
      const { next, saveNeighbour } = yield* watched("linux", "exists");
      yield* saveNeighbour;
      assert.equal(Option.getOrThrow(yield* next(5000)), "statev2.sqlite");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
