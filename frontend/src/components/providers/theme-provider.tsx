"use client";

import { createContext, use, useCallback, useLayoutEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";

import { THEME_STORAGE_KEY } from "@/lib/theme";

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const listeners = new Set<() => void>();

function readPreference(): ThemePreference {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

function subscribePreference(callback: () => void) {
  listeners.add(callback);
  const onStorage = (event: StorageEvent) => {
    if (event.key === THEME_STORAGE_KEY) callback();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(callback);
    window.removeEventListener("storage", onStorage);
  };
}

const DARK_QUERY = "(prefers-color-scheme: dark)";

function subscribeSystem(callback: () => void) {
  const media = window.matchMedia(DARK_QUERY);
  media.addEventListener("change", callback);
  return () => media.removeEventListener("change", callback);
}

function readSystemDark(): boolean {
  return window.matchMedia(DARK_QUERY).matches;
}

interface ThemeContextValue {
  theme: ThemePreference;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const theme = useSyncExternalStore(subscribePreference, readPreference, () => "system" as const);
  const systemDark = useSyncExternalStore(subscribeSystem, readSystemDark, () => false);
  const resolvedTheme: ResolvedTheme = theme === "system" ? (systemDark ? "dark" : "light") : theme;

  // Apply before paint; also restores the attribute after React's dev-mode
  // remount of <html> clears what the inline script set.
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-theme", resolvedTheme);
    root.style.colorScheme = resolvedTheme;
  }, [resolvedTheme]);

  const setTheme = useCallback((next: ThemePreference) => {
    try {
      if (next === "system") window.localStorage.removeItem(THEME_STORAGE_KEY);
      else window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Storage unavailable (private mode): the choice lasts for this page only.
    }
    listeners.forEach((listener) => listener());
  }, []);

  const value = useMemo(() => ({ theme, resolvedTheme, setTheme }), [theme, resolvedTheme, setTheme]);
  return <ThemeContext value={value}>{children}</ThemeContext>;
}

export function useTheme(): ThemeContextValue {
  const context = use(ThemeContext);
  if (!context) throw new Error("useTheme must be used within ThemeProvider");
  return context;
}
