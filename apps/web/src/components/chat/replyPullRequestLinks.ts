// fork: a bare `#123` in an assistant reply links to the pull request it names, so a reply doesn't depend on its
// agent writing the link. See FORK.md, "Pull request numbers in replies link".
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import type { PluggableList } from "unified";

/** A pull request linked to a thread. */
export interface KnownPullRequest {
  /** The repository's browser URL, without a trailing slash. */
  readonly repositoryUrl: string;
  readonly number: number;
  readonly url: string;
}

export interface ReplyPullRequestSources {
  /** The pull requests linked to the reply's thread. */
  readonly thread: ReadonlyArray<KnownPullRequest>;
  /** The pull requests linked to every loaded thread, the reply's own among them. */
  readonly known: ReadonlyArray<KnownPullRequest>;
  /** The browser URL of the GitHub repository the thread's project works in. */
  readonly projectRepositoryUrl: string | null;
}

export interface ReplyPullRequestLink {
  /** Where `text` starts in the string that was searched. */
  readonly index: number;
  readonly text: string;
  readonly url: string;
  /**
   * The number is only a guess at the repository's pull request; it may be an issue. T3 reads it as a pull request
   * before opening it, as it does for `#123` in a pull request's description.
   */
  readonly reference: boolean;
}

/** Parses a pull request URL, or null when it isn't one. */
export function knownPullRequest(url: string): KnownPullRequest | null {
  const link = sourceControlClients.parseChangeRequestUrl(url)?.link;
  if (link === undefined) return null;
  return { repositoryUrl: trimSlash(link.repositoryUrl), number: link.number, url };
}

const PLACEHOLDER_REPOSITORY = "https://github.com/_/_";
const REFERENCE_TEXT = /^(?:(.+))?#([1-9]\d*)$/u;

const trimSlash = (url: string) => url.replace(/\/+$/u, "");
const repositoryKey = (url: string) => trimSlash(url).toLowerCase();
const repositoryName = (url: string) => repositoryKey(url).split("/").pop() ?? "";
const distinctRepositories = (pullRequests: ReadonlyArray<KnownPullRequest>) => [
  ...new Map(pullRequests.map((pr) => [repositoryKey(pr.repositoryUrl), pr])).values(),
];

/**
 * Finds pull request numbers in `text`: the thread's own first, then another thread's (in one repository, or the
 * thread's), then a guess in the thread's repository no higher than a pull request seen there. `owner/repo#123`
 * names its repository; `repo#123` needs one known repository with that name.
 */
export function findReplyPullRequestLinks(
  text: string,
  sources: ReplyPullRequestSources,
): ReadonlyArray<ReplyPullRequestLink> {
  // GitHub's own grammar for a reference, so a number reads the same here as in a pull request's description.
  const references = sourceControlClients
    .get("github")
    .referenceAutolinks?.(text, PLACEHOLDER_REPOSITORY)
    .filter((link) => link.kind === "reference");
  if (!references?.length) return [];

  const ownRepositories = distinctRepositories(sources.thread);
  const homeRepositoryUrl =
    ownRepositories.length === 1 ? ownRepositories[0]!.repositoryUrl : sources.projectRepositoryUrl;
  const highest = new Map<string, number>();
  for (const pr of sources.known) {
    const key = repositoryKey(pr.repositoryUrl);
    highest.set(key, Math.max(highest.get(key) ?? 0, pr.number));
  }
  const repositories = new Map(
    [...sources.known.map((pr) => pr.repositoryUrl), sources.projectRepositoryUrl]
      .filter((url) => url !== null)
      .map((url) => [repositoryKey(url), trimSlash(url)]),
  );

  const direct = (pr: KnownPullRequest) => ({ url: pr.url, reference: false });
  const guess = (repositoryUrl: string, number: number) => ({
    url: `${trimSlash(repositoryUrl)}/issues/${number}`,
    reference: true,
  });
  const inRepository = (repositoryUrl: string, number: number) =>
    sources.known.find(
      (pr) =>
        pr.number === number && repositoryKey(pr.repositoryUrl) === repositoryKey(repositoryUrl),
    );
  const qualified = (qualifier: string): string | null => {
    if (qualifier.includes("/")) {
      return (
        [...repositories.values()].find((url) =>
          repositoryKey(url).endsWith(`/${qualifier.toLowerCase()}`),
        ) ?? `https://github.com/${qualifier}`
      );
    }
    const named = [...repositories.values()].filter(
      (url) => repositoryName(url) === qualifier.toLowerCase(),
    );
    return named.length === 1 ? named[0]! : null;
  };
  const resolve = (qualifier: string | undefined, number: number) => {
    if (qualifier !== undefined) {
      const repositoryUrl = qualified(qualifier);
      if (repositoryUrl === null) return null;
      const pr = inRepository(repositoryUrl, number);
      return pr ? direct(pr) : guess(repositoryUrl, number);
    }
    const own = distinctRepositories(sources.thread.filter((pr) => pr.number === number));
    if (own.length > 0) return own.length === 1 ? direct(own[0]!) : null;
    const anywhere = distinctRepositories(sources.known.filter((pr) => pr.number === number));
    if (anywhere.length === 1) return direct(anywhere[0]!);
    if (homeRepositoryUrl === null) return null;
    if (anywhere.length > 1) {
      const home = inRepository(homeRepositoryUrl, number);
      return home ? direct(home) : null;
    }
    return (highest.get(repositoryKey(homeRepositoryUrl)) ?? 0) >= number
      ? guess(homeRepositoryUrl, number)
      : null;
  };

  const links: ReplyPullRequestLink[] = [];
  for (const reference of references) {
    const [, qualifier, digits] = REFERENCE_TEXT.exec(reference.text) ?? [];
    if (digits === undefined) continue;
    const target = resolve(qualifier, Number(digits));
    if (target !== null) links.push({ index: reference.index, text: reference.text, ...target });
  }
  return links;
}

