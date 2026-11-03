// fork: awaited commands retain ownership until their native wake is attached; see FORK.md.
import type {
  OrchestrationV2PendingBackgroundTask,
  OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

export const CLAUDE_WAKE_OWNERSHIP_TIMEOUT_MS = 120_000;

export function claudeWakeTaskIds(messages: ReadonlyArray<SDKMessage>) {
  return messages.flatMap((message) =>
    message.type === "system" && message.subtype === "task_notification" ? [message.task_id] : [],
  );
}

export function claudeAwaitedRosterHoldsIngestion(thread: OrchestrationV2ProviderThread): boolean {
  return (
    thread.driver === "claudeAgent" &&
    (thread.pendingBackgroundTasks ?? []).some((task) => task.awaited === true)
  );
}

export interface ClaudeWakeLease {
  readonly nativeThreadId: string;
  readonly owner: object;
  readonly task: OrchestrationV2PendingBackgroundTask;
  waking: boolean;
}

export function makeClaudeWakeOwnership(input: {
  readonly scope: Scope.Scope;
  readonly onDeadline: (lease: ClaudeWakeLease) => Effect.Effect<void>;
}) {
  const leases = new Map<string, Map<string, ClaudeWakeLease>>();
  const tasks = (nativeThreadId: string) =>
    Array.from(leases.get(nativeThreadId)?.values() ?? [], ({ task }) => task);
  const remove = (nativeThreadId: string, ids: ReadonlyArray<string>, owner?: object) => {
    const current = leases.get(nativeThreadId);
    if (current === undefined) return;
    for (const id of ids) {
      if (owner === undefined || current.get(id)?.owner === owner) current.delete(id);
    }
    if (current.size === 0) leases.delete(nativeThreadId);
  };
  return {
    tasks,
    merge: (nativeThreadId: string, roster: ReadonlyArray<OrchestrationV2PendingBackgroundTask>) =>
      Array.from(
        new Map(
          [...roster, ...tasks(nativeThreadId).filter((task) => task.awaited === true)].map(
            (task) => [task.taskId, task],
          ),
        ).values(),
      ),
    has: (nativeThreadId?: string) =>
      nativeThreadId === undefined ? leases.size > 0 : (leases.get(nativeThreadId)?.size ?? 0) > 0,
    acquire: Effect.fn("ClaudeWakeOwnership.acquire")(function* (
      nativeThreadId: string,
      owner: object,
      removed: ReadonlyArray<OrchestrationV2PendingBackgroundTask>,
    ) {
      for (const task of removed) {
        if (task.awaited !== true) continue;
        const current = leases.get(nativeThreadId) ?? new Map<string, ClaudeWakeLease>();
        if (current.get(task.taskId)?.owner === owner) continue;
        const lease: ClaudeWakeLease = { nativeThreadId, owner, task, waking: false };
        current.set(task.taskId, lease);
        leases.set(nativeThreadId, current);
        yield* Effect.sleep(CLAUDE_WAKE_OWNERSHIP_TIMEOUT_MS).pipe(
          Effect.andThen(input.onDeadline(lease)),
          Effect.forkIn(input.scope),
        );
      }
    }),
    markWaking: (nativeThreadId: string, owner: object, taskIds: ReadonlyArray<string>) => {
      for (const taskId of taskIds) {
        const lease = leases.get(nativeThreadId)?.get(taskId);
        if (lease?.owner === owner) lease.waking = true;
      }
    },
    consumeWake: (nativeThreadId: string, owner: object, taskIds: ReadonlyArray<string>) => {
      remove(
        nativeThreadId,
        Array.from(leases.get(nativeThreadId)?.values() ?? [])
          .filter(
            (lease) => lease.owner === owner && lease.waking && taskIds.includes(lease.task.taskId),
          )
          .map((lease) => lease.task.taskId),
        owner,
      );
    },
    consumeObserved: (nativeThreadId: string, owner: object, taskId: string) => {
      const lease = leases.get(nativeThreadId)?.get(taskId);
      if (lease?.owner === owner && !lease.waking) remove(nativeThreadId, [taskId], owner);
    },
    consume: remove,
    clear: (nativeThreadId: string) => leases.delete(nativeThreadId),
    expire: (lease: ClaudeWakeLease) => {
      if (leases.get(lease.nativeThreadId)?.get(lease.task.taskId) !== lease || lease.waking)
        return false;
      remove(lease.nativeThreadId, [lease.task.taskId], lease.owner);
      return true;
    },
  };
}
