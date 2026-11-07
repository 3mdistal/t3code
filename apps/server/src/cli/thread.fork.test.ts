import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";

import { decodeEnvironment } from "./thread.ts";

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
