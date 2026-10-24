// fork: Codex's `skills/list` has no flag for skills a user can't invoke, so this reads each
// skill's SKILL.md frontmatter and carries `user-invocable: false` into the `$` menu, as Claude's
// skills already do. The model still sees every skill. See FORK.md.
import type { ServerProviderSkill } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { parseSkillFrontmatter } from "./Drivers/ClaudeSkills.ts";

const SKILL_FILE_NAME = "SKILL.md";
const SKILL_READ_CONCURRENCY = 16;
const SKILL_READ_TIMEOUT_MS = 2_000;

/**
 * Marks each skill whose SKILL.md says `user-invocable: false`. A missing, unreadable or malformed
 * file leaves the skill visible. Reads get at most 2 s and never run past `deadlineMs` (epoch ms),
 * so a slow disk can't cost the provider probe its account and models result; when time runs out,
 * every skill comes back unmarked, so visible.
 */
export const markCodexSkillsUserInvocable = Effect.fn("markCodexSkillsUserInvocable")(function* (
  skills: ReadonlyArray<ServerProviderSkill>,
  options?: { readonly deadlineMs?: number },
) {
  const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
  const timeoutMs = Math.min(SKILL_READ_TIMEOUT_MS, (options?.deadlineMs ?? Infinity) - nowMs);
  if (skills.length === 0 || timeoutMs <= 0) return skills;
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
  }).pipe(
    Effect.timeoutOption(Duration.millis(timeoutMs)),
    Effect.map(Option.getOrElse(() => skills)),
  );
});
