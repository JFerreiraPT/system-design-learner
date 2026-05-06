import { useEffect, useState, useSyncExternalStore } from "react";
import {
  type Theme,
  cycleTheme,
  parseStoredTheme
} from "./theme";

export type { Theme } from "./theme";

const KEY = "theme";

function getStored(): Theme | null {
  if (typeof window === "undefined") return null;
  return parseStoredTheme(window.localStorage.getItem(KEY));
}

function getSystem(): Theme {
  if (typeof window === "undefined" || !window.matchMedia) return "dark";
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function getInitial(): Theme {
  return getStored() ?? getSystem();
}

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === "dark") {
    root.classList.add("dark");
  } else {
    root.classList.remove("dark");
  }
  root.setAttribute("data-theme", theme);
}

const listeners = new Set<() => void>();
let currentTheme: Theme = typeof window === "undefined" ? "dark" : getInitial();

function setTheme(theme: Theme) {
  currentTheme = theme;
  try {
    window.localStorage.setItem(KEY, theme);
  } catch {
    // no-op (private mode etc.)
  }
  applyTheme(theme);
  listeners.forEach((fn) => fn());
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function snapshot(): Theme {
  return currentTheme;
}

export function useTheme() {
  const theme = useSyncExternalStore(subscribe, snapshot, () => "dark" as Theme);

  // Sync with system preference if user hasn't explicitly chosen one.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
    if (getStored()) return;
    const mql = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => setTheme(mql.matches ? "light" : "dark");
    mql.addEventListener?.("change", onChange);
    return () => mql.removeEventListener?.("change", onChange);
  }, []);

  return {
    theme,
    mounted,
    setTheme,
    toggle: () => setTheme(cycleTheme(theme))
  };
}
