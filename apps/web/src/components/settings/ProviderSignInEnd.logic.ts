import type { ServerProviderAuth } from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../../i18n/messages";

export const SIGN_IN_WARNING_MS = 5 * 24 * 60 * 60_000;

const endDateFormatter = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });

/** Null when the provider published no end, or already reports the account signed out. */
export function signInEndPresentation(
  auth: Pick<ServerProviderAuth, "status" | "expiresAt">,
  nowMs: number,
  resolve: MessageResolver = m,
): { readonly label: string; readonly warning: boolean } | null {
  const endMs = Date.parse(auth.expiresAt ?? "");
  if (auth.status === "unauthenticated" || !Number.isFinite(endMs)) return null;
  const date = endDateFormatter.format(endMs);
  if (endMs <= nowMs)
    return { label: resolve(msg("Sign-in ended {date}", { date })), warning: true };
  return {
    label: resolve(msg("Signed in until {date}", { date })),
    warning: endMs - nowMs <= SIGN_IN_WARNING_MS,
  };
}
