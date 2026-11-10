// fork: the plugins that link bare pull request numbers in a thread's replies. See FORK.md, "Pull request numbers
// in replies link".
import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { parseThreadKey, threadKey } from "@t3tools/client-runtime/state/entities";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import type { PluggableList } from "unified";

import { environmentProjects } from "../../state/projects";
import { environmentThreadShells } from "../../state/threads";
import {
  knownPullRequest,
  replyPullRequestLinkPlugins,
  type KnownPullRequest,
} from "./replyPullRequestLinks";

const NO_PLUGINS: PluggableList = [];
const NO_PLUGINS_ATOM = Atom.make(NO_PLUGINS).pipe(Atom.withLabel("fork-reply-pr-links:none"));

function shellPullRequests(shell: EnvironmentThreadShell): KnownPullRequest[] {
  const urls = new Set([
    ...visibleThreadPullRequests(shell.pullRequests ?? []).map((pr) => pr.url),
    ...[shell.linkedPullRequest?.url, shell.branchPullRequest?.url].filter((url) => url != null),
  ]);
  return [...urls].flatMap((url) => knownPullRequest(url) ?? []);
}

function projectRepositoryUrl(project: EnvironmentProject | null): string | null {
  const identity = project?.repositoryIdentity;
  if (!identity?.webUrl) return null;
  return identity.provider === "github" ||
    (identity.provider === undefined && URL.parse(identity.webUrl)?.hostname === "github.com")
    ? identity.webUrl
    : null;
}

interface KnownPullRequests {
  readonly signature: string;
  readonly list: ReadonlyArray<KnownPullRequest>;
}

// The quiet list skips a running thread's streaming ticks, and an unchanged set of links keeps its object, so
// replies re-render only when a thread's pull requests change.
const knownPullRequestsAtom = Atom.make((get): KnownPullRequests => {
  const previous = Option.getOrUndefined(get.self<KnownPullRequests>());
  const list = get(environmentThreadShells.quietThreadShellsAtom).flatMap(shellPullRequests);
  const signature = list.map((pr) => pr.url).join("\n");
  return previous?.signature === signature ? previous : { signature, list };
}).pipe(Atom.withLabel("fork-reply-pr-links:known"));

const threadPluginsAtom = Atom.family((key: string) =>
  Atom.make((get) => {
    const shell = get(environmentThreadShells.quietThreadShellAtom(parseThreadKey(key)));
    if (shell === null) return NO_PLUGINS;
    const project = get(
      environmentProjects.projectAtom({
        environmentId: shell.environmentId,
        projectId: shell.projectId,
      }),
    );
    const known = get(knownPullRequestsAtom);
    return replyPullRequestLinkPlugins(
      {
        thread: shellPullRequests(shell),
        known: known.list,
        projectRepositoryUrl: projectRepositoryUrl(project),
      },
      known,
    );
  }).pipe(Atom.withLabel(`fork-reply-pr-links:${key}`)),
);

/** Remark plugins for a reply in `threadRef`'s thread. Stable while its sources are. */
export function useReplyPullRequestLinkPlugins(threadRef: ScopedThreadRef | null): PluggableList {
  return useAtomValue(
    threadRef === null ? NO_PLUGINS_ATOM : threadPluginsAtom(threadKey(threadRef)),
  );
}
