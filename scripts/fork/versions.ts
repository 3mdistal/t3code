// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - runs from a bare checkout, before any install, so it has only Node built-ins.
// fork: the X.Y.Z-alice.N version scheme (see FORK.md). Node built-ins only, so
// the sync script and the release workflow run it without installing anything.
import * as NodeChildProcess from "node:child_process";

export const FORK_REPOSITORY = "3mdistal/t3code";
export const FORK_MAIN_BRANCH = "fork/main";

const STABLE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;
const FORK_TAG = /^v(\d+\.\d+\.\d+)-alice\.(\d+)$/;

export function isStableTag(tag: string): boolean {
  return STABLE_TAG.test(tag);
}

export function compareStableTags(left: string, right: string): number {
  const a = STABLE_TAG.exec(left);
  const b = STABLE_TAG.exec(right);
  if (!a || !b) throw new Error(`Not stable tags: ${left}, ${right}`);
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(a[index]) - Number(b[index]);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function newestStableTag(tags: ReadonlyArray<string>): string | undefined {
  return tags.filter(isStableTag).toSorted(compareStableTags).at(-1);
}

/** The release that follows the existing `vX.Y.Z-alice.N` tags on the base stable tag. */
export function nextForkVersion(baseTag: string, tags: ReadonlyArray<string>): string {
  if (!isStableTag(baseTag)) throw new Error(`${baseTag} is not a stable tag`);
  const base = baseTag.slice(1);
  let counter = 0;
  for (const tag of tags) {
    const match = FORK_TAG.exec(tag);
    if (match?.[1] === base) counter = Math.max(counter, Number(match[2]));
  }
  return `${base}-alice.${counter + 1}`;
}

export function forkVersionOfTag(tag: string): string | undefined {
  return FORK_TAG.test(tag) ? tag.slice(1) : undefined;
}

export function git(cwd: string, args: ReadonlyArray<string>): string {
  return NodeChildProcess.execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function lines(output: string): Array<string> {
  return output.split(/\r?\n/).filter((line) => line.length > 0);
}

/** The newest stable tag `ref` contains: the upstream release its patch stack sits on. */
export function baseStableTag(cwd: string, ref: string): string {
  const base = newestStableTag(lines(git(cwd, ["tag", "--merged", ref, "--list", "v*"])));
  if (base === undefined) throw new Error(`${ref} contains no stable tag`);
  return base;
}

/**
 * What the release workflow publishes for `ref`: nothing if a release tag already
 * points at it, otherwise the next counter on its base stable tag.
 */
export function resolveReleaseVersion(
  cwd: string,
  ref: string,
): { readonly version: string; readonly base: string; readonly released: boolean } {
  const base = baseStableTag(cwd, ref);
  const existing = lines(git(cwd, ["tag", "--points-at", ref])).find(forkVersionOfTag);
  if (existing !== undefined) return { version: existing.slice(1), base, released: true };
  const tags = lines(git(cwd, ["tag", "--list", `${base}-alice.*`]));
  return { version: nextForkVersion(base, tags), base, released: false };
}

if (import.meta.main) {
  const [command, ref = "HEAD"] = process.argv.slice(2);
  if (command !== "release-version") {
    console.error("Usage: node scripts/fork/versions.ts release-version [ref]");
    process.exit(2);
  }
  const { version, base, released } = resolveReleaseVersion(process.cwd(), ref);
  console.log(`version=${version}`);
  console.log(`base=${base}`);
  console.log(`released=${released}`);
}
