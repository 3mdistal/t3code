import { AuthOrchestrationOperateScope, EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import { Atom, AtomRegistry } from "effect/reactivity";

import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { PrimaryConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import { createCommandPermissions } from "./commandPermissions.ts";
import { createEnvironmentSessionAtoms } from "./session.ts";

it.effect.each(["failure", "timeout"] as const)(
  "recovers sending after a permission load %s without refreshing or remounting",
  (failure) =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("permission-recovery");
      const prepared = yield* SubscriptionRef.make(
        Option.some<PreparedConnection>({
          environmentId,
          label: "Recovery fixture",
          httpBaseUrl: "http://fixture.test",
          socketUrl: "ws://fixture.test/ws",
          httpAuthorization: null,
          target: new PrimaryConnectionTarget({
            environmentId,
            label: "Fixture",
            httpBaseUrl: "http://fixture.test",
            wsBaseUrl: "ws://fixture.test",
          }),
        }),
      );
      const supervisor = { prepared } as EnvironmentSupervisor["Service"];
      const environments = {
        followStream: (_id, stream) =>
          Stream.provideService(stream, EnvironmentSupervisor, supervisor),
      } as EnvironmentRegistry["Service"];
      const firstAttempt = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      let requests = 0;
      const client = HttpClient.make((request) =>
        Effect.gen(function* () {
          requests++;
          if (requests === 1) {
            yield* Deferred.succeed(firstAttempt, undefined);
            if (failure === "timeout") return yield* Effect.never;
            yield* Deferred.await(releaseFirst);
            return HttpClientResponse.fromWeb(
              request,
              new Response("unavailable", { status: 503 }),
            );
          }
          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              authenticated: true,
              auth: {
                policy: "remote-reachable",
                bootstrapMethods: [],
                sessionMethods: [],
                sessionCookieName: "test",
              },
              scopes: [AuthOrchestrationOperateScope],
              permissions: [AuthOrchestrationOperateScope],
            }),
          );
        }),
      );
      const runtime = Atom.runtime(
        Layer.mergeAll(
          Layer.succeed(EnvironmentRegistry, environments),
          Layer.succeed(HttpClient.HttpClient, client),
          Layer.succeed(Clock.Clock, yield* Clock.Clock),
        ),
      );
      const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
        Effect.sync(() => registry.dispose()),
      );
      const command = createCommandPermissions(runtime, WS_METHODS.scheduledTasksDelete);
      const permission = command.permissionAtom(environmentId);
      yield* Effect.acquireRelease(
        Effect.sync(() => registry.mount(permission)),
        (unmount) => Effect.sync(unmount),
      );
      expect(registry.get(permission)).toBe(false);
      yield* Deferred.await(firstAttempt);
      yield* Deferred.succeed(releaseFirst, undefined);
      yield* TestClock.adjust(failure === "timeout" ? 7_000 : 1_000);
      expect(requests).toBe(2);
      yield* AtomRegistry.getResult(
        registry,
        createEnvironmentSessionAtoms(runtime).sessionStateAtom(environmentId),
      );
      expect(registry.get(permission)).toBe(true);
      yield* command.authorize(registry, environmentId);
    }).pipe(Effect.scoped),
);
