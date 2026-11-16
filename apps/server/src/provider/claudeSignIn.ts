import { spawnAndCollect } from "@t3tools/provider-core/server/snapshotProbe";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess } from "effect/process";

const decodeCredentials = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      claudeAiOauth: Schema.optional(
        Schema.Struct({ refreshTokenExpiresAt: Schema.optional(Schema.Number) }),
      ),
    }),
  ),
);

/** Claude Code's login JSON keeps the end of the sign-in as epoch ms beside the tokens. */
export function claudeSignInExpiresAt(credentialsJson: string): string | undefined {
  const endMs = Option.getOrUndefined(decodeCredentials(credentialsJson))?.claudeAiOauth
    ?.refreshTokenExpiresAt;
  if (endMs === undefined || endMs <= 0) return undefined;
  return Option.getOrUndefined(Option.map(DateTime.make(endMs), DateTime.formatIso));
}

const KEYCHAIN_ITEM_NOT_FOUND = 44;
const KEYCHAIN_ACCOUNT = /^[a-zA-Z0-9._-]+$/;

/** Claude Code's own Keychain lookup, so the read gets the access Claude Code has and asks for none. */
const keychainItem = Effect.fn("claudeSignIn.keychainItem")(function* (
  environment: NodeJS.ProcessEnv,
) {
  const digest = yield* Digest.Digest;
  const configDir = environment.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? environment.CLAUDE_CONFIG_DIR;
  const suffix = configDir
    ? `-${Hex.encode(yield* digest.digest(Digest.sha256, new TextEncoder().encode(configDir.normalize("NFC")))).slice(0, 8)}`
    : "";
  const user = environment.USER || (yield* HostProcess.Username) || "";
  return {
    service: `Claude Code-credentials${suffix}`,
    account: KEYCHAIN_ACCOUNT.test(user) ? user : "claude-code-user",
  };
});

/**
 * When this config directory's Claude login ends, or undefined when that can't be read. On macOS
 * the login is in the Keychain, and Claude Code reads the file only when the Keychain has no item.
 */
export const readClaudeSignInExpiresAt = Effect.fn("readClaudeSignInExpiresAt")(
  function* (input: { readonly configDir: string; readonly environment: NodeJS.ProcessEnv }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const readFile = fs
      .readFileString(path.join(input.configDir, ".credentials.json"))
      .pipe(Effect.map(claudeSignInExpiresAt));
    if ((yield* HostProcess.Platform) !== "darwin") return yield* readFile;
    const { service, account } = yield* keychainItem(input.environment);
    const result = yield* spawnAndCollect(
      "security",
      ChildProcess.make("/usr/bin/security", [
        "find-generic-password",
        "-a",
        account,
        "-w",
        "-s",
        service,
      ]),
    );
    if (result.code === KEYCHAIN_ITEM_NOT_FOUND) return yield* readFile;
    return result.code === 0 ? claudeSignInExpiresAt(result.stdout.trim()) : undefined;
  },
  Effect.timeout("5 seconds"),
  Effect.orElseSucceed(() => undefined),
);
