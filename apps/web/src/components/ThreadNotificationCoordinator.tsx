import {
  type EnvironmentThreadShell,
  type PendingSubagentRequest,
  presentThreadShell,
} from "@t3tools/client-runtime/state/models";
import { isShownUnderParent } from "@t3tools/client-runtime/state/threads";
import type { AnyRouter } from "@tanstack/react-router";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import type { EnvironmentId, OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import type { ClientSettings } from "@t3tools/contracts/settings";
import * as Option from "effect/Option";
import type { AtomRegistry } from "effect/reactivity";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  MessageCircleQuestionIcon,
  ShieldQuestionIcon,
} from "lucide-react";

import { getClientSettings, subscribeClientSettings } from "../hooks/useSettings";
import { isWindowsPlatform } from "../lib/utils";
import { environmentSummaries } from "../state/presentation";
import { environmentShell } from "../state/shell";
import { environmentThreadShells } from "../state/threads";
import {
  hasDesktopNotifications,
  hasNotificationSound,
  playNotificationSound,
  setNotificationBadge,
  threadNotificationTag,
  unlockNotificationAudio,
} from "../threadNotifications";
import { resolveSidebarThreadStatus, type SidebarThreadStatus } from "./Sidebar.logic";
import {
  announcedRequest,
  type AttentionRequest,
  createPendingChildRequestsAtom,
  newerAttentionRequest,
  ownAttentionRequest,
  threadAttentionKey,
} from "./ThreadAttentionRequests.fork";
import {
  createThreadNotificationGate,
  type ThreadNotificationKind,
  type ThreadNotificationObservation,
} from "./ThreadNotificationCoordinator.logic";
import { readWakeNoticeItems } from "./ThreadWakeNoticeRead.fork";
import { createThreadWakeNotices, WAKE_CANCELLED_NOTICE_TITLE } from "./ThreadWakeNotices.fork";
import { toastManager } from "./ui/toast";

interface NotificationState extends ThreadNotificationObservation {
  readonly raw: OrchestrationV2ThreadShell;
  readonly subagentRequest: PendingSubagentRequest | null;
  // fork: tell a new request from an older one still waiting; see FORK.md.
  readonly childRequest: AttentionRequest | null;
  readonly announcedRequest: AttentionRequest | null;
  readonly thread: EnvironmentThreadShell;
  readonly status: SidebarThreadStatus;
}

type ToastId = ReturnType<typeof toastManager.add>;

interface WatchedEnvironment {
  unsubscribe: () => void;
  previous: Map<ThreadId, NotificationState>;
  reconnecting: boolean;
  readonly gate: ReturnType<typeof createThreadNotificationGate<ThreadId>>;
  readonly wakeNotices: ReturnType<typeof createThreadWakeNotices>;
}

const pendingChildRequestsAtom = createPendingChildRequestsAtom(environmentThreadShells);

/**
 * Turns thread status transitions in every connected environment into sounds, in-app toasts,
 * and desktop notifications, and keeps the dock badge in step with the unread ones.
 */
