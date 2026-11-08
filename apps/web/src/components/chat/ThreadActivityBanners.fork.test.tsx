import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { isValidElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { childInputNowItem } from "./ThreadActivityBanners";

const MAC = EnvironmentId.make("mac");
const PC = EnvironmentId.make("pc");

const child = (environmentId: EnvironmentId, id: string, title: string) =>
  ({
    environmentId,
    id: ThreadId.make(id),
    title,
    hasPendingApprovals: true,
    lineage: { parentThreadId: null, relationshipToParent: null },
  }) as unknown as EnvironmentThreadShell;

/** The click handler of the first element in the tree whose text is exactly `label`. */
function clickHandler(node: ReactNode, label: string): (() => void) | null {
  if (Array.isArray(node)) {
    for (const entry of node) {
      const found = clickHandler(entry, label);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(node)) return null;
  if (node.props.children === label && node.props.onClick) return node.props.onClick;
  return clickHandler(node.props.children, label);
}

describe("childInputNowItem", () => {
  it("opens a child on the machine it runs on, not the parent's", () => {
    const onOpenThread = vi.fn();
    const item = childInputNowItem({
      childThreadInputs: [child(PC, "pc-task", "Fix the sync"), child(MAC, "mac-child", "Review")],
      parentAwaitingUser: false,
      onOpenThread,
    });

    clickHandler(item?.actions, "Open approval")?.();
    expect(onOpenThread).toHaveBeenLastCalledWith("pc-task", PC);

    clickHandler(item?.description, "Fix the sync")?.();
    expect(onOpenThread).toHaveBeenLastCalledWith("pc-task", PC);
    clickHandler(item?.description, "Review")?.();
    expect(onOpenThread).toHaveBeenLastCalledWith("mac-child", MAC);
    expect(onOpenThread).toHaveBeenCalledTimes(3);
  });
});
