import type { ThreadLinkedPullRequest, ThreadPullRequestLink } from "@t3tools/contracts";

/** Tombstoned stack members stay in the array only so the
 * sync reactor does not re-add them. */
export function visibleThreadPullRequests(
  links: ReadonlyArray<ThreadPullRequestLink>,
): ReadonlyArray<ThreadPullRequestLink> {
  return links.filter((link) => link.source !== "stack-dismissed");
}

export function threadPullRequestSearchTerms(thread: {
  readonly pullRequests?: ReadonlyArray<ThreadPullRequestLink> | undefined;
  readonly linkedPullRequest?: ThreadLinkedPullRequest | null | undefined;
  readonly branchPullRequest?: ThreadLinkedPullRequest | null | undefined;
}): string[] {
  const branch = thread.branchPullRequest;
  const terms = branch
    ? [`#${branch.number}`, `${branch.repository}#${branch.number}`, branch.url]
    : [];
  if (thread.pullRequests !== undefined && thread.pullRequests.length > 0) {
    return terms.concat(
      visibleThreadPullRequests(thread.pullRequests).flatMap((link) => [
        `#${link.number}`,
        `${link.repository}#${link.number}`,
        link.url,
        link.snapshot?.title ?? "",
      ]),
    );
  }
  const legacy = thread.linkedPullRequest;
  return legacy
    ? terms.concat([`#${legacy.number}`, `${legacy.repository}#${legacy.number}`, legacy.url])
    : terms;
}
