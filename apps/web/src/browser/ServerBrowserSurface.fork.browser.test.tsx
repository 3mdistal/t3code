import { EnvironmentId } from "@t3tools/contracts";
import type { PreviewStreamEvents } from "@t3tools/client-runtime/preview/server-browser-stream";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn<(target: unknown, handlers: PreviewStreamEvents) => unknown>(),
  access: { url: "ws://preview.test", token: "test" },
  painted: null as (() => void) | null,
}));

vi.mock(import("@t3tools/client-runtime/preview/server-browser-stream"), async (original) => ({
  ...(await original()),
  createPreviewStreamClient: mocks.createClient as never,
  createPreviewFramePainter: (_canvas, onPainted) => {
    mocks.painted = onPainted ?? null;
    return { paint: () => undefined, stop: () => undefined };
  },
}));

vi.mock(import("~/state/previewStream"), async (original) => ({
  ...(await original()),
  usePreviewStreamAccess: () => mocks.access as never,
}));

import { ServerBrowserSurface } from "./ServerBrowserSurface";

function setup() {
  mocks.painted = null;
  mocks.createClient.mockReset().mockImplementation(() => ({
    send: () => false,
    stop: () => undefined,
  }));
}

const surface = (visible: boolean) => (
  <ServerBrowserSurface
    environmentId={EnvironmentId.make("environment-unpainted")}
    threadId="thread-unpainted"
    tabId="tab-unpainted"
    visible={visible}
    followSize={false}
    className="flex-1"
  />
);

// fork: see "A viewer of a hidden tab" in FORK.md.
it("says why a tab is blank until it paints, disconnects or stops", async () => {
  setup();
  const container = document.createElement("div");
  container.style.cssText = "width: 400px; height: 300px; display: flex;";
  await using screen = await render(surface(true), { container });
  await vi.waitFor(() => expect(mocks.createClient).toHaveBeenCalled());
  const handlers = () => mocks.createClient.mock.calls.at(-1)![1];
  const notice = screen.getByText(/This tab can't draw while T3's window is minimized/);

  await act(() => handlers().onUnpainted?.());
  await expect.element(notice).toBeVisible();
  await act(() => mocks.painted?.());
  await expect.element(notice).not.toBeInTheDocument();

  await act(() => handlers().onUnpainted?.());
  await expect.element(notice).toBeVisible();
  await act(() => handlers().onConnectedChange(false));
  await expect.element(notice).not.toBeInTheDocument();

  await act(() => handlers().onUnpainted?.());
  await expect.element(notice).toBeVisible();
  await screen.rerender(surface(false));
  await screen.rerender(surface(true));
  await vi.waitFor(() => expect(mocks.createClient).toHaveBeenCalledTimes(2));
  await expect.element(notice).not.toBeInTheDocument();
});
