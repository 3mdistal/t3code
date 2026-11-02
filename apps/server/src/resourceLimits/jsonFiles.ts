// fork: limits. The small JSON files the limits share with teenylilconfig's hook and task wake; see FORK.md.
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const Json = Schema.fromJsonString(Schema.Unknown, { space: 2 });
const decodeJson = Schema.decodeUnknownOption(Json);
const encodeJson = Schema.encodeEffect(Json);

export const makeJsonFiles = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const readJson = (file: string) =>
    fs.readFileString(file).pipe(
      Effect.map((text) => Option.getOrNull(decodeJson(text))),
      Effect.orElseSucceed((): unknown => null),
    );

  let written = 0;

  // A temporary file and a rename, so the hook never reads half a file. False when it couldn't be written.
  const writeJson = Effect.fn("ResourceLimits.writeJson")(
    function* (file: string, value: unknown) {
      yield* fs.makeDirectory(path.dirname(file), { recursive: true });
      const temporary = `${file}.${process.pid}.${(written += 1)}.tmp`;
      yield* fs.writeFileString(temporary, `${yield* encodeJson(value)}\n`);
      yield* fs.rename(temporary, file);
      return true;
    },
    (effect, file) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("resource-limits.write-failed", { file, cause }).pipe(Effect.as(false)),
        ),
      ),
  );

  return { readJson, writeJson };
});
