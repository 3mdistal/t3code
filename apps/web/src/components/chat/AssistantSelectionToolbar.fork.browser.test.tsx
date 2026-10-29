import {
  ASSISTANT_CITATION_MAX_TEXT_LENGTH,
  EnvironmentId,
  ThreadId,
  type AssistantCitation,
} from "@t3tools/contracts";
import { isMacPlatform } from "@t3tools/shared/keybindings";
import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { AssistantSelectionToolbar } from "./AssistantSelectionToolbar";

const threadRef = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
};
const mod = isMacPlatform(navigator.platform) ? "Meta" : "Control";
const citeButton = () => page.getByRole("button", { name: "Cite selection in composer" });

function Timeline({
  text,
  onCite,
}: {
  text: string;
  onCite: (citation: AssistantCitation) => boolean;
}) {
  const [viewport, setViewport] = useState<HTMLElement | null>(null);
  return (
    <div ref={setViewport} data-assistant-citation-viewport="true">
      <AssistantSelectionToolbar viewport={viewport} threadRef={threadRef} onCite={onCite} />
      <p data-assistant-citation-source="source">{text}</p>
    </div>
  );
}

function selectSourceText(end: number) {
  const text = document.querySelector("[data-assistant-citation-source]")!.firstChild!;
  const range = document.createRange();
  range.setStart(text, 0);
  range.setEnd(text, end);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}

describe("AssistantSelectionToolbar Mod+L (fork)", () => {
  it("cites the selection, as clicking Cite does", async () => {
    const onCite = vi.fn((_citation: AssistantCitation) => true);
    await using _screen = await render(<Timeline text="hello world" onCite={onCite} />);

    selectSourceText(5);
    await expect.element(citeButton()).toBeVisible();
    await expect
      .element(citeButton())
      .toHaveAttribute("aria-keyshortcuts", mod === "Meta" ? "Meta+L" : "Control+L");
    await userEvent.keyboard(`{${mod}>}l{/${mod}}`);

    expect(onCite).toHaveBeenCalledOnce();
    expect(onCite.mock.calls[0]![0]).toMatchObject({ messageId: "source", text: "hello" });
    await expect.element(citeButton()).not.toBeInTheDocument();
    expect(window.getSelection()!.isCollapsed).toBe(true);
  });

  it("does nothing without a selection", async () => {
    const onCite = vi.fn(() => true);
    await using _screen = await render(<Timeline text="hello world" onCite={onCite} />);
    let prevented: boolean | null = null;
    const record = (event: KeyboardEvent) => {
      if (event.key === "l") prevented = event.defaultPrevented;
    };
    window.addEventListener("keydown", record);
    try {
      await userEvent.keyboard(`{${mod}>}l{/${mod}}`);
    } finally {
      window.removeEventListener("keydown", record);
    }

    expect(prevented).toBe(false);
    expect(onCite).not.toHaveBeenCalled();
  });

  it("does nothing when the selection is too long to cite", async () => {
    const onCite = vi.fn(() => true);
    const text = "a".repeat(ASSISTANT_CITATION_MAX_TEXT_LENGTH + 1);
    await using _screen = await render(<Timeline text={text} onCite={onCite} />);

    selectSourceText(text.length);
    const tooLong = page.getByRole("button", { name: "Selection is too long to cite" });
    await expect.element(tooLong).toBeVisible();
    await userEvent.keyboard(`{${mod}>}l{/${mod}}`);

    expect(onCite).not.toHaveBeenCalled();
    await expect.element(tooLong).toBeVisible();
  });
});
