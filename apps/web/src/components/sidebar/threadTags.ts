// fork: thread tags, see FORK.md.
import { useAtomMount } from "@effect/atom-react";
import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  createEnvironmentRpcQueryAtomFamily,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  hasAnyThreadTag,
  listThreadTags,
  planThreadTagChanges,
  type ScopedThreadRef,
  THREAD_TAG_NAMES_WS_METHOD,
  type ThreadTagMatch,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { msg } from "gt-react";

import { environmentCatalog } from "~/connection/catalog";
import { connectionAtomRuntime } from "~/connection/runtime";
import { m } from "~/i18n/messages";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { serverEnvironment } from "~/state/server";
import { environmentThreadShells, threadEnvironment } from "~/state/threads";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import type { ThreadActionMenuId, ThreadTagMenuState } from "../threadActionMenu.logic";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { type BulkTagMenuId, bulkAllTags, bulkTagAdds } from "./bulkThreadActions";
import { requestNewThreadTag } from "./NewThreadTagDialog";

const NO_TAGS: ReadonlyArray<string> = [];

/** A thread's tags, as its server keeps them on the thread. */
export function threadTagsOf(
  thread: Pick<EnvironmentThreadShell, "source">,
): ReadonlyArray<string> {
  return thread.source.tags ?? NO_TAGS;
}

/** The tags on the threads this window has from a server; it changes only when that set does. */
const loadedTagNamesAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) =>
    listThreadTags(
      get(environmentThreadShells.environmentThreadsAtom(environmentId)).map(({ tags }) => tags),
    ).join("\n"),
  ),
);

const TAG_NAMES_STALE_MS = 30_000;

const tagNamesRead = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:thread-tags:names",
  tag: THREAD_TAG_NAMES_WS_METHOD,
  staleTimeMs: TAG_NAMES_STALE_MS,
  // A change among the loaded threads' tags reads again; one on threads not loaded waits for a menu.
  refreshTrigger: ({ environmentId }) => loadedTagNamesAtom(environmentId),
});

/** Reads a server's tags again when its copy is over 30 s old, for the next menu that opens. */
function refreshStaleTagNames(environmentId: EnvironmentId) {
  if (
    appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId))?.threadTagNames !== true
  ) {
    return;
  }
  const read = tagNamesRead({ environmentId, input: {} });
  const result = appAtomRegistry.get(read);
  if (result.waiting) return;
  const stale = AsyncResult.isSuccess(result)
    ? Date.now() - result.timestamp >= TAG_NAMES_STALE_MS
    : AsyncResult.isFailure(result);
  if (stale) appAtomRegistry.refresh(read);
}

/** Every tag on a server's threads, archived ones too; none from a server without the read. */
const serverTagNamesAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): ReadonlyArray<string> => {
    if (get(serverEnvironment.configValueAtom(environmentId))?.threadTagNames !== true) {
      return NO_TAGS;
    }
    const read = AsyncResult.getOrElse(get(tagNamesRead({ environmentId, input: {} })), () => null);
    return read?.tags ?? NO_TAGS;
  }),
);

/** Kept read while a tag menu can open, so it has every server's tags when it does. */
const enabledServerTagNamesAtom = Atom.make((get) => {
  for (const environmentId of enabledEnvironmentIds(get(environmentCatalog.catalogValueAtom))) {
    get(serverTagNamesAtom(environmentId));
  }
});

/**
 * The Tags submenu for a thread: its own tags, then every tag on its server's threads, those the
 * window has loaded and, from the server's read, the rest, archived ones included. Call it as the
 * menu opens: a server read over 30 s old is read again for the next opening.
 */
export function readThreadTagMenu(
  thread: Pick<EnvironmentThreadShell, "environmentId" | "source">,
): ThreadTagMenuState {
  refreshStaleTagNames(thread.environmentId);
  const threads = appAtomRegistry.get(
    environmentThreadShells.environmentThreadsAtom(thread.environmentId),
  );
  return {
    all: listThreadTags([
      thread.source.tags,
      ...threads.map((candidate) => candidate.tags),
      appAtomRegistry.get(serverTagNamesAtom(thread.environmentId)),
    ]),
    selected: threadTagsOf(thread),
  };
}

/** A steady hue per tag, so a tag keeps its color everywhere it shows. */
export function threadTagHue(tag: string): number {
  let hash = 0;
  for (const char of tag.toLowerCase()) hash = (hash * 31 + char.codePointAt(0)!) | 0;
  return Math.abs(hash) % 360;
}

/** A thread to tag, with the Tags submenu it was shown. */
export interface ThreadTagTarget {
  readonly threadRef: ScopedThreadRef;
  readonly menu: ThreadTagMenuState;
}

/**
 * Tags or untags threads with `thread.tag.set`: a new tag takes the spelling the thread's server
 * already uses, and untagging removes every spelling that matches. Toasts the first failure.
 */
function useWriteThreadTag() {
  const setTag = useOrchestrationCommand(threadEnvironment.setTag, { reportFailure: false });
  return async (
    targets: ReadonlyArray<ThreadTagTarget>,
    { match, ...wanted }: { tag: string; tagged: boolean; match: ThreadTagMatch },
    failureTitle: string,
  ) => {
    const results = await Promise.all(
      targets.flatMap(({ threadRef, menu }) =>
        planThreadTagChanges(menu.selected, menu.all, [wanted], match).commands.map((change) =>
          setTag({
            environmentId: threadRef.environmentId,
            input: { threadId: threadRef.threadId, ...change },
          }),
        ),
      ),
    );
    for (const result of results) {
      if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) continue;
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: failureTitle,
          description: error instanceof Error ? error.message : m(msg("An error occurred.")),
        }),
      );
      return;
    }
  };
}

/** Handles the Tags submenu's clicks. Returns false for other menu items. */
export function useThreadTagMenuActions() {
  useAtomMount(enabledServerTagNamesAtom);
  const write = useWriteThreadTag();
  return (target: ThreadTagTarget, action: ThreadActionMenuId): boolean => {
    if (action === "tag-new") {
      void requestNewThreadTag(target.menu.all).then((tag) => {
        if (tag !== null) {
          void write(
            [target],
            { tag, tagged: true, match: "typed" },
            m(msg("Could not tag thread")),
          );
        }
      });
      return true;
    }
    if (!action.startsWith("tag:")) return false;
    const tag = action.slice("tag:".length);
    const tagged = !hasAnyThreadTag(target.menu.selected, [tag], "picked");
    void write(
      [target],
      { tag, tagged, match: "picked" },
      tagged ? m(msg("Could not tag thread")) : m(msg("Could not remove tag")),
    );
    return true;
  };
}

/** Handles the Tags submenu's clicks when several threads are selected. */
export function useBulkThreadTagMenuActions() {
  const write = useWriteThreadTag();
  return async (targets: ReadonlyArray<ThreadTagTarget>, action: BulkTagMenuId) => {
    const menus = targets.map(({ menu }) => menu);
    if (action === "tag-new") {
      const tag = await requestNewThreadTag(bulkAllTags(menus));
      if (tag !== null) {
        await write(
          targets,
          { tag, tagged: true, match: "typed" },
          m(msg("Could not tag threads")),
        );
      }
      return;
    }
    if (action === "tags") return;
    const tag = action.slice("tag:".length);
    const tagged = bulkTagAdds(
      menus.map((menu) => menu.selected),
      tag,
    );
    await write(
      targets,
      { tag, tagged, match: "picked" },
      tagged ? m(msg("Could not tag threads")) : m(msg("Could not remove tag")),
    );
  };
}
