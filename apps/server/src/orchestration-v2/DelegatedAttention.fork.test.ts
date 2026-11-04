import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderSessionId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as DelegatedTaskQuestionReactor from "./DelegatedTaskQuestionReactor.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";

import { attentionTestLayer, modelSelection } from "./testkit/DelegatedAttention.fork.testkit.ts";

it.effect.each(["approval", "question", "wake"] as const)(
  "delivers a delegated child's %s to its parent before completion",
  (kind) =>
    Effect.gen(function* () {
      const engine = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const reactor = yield* DelegatedTaskQuestionReactor.DelegatedTaskQuestionReactor;
      const parent = ThreadId.make("fork-attention-parent");
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-parent"),
        threadId: parent,
        projectId: ProjectId.make("fork-attention-project"),
        title: "Coordinator",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* engine.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("start-parent"),
        threadId: parent,
        messageId: MessageId.make("parent-work"),
        text: "Delegate a task",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      const parentRun = (yield* engine.getThreadProjection(parent)).runs[0]!;
      yield* engine.dispatch({
        type: "delegated_task.request",
        commandId: CommandId.make("delegate"),
        parentThreadId: parent,
        parentRunId: parentRun.id,
        parentNodeId: parentRun.rootNodeId!,
        task: "Do the work",
        completionWake: "always",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdBy: "agent",
        creationSource: "mcp",
      });
      const task = (yield* engine.getThreadProjection(parent)).subagents[0]!;
      const childId = task.childThreadId!;
      const child = yield* engine.getThreadProjection(childId);
      const run = child.runs[0]!;
      const now = yield* DateTime.now;
      const requestId = RuntimeRequestId.make("fork-child-request");
      const event: OrchestrationV2DomainEvent =
        kind === "wake"
          ? {
              id: EventId.make("child-notice"),
              type: "turn-item.updated",
              threadId: childId,
              runId: run.id,
              occurredAt: now,
              payload: {
                id: TurnItemId.make("fork-child-wake-notice"),
                threadId: childId,
                runId: run.id,
                nodeId: run.rootNodeId!,
                providerThreadId: null,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 3,
                type: "system_notice",
                status: "completed",
                title: "Background wake cancelled",
                message: "The session was released after its idle pin budget expired.",
                startedAt: now,
                completedAt: now,
                updatedAt: now,
              },
            }
          : {
              id: EventId.make("child-request"),
              type: "runtime-request.updated",
              threadId: childId,
              runId: run.id,
              occurredAt: now,
              payload: {
                id: requestId,
                nodeId: run.rootNodeId!,
                providerTurnId: null,
                nativeRequestRef: null,
                kind: kind === "question" ? "user_input" : "command",
                status: "pending",
                responseCapability: {
                  type: "live",
                  providerSessionId: ProviderSessionId.make("fixture-session"),
                },
                createdAt: now,
                resolvedAt: null,
              },
            };
      yield* sink.write({ events: [event] });
      yield* reactor.handle(event);
      yield* reactor.handle(event);
      const after = yield* engine.getThreadProjection(parent);
      const notifications = after.messages.filter(
        (m) => m.notification?.source.kind === "delegated_task",
      );
      assert.lengthOf(notifications, 1);
      assert.equal(notifications[0]!.notification?.outcome, "updated");
      if (kind === "approval") {
        assert.include(notifications[0]!.text, "user");
        assert.notInclude(notifications[0]!.text, "action respond");
      }
      assert.equal(after.runs[0]!.status, "starting");
      assert.equal((yield* engine.getThreadProjection(childId)).runs[0]!.status, "starting");
      if (kind !== "wake")
        assert.equal(
          (yield* engine.getThreadProjection(childId)).runtimeRequests[0]!.status,
          "pending",
        );
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const input = {
        projectId: child.thread.projectId,
        threadId: childId,
        runId: run.id,
        timeoutMs: 1,
        seenAttentionIds: [],
      };
      const waiting = yield* threads
        .waitForThread(input)
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* TestClock.adjust(1);
      const result = yield* Fiber.join(waiting);
      assert.isFalse(result.timedOut);
      assert.equal(result.attention?.[0]?.kind, kind === "wake" ? "wake_cancelled" : kind);
      if (kind === "approval" && event.type === "runtime-request.updated") {
        const queued = after.runs.find((run) => run.userMessageId === notifications[0]!.id)!;
        assert.equal(queued.status, "queued");
        const resolved: OrchestrationV2DomainEvent = {
          ...event,
          id: EventId.make("child-request-resolved"),
          payload: { ...event.payload, status: "resolved", resolvedAt: now },
        };
        yield* sink.write({ events: [resolved] });
        yield* reactor.handle(resolved);
        const cleared = yield* engine.getThreadProjection(parent);
        assert.equal(cleared.runs.find((run) => run.id === queued.id)!.status, "cancelled");
        assert.equal(cleared.runs[0]!.status, "starting");
        const seen = yield* threads
          .waitForThread({ ...input, seenAttentionIds: [requestId] })
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* TestClock.adjust(1);
        assert.isTrue((yield* Fiber.join(seen)).timedOut);
      }
    }).pipe(Effect.provide(attentionTestLayer), Effect.scoped),
);
