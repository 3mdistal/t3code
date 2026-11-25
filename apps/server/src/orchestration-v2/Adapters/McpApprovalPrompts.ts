// fork: Auto and Full access answer an MCP server's own approval prompt; see FORK.md.
import type { RuntimeMode } from "@t3tools/contracts";

/**
 * Whether this mode answers an MCP server's approval prompt itself instead of showing a card. The
 * thread's mode already let the call run; the answer only picks an approve-style option.
 */
export const runtimeModeAnswersMcpApprovals = (runtimeMode: RuntimeMode): boolean =>
  runtimeMode === "auto" || runtimeMode === "full-access";
