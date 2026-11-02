// @effect-diagnostics nodeBuiltinImport:off - Matches the by-path stat the ownership lock check uses.
import * as NodeFS from "node:fs";

import * as Effect from "effect/Effect";

/**
 * fork: the ownership lock check's stat, off the event loop. See FORK.md.
 *
 * Resolves like `statSync(path, { bigint: true, throwIfNoEntry: false })`: the stats, `undefined`
 * when nothing is at the path, or the error code for anything else.
 */
export const statOwnershipLockOffEventLoop = (
  lockPath: string,
): Effect.Effect<NodeFS.BigIntStats | string | undefined> =>
  Effect.promise(() =>
    NodeFS.promises.stat(lockPath, { bigint: true }).then(
      (stats): NodeFS.BigIntStats | string | undefined => stats,
      (cause: unknown) => {
        const code = cause instanceof Error && "code" in cause ? String(cause.code) : "unknown";
        return code === "ENOENT" || code === "ENOTDIR" ? undefined : code;
      },
    ),
  );
