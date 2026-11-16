import { describe, expect, it } from "vite-plus/test";

import { signInEndPresentation } from "./ProviderSignInEnd.logic";

const endsAt = "2026-12-16T12:00:00.000Z";
const endMs = Date.parse(endsAt);
const days = (count: number) => count * 24 * 60 * 60_000;

describe("signInEndPresentation", () => {
  it("warns from five days before the sign-in ends", () => {
    const at = (nowMs: number) =>
      signInEndPresentation({ status: "authenticated", expiresAt: endsAt }, nowMs);
    expect(at(endMs - days(5) - 1)).toEqual({ label: "Signed in until Dec 16", warning: false });
    expect(at(endMs - days(5))).toEqual({ label: "Signed in until Dec 16", warning: true });
    expect(at(endMs)).toEqual({ label: "Sign-in ended Dec 16", warning: true });
  });

  it("leaves a signed-out account and an unknown end to the status line", () => {
    expect(signInEndPresentation({ status: "unauthenticated", expiresAt: endsAt }, 0)).toBeNull();
    expect(signInEndPresentation({ status: "authenticated" }, 0)).toBeNull();
  });
});
