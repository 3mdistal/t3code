// fork: thread tags, see FORK.md.
import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  listThreadTags,
  normalizeThreadTag,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentServerConfigsAtom, serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import type { ThreadActionMenuId, ThreadTagMenuState } from "../threadActionMenu.logic";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { requestNewThreadTag } from "./NewThreadTagDialog";

const NO_TAGS: ReadonlyArray<string> = [];
const TAG_SEPARATOR = "\u0000";

/** The Tags submenu for a thread, or null when its server can't hold tags. */
export function readThreadTagMenu(threadRef: ScopedThreadRef): ThreadTagMenuState | null {
  const config = appAtomRegistry.get(environmentServerConfigsAtom).get(threadRef.environmentId);
  if (config?.environment.capabilities.threadTags !== true) return null;
  const threadTags = config.settings.threadTags;
  return {
    all: listThreadTags(threadTags),
    selected: threadTags[threadRef.threadId] ?? NO_TAGS,
    canEdit: appAtomRegistry.get(
      serverEnvironment.updateSettings.permissionAtom(threadRef.environmentId),
    ),
  };
}

/** A thread's tags, read live so an agent's tag shows without a reload. */
export function useThreadTags(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): ReadonlyArray<string> {
  // Joined so the row only re-renders when this thread's tags change.
  const joined = useAtomValue(
    serverEnvironment.settingsValueAtom(environmentId),
    (settings) => settings?.threadTags[threadId]?.join(TAG_SEPARATOR) ?? "",
  );
  return joined === "" ? NO_TAGS : joined.split(TAG_SEPARATOR);
}

/** A steady hue per tag, so a tag keeps its color everywhere it shows. */
export function threadTagHue(tag: string): number {
  let hash = 0;
  for (const char of tag.toLocaleLowerCase()) hash = (hash * 31 + char.codePointAt(0)!) | 0;
  return Math.abs(hash) % 360;
}

/** Handles the Tags submenu's clicks. Returns false for other menu items. */
export function useThreadTagMenuActions() {
  const persist = useAtomCommand(serverEnvironment.updateSettings, {
    label: "thread tags update",
    reportFailure: false,
  });
  const write = async (threadRef: ScopedThreadRef, tag: string, add: boolean) => {
    const result = await persist({
      environmentId: threadRef.environmentId,
      input: { patch: { threadTags: { [threadRef.threadId]: { [tag]: add } } } },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: add ? "Could not tag thread" : "Could not remove tag",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    }
  };
  return (threadRef: ScopedThreadRef, action: ThreadActionMenuId): boolean => {
    if (action === "tag-new") {
      void requestNewThreadTag(readThreadTagMenu(threadRef)?.all ?? NO_TAGS).then((tag) => {
        if (tag !== null) void write(threadRef, tag, true);
      });
      return true;
    }
    if (!action.startsWith("tag:")) return false;
    const tag = action.slice("tag:".length);
    const selected = readThreadTagMenu(threadRef)?.selected ?? NO_TAGS;
    const key = normalizeThreadTag(tag).toLocaleLowerCase();
    void write(
      threadRef,
      tag,
      !selected.some((candidate) => candidate.toLocaleLowerCase() === key),
    );
    return true;
  };
}
