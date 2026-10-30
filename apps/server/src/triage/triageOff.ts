import { ServerPrepareTriageError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

/**
 * Triage, from `t3 triage` or the command palette, searches and files public issues on
 * pingdotgg/t3code. This fork's bugs are reported privately, so it's off. See FORK.md.
 */
export const TRIAGE_ENABLED = false;

export const TRIAGE_OFF_REASON =
  "it searches and files public issues on pingdotgg/t3code, and this fork's bugs are reported privately";

/** The server's answer to `server.prepareTriage`, from a client that doesn't check `triage`. */
export const refuseTriage = Effect.fail(
  new ServerPrepareTriageError({
    cause: new Error(`Triage is off in this fork: ${TRIAGE_OFF_REASON}.`),
  }),
);
