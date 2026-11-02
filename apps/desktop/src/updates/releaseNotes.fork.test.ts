import { describe, expect, it } from "vite-plus/test";

import { normalizeDesktopUpdateReleaseNotes } from "./releaseNotes.ts";

// fork: GitHub renders a list with a blank line in it as a loose list, wrapping every item in
// <p>. The update feed carries that HTML, which used to split each item from its bullet and show
// a lone "-" between items (see FORK.md).
describe("fork release notes", () => {
  it("keeps loose list items on their bullets", () => {
    const html = [
      "<p>Built from upstream v0.1.6 and the fork patches below.</p>",
      "<ul>",
      "<li>",
      "<p>fork: settle a delegated thread as soon as its task ends</p>",
      "</li>",
      "<li>",
      "<p><strong>Windows:</strong> run the <code>.exe</code>.</p>",
      "</li>",
      "</ul>",
    ].join("\n");

    const result = normalizeDesktopUpdateReleaseNotes(html, "0.1.6-alice.3", "latest");

    expect(result.releaseNotes[0]?.items).toEqual([
      "Windows: run the .exe.",
      "fork: settle a delegated thread as soon as its task ends",
      "Built from upstream v0.1.6 and the fork patches below.",
    ]);
  });

  it("shows the newest patches when install steps come first", () => {
    const html = [
      "<h3>Install</h3>",
      "<ul>",
      "<li><strong>Windows:</strong> run the <code>.exe</code>.</li>",
      "<li><strong>macOS (Apple silicon):</strong> open the <code>.dmg</code>.</li>",
      "</ul>",
      "<h3>Patches</h3>",
      "<p>Built from upstream v0.1.6 and the fork patches below.</p>",
      "<ul>",
      "<li>fork: install updates on ad hoc-signed Macs</li>",
      "<li>fork: close review gaps in releasing finished delegated threads</li>",
      "</ul>",
    ].join("\n");

    const result = normalizeDesktopUpdateReleaseNotes(html, "0.1.6-alice.4", "latest");

    expect(result.releaseNotes[0]?.items.slice(0, 2)).toEqual([
      "fork: close review gaps in releasing finished delegated threads",
      "fork: install updates on ad hoc-signed Macs",
    ]);
  });
});
