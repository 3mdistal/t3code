import type { ServerProviderAuth } from "@t3tools/contracts";
import { useMessages } from "gt-react";

import { useDeadlinePassed, useNowAfter } from "../../hooks/useDeadline";
import { cn } from "../../lib/utils";
import { SIGN_IN_WARNING_MS, signInEndPresentation } from "./ProviderSignInEnd.logic";

/** The server publishes the end once, so this reads the clock to turn to a warning and then to ended. */
export function ProviderSignInEnd({
  auth,
  className,
  separator = "",
}: {
  readonly auth: ServerProviderAuth | undefined;
  readonly className?: string;
  readonly separator?: string;
}) {
  const messages = useMessages();
  const endMs = Date.parse(auth?.expiresAt ?? "");
  const warnFromMs = Number.isFinite(endMs) ? endMs - SIGN_IN_WARNING_MS : null;
  const warned = useDeadlinePassed(warnFromMs);
  const nowMs = useNowAfter(warnFromMs === null ? null : warned ? endMs : warnFromMs);
  const presentation = auth ? signInEndPresentation(auth, nowMs, messages) : null;
  if (presentation === null) return null;
  return (
    <span
      className={cn(
        className,
        presentation.warning ? "text-warning-foreground" : "text-muted-foreground",
      )}
    >
      {separator}
      {presentation.label}
    </span>
  );
}
