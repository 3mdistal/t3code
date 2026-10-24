import * as Scheduler from "../scheduling/Scheduler.ts";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProviderPoolCatalog } from "../orchestration-v2/ProviderPoolCatalog.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

it.effect("saves a task that names a pool on the pool's first account", () =>
  Effect.gen(function* () {
    const claude = ProviderDriverKind.make("claudeAgent");
    const account = (instanceId: string, pool: ServerProvider["pool"]): ServerProvider => ({
      instanceId: ProviderInstanceId.make(instanceId),
      driver: claude,
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-10-24T00:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
      pool,
    });
    const poolId = ProviderInstanceId.make("pool_claudeAgent");
    const member = { role: "member" as const, poolInstanceId: poolId };
    const providers = [
      account("claudeAgent_work", member),
      account("claudeAgent", member),
      account("pool_claudeAgent", {
        role: "pool",
        memberInstanceIds: [
          ProviderInstanceId.make("claudeAgent_work"),
          ProviderInstanceId.make("claudeAgent"),
        ],
        droppedModels: [],
      }),
    ];
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
          Layer.mock(ThreadManagementService.ThreadManagementService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            isScratchProject: () => Effect.succeed(false),
          }),
          Layer.succeed(ProviderPoolCatalog)({
            getPublishedProviders: Effect.succeed(providers),
            markLimited: () => Effect.void,
          }),
          NodeCrypto.layer,
          Scheduler.layer,
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const { task } = yield* service.upsert({
        title: "Daily review",
        prompt: "Review open PRs",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: ProjectId.make("project:test"),
        workspaceStrategy: { type: "root" },
        modelSelection: {
          instanceId: poolId,
          model: "claude-opus-4-8",
          options: [{ id: "effort", value: "xhigh" }],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      const stored = {
        instanceId: ProviderInstanceId.make("claudeAgent_work"),
        model: "claude-opus-4-8",
        options: [{ id: "effort", value: "xhigh" }],
      };
      assert.deepEqual(task.modelSelection, stored);
      assert.deepEqual((yield* service.list()).tasks[0]?.modelSelection, stored);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
