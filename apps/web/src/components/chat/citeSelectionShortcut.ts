// fork: Mod+L cites selected assistant text, as clicking Cite does. See FORK.md.
import {
  isMacPlatform,
  matchesKeybindingShortcut,
  parseKeybindingShortcut,
} from "@t3tools/shared/keybindings";

import { formatShortcutLabel, type ShortcutEventLike } from "~/keybindings";

const CITE_SELECTION_SHORTCUT = parseKeybindingShortcut("mod+l")!;

export function isCiteSelectionShortcut(
  event: ShortcutEventLike & { isComposing?: boolean },
  platform = navigator.platform,
): boolean {
  if (event.type !== undefined && event.type !== "keydown") return false;
  if (event.isComposing) return false;
  return matchesKeybindingShortcut(event, CITE_SELECTION_SHORTCUT, platform);
}

export function citeSelectionShortcutLabel(platform = navigator.platform): string {
  return formatShortcutLabel(CITE_SELECTION_SHORTCUT, platform);
}

/** The shortcut in `aria-keyshortcuts` syntax. */
export function citeSelectionAriaKeyShortcuts(platform = navigator.platform): string {
  return isMacPlatform(platform) ? "Meta+L" : "Control+L";
}
