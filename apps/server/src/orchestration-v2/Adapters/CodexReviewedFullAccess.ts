// fork: full access can send flagged commands to Codex's auto-review instead of running them; see FORK.md.
import type * as CodexSchema from "effect-codex-app-server/schema";

/**
 * Upstream's full access accepts every command Codex flags. This asks instead, and `auto_review`
 * routes the ask to Codex's reviewer. The sandbox stays off, so unflagged commands run as before.
 */
export const CODEX_REVIEWED_FULL_ACCESS_TURN_DEFAULTS = {
  approvalPolicy: {
    granular: {
      sandbox_approval: true,
      rules: true,
      request_permissions: false,
      skill_approval: false,
      // As upstream's full access: connectors' empty elicitations are accepted.
      mcp_elicitations: true,
    },
  },
  approvalsReviewer: "auto_review",
  sandboxPolicy: { type: "dangerFullAccess" },
} as const satisfies {
  readonly approvalPolicy: CodexSchema.V2TurnStartParams__AskForApproval;
  readonly approvalsReviewer: CodexSchema.V2TurnStartParams__ApprovalsReviewer;
  readonly sandboxPolicy: CodexSchema.V2TurnStartParams__SandboxPolicy;
};

const MCP_TOOLS_APPROVE = "approve";

/** The value T3's own inline server table takes, since it can't be overridden by a dotted key. */
export const CODEX_REVIEWED_FULL_ACCESS_T3_SERVER = {
  default_tools_approval_mode: MCP_TOOLS_APPROVE,
} as const;

/**
 * Off `never`, Codex reviews any MCP call not annotated as safe, which the granular flags don't
 * gate. Approving per server keeps connector calls as they are in full access today, unless a
 * server or tool sets its own approval mode, which wins over this default.
 */
export function codexReviewedFullAccessThreadConfig(
  serverNames: ReadonlyArray<string>,
): Readonly<Record<string, string>> {
  const config: Record<string, string> = {
    "apps._default.default_tools_approval_mode": MCP_TOOLS_APPROVE,
  };
  for (const name of serverNames) {
    // T3's servers are inline tables, and a dot would split the config path, so those names stay reviewed.
    if (name === "t3-code" || name === "t3-code-direct" || name.includes(".")) continue;
    config[`mcp_servers.${name}.default_tools_approval_mode`] = MCP_TOOLS_APPROVE;
  }
  return config;
}

/**
 * The servers whose calls skip review, read from the thread's `config/read`, or undefined when the
 * thread doesn't review flagged commands. A failed read names none, so their calls are reviewed.
 */
export function codexUnreviewedMcpServers(
  settings: { readonly reviewFlaggedCommandsInFullAccess?: boolean | undefined },
  runtimePolicy: { readonly runtimeMode: string } | undefined,
  mcpServers: unknown,
): ReadonlyArray<string> | undefined {
  if (
    settings.reviewFlaggedCommandsInFullAccess !== true ||
    runtimePolicy?.runtimeMode !== "full-access"
  ) {
    return undefined;
  }
  return mcpServers !== null && typeof mcpServers === "object" ? Object.keys(mcpServers) : [];
}

type CodexAutoReviewAction =
  CodexSchema.V2ItemGuardianApprovalReviewCompletedNotification["action"];

function describeAutoReviewAction(action: CodexAutoReviewAction): {
  readonly noun: string;
  readonly details: ReadonlyArray<string>;
  readonly retryable: boolean;
} {
  switch (action.type) {
    case "command":
      return {
        noun: "command",
        details: [`Command: ${action.command}`, `Folder: ${action.cwd}`],
        retryable: true,
      };
    case "execve":
      return {
        noun: "command",
        details: [`Command: ${action.argv.join(" ")}`, `Folder: ${action.cwd}`],
        retryable: true,
      };
    case "writeStdin":
      return {
        noun: "terminal input",
        details: [`Input: ${action.stdin.trim()}`, `Folder: ${action.cwd}`],
        retryable: true,
      };
    case "applyPatch":
      return { noun: "file edit", details: [`Files: ${action.files.join(", ")}`], retryable: true };
    case "networkAccess":
      return { noun: "network request", details: [`Target: ${action.target}`], retryable: true };
    case "mcpToolCall":
      return {
        noun: "tool call",
        details: [`Tool: ${action.server} / ${action.toolName}`],
        retryable: true,
      };
    case "requestPermissions":
      return {
        noun: "permission request",
        details: action.reason ? [`Reason: ${action.reason}`] : [],
        retryable: false,
      };
    default:
      return { noun: "action", details: [], retryable: false };
  }
}

/**
 * What to show when auto-review stops something. Only `denied` and `timedOut` stop an action the
 * thread still wanted; `aborted` follows the thread being interrupted.
 */
export function codexAutoReviewNotice(
  payload: Pick<CodexSchema.V2ItemGuardianApprovalReviewCompletedNotification, "action" | "review">,
): { readonly title: string; readonly message: string } | undefined {
  const { review } = payload;
  if (review.status !== "denied" && review.status !== "timedOut") return undefined;
  const { noun, details, retryable } = describeAutoReviewAction(payload.action);
  const title =
    review.status === "denied"
      ? `Auto-review blocked a ${noun}`
      : `Auto-review timed out on a ${noun}`;
  const risk = review.riskLevel ? ` (${review.riskLevel} risk)` : "";
  const reason = review.rationale?.trim();
  return {
    title,
    message: [
      `${title}${risk}${review.status === "timedOut" ? ", so it didn't run." : "."}`,
      ...details,
      ...(reason ? [`Why: ${reason}`] : []),
      ...(retryable
        ? [
            `To try it anyway, reply in this thread approving this exact ${noun}. The reviewer reads that reply and decides again.`,
          ]
        : []),
    ].join("\n"),
  };
}
