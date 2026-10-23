import { PullRequestOperationError, PullRequestUnavailableError } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { createNativeReviewDiffSourceLoader } from "./nativeReviewDiffSource";
import type { NativeReviewDiffSource } from "./nativeReviewDiffTypes";

const SOURCE = { oldContents: "const before = true;", newContents: "const after = false;" };

vi.mock("expo-file-system", () => ({
  Paths: { document: "test-documents" },
  File: class {
    create() {}
    async write() {}
  },
}));

it("fetches lazily and shares pending and completed source requests", async () => {
  const started = Promise.withResolvers<void>();
  const response = Promise.withResolvers<NativeReviewDiffSource>();
  const fetch = vi.fn(() => {
    started.resolve();
    return response.promise;
  });
  const load = createNativeReviewDiffSourceLoader(fetch);
  expect(fetch).not.toHaveBeenCalled();
  const first = load("source.ts");
  const second = load("source.ts");
  await started.promise;
  expect(fetch).toHaveBeenCalledTimes(1);
  response.resolve(SOURCE);
  expect(await first).toBe(SOURCE);
  expect(await second).toBe(SOURCE);
  expect(await load("source.ts")).toBe(SOURCE);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("keeps at most four recently used files", async () => {
  const fetch = vi.fn(async (_file: string) => SOURCE);
  const load = createNativeReviewDiffSourceLoader(fetch);
  for (const file of ["one", "two", "three", "four", "one", "five", "one", "two"]) {
    await load(file);
  }
  expect(fetch.mock.calls).toEqual([["one"], ["two"], ["three"], ["four"], ["five"], ["two"]]);
});

it("does not retain oversized source text or repeatedly refetch it", async () => {
  const fetch = vi.fn(async () => ({ oldContents: "", newContents: "x".repeat(500_001) }));
  const load = createNativeReviewDiffSourceLoader(fetch);
  expect(await load("generated.ts")).toBeNull();
  expect(await load("generated.ts")).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("lets later viewport requests retry a failed source fetch", async () => {
  const fetch = vi.fn().mockRejectedValueOnce(new Error("Offline")).mockResolvedValueOnce(SOURCE);
  const load = createNativeReviewDiffSourceLoader(fetch);
  await expect(load("retry.ts")).rejects.toThrow("Offline");
  expect(await load("retry.ts")).toBe(SOURCE);
});

it("cancels a viewport immediately while sharing its already sent RPC with a later viewport", async () => {
  const started = Promise.withResolvers<void>();
  const response = Promise.withResolvers<NativeReviewDiffSource>();
  const fetch = vi.fn(() => {
    started.resolve();
    return response.promise;
  });
  const load = createNativeReviewDiffSourceLoader(fetch);
  const controller = new AbortController();
  const first = load("active.ts", controller.signal);
  await started.promise;
  controller.abort();
  expect(await first).toBeNull();
  const second = load("active.ts");
  response.resolve(SOURCE);
  expect(await second).toBe(SOURCE);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("serializes RPCs and drops cancelled queued files", async () => {
  const started = Promise.withResolvers<void>();
  const response = Promise.withResolvers<NativeReviewDiffSource>();
  const fetch = vi.fn((file: string) => {
    if (file !== "active.ts") return Promise.resolve(SOURCE);
    started.resolve();
    return response.promise;
  });
  const load = createNativeReviewDiffSourceLoader(fetch);
  const active = load("active.ts");
  await started.promise;
  const controller = new AbortController();
  const queued = load("cancelled.ts", controller.signal);
  controller.abort();
  expect(await queued).toBeNull();
  expect(fetch.mock.calls).toEqual([["active.ts"]]);
  response.resolve(SOURCE);
  await active;
  await load("next.ts");
  expect(fetch.mock.calls).toEqual([["active.ts"], ["next.ts"]]);
});

it("caches permanent unavailable failures even after successful sources are evicted", async () => {
  const fetch = vi.fn(async (file: string) => {
    if (file === "unsupported")
      throw new PullRequestUnavailableError({ reason: "provider-unsupported" });
    if (file === "old-server")
      throw new PullRequestOperationError({
        operation: "diffFileContents",
        detail: "This host cannot expand unchanged pull request lines.",
      });
    if (file === "oversized") throw { cause: { reason: "oversized" } };
    return SOURCE;
  });
  const load = createNativeReviewDiffSourceLoader(fetch);
  for (const file of ["unsupported", "old-server", "oversized"]) {
    expect(await load(file)).toBeNull();
  }
  for (const file of ["one", "two", "three", "four", "five"]) await load(file);
  for (const file of ["unsupported", "old-server", "oversized"]) {
    expect(await load(file)).toBeNull();
    expect(fetch.mock.calls.filter(([id]) => id === file)).toHaveLength(1);
  }
});

it("bounds transient failures to one retry on a future request", async () => {
  const fetch = vi.fn(async () => {
    throw new Error("Offline");
  });
  const load = createNativeReviewDiffSourceLoader(fetch);
  await expect(load("offline")).rejects.toThrow("Offline");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(await load("offline")).toBeNull();
  expect(await load("offline")).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("caches permanent source errors after the RPC has erased their custom reason fields", async () => {
  const codec = Schema.fromJsonString(PullRequestOperationError);
  const encode = Schema.encodeSync(codec);
  const decode = Schema.decodeUnknownSync(codec);
  for (const name of [
    "GitCafeDiffSourceUnavailableError",
    "GitHubDiffFileContentsUnavailableError",
  ]) {
    const sourceError = Object.assign(new Error("Source unavailable"), {
      name,
      reason: "oversized",
    });
    const error = decode(
      encode(
        new PullRequestOperationError({
          operation: "diffFileContents",
          detail: "Source unavailable",
          cause: new Error("Provider failed", { cause: sourceError }),
        }),
      ),
    );
    const fetch = vi.fn(async () => {
      throw error;
    });
    const load = createNativeReviewDiffSourceLoader(fetch);
    expect(await load("generated.ts")).toBeNull();
    expect(await load("generated.ts")).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  }
});

it("traces source lifecycle counts without source, file paths, or error messages", async () => {
  using warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubEnv("EXPO_PUBLIC_T3_DIFF_TRACE", "1");
  try {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("private RPC detail"))
      .mockResolvedValueOnce(SOURCE);
    const load = createNativeReviewDiffSourceLoader(fetch);
    await expect(load("private/file.ts")).rejects.toThrow("private RPC detail");
    await load("private/file.ts");
    await load("private/file.ts");
    const events = warning.mock.calls.map(([line]) =>
      JSON.parse(String(line).replace("[diff-highlight-trace] ", "")),
    );
    expect(events.map(({ event }) => event)).toEqual([
      "source-queued",
      "source-start",
      "source-error",
      "source-queued",
      "source-start",
      "source-result",
      "source-cache",
    ]);
    expect(events[2]).toMatchObject({ attempt: 1, permanent: false });
    expect(events[5]).toMatchObject({
      oldCharacters: SOURCE.oldContents.length,
      newCharacters: SOURCE.newContents.length,
    });
    const output = JSON.stringify(warning.mock.calls);
    for (const secret of ["private", SOURCE.oldContents, SOURCE.newContents])
      expect(output).not.toContain(secret);
  } finally {
    vi.unstubAllEnvs();
  }
});
