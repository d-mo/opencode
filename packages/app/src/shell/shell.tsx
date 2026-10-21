import { Show, Suspense, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import { createMediaQuery } from "@solid-primitives/media"
import { ResizeHandle } from "@opencode/ui/resize-handle"
import { Titlebar } from "@/shell/titlebar/titlebar"
import { usePlatform } from "@/runtime/platform/platform"
import { ToastRegion } from "@/shell/notifications/toast"
import { UploadToastHost } from "@/composer/attachments/uploads"
import { TitlebarRightProvider } from "@/shell/titlebar/right-slot"
import { useSettingsSurface } from "@/settings/surface"
import { useSettings } from "@/settings/model"
import { ExtensionServerCover } from "@/runtime/extension/server-shell"
import { ExtensionSlot } from "@/runtime/extension/render"
import { useCommand } from "@/shell/commands/command"
import { useLanguage } from "@/runtime/i18n/language"
import { CollapsedSidebarToggle, paintCollapsedSlots } from "@/shell/sidebar-toggle"
import { createPanelMotion, guardClosingFocus, replayPanelToggle } from "@/shell/panel-motion"
import { windowDragEnabled } from "@/session/header/drag-area"

export default function Layout(props: ParentProps) {
  const platform = usePlatform()
  const settings = useSettingsSurface()
  const preferences = useSettings()
  const command = useCommand()
  const language = useLanguage()
  const mobile = createMediaQuery("(max-width: 767px)")

  const [state, setState] = createStore<{
    tabsWidth: number
    tabsMount: HTMLElement | undefined
    tabsAside: HTMLElement | undefined
    tabsPanel: HTMLElement | undefined
  }>({
    tabsWidth: 260,
    tabsMount: undefined,
    tabsAside: undefined,
    tabsPanel: undefined,
  })

  const verticalTabs = () => preferences.appearance.tabLayout() !== "horizontal" && !mobile()

  const toggleSidebar = () => preferences.appearance.setSidebarOpen(!preferences.appearance.sidebarOpen())

  const sidebarMotion = createPanelMotion({
    open: preferences.appearance.sidebarOpen,
    // The aside's real width moves main's edge with the sidebar's; its contents keep their width, pinned to that edge.
    paint: (closed) => {
      const aside = state.tabsAside

      if (aside) aside.style.width = `${state.tabsWidth * (1 - closed)}px`
      paintCollapsedSlots(closed)
    },
    element: () => state.tabsPanel,
    offset: () => -10,
    neighbours: () => [
      [document.querySelector<HTMLElement>('[data-slot="session-chat-panel"]'), "center"],
      [document.querySelector<HTMLElement>('[data-slot="session-side-panel-presence"]'), "start"],
    ],
    resize: () => state.tabsAside,
  })

  replayPanelToggle({ id: "sidebar", label: "Toggle the left sidebar", toggle: toggleSidebar })

  guardClosingFocus({
    root: () => state.tabsAside,
    closing: () => !preferences.appearance.sidebarOpen() && sidebarMotion.present(),
    // The toggle that reopens the sidebar, outside it.
    target: () =>
      [...document.querySelectorAll<HTMLElement>('button[aria-controls="vertical-tabs-sidebar"]')].find(
        (button) => !state.tabsAside?.contains(button),
      ),
  })

  command.register("sidebar", () =>
    verticalTabs()
      ? [
          {
            id: "sidebar.toggle",
            title: language.t("command.sidebar.toggle"),
            category: language.t("command.category.view"),
            keybind: "mod+shift+b",
            onSelect: toggleSidebar,
          },
        ]
      : [],
  )
  const bottomTitlebar = () => mobile() && preferences.general.mobileTitlebarPosition() === "bottom"
  const dragInset = () => windowDragEnabled(platform) && !mobile()

  return (
    <TitlebarRightProvider>
      <div
        class="relative bg-v2-background-bg-deep flex-1 min-h-0 min-w-0 flex flex-col select-none [&_input]:select-text [&_textarea]:select-text [&_[contenteditable]]:select-text"
        style={{
          // Mobile panels only need clearance for their outer border.
          "--shell-inline-inset": mobile() ? "1px" : "8px",
          // A bottom mobile titlebar leaves main's top edge to the safe area. Native Windows chrome supplies the gap;
          // retain outer-outline clearance.
          "--shell-top-inset": bottomTitlebar()
            ? "0px"
            : platform.platform === "desktop" && platform.os === "windows"
              ? "1px"
              : "8px",
          "--shell-bottom-inset": bottomTitlebar()
            ? "8px"
            : "max(0px, calc(8px - var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))))",
        }}
      >
        <Titlebar verticalTabs={verticalTabs() ? { mount: state.tabsMount } : undefined} />
        <div class="relative flex flex-1 min-h-0 min-w-0 flex-row">
          {/* The empty inset above the panels moves the window, as the titlebar does. */}
          <Show when={dragInset()}>
            <div
              data-slot="shell-drag-inset"
              aria-hidden="true"
              class="absolute inset-x-0 top-0 h-[var(--shell-top-inset,8px)]"
              data-tauri-drag-region
            />
          </Show>
          <Show when={verticalTabs()}>
            <aside
              id="vertical-tabs-sidebar"
              data-slot="vertical-tabs-sidebar"
              data-state={preferences.appearance.sidebarOpen() ? "open" : "closed"}
              ref={(element) => setState("tabsAside", element)}
              class="relative z-10 h-full min-h-0 shrink-0"
            >
              {/* Skipped rather than display: none or inert, so neither direction restyles the sidebar's contents and
                  a reopen reuses their layout. */}
              <div
                ref={(element) => setState("tabsPanel", element)}
                class="absolute inset-0 overflow-hidden [contain:layout_style_paint]"
                classList={{ "[content-visibility:hidden]": !sidebarMotion.present() }}
              >
                <div
                  ref={(element) => setState("tabsMount", element)}
                  class="absolute inset-y-0 end-0 contain-strict flex min-h-0 flex-col bg-v2-background-bg-deep pe-0.5 ps-2.5 pb-[var(--shell-bottom-inset,8px)] pt-[var(--shell-top-inset,8px)]"
                  style={{
                    width: `${state.tabsWidth}px`,
                    "padding-bottom": "max(10px, var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)))",
                  }}
                />
              </div>
              {/* Takes the pointer while the sidebar closes, without restyling its contents. */}
              <div
                class="absolute inset-0 z-20"
                classList={{ hidden: preferences.appearance.sidebarOpen() || !sidebarMotion.present() }}
              />
              <Show when={preferences.appearance.sidebarOpen()}>
                <ResizeHandle
                  class="-end-1"
                  direction="horizontal"
                  size={state.tabsWidth}
                  min={120}
                  max={640}
                  onResize={(width) => setState("tabsWidth", width)}
                />
              </Show>
            </aside>
          </Show>
          {/* Size containment collapses percentage-height descendants in WebKit. */}
          <main
            class="flex-1 min-h-0 min-w-0 overflow-x-hidden flex flex-col items-start contain-content"
            style={{
              "padding-top": bottomTitlebar() ? "env(safe-area-inset-top, 0px)" : "0px",
              "padding-bottom":
                bottomTitlebar() || settings.active()
                  ? "0px"
                  : "var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))",
              "--settings-bottom-inset": bottomTitlebar()
                ? "40px"
                : "var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))",
            }}
          >
            <ExtensionServerCover>
              <Suspense>{props.children}</Suspense>
            </ExtensionServerCover>
            <CollapsedSidebarToggle />
          </main>
        </div>
        <ExtensionSlot at="window.bottom" input={{}} />
        <ToastRegion />
        <UploadToastHost />
      </div>
    </TitlebarRightProvider>
  )
}
