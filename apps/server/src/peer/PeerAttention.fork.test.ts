import { NodeHttpServer } from "@effect/platform-node";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import { Toolkit } from "effect/ai";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import { OrchestratorToolkit } from "../mcp/toolkits/orchestrator/tools.ts";
import * as OrchestratorMcpService from "../mcp/OrchestratorMcpService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as PeerForwarding from "./PeerForwarding.ts";
import * as PeerLinks from "./PeerLinks.ts";
import { descriptorOf, layerLinkingEnvironment, linkTo, servePeer } from "./PeerLinks.testkit.ts";
import type { OrchestratorMcpThreadWaitInput } from "@t3tools/contracts";

it.effect(
  "carries attention acknowledgements and results through a real authenticated peer call",
  () =>
    Effect.gen(function* () {
      const here = descriptorOf("fixture-attention-here", "Here");
      const there = descriptorOf("fixture-attention-there", "There");
      const child = ThreadId.make("fixture-peer-child");
      const parent = ThreadId.make("fixture-peer-parent");
      const requests = yield* Queue.unbounded<OrchestratorMcpThreadWaitInput>();
      const toolkit = Toolkit.make(OrchestratorToolkit.tools.t3_thread_wait);
      const handlers = McpToolAccess.toLayer(toolkit, {
        t3_thread_wait: McpToolAccess.reads((input) =>
          Queue.offer(requests, input).pipe(
            Effect.as({
              threadId: child,
              runId: RunId.make("fixture-peer-run"),
              status: "running" as const,
              timedOut: false,
              attention: [
                { id: "new-request", kind: "approval" as const, summary: "Approval needed." },
              ],
            }),
          ),
        ),
      });
      const peer = yield* servePeer(
        there,
        McpHttpServer.toolkitRegistration(toolkit, handlers).pipe(
          Layer.provide(Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({})),
          Layer.provide(Layer.mock(ThreadManagement.ThreadManagementService)({})),
        ),
      );
      const local = yield* Layer.build(
        PeerForwarding.layer.pipe(
          Layer.provideMerge(layerLinkingEnvironment(here)),
          Layer.provide(
            Layer.mock(ThreadManagement.ThreadManagementService)({
              getThreadShell: () =>
                Effect.succeed(liveThreadShell(parent, { runtimeMode: "full-access" })),
            }),
          ),
          Layer.provide(NodeCrypto.layer),
        ),
      );
      yield* linkTo(Context.get(local, PeerLinks.PeerLinks), peer, "full-access");
      const result = yield* Context.get(local, PeerForwarding.PeerForwarding).waitForThread(
        {
          environmentId: here.environmentId,
          requestNamespace: "fixture-peer-parent",
          thread: {
            threadId: parent,
            providerSessionId: "fixture-peer-session",
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
          client: undefined,
          capabilities: new Set(["orchestration"]),
          issuedAt: 0,
        },
        there.environmentId,
        {
          threadId: child,
          timeoutMs: 1,
          untilDelegatedWorkSettled: true,
          seenAttentionIds: ["prior-request"],
        },
      );
      assert.deepEqual((yield* Queue.take(requests)).seenAttentionIds, ["prior-request"]);
      assert.deepEqual(result.attention, [
        { id: "new-request", kind: "approval", summary: "Approval needed." },
      ]);
      assert.isFalse(result.timedOut);
    }).pipe(Effect.provide(NodeHttpServer.layerTest), Effect.scoped),
);
