import { expect, it } from "@effect/vitest";
import { ServerPrepareTriageError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { refuseTriage, TRIAGE_ENABLED } from "./triageOff.ts";

it("keeps triage off", () => {
  expect(TRIAGE_ENABLED).toBe(false);
});

it.effect("refuses an in-app triage request with the reason", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(refuseTriage);
    expect(error).toBeInstanceOf(ServerPrepareTriageError);
    expect(String(error.cause)).toContain("Triage is off in this fork");
  }),
);
