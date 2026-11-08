import { useState } from "react";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";
import { SettingsSubsection } from "@/features/design-system/components/settings/SettingsPrimitives";
import { isCustomSidebarColor, normalizeColorHex, type SidebarColor, type SidebarColorOption } from "@app/utils/sidebarColors";

type Props = {
  palette: SidebarColorOption[];
  onAddColor: (name: string, hex: string) => string | null;
  onRemoveColor: (id: SidebarColor) => void;
};

export function SettingsProjectColors({ palette, onAddColor, onRemoveColor }: Props) {
  const [name, setName] = useState("");
  const [hex, setHex] = useState("#8b5cf6");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");

  return <div className="settings-project-colors">
    <SettingsSubsection title="Project colors" subtitle="Create named colors for your projects. Colors stay readable in opaque and translucent modes." />
    <form className="settings-color-create" onSubmit={(event) => {
      event.preventDefault();
      const result = onAddColor(name, hex);
      setError(result);
      if (!result) { setNotice(`${name.trim()} added to project colors.`); setName(""); }
    }}>
      <label className="settings-color-field settings-color-name-field">
        <span>Color name</span>
        <input className="settings-input settings-input--compact" value={name} maxLength={40} placeholder="e.g. Brand navy" onChange={(event) => { setName(event.target.value); setError(null); setNotice(""); }} />
      </label>
      <label className="settings-color-field">
        <span>Color</span>
        <input type="color" className="settings-color-picker" value={normalizeColorHex(hex) ?? "#8b5cf6"} onChange={(event) => { setHex(event.target.value); setError(null); setNotice(""); }} />
      </label>
      <label className="settings-color-field settings-color-hex-field">
        <span>Hex</span>
        <input className="settings-input settings-input--compact" value={hex} maxLength={7} spellCheck={false} aria-invalid={Boolean(error && !normalizeColorHex(hex))} onChange={(event) => { setHex(event.target.value); setError(null); setNotice(""); }} />
      </label>
      <button type="submit" className="ghost settings-button-compact" disabled={!name.trim()}>Add color</button>
    </form>
    {error && <div className="settings-group-error" role="alert">{error}</div>}
    <span className="settings-color-notice" role="status">{notice}</span>
    <ul className="settings-color-palette" aria-label="Project color palette">
      {palette.map((color) => <li key={color.id} className="settings-color-entry">
        <span className="settings-color-swatch" style={{ backgroundColor: color.value }} aria-hidden />
        <span className="settings-color-label" title={`${color.label} (${color.value})`}>{color.label}<small>{color.value.toUpperCase()}</small></span>
        {isCustomSidebarColor(color.id) && <button type="button" className="ghost icon-button" aria-label={`Remove color ${color.label}`} title="Remove color and clear it from assigned projects" onClick={() => { onRemoveColor(color.id); setNotice(`${color.label} removed from the palette and assigned projects.`); }}><Trash2 aria-hidden /></button>}
      </li>)}
    </ul>
    <p className="settings-subsection-subtitle">Choose a color below or right-click a sidebar project. Removing a custom color clears it from assigned projects.</p>
  </div>;
}
