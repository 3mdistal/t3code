// fork: see FORK.md, "A Claude session that was never saved recovers".
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

import * as HostProcess from "@t3tools/shared/HostProcess";

/**
 * True when no project folder in this Claude home holds the session's transcript, so
 * `claude --resume` can only answer "No conversation found". The folder's location follows the
 * adapter's own transcript check. Any other read failure fails this effect.
 */
export const isClaudeTranscriptMissing = Effect.fn("isClaudeTranscriptMissing")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly configDir: string | undefined;
  readonly cwd: string;
  readonly nativeThreadId: string;
}) {
  const { fileSystem, path, nativeThreadId } = input;
  const configuredDir = input.configDir?.trim() ?? "";
  const projectsDir = path.join(
    configuredDir.length > 0
      ? path.resolve(input.cwd, configuredDir)
      : path.join(yield* HostProcess.HomeDirectory, ".claude"),
    "projects",
  );
  // An account that has never saved a session has no projects folder yet.
  const projects = yield* fileSystem
    .readDirectory(projectsDir)
    .pipe(
      Effect.catchReason("PlatformError", "NotFound", () =>
        Effect.succeed<ReadonlyArray<string>>([]),
      ),
    );
  for (const project of projects) {
    const saved = yield* fileSystem
      .exists(path.join(projectsDir, project, `${nativeThreadId}.jsonl`))
      // Stray files beside the project folders fail with ENOTDIR.
      .pipe(Effect.catchReason("PlatformError", "BadResource", () => Effect.succeed(false)));
    if (saved) return false;
  }
  return true;
});
