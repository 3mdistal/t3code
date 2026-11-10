import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";

import { decodeEnvironment, decodeListScope } from "./thread.ts";

it.effect("--environment names the linked environment a send goes to", () =>
  Effect.gen(function* () {
    assert.strictEqual(yield* decodeEnvironment(Option.none(), false), undefined);
    assert.strictEqual(yield* decodeEnvironment(Option.none(), true), undefined);
    assert.strictEqual(yield* decodeEnvironment(Option.some(" env-mac "), false), "env-mac");
  }),
);

it.effect("--environment refuses --wait and an empty id", () =>
  Effect.gen(function* () {
    for (const [value, wait] of [
      ["env-mac", true],
      ["   ", false],
    ] as const) {
      const exit = yield* Effect.exit(decodeEnvironment(Option.some(value), wait));
      assert.isTrue(Exit.isFailure(exit), value);
    }
  }),
);

// Widened so the expected objects can spell the branded environment id as a string.
const listScope = (project?: string, environment?: string) =>
  decodeListScope(Option.fromUndefinedOr(project), Option.fromUndefinedOr(environment)).pipe(
    Effect.map((scope): unknown => scope),
  );

it.effect("list --environment covers all of a linked machine's projects unless one is named", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* listScope(), { kind: "local", project: "." });
    assert.deepStrictEqual(yield* listScope("proj-pc"), { kind: "local", project: "proj-pc" });
    assert.deepStrictEqual(yield* listScope(undefined, " env-mac "), {
      kind: "linked",
      environmentId: "env-mac",
      projectId: undefined,
    });
    assert.deepStrictEqual(yield* listScope(" proj-mac ", "env-mac"), {
      kind: "linked",
      environmentId: "env-mac",
      projectId: "proj-mac",
    });
  }),
);

it.effect("list --environment refuses an empty id", () =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(listScope(undefined, "   "));
    assert.isTrue(Exit.isFailure(exit));
  }),
);
