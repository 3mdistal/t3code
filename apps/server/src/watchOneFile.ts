// fork: see FORK.md. A directory watch makes libuv on Windows look up each changed entry on the main
// thread, and the state directory holds the database. A watch on a file matches by name, with no lookup.
// Elsewhere a watch on a file loses it on an atomic save, so it stays on the directory, as it does for
// a file that doesn't exist yet. Callers still filter by name.
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";

export const watchOneFile = (
  fs: FileSystem.FileSystem,
  filePath: string,
  directory: string,
  options?: FileSystem.WatchOptions,
) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const onWindows = (yield* HostProcess.Platform) === "win32";
      const exists =
        onWindows && (yield* fs.exists(filePath).pipe(Effect.orElseSucceed(() => false)));
      if (!exists) return fs.watch(directory, options);
      // The file can be replaced as the watch attaches; the directory is still there.
      return fs.watch(filePath, options).pipe(Stream.catch(() => fs.watch(directory, options)));
    }),
  );