export function startThreadNotifications(
  registry: AtomRegistry.AtomRegistry,
  router: AnyRouter,
): () => void {
  const pending = new Map<
    string,
    { environmentId: EnvironmentId; threadId: ThreadId; notification: Notification }
  >();
  const watched = new Map<EnvironmentId, WatchedEnvironment>();

  const trackNotification = (
    environmentId: EnvironmentId,
    threadId: ThreadId,
    notification: Notification,
  ) => {
    pending.get(notification.tag)?.notification.close();
    pending.set(notification.tag, { environmentId, threadId, notification });
    setNotificationBadge(pending.size);
  };
  // Toast ids by thread key, so hiding a thread can close its open toasts.
  const openToasts = new Map<string, Array<ToastId>>();
  const forgetToast = (key: string, toastId: ToastId) => {
    const remaining = (openToasts.get(key) ?? []).filter((id) => id !== toastId);
    if (remaining.length === 0) openToasts.delete(key);
    else openToasts.set(key, remaining);
  };
  // A notification shown before the tag filter turned on must not stay on screen. While hiding,
  // one whose thread left the live list (archived) cannot be judged, so it closes too.
  const closeHiddenPending = () => {
    const hidden = registry.get(environmentThreadShells.hiddenThreadKeysAtom);
    const live = registry.get(environmentThreadShells.anyEnvironmentHidingAtom)
      ? new Set(registry.get(environmentThreadShells.threadRefsAtom).map(threadKey))
      : null;
    const shouldClose = (key: string) => hidden.has(key) || (live !== null && !live.has(key));
    for (const [key, toastIds] of openToasts) {
      if (!shouldClose(key)) continue;
      for (const toastId of toastIds) toastManager.close(toastId);
      openToasts.delete(key);
    }
    const count = pending.size;
    for (const [tag, entry] of pending) {
      if (!shouldClose(threadKey(entry))) continue;
      entry.notification.close();
      pending.delete(tag);
    }
    if (count !== pending.size) setNotificationBadge(pending.size);
  };
  const clearPending = () => {
    for (const { notification } of pending.values()) notification.close();
    pending.clear();
    setNotificationBadge(0);
  };

  const present = (
    environmentId: EnvironmentId,
    state: NotificationState,
    kind: ThreadNotificationKind,
    // fork: a lost background wake alerts like attention, under its own name; see FORK.md.
    wakeCancelled = false,
  ) => {
    const { thread, status } = state;
    if (
      registry
        .get(environmentThreadShells.hiddenThreadKeysAtom)
        .has(threadKey({ environmentId, threadId: thread.id }))
    )
      return;
    const { notificationMode: mode, inAppNotificationsEnabled } = getClientSettings();
    const active = (router.state.matches.at(-1)?.params ?? {}) as {
      environmentId?: string;
      threadId?: string;
    };
    const title = wakeCancelled
      ? WAKE_CANCELLED_NOTICE_TITLE
      : kind === "completion"
        ? "Thread completed"
        : status === "approval"
          ? "Approval needed"
          : status === "limited"
            ? "Usage limit reached"
            : status === "failed"
              ? "Thread failed"
              : status === "request"
                ? "Guest request"
                : "Input needed";
    if (hasNotificationSound(mode)) {
      void playNotificationSound(kind, () =>
        hasNotificationSound(getClientSettings().notificationMode),
      );
    }
    if (
      inAppNotificationsEnabled &&
      document.visibilityState === "visible" &&
      document.hasFocus() &&
      (active.environmentId !== environmentId || active.threadId !== thread.id)
    ) {
      const toastKey = threadKey({ environmentId, threadId: thread.id });
      const toastId: ToastId = toastManager.add({
        onRemove: (): void => forgetToast(toastKey, toastId),
        type: wakeCancelled
          ? "warning"
          : kind === "completion"
            ? "success"
            : status === "failed"
              ? "error"
              : "warning",
        title,
        description: thread.title,
        data: {
          hideCopyButton: true,
          leadingIcon: wakeCancelled ? (
            <CircleAlertIcon aria-hidden className="size-4 text-warning-foreground" />
          ) : kind === "completion" ? (
            <CircleCheckIcon aria-hidden className="size-4 text-success-foreground" />
          ) : status === "approval" ? (
            <ShieldQuestionIcon aria-hidden className="size-4 text-warning-foreground" />
          ) : status === "limited" ? (
            <CircleAlertIcon aria-hidden className="size-4 text-warning-foreground" />
          ) : status === "failed" ? (
            <CircleAlertIcon aria-hidden className="size-4 text-destructive-foreground" />
          ) : (
            <MessageCircleQuestionIcon aria-hidden className="size-4 text-info-foreground" />
          ),
        },
        actionProps: {
          children: "Open thread",
          onClick: () => {
            toastManager.close(toastId);
            void router.navigate({
              to: "/$environmentId/$threadId",
              params: { environmentId, threadId: thread.id },
            });
          },
        },
      });
      openToasts.set(toastKey, [...(openToasts.get(toastKey) ?? []), toastId]);
      return;
    }
    if (
      !hasDesktopNotifications(mode) ||
      (document.visibilityState === "visible" && document.hasFocus()) ||
      typeof Notification === "undefined" ||
      Notification.permission !== "granted"
    )
      return;
    try {
      const notification = new Notification(title, {
        body: thread.title,
        tag: threadNotificationTag(environmentId, thread.id),
        silent: true,
        // Windows drops clicks after a toast moves into Notification Center.
        requireInteraction: kind === "completion" && isWindowsPlatform(navigator.platform),
      });
      trackNotification(environmentId, thread.id, notification);
      notification.addEventListener("click", () => {
        notification.close();
        window.focus();
        void window.desktopBridge?.revealWindow().catch(() => undefined);
        void router.navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId, threadId: thread.id },
        });
      });
    } catch {
      // Some browsers expose Notification but reject desktop presentation.
    }
  };

  const observeThreads = (
    environmentId: EnvironmentId,
    entry: WatchedEnvironment,
    threads: ReadonlyArray<OrchestrationV2ThreadShell>,
  ) => {
    const previous = entry.previous;
    const next = new Map<ThreadId, NotificationState>();
    // A parent here also hears of what its tasks on linked environments ask.
    const subagentRequests = registry.get(
      environmentThreadShells.pendingSubagentRequestsAtom(environmentId),
    );
    const delegatedUnderParent = registry.get(environmentThreadShells.delegatedUnderParentAtom);
    const childRequests = registry.get(pendingChildRequestsAtom(environmentId));
    const changed: Array<[NotificationState | undefined, NotificationState]> = [];
    for (const rawThread of threads) {
      if (
        isShownUnderParent(
          { environmentId, threadId: rawThread.id },
          rawThread.lineage,
          delegatedUnderParent,
        )
      ) {
        continue;
      }
      const prior = previous.get(rawThread.id);
      const subagentRequest = subagentRequests.get(rawThread.id) ?? null;
      const childRequest = childRequests.get(rawThread.id) ?? null;
      if (
        !entry.reconnecting &&
        prior?.raw === rawThread &&
        prior.subagentRequest === subagentRequest &&
        prior.childRequest?.id === childRequest?.id
      ) {
        next.set(rawThread.id, prior);
        continue;
      }
      const thread = presentThreadShell(environmentId, rawThread, subagentRequest);
      let status = resolveSidebarThreadStatus(thread);
      if (status === "ready" && thread.latestRun?.status === "failed") status = "failed";
      // fork: the pending request's identity keeps a new prompt in the same run from being
      // deduplicated; see FORK.md.
      const request = announcedRequest(
        prior?.announcedRequest ?? null,
        newerAttentionRequest(ownAttentionRequest(rawThread), childRequest),
      );
      const attention = threadAttentionKey(thread.latestRun?.runId ?? "", status, request);
      const completedAt = Date.parse(thread.latestRun?.completedAt ?? "");
      const settled = status === "ready" && thread.latestRun?.status === "completed";
      const state = {
        raw: rawThread,
        subagentRequest,
        childRequest,
        announcedRequest: request,
        thread,
        status,
        attention,
        settled,
        completedAt: settled && Number.isFinite(completedAt) ? completedAt : null,
      };
      next.set(thread.id, state);
      changed.push([prior, state]);
    }
    entry.reconnecting = false;
    entry.previous = next;
    const threadIds = new Set(next.keys());
    entry.gate.retain(threadIds);
    entry.wakeNotices.retain(threadIds);
    // fork: completions send at once, so queue a lost-wake read before the gate sees the same
    // update, and that completion waits for it; see FORK.md.
    entry.wakeNotices.resume();
    for (const [prior, state] of changed) {
      entry.wakeNotices.observe(state.thread.id, state.raw);
      entry.gate.observe(state.thread.id, prior, state, {
        archived: state.thread.archivedAt !== null,
        quiet: state.raw.latestRunStopRequested === true,
      });
    }
  };

  const watchEnvironment = (environmentId: EnvironmentId): WatchedEnvironment => {
    const entry: WatchedEnvironment = {
      previous: new Map(),
      reconnecting: false,
      unsubscribe: () => {},
      gate: createThreadNotificationGate<ThreadId>((threadId, kind) => {
        const deliver = () => {
          const state = entry.previous.get(threadId);
          if (state) present(environmentId, state, kind);
        };
        // fork: a read in flight may replace this completion with a wake alert; see FORK.md.
        if (kind !== "completion" || !entry.wakeNotices.holdCompletion(threadId, deliver)) {
          deliver();
        }
      }),
      wakeNotices: createThreadWakeNotices({
        read: (threadId) => readWakeNoticeItems(registry, environmentId, threadId),
        notify: (threadId) => {
          const state = entry.previous.get(threadId);
          if (!state) return;
          entry.gate.supersedeCompletion(
            threadId,
            Date.parse(state.thread.latestRun?.completedAt ?? ""),
          );
          present(environmentId, state, "input", true);
        },
      }),
    };
    let threads: ReadonlyArray<OrchestrationV2ThreadShell> | null = null;
    const unsubscribeShell = registry.subscribe(
      environmentShell.stateValueAtom(environmentId),
      (shell) => {
        threads =
          shell.status === "live" && Option.isSome(shell.snapshot)
            ? shell.snapshot.value.threads
            : null;
        if (threads !== null) {
          observeThreads(environmentId, entry, threads);
          return;
        }
        entry.wakeNotices.pause();
        entry.reconnecting = true;
      },
      { immediate: true },
    );
    const reobserve = () => {
      if (threads !== null) observeThreads(environmentId, entry, threads);
    };
    const unsubscribeRequests = registry.subscribe(
      environmentThreadShells.pendingSubagentRequestsAtom(environmentId),
      reobserve,
    );
    const unsubscribeDelegated = registry.subscribe(
      environmentThreadShells.delegatedUnderParentAtom,
      reobserve,
    );
    // fork: a linked task's next request changes neither this environment's shell nor its flags.
    const unsubscribeChildRequests = registry.subscribe(
      pendingChildRequestsAtom(environmentId),
      reobserve,
    );
    entry.unsubscribe = () => {
      unsubscribeShell();
      unsubscribeRequests();
      unsubscribeDelegated();
      unsubscribeChildRequests();
      entry.gate.clear();
      entry.wakeNotices.dispose();
    };
    return entry;
  };

  const syncEnvironments = () => {
    const { notificationMode, inAppNotificationsEnabled } = getClientSettings();
    const enabled = notificationMode !== "off" || inAppNotificationsEnabled;
    const environmentIds = enabled ? registry.get(environmentSummaries.environmentIdsAtom) : [];
    const activeIds = new Set(environmentIds);
    for (const [environmentId, entry] of watched) {
      if (activeIds.has(environmentId)) continue;
      entry.unsubscribe();
      watched.delete(environmentId);
    }
    for (const environmentId of environmentIds) {
      if (!watched.has(environmentId)) watched.set(environmentId, watchEnvironment(environmentId));
    }
  };

  const pruneRemovedEnvironments = () => {
    const activeIds = new Set(registry.get(environmentSummaries.environmentIdsAtom));
    const count = pending.size;
    for (const [tag, entry] of pending) {
      if (activeIds.has(entry.environmentId)) continue;
      entry.notification.close();
      pending.delete(tag);
    }
    if (count !== pending.size) setNotificationBadge(pending.size);
  };

  // Listeners that only exist for some notification modes, rebuilt when the mode changes.
  let appliedMode: ClientSettings["notificationMode"] | null = null;
  let stopModeListeners = () => {};
  const applyMode = () => {
    const nextMode = getClientSettings().notificationMode;
    if (nextMode === appliedMode) return;
    appliedMode = nextMode;
    stopModeListeners();
    clearPending();
    const stops: Array<() => void> = [];
    if (hasDesktopNotifications(nextMode)) {
      const unsubscribeBadgeClear = window.desktopBridge?.onNotificationBadgeClear(clearPending);
      window.addEventListener("focus", clearPending);
      stops.push(() => {
        unsubscribeBadgeClear?.();
        window.removeEventListener("focus", clearPending);
        clearPending();
      });
    }
    if (hasNotificationSound(nextMode)) {
      document.addEventListener("pointerdown", unlockNotificationAudio);
      document.addEventListener("keydown", unlockNotificationAudio);
      stops.push(() => {
        document.removeEventListener("pointerdown", unlockNotificationAudio);
        document.removeEventListener("keydown", unlockNotificationAudio);
      });
    }
    stopModeListeners = () => {
      for (const stop of stops) stop();
    };
  };

  const onSettings = () => {
    applyMode();
    syncEnvironments();
  };
  const unsubscribeSettings = subscribeClientSettings(onSettings);
  const unsubscribeEnvironmentIds = registry.subscribe(
    environmentSummaries.environmentIdsAtom,
    () => {
      pruneRemovedEnvironments();
      syncEnvironments();
    },
  );
  const unsubscribeHidden = [
    registry.subscribe(environmentThreadShells.hiddenThreadKeysAtom, closeHiddenPending),
    registry.subscribe(environmentThreadShells.anyEnvironmentHidingAtom, closeHiddenPending),
    registry.subscribe(environmentThreadShells.threadRefsAtom, closeHiddenPending),
  ];
  onSettings();

  return () => {
    unsubscribeSettings();
    unsubscribeEnvironmentIds();
    for (const unsubscribe of unsubscribeHidden) unsubscribe();
    for (const entry of watched.values()) entry.unsubscribe();
    watched.clear();
    stopModeListeners();
  };
}
