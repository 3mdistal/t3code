// fork: Codex's `skills/list` has no flag for skills a user can't invoke, so this reads each
// skill's SKILL.md frontmatter and carries `user-invocable: false` into the `$` menu, as Claude's
// skills already do. The model still sees every skill. See FORK.md.
import type { ServerProviderSkill } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { parseSkillFrontmatter } from "./Drivers/ClaudeSkills.ts";

const SKILL_FILE_NAME = "SKILL.md";
const SKILL_READ_CONCURRENCY = 16;
// A slow disk must never cost the probe its account and models result.
const SKILL_READ_TIMEOUT = Duration.seconds(2);

/**
 * Marks each skill whose SKILL.md says `user-invocable: false`. A missing,
 * unreadable or malformed file, or a slow read, leaves the skill visible.
 */
export const markCodexSkillsUserInvocable = Effect.fn("markCodexSkillsUserInvocable")(function* (
  skills: ReadonlyArray<ServerProviderSkill>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const readUserInvocable = (skill: ServerProviderSkill) => {
    // Codex lists the SKILL.md file itself; accept its folder too.
    const skillFile =
      path.basename(skill.path).toLowerCase() === SKILL_FILE_NAME.toLowerCase()
        ? skill.path
        : path.join(skill.path, SKILL_FILE_NAME);
    return fileSystem.readFileString(skillFile).pipe(
      Effect.map((contents): ServerProviderSkill => {
        const frontmatter = parseSkillFrontmatter(contents);
        return frontmatter.kind === "parsed" && frontmatter.userInvocable === false
          ? { ...skill, userInvocable: false }
          : skill;
      }),
      Effect.orElseSucceed(() => skill),
    );
  };
  return yield* Effect.forEach(skills, readUserInvocable, {
    concurrency: SKILL_READ_CONCURRENCY,
  }).pipe(Effect.timeoutOption(SKILL_READ_TIMEOUT), Effect.map(Option.getOrElse(() => skills)));
});
