// fork: Auto and Full access answer an MCP server's own approval prompt; see FORK.md.
import type { RuntimeMode } from "@t3tools/contracts";

/**
 * Whether a thread in this mode answers an MCP server's approval prompt itself instead of showing
 * a card. A server such as an Agent-Native app asks the client to approve a call the thread's mode
 * has already let run. Auto and Full access run routine actions without a person, so the prompt
 * gets the same answer the call did. The answer only picks an approve-style option the prompt
 * offers; a prompt for a value or a URL visit is still cancelled.
 */
export const runtimeModeAnswersMcpApprovals = (runtimeMode: RuntimeMode): boolean =>
  runtimeMode === "auto" || runtimeMode === "full-access";