type MarkdownNode = {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  url?: string;
  data?: unknown;
};

const SKIPPED_TYPES = new Set(["link", "linkReference"]);

/** Turns the numbers `find` resolves into links. A guessed one carries upstream's reference autolink marker. */
export function remarkReplyPullRequestLinks(options: {
  readonly find: (text: string) => ReadonlyArray<ReplyPullRequestLink>;
}) {
  const visit = (node: MarkdownNode): void => {
    const children = node.children;
    if (children === undefined) return;
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index]!;
      if (SKIPPED_TYPES.has(child.type)) continue;
      if (child.type !== "text" || child.value === undefined) {
        visit(child);
        continue;
      }
      const value = child.value;
      const links = options.find(value);
      if (links.length === 0) continue;
      const replacements: MarkdownNode[] = [];
      let start = 0;
      for (const link of links) {
        if (start < link.index) {
          replacements.push({ type: "text", value: value.slice(start, link.index) });
        }
        replacements.push({
          type: "link",
          url: link.url,
          ...(link.reference
            ? { data: { hProperties: { dataPullRequestAutolink: "reference" } } }
            : {}),
          children: [{ type: "text", value: link.text }],
        });
        start = link.index + link.text.length;
      }
      if (start < value.length) replacements.push({ type: "text", value: value.slice(start) });
      children.splice(index, 1, ...replacements);
      index += replacements.length - 1;
    }
  };
  return (tree: MarkdownNode) => visit(tree);
}

const NO_PLUGINS: PluggableList = [];
let pluginsVersion: unknown;
const pluginsBySignature = new Map<string, PluggableList>();

/**
 * One plugin list per set of sources, so every reply in a thread shares one markdown renderer and its parse cache.
 * `version` identifies `sources.known`; a new one drops the lists built from the old.
 */
export function replyPullRequestLinkPlugins(
  sources: ReplyPullRequestSources,
  version: unknown,
): PluggableList {
  if (sources.known.length === 0 && sources.projectRepositoryUrl === null) return NO_PLUGINS;
  if (version !== pluginsVersion) {
    pluginsVersion = version;
    pluginsBySignature.clear();
  }
  const signature = JSON.stringify([
    sources.thread.map((pr) => pr.url),
    sources.projectRepositoryUrl,
  ]);
  let plugins = pluginsBySignature.get(signature);
  if (plugins === undefined) {
    plugins = [
      [
        remarkReplyPullRequestLinks,
        { find: (text: string) => findReplyPullRequestLinks(text, sources) },
      ],
    ];
    pluginsBySignature.set(signature, plugins);
  }
  return plugins;
}
