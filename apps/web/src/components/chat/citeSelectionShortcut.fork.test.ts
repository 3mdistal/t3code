import { describe, expect, it } from "vite-plus/test";

import {
  citeSelectionAriaKeyShortcuts,
  citeSelectionShortcutLabel,
  isCiteSelectionShortcut,
} from "./citeSelectionShortcut";

const key = (overrides: Partial<Parameters<typeof isCiteSelectionShortcut>[0]> = {}) => ({
  type: "keydown",
  key: "l",
  code: "KeyL",
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...overrides,
});

describe("isCiteSelectionShortcut", () => {
  it("matches Cmd+L on a Mac and Ctrl+L elsewhere", () => {
    expect(isCiteSelectionShortcut(key({ metaKey: true }), "MacIntel")).toBe(true);
    expect(isCiteSelectionShortcut(key({ ctrlKey: true }), "Win32")).toBe(true);
    expect(isCiteSelectionShortcut(key({ ctrlKey: true }), "Linux x86_64")).toBe(true);
  });

  it("leaves the other platform's modifier alone", () => {
    expect(isCiteSelectionShortcut(key({ ctrlKey: true }), "MacIntel")).toBe(false);
    expect(isCiteSelectionShortcut(key({ metaKey: true }), "Win32")).toBe(false);
  });

  it("leaves Mod+Shift+L, the previous-worktree shortcut, alone", () => {
    expect(isCiteSelectionShortcut(key({ metaKey: true, shiftKey: true }), "MacIntel")).toBe(false);
    expect(isCiteSelectionShortcut(key({ ctrlKey: true, shiftKey: true }), "Win32")).toBe(false);
  });

  it("follows the L key on other layouts", () => {
    expect(isCiteSelectionShortcut(key({ key: "д", ctrlKey: true }), "Win32")).toBe(true);
  });

  it("ignores key-ups, a bare L and IME composition", () => {
    expect(isCiteSelectionShortcut(key({ type: "keyup", ctrlKey: true }), "Win32")).toBe(false);
    expect(isCiteSelectionShortcut(key(), "Win32")).toBe(false);
    expect(isCiteSelectionShortcut(key({ ctrlKey: true, isComposing: true }), "Win32")).toBe(false);
  });
});

describe("cite shortcut labels", () => {
  it("reads as each platform writes it", () => {
    expect(citeSelectionShortcutLabel("MacIntel")).toBe("⌘L");
    expect(citeSelectionShortcutLabel("Win32")).toBe("Ctrl+L");
    expect(citeSelectionAriaKeyShortcuts("MacIntel")).toBe("Meta+L");
    expect(citeSelectionAriaKeyShortcuts("Win32")).toBe("Control+L");
  });
});
