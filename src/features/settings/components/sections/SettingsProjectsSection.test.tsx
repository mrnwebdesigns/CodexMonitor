// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectColors } from "@app/hooks/useProjectColors";
import { sidebarColorStyle } from "@app/utils/sidebarColors";
import { SettingsProjectsSection } from "./SettingsProjectsSection";

const project = { id: "client", name: "Client Alpha", path: "/tmp/client", connected: true, settings: { sidebarCollapsed: false } };
const props: ComponentProps<typeof SettingsProjectsSection> = {
  workspaceGroups: [], groupedWorkspaces: [{ id: null, name: "Ungrouped", workspaces: [project] }],
  ungroupedLabel: "Ungrouped", groupDrafts: {}, newGroupName: "", groupError: null,
  projects: [project], canCreateGroup: false, onSetNewGroupName: vi.fn(), onSetGroupDrafts: vi.fn(),
  onCreateGroup: vi.fn(), onRenameGroup: vi.fn(), onMoveWorkspaceGroup: vi.fn(), onDeleteGroup: vi.fn(),
  onChooseGroupCopiesFolder: vi.fn(), onClearGroupCopiesFolder: vi.fn(), onAssignWorkspaceGroup: vi.fn(),
  onMoveWorkspace: vi.fn(), onDeleteWorkspace: vi.fn(),
};

function LiveProject() {
  const { getProjectColor } = useProjectColors();
  const color = getProjectColor("client");
  return <div data-testid="live-project" data-project-color={color} style={sidebarColorStyle(color)} />;
}

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe("Projects color settings", () => {
  it("creates a named hex color, applies it live, persists it, and removes it from assigned projects", () => {
    const first = render(<><LiveProject /><SettingsProjectsSection {...props} /></>);
    fireEvent.change(screen.getByLabelText("Color name"), { target: { value: "Brand navy" } });
    fireEvent.change(screen.getByLabelText("Hex"), { target: { value: "#123" } });
    fireEvent.click(screen.getByRole("button", { name: "Add color" }));
    expect(within(screen.getByRole("list", { name: "Project color palette" })).getByText("Brand navy")).toBeTruthy();
    const select = screen.getByRole("combobox", { name: "Color for Client Alpha" });
    fireEvent.change(select, { target: { value: "custom:#112233" } });
    expect(screen.getByTestId("live-project").dataset.projectColor).toBe("custom:#112233");
    expect(screen.getByTestId("live-project").style.getPropertyValue("--sidebar-item-color")).toBe("#112233");
    first.unmount();
    render(<><LiveProject /><SettingsProjectsSection {...props} /></>);
    expect((screen.getByRole("combobox", { name: "Color for Client Alpha" }) as HTMLSelectElement).value).toBe("custom:#112233");
    fireEvent.click(screen.getByRole("button", { name: "Remove color Brand navy" }));
    expect(screen.getByTestId("live-project").dataset.projectColor).toBeUndefined();
    expect(screen.queryByRole("option", { name: "Brand navy" })).toBeNull();
    expect(props.onDeleteWorkspace).not.toHaveBeenCalled();
  });

  it("uses the color picker and reports duplicate names or invalid hex without adding options", () => {
    render(<SettingsProjectsSection {...props} />);
    fireEvent.change(screen.getByLabelText("Color name"), { target: { value: "Red" } });
    fireEvent.change(screen.getByLabelText("Color", { exact: true }), { target: { value: "#112233" } });
    expect((screen.getByLabelText("Hex") as HTMLInputElement).value).toBe("#112233");
    fireEvent.click(screen.getByRole("button", { name: "Add color" }));
    expect(screen.getByRole("alert").textContent).toMatch(/name already/);
    fireEvent.change(screen.getByLabelText("Color name"), { target: { value: "Brand" } });
    fireEvent.change(screen.getByLabelText("Hex"), { target: { value: "invalid" } });
    fireEvent.click(screen.getByRole("button", { name: "Add color" }));
    expect(screen.getByRole("alert").textContent).toMatch(/hex color/);
    expect(screen.getByRole("list", { name: "Project color palette" }).children).toHaveLength(8);
  });
});
