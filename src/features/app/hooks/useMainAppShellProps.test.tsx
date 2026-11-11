/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { MainTopbar } from "@app/components/MainTopbar";
import { useMainAppDisplayNodes } from "./useMainAppDisplayNodes";
import { useMainAppShellProps } from "./useMainAppShellProps";

const noop = () => {};
type ShellArgs = Parameters<typeof useMainAppShellProps>[0];

function Toolbar({
  rightPanelCollapsed,
  onToggleBrowser,
  onToggleRightPanel,
}: {
  rightPanelCollapsed: boolean;
  onToggleBrowser: () => void;
  onToggleRightPanel: () => void;
}) {
  const { mainHeaderActionsNode } = useMainAppDisplayNodes({
    showCompactCodexThreadActions: false,
    handleMobileThreadRefresh: noop,
    mobileThreadRefreshLoading: false,
    centerMode: "chat",
    gitDiffViewStyle: "split",
    setGitDiffViewStyle: noop,
    browserToggleNode: <button type="button" onClick={onToggleBrowser}>Browser</button>,
    workspaceHomeProps: null,
  });

  const { appLayoutProps } = useMainAppShellProps({
    shell: {
      appClassName: "app",
      isResizing: false,
      appStyle: {},
      appRef: useRef<HTMLDivElement>(null),
      sidebarToggleProps: {
        isCompact: false,
        sidebarCollapsed: false,
        rightPanelCollapsed,
        onCollapseSidebar: noop,
        onExpandSidebar: noop,
        onCollapseRightPanel: onToggleRightPanel,
        onExpandRightPanel: onToggleRightPanel,
      },
      shouldLoadGitHubPanelData: false,
      appModalsProps: {} as ShellArgs["shell"]["appModalsProps"],
      showMobileSetupWizard: false,
      mobileSetupWizardProps: {} as ShellArgs["shell"]["mobileSetupWizardProps"],
    },
    gitHubPanelDataProps: {} as ShellArgs["gitHubPanelDataProps"],
    appLayout: {} as ShellArgs["appLayout"],
    topbar: {
      isCompact: false,
      desktopTopbarLeftNode: (
        <div role="group" aria-label="Chat controls">{mainHeaderActionsNode}</div>
      ),
      hasActiveWorkspace: true,
      backendMode: "remote",
      remoteThreadConnectionState: "live",
    },
  });

  return <MainTopbar leftNode={appLayoutProps.desktopTopbarLeftNode} actionsNode={appLayoutProps.topbarActionsNode} />;
}

afterEach(cleanup);

it.each([
  { rightPanelCollapsed: false, label: "Hide git sidebar" },
  { rightPanelCollapsed: true, label: "Show git sidebar" },
])("places Browser in the chat controls and $label on the right", ({ rightPanelCollapsed, label }) => {
  const onToggleBrowser = vi.fn();
  const onToggleRightPanel = vi.fn();
  render(<Toolbar {...{ rightPanelCollapsed, onToggleBrowser, onToggleRightPanel }} />);

  const chatControls = within(screen.getByRole("group", { name: "Chat controls" }));
  const browser = chatControls.getByRole("button", { name: "Browser" });
  const panel = screen.getByRole("button", { name: label });
  expect(panel.parentElement).toBe(screen.getByText("Live").parentElement);
  expect(chatControls.queryByRole("button", { name: label })).toBeNull();

  fireEvent.click(browser);
  fireEvent.click(panel);
  expect(onToggleBrowser).toHaveBeenCalledTimes(1);
  expect(onToggleRightPanel).toHaveBeenCalledTimes(1);
});
