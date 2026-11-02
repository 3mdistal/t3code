import { vi } from "vite-plus/test";

// fork: reruns upstream's client tests with the writer on its worker, so the two paths can't drift.
// In-memory databases stay on the main thread. See FORK.md.
vi.mock("./nodeSqliteClient.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./nodeSqliteClient.ts")>();
  return {
    ...actual,
    layer: (config: Parameters<typeof actual.layer>[0]) =>
      actual.layer({ ...config, writerWorker: true }),
  };
});

await import("./nodeSqliteClient.test.ts");
