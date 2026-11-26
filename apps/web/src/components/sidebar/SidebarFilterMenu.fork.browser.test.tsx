// fork: sidebar filter and sort, see FORK.md.
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { SidebarProvider } from "../ui/sidebar";
import { SidebarFilterMenu } from "./SidebarFilterMenu";
import { DEFAULT_SIDEBAR_VIEW } from "./sidebarView";

it("offers Add project in its Project menu, as upstream's folder picker does", async () => {
  const onAddProject = vi.fn();
  await using screen = await render(
    <SidebarProvider defaultOpen>
      <SidebarFilterMenu
        view={DEFAULT_SIDEBAR_VIEW}
        onViewChange={vi.fn()}
        projects={[]}
        projectKeys={[]}
        onProjectKeysChange={vi.fn()}
        onProjectSettings={vi.fn()}
        onAddProject={onAddProject}
        tags={[]}
        statuses={[]}
        pinned={[]}
        pullRequests={[]}
        machines={[]}
        filterCount={0}
        onClear={vi.fn()}
      />
    </SidebarProvider>,
  );

  await screen.getByTestId("sidebar-filter-button").click();
  await page.getByRole("menuitem", { name: /^Project/ }).click();
  await page.getByRole("menuitem", { name: "Add project" }).click();

  expect(onAddProject).toHaveBeenCalledOnce();
});
