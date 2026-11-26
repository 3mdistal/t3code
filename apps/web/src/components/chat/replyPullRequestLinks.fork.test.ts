import type { Element, Root } from "hast";
import { describe, expect, it } from "vite-plus/test";

import { wordsHast } from "../../markdown/wordsHast";
import {
  findReplyPullRequestLinks,
  knownPullRequest,
  replyPullRequestLinkExtensions,
  type KnownPullRequest,
  type ReplyPullRequestSources,
} from "./replyPullRequestLinks";

const CONFIG = "https://github.com/alice/config";
const APP = "https://github.com/acme/app";
const VAULT = "https://github.com/alice/vault";

const pr = (repositoryUrl: string, number: number): KnownPullRequest =>
  knownPullRequest(`${repositoryUrl}/pull/${number}`)!;

const sources = (overrides: Partial<ReplyPullRequestSources> = {}): ReplyPullRequestSources => ({
  thread: [],
  known: [],
  projectRepositoryUrl: null,
  ...overrides,
});

const urls = (text: string, from: ReplyPullRequestSources) =>
  findReplyPullRequestLinks(text, from).map((link) => [link.text, link.url, link.reference]);

describe("findReplyPullRequestLinks", () => {
  it("links a number to the thread's own pull request first", () => {
    const own = pr(CONFIG, 434);
    expect(urls("Merged #434.", sources({ thread: [own], known: [own, pr(APP, 434)] }))).toEqual([
      ["#434", `${CONFIG}/pull/434`, false],
    ]);
  });

  it("links a number another thread links, when only one repository has it", () => {
    const from = sources({ known: [pr(CONFIG, 554), pr(APP, 8509)], projectRepositoryUrl: VAULT });
    expect(urls("PR #554 holds a slot; #8509 is green", from)).toEqual([
      ["#554", `${CONFIG}/pull/554`, false],
      ["#8509", `${APP}/pull/8509`, false],
    ]);
  });

  it("settles a number two repositories link by the thread's repository, or leaves it", () => {
    const known = [pr(CONFIG, 12), pr(APP, 12)];
    expect(urls("#12", sources({ known, projectRepositoryUrl: APP }))).toEqual([
      ["#12", `${APP}/pull/12`, false],
    ]);
    expect(urls("#12", sources({ known, projectRepositoryUrl: VAULT }))).toEqual([]);
  });

  it("guesses the thread's repository only within the numbers seen there", () => {
    const from = sources({ known: [pr(APP, 8962)], projectRepositoryUrl: APP });
    expect(urls("follows #8221", from)).toEqual([["#8221", `${APP}/issues/8221`, true]]);
    expect(urls("then #9000", from)).toEqual([]);
  });

  it("leaves a number plain when the thread's project has no pull requests that high", () => {
    const from = sources({ known: [pr(VAULT, 15), pr(APP, 8509)], projectRepositoryUrl: VAULT });
    expect(urls("#8221 and #540", from)).toEqual([]);
  });

  it("takes the thread's repository from its linked pull requests before its project's", () => {
    const own = pr(APP, 8509);
    const from = sources({ thread: [own], known: [own], projectRepositoryUrl: VAULT });
    expect(urls("#8221 follows it", from)).toEqual([["#8221", `${APP}/issues/8221`, true]]);
  });

  it("links qualified references to the repository they name", () => {
    const from = sources({ known: [pr(APP, 77)] });
    expect(urls("acme/app#77, alice/other#3, app#5, nope#5", from)).toEqual([
      ["acme/app#77", `${APP}/pull/77`, false],
      ["alice/other#3", "https://github.com/alice/other/issues/3", true],
      ["app#5", `${APP}/issues/5`, true],
    ]);
  });

  it("follows GitHub's grammar for what counts as a reference", () => {
    const from = sources({ known: [pr(CONFIG, 12)] });
    expect(urls("a#12 x/#12 #12abc #0", from)).toEqual([]);
    expect(urls("(#12)", from)).toEqual([["#12", `${CONFIG}/pull/12`, false]]);
  });
});

function linked(markdown: string, from: ReplyPullRequestSources) {
  const tree = wordsHast(markdown, {
    math: false,
    breaks: false,
    escapeHtml: false,
    insights: false,
    extensions: { replyPullRequestLinks: (text) => findReplyPullRequestLinks(text, from) },
  });
  const found: Array<[string | undefined, unknown, unknown]> = [];
  const visit = (node: Root | Element) => {
    for (const child of node.children) {
      if (child.type !== "element") continue;
      if (child.tagName === "a") {
        const text = child.children[0];
        found.push([
          text?.type === "text" ? text.value : undefined,
          child.properties.href,
          child.properties.dataPullRequestAutolink,
        ]);
      }
      visit(child);
    }
  };
  visit(tree);
  return found;
}

describe("reply pull request links in Markdown", () => {
  const from = sources({ known: [pr(APP, 8962)], projectRepositoryUrl: APP });

  it("links known pull requests plainly and marks guesses as references", () => {
    expect(linked("**PR #8962** waits; #8221 follows.", from)).toEqual([
      ["#8962", `${APP}/pull/8962`, undefined],
      ["#8221", `${APP}/issues/8221`, "reference"],
    ]);
  });

  it("leaves code, character references and existing links alone", () => {
    expect(
      linked("`#8962`, &#8962; and [#8962](https://example.com) and\n\n```\n#8962\n```", from),
    ).toEqual([["#8962", "https://example.com", undefined]]);
  });
});

describe("replyPullRequestLinkExtensions", () => {
  it("shares one extension per set of sources and drops them when the known pull requests change", () => {
    const known = [pr(APP, 1)];
    const first = replyPullRequestLinkExtensions(sources({ known }), known);
    expect(replyPullRequestLinkExtensions(sources({ known }), known)).toBe(first);
    expect(
      replyPullRequestLinkExtensions(sources({ known, projectRepositoryUrl: APP }), known),
    ).not.toBe(first);
    expect(replyPullRequestLinkExtensions(sources({ known }), [...known])).not.toBe(first);
  });

  it("adds nothing when there is nothing to link against", () => {
    expect(replyPullRequestLinkExtensions(sources(), [])).toBeUndefined();
  });
});
