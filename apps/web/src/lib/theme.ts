export type Theme = "light" | "dark" | "summer";

export function parseStoredTheme(value: string | null): Theme | null {
  if (value === "light" || value === "dark" || value === "summer") return value;
  return null;
}

/** Excalidraw only supports light/dark; summer maps to light canvas styling. */
export function excalidrawAppearance(theme: Theme): "light" | "dark" {
  return theme === "dark" ? "dark" : "light";
}

export function cycleTheme(theme: Theme): Theme {
  if (theme === "dark") return "light";
  if (theme === "light") return "summer";
  return "dark";
}
