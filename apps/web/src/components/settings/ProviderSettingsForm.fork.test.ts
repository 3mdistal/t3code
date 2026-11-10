// fork: the reviewed full access setting is a switch on the Codex provider card; see FORK.md.
import { CodexSettings } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveProviderSettingsFields,
  nextProviderConfigWithFieldValue,
} from "./ProviderSettingsForm";

describe("Codex provider settings", () => {
  it("offers reviewing flagged commands in full access as a switch that starts on", () => {
    const field = deriveProviderSettingsFields({ settingsSchema: CodexSettings }).find(
      ({ key }) => key === "reviewFlaggedCommandsInFullAccess",
    );

    expect(field).toMatchObject({
      control: "switch",
      label: "Review flagged commands in full access",
      defaultBooleanValue: true,
    });
    if (field === undefined) throw new Error("Missing field");
    expect(nextProviderConfigWithFieldValue({}, field, false)).toEqual({
      reviewFlaggedCommandsInFullAccess: false,
    });
    expect(
      nextProviderConfigWithFieldValue({ reviewFlaggedCommandsInFullAccess: false }, field, true),
    ).toBeUndefined();
  });
});
