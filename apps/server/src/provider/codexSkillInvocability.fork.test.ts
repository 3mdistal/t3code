import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { markCodexSkillsUserInvocable } from "./codexSkillInvocability.ts";

const writeSkill = Effect.fn("writeSkill")(function* (
  root: string,
  name: string,
  contents: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(root, name);
  yield* fileSystem.makeDirectory(directory, { recursive: true });
  const skillPath = path.join(directory, "SKILL.md");
  yield* fileSystem.writeFileString(skillPath, contents);
  return skillPath;
});

it.layer(NodeServices.layer)("markCodexSkillsUserInvocable", (it) => {
  it.effect("hides only skills whose SKILL.md says user-invocable: false", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-codex-skills-" });
      const hiddenPath = yield* writeSkill(
        root,
        "hidden",
        "---\nname: hidden\ndescription: Runs on its own.\nuser-invocable: false\n---\nBody\n",
      );
      const visiblePath = yield* writeSkill(
        root,
        "visible",
        "---\nname: visible\ndescription: Typed by hand.\n---\nBody\n",
      );
      const missingPath = path.join(root, "missing", "SKILL.md");

      const skills = yield* markCodexSkillsUserInvocable([
        { name: "hidden", path: hiddenPath, enabled: true },
        { name: "visible", path: visiblePath, enabled: true },
        { name: "missing", path: missingPath, enabled: true },
      ]);

      assert.deepEqual(skills, [
        { name: "hidden", path: hiddenPath, enabled: true, userInvocable: false },
        { name: "visible", path: visiblePath, enabled: true },
        { name: "missing", path: missingPath, enabled: true },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("reads SKILL.md inside a skill folder path", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-codex-skills-" });
      yield* writeSkill(root, "folder", "---\nname: folder\nuser-invocable: no\n---\n");
      const folderPath = path.join(root, "folder");

      const skills = yield* markCodexSkillsUserInvocable([
        { name: "folder", path: folderPath, enabled: true },
      ]);

      assert.deepEqual(skills, [
        { name: "folder", path: folderPath, enabled: true, userInvocable: false },
      ]);
    }).pipe(Effect.scoped),
  );
});
