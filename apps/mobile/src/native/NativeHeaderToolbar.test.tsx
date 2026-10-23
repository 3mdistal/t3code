import type { NativeStackHeaderItem } from "@react-navigation/native-stack";
import { act, createContext, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";

type HeaderOptions = {
  unstable_headerLeftItems?: () => NativeStackHeaderItem[];
  unstable_headerRightItems?: () => NativeStackHeaderItem[];
  unstable_headerToolbarItems?: () => NativeStackHeaderItem[];
};

const harness = vi.hoisted(() => ({
  params: { path: ["first", "guide.pdf"] },
  appliedOptions: {} as HeaderOptions,
  renderedItems: [] as NativeStackHeaderItem[],
  setOptionsCalls: 0,
  openedDocuments: [] as string[],
}));

// Native headers retain the actions materialized when navigation applies options. Like React
// Navigation, the header renders again only when the options are no longer shallowly equal.
vi.mock("@react-navigation/native", () => {
  const navigation = {
    setOptions(options: HeaderOptions) {
      harness.setOptionsCalls += 1;
      const previous: Record<string, unknown> = harness.appliedOptions;
      const next: Record<string, unknown> = { ...previous, ...options };
      harness.appliedOptions = next;
      if (
        Object.keys(next).length === Object.keys(previous).length &&
        Object.keys(next).every((key) => next[key] === previous[key])
      )
        return;
      harness.renderedItems =
        options.unstable_headerLeftItems?.() ??
        options.unstable_headerRightItems?.() ??
        options.unstable_headerToolbarItems?.() ??
        [];
    },
  };
  return {
    useNavigation: () => navigation,
    useRoute: () => ({ key: "file", name: "ThreadFile", params: harness.params }),
  };
});

import { NativeHeaderToolbar } from "./NativeHeaderToolbar";

let root: Root | null = null;
type Placement = "left" | "right" | "bottom";

function DocumentToolbar(props: { readonly path: string; readonly placement: Placement }) {
  return (
    <NativeHeaderToolbar placement={props.placement}>
      <NativeHeaderToolbar.Menu title="File actions" icon="ellipsis">
        <NativeHeaderToolbar.MenuAction onPress={() => harness.openedDocuments.push(props.path)}>
          Open PDF
        </NativeHeaderToolbar.MenuAction>
      </NativeHeaderToolbar.Menu>
    </NativeHeaderToolbar>
  );
}

function PairingForm(props: {
  readonly placement: Placement;
  readonly onPair: (host: string, code: string) => void;
}) {
  const [host, setHost] = useState("");
  const [code, setCode] = useState("");
  const pair = () => props.onPair(host, code);
  return (
    <>
      <input
        aria-label="Host"
        value={host}
        onInput={(event) => setHost(event.currentTarget.value)}
      />
      <input
        aria-label="Code"
        value={code}
        onInput={(event) => setCode(event.currentTarget.value)}
      />
      <NativeHeaderToolbar placement={props.placement}>
        <NativeHeaderToolbar.Button label="Pair" disabled={!host} onPress={pair} />
        <NativeHeaderToolbar.Menu title="Pairing">
          <NativeHeaderToolbar.Menu title="Actions">
            <NativeHeaderToolbar.MenuAction disabled={!host} onPress={pair}>
              Pair
            </NativeHeaderToolbar.MenuAction>
          </NativeHeaderToolbar.Menu>
        </NativeHeaderToolbar.Menu>
      </NativeHeaderToolbar>
    </>
  );
}

function renderDocument(path: string, placement: Placement) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  harness.params = { path: path.split("/") };
  root ??= createRoot(document.createElement("div"));
  act(() => root!.render(<DocumentToolbar path={path} placement={placement} />));
}

// Like React Navigation's NavigationStateContext, whose default value throws when
// read. React restores a context's default outside render, so layout effects see it.
const ContainerStateContext = createContext<object>({
  get getIsInitial(): never {
    throw new Error("Couldn't find a navigation context.");
  },
});
const containerState = {};

function ConnectingToolbar(props: { readonly label: string }) {
  return (
    <NativeHeaderToolbar placement="right">
      <NativeHeaderToolbar.Custom>
        <span aria-label={props.label} />
      </NativeHeaderToolbar.Custom>
    </NativeHeaderToolbar>
  );
}

function renderConnecting(label: string) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root ??= createRoot(document.createElement("div"));
  act(() =>
    root!.render(
      <ContainerStateContext value={containerState}>
        <ConnectingToolbar label={label} />
      </ContainerStateContext>,
    ),
  );
}

function renderedCustomLabel() {
  const item = harness.renderedItems[0];
  if (item?.type !== "custom") throw new Error("Expected the custom header element");
  return (item.element as ReactElement<{ "aria-label": string }>).props["aria-label"];
}

function openRenderedDocument() {
  const menu = harness.renderedItems[0];
  if (menu?.type !== "menu") throw new Error("Expected the native file menu");
  const action = menu.menu.items[0];
  if (action?.type !== "action") throw new Error("Expected the native Open PDF action");
  action.onPress?.();
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  harness.appliedOptions = {};
  harness.renderedItems = [];
  harness.setOptionsCalls = 0;
  harness.openedDocuments = [];
  vi.unstubAllGlobals();
});

it.each(["left", "right", "bottom"] as const)(
  "updates the %s header action when switching between documents with the same name",
  (placement) => {
    renderDocument("first/guide.pdf", placement);
    openRenderedDocument();
    renderDocument("second/guide.pdf", placement);
    openRenderedDocument();

    expect(harness.openedDocuments).toEqual(["first/guide.pdf", "second/guide.pdf"]);
  },
);

it.each(["left", "right", "bottom"] as const)(
  "pairs with current form values through retained %s button and nested menu actions",
  (placement) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    root = createRoot(container);
    const onPair = vi.fn();
    act(() => root!.render(<PairingForm placement={placement} onPair={onPair} />));

    const edit = (label: string, value: string) => {
      const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
      act(() => {
        input.value = value;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    edit("Host", "h");

    const button = harness.renderedItems[0];
    if (button?.type !== "button") throw new Error("Expected the native Pair button");
    expect(button.disabled).toBe(false);
    const menu = harness.renderedItems[1];
    if (menu?.type !== "menu") throw new Error("Expected the native pairing menu");
    const submenu = menu.menu.items[0];
    if (submenu?.type !== "submenu") throw new Error("Expected the nested actions menu");
    const action = submenu.items[0];
    if (action?.type !== "action") throw new Error("Expected the native Pair action");
    expect(action.disabled).toBe(false);
    const applied = harness.setOptionsCalls;
    const params = harness.params;

    edit("Host", "https://my-server.example");
    edit("Code", "123456");

    expect(harness.params).toBe(params);
    expect(harness.setOptionsCalls).toBe(applied);
    expect(harness.renderedItems[0]).toBe(button);
    expect(harness.renderedItems[1]).toBe(menu);
    button.onPress?.();
    action.onPress?.();
    expect(onPair.mock.calls).toEqual([
      ["https://my-server.example", "123456"],
      ["https://my-server.example", "123456"],
    ]);
  },
);

it("applies a custom header element rendered inside a navigation container", () => {
  renderConnecting("Connecting");
  expect(renderedCustomLabel()).toBe("Connecting");

  const applied = harness.setOptionsCalls;
  renderConnecting("Connecting");
  expect(harness.setOptionsCalls).toBe(applied);

  renderConnecting("Reconnecting");
  expect(renderedCustomLabel()).toBe("Reconnecting");
});
