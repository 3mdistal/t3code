import { expect, it, vi } from "vite-plus/test";

import { showBootError } from "./bootError";

function mountBootShell() {
  const shell = document.createElement("div");
  shell.id = "boot-shell";
  document.body.append(shell);
  return Object.assign(shell, { [Symbol.dispose]: () => shell.remove() });
}

function stubDesktopBridge() {
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: {
      getClientPlatform: () => "win32",
      getUpdateState: async () => ({ status: "idle" }),
      onUpdateState: () => () => {},
    },
  });
  return { [Symbol.dispose]: () => Reflect.deleteProperty(window, "desktopBridge") };
}

const linksIn = (shell: HTMLElement) =>
  Array.from(shell.querySelectorAll("a")).map((anchor) => anchor.href);

it("reports a failed start without triage or upstream's issue form", () => {
  using _error = vi.spyOn(console, "error").mockImplementation(() => {});
  using shell = mountBootShell();

  showBootError(new Error("boom"));

  expect(shell.textContent).toContain("T3 Code failed to start");
  expect(shell.textContent).toContain("Copy error details");
  expect(shell.textContent).toContain("Error: boom");
  expect(shell.textContent).not.toMatch(/triage/i);
  expect(shell.querySelector("code")).toBeNull();
  expect(linksIn(shell)).toEqual([]);
});

it("sends a reinstall from the desktop app to the fork's releases", () => {
  using _error = vi.spyOn(console, "error").mockImplementation(() => {});
  using shell = mountBootShell();
  using _bridge = stubDesktopBridge();

  showBootError(new Error("boom"));

  expect(linksIn(shell)).toEqual(["https://github.com/3mdistal/t3code/releases/latest"]);
  expect(shell.textContent).not.toMatch(/triage/i);
});
