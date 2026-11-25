import { assert, describe, it } from "@effect/vitest";
import { toMcpElicitationResponse } from "../../provider/CodexMcpElicitation.ts";
import { claudeMcpElicitationAcceptance } from "./ClaudeAdapterV2.ts";
import { runtimeModeAnswersMcpApprovals } from "./McpApprovalPrompts.ts";

describe("MCP approval prompts", () => {
  it("are answered by Auto and Full access, and shown to a person in the other modes", () => {
    assert.deepEqual(
      (["approval-required", "auto-accept-edits", "auto", "full-access"] as const).map((mode) => [
        mode,
        runtimeModeAnswersMcpApprovals(mode),
      ]),
      [
        ["approval-required", false],
        ["auto-accept-edits", false],
        ["auto", true],
        ["full-access", true],
      ],
    );
  });

  // The form an Agent-Native app sends before an action that needs approval.
  const agentNative = {
    serverName: "mail-beta",
    message: 'Action "mark-sent" requires your approval before it can run.',
    mode: "form" as const,
    requestedSchema: {
      type: "object",
      properties: { decision: { type: "string", enum: ["approve", "deny"] } },
      required: ["decision"],
    },
  };

  it("approve an Agent-Native action, for Claude and Codex alike", () => {
    const approved = { action: "accept", content: { decision: "approve" } } as const;
    assert.deepEqual(claudeMcpElicitationAcceptance(agentNative), approved);
    assert.deepEqual(toMcpElicitationResponse(agentNative, "accept"), approved);
  });
});
