import type { BrowserDeviceViewport } from "../browserTypes";

export type DeviceSize = Pick<BrowserDeviceViewport, "width" | "height">;
export const RESPONSIVE = "Responsive";
export const MIN_DIMENSION = 200;
export const MAX_DIMENSION = 2400;

const DEVICE_PRESETS = [
  { name: "iPhone SE", size: { width: 375, height: 667 } },
  { name: "iPhone 14", size: { width: 390, height: 844 } },
  { name: "iPhone 14 Pro Max", size: { width: 430, height: 932 } },
  { name: "Pixel 7", size: { width: 412, height: 915 } },
  { name: "Samsung Galaxy S8+", size: { width: 360, height: 740 } },
  { name: "iPad mini", size: { width: 768, height: 1024 } },
] as const;

export type DeviceSettings = {
  preset: typeof RESPONSIVE | (typeof DEVICE_PRESETS)[number]["name"];
  size: DeviceSize;
};

type Props = { settings: DeviceSettings; onChange: (settings: DeviceSettings) => void };

export function BrowserDeviceControls({ settings, onChange }: Props) {
  const { preset, size } = settings;
  return (
    <div className="browser-device-controls" role="group" aria-label="Device viewport">
      <select
        aria-label="Device preset"
        value={preset}
        onChange={(event) => {
          const selected = DEVICE_PRESETS.find(({ name }) => name === event.target.value);
          onChange(selected ? { preset: selected.name, size: selected.size } : { preset: RESPONSIVE, size });
        }}
      >
        <option>{RESPONSIVE}</option>
        {DEVICE_PRESETS.map(({ name }) => <option key={name}>{name}</option>)}
      </select>
      {(["width", "height"] as const).map((dimension) => (
        <label key={dimension}>
          {dimension === "width" ? "W" : "H"}
          <input
            key={size[dimension]}
            type="number"
            aria-label={`Viewport ${dimension} in pixels`}
            min={MIN_DIMENSION}
            max={MAX_DIMENSION}
            step={1}
            defaultValue={size[dimension]}
            onBlur={(event) => {
              const input = event.currentTarget;
              if (!input.value || !input.validity.valid) {
                input.value = String(size[dimension]);
                return;
              }
              if (input.valueAsNumber !== size[dimension]) {
                onChange({ preset: RESPONSIVE, size: { ...size, [dimension]: input.valueAsNumber } });
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.blur();
              }
            }}
          />
        </label>
      ))}
      <button type="button" className="ghost" onClick={() => onChange({ preset, size: { width: size.height, height: size.width } })}>
        Rotate
      </button>
    </div>
  );
}
