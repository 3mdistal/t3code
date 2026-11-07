import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";

import { decodeEnvironment, decodeModelOptions } from "./thread.ts";

it.effect("--option reads id=value pairs with boolean values as booleans", () =>
  Effect.gen(function* () {
    const options = yield* decodeModelOptions(["effort=xhigh", "fastMode=false", " a = b=c "]);
    assert.deepStrictEqual(options, [
      { id: "effort", value: "xhigh" },
      { id: "fastMode", value: false },
      { id: "a", value: "b=c" },
    ]);
  }),
);

it.effect("--option rejects entries without an id or a value", () =>
  Effect.gen(function* () {
    for (const entry of ["effort", "=xhigh", "effort="]) {
      const exit = yield* Effect.exit(decodeModelOptions([entry]));
      assert.isTrue(Exit.isFailure(exit), entry);
    }
  }),
);

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
