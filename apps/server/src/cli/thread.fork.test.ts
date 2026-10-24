import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { decodeModelOptions } from "./thread.ts";

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
