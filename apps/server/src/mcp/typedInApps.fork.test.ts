// fork: limits. A launch or send from an app on `typedInApps` carries the mark that starts it like Alice's typing.
import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, type ServerSettings, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { typedInMessageContext } from "./typedInApps.ts";

const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:typed-in"),
  requestNamespace: "client:content",
  thread: undefined,
  client: { sessionId: "session:content", label: "Content", access: "full-access" },
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

const settings = (typedInApps?: ReadonlyArray<string>) =>
  Effect.succeed({
    resourceLimits: typedInApps === undefined ? {} : { typedInApps },
  } as ServerSettings);

describe("typedInMessageContext", () => {
  it.effect("marks a call from a listed app", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* typedInMessageContext(scope, settings(["content"])), {
        version: 1,
        records: [],
        typedIn: { app: "Content" },
      });
    }),
  );

  it.effect("marks nothing when the list is unset, or the settings can't be read", () =>
    Effect.gen(function* () {
      assert.isUndefined(yield* typedInMessageContext(scope, settings()));
      assert.isUndefined(yield* typedInMessageContext(scope, Effect.fail("unreadable")));
    }),
  );

  it.effect("never reads the settings for an agent's own thread", () =>
    Effect.gen(function* () {
      const agent: McpInvocationScope = {
        ...scope,
        thread: {
          threadId: ThreadId.make("thread:agent"),
          providerSessionId: "provider-session:agent",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
      };
      assert.isUndefined(yield* typedInMessageContext(agent, Effect.die("read the settings")));
    }),
  );
});
