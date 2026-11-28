// fork: limits, see FORK.md. Marks a launch or send from an app on `resourceLimits.typedInApps`, such as a Content
// comment tagging an agent, so its run starts like a message Alice typed in T3.
import type { OrchestrationMessageContext, ServerSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { typedInContext } from "../resourceLimits/policy.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

/**
 * The context for the message this call sends, or undefined. Settings are read only for an outside app's call, and
 * a failed read marks nothing, so the message waits like any agent's.
 */
export const typedInMessageContext = <E, R>(
  scope: McpInvocationScope,
  getSettings: Effect.Effect<ServerSettings, E, R>,
): Effect.Effect<OrchestrationMessageContext | undefined, never, R> =>
  scope.thread !== undefined || scope.client === undefined
    ? Effect.undefined
    : getSettings.pipe(
        Effect.map((settings) => typedInContext(scope, settings.resourceLimits?.typedInApps)),
        Effect.orElseSucceed(() => undefined),
      );
