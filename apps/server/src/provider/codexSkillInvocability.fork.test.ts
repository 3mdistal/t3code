import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

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

// A disk that never answers, on the test clock, so no test waits in real time.
const hungDisk = Layer.merge(
  FileSystem.layerNoop({ readFileString: () => Effect.never }),
  Path.layer,
);
const hungSkills = [
  { name: "hidden", path: "/skills/hidden/SKILL.md", enabled: true },
  { name: "visible", path: "/skills/visible/SKILL.md", enabled: true },
];

describe("markCodexSkillsUserInvocable on a slow disk", () => {
  it.effect("returns skills unmarked at the probe's discovery deadline", () =>
    Effect.gen(function* () {
      // The probe leaves 250 ms before its outer timeout, less than the 2 s read cap.
      const deadlineMs = DateTime.toEpochMillis(yield* DateTime.now) + 250;
      const fiber = yield* markCodexSkillsUserInvocable(hungSkills, { deadlineMs }).pipe(
        Effect.forkChild,
      );
      yield* TestClock.adjust("250 millis");
      assert.deepEqual(yield* Fiber.join(fiber), hungSkills);
    }).pipe(Effect.provide(hungDisk)),
  );

  it.effect("skips the reads when the deadline has already passed", () =>
    Effect.gen(function* () {
      const deadlineMs = DateTime.toEpochMillis(yield* DateTime.now) - 1;
      assert.deepEqual(yield* markCodexSkillsUserInvocable(hungSkills, { deadlineMs }), hungSkills);
    }).pipe(Effect.provide(hungDisk)),
  );

  it.effect("caps the reads at 2 s without a deadline", () =>
    Effect.gen(function* () {
      const fiber = yield* markCodexSkillsUserInvocable(hungSkills).pipe(Effect.forkChild);
      yield* TestClock.adjust("2 seconds");
      assert.deepEqual(yield* Fiber.join(fiber), hungSkills);
    }).pipe(Effect.provide(hungDisk)),
  );
});
