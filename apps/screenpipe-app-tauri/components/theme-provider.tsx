"use client";

import React, { createContext, useContext, useEffect, useState } from "react";
import { type ColorTheme } from "@/lib/constants/colors";
import { useSettings } from "@/lib/hooks/use-settings";
import { invoke } from "@tauri-apps/api/core";

interface ThemeProviderProps {
  children: React.ReactNode;
  defaultTheme?: ColorTheme;
  storageKey?: string;
}

interface ThemeProviderState {
  theme: ColorTheme;
  setTheme: (theme: ColorTheme) => void;
  toggleTheme: () => void;
}

const initialState: ThemeProviderState = {
  theme: "system",
  setTheme: () => null,
  toggleTheme: () => null,
};

const ThemeProviderContext = createContext<ThemeProviderState>(initialState);

export function ThemeProvider({
  children,
  defaultTheme = "system",
  storageKey = "screenpipe-ui-theme",
  ...props
}: ThemeProviderProps) {
  const [theme, setThemeState] = useState<ColorTheme | undefined>(() => {
    // Read theme synchronously on first render to avoid flash
    if (typeof window === "undefined") return undefined;
    try {
      const stored = localStorage?.getItem(storageKey) as ColorTheme;
      return stored || "system";
    } catch {
      return "system";
    }
  });
  const [isLoaded, setIsLoaded] = useState(() => typeof window !== "undefined");
  const { updateSettings } = useSettings();

  useEffect(() => {
    // Fallback for SSR or edge cases where initializer didn't run
    if (theme && isLoaded) return;
    try {
      const storedTheme = localStorage?.getItem(storageKey) as ColorTheme;
      if (storedTheme) {
        setThemeState(storedTheme);
      } else {
        setThemeState("system");
      }
    } catch {
      setThemeState("system");
    }
    setIsLoaded(true);
  }, [storageKey, theme, isLoaded]);

  useEffect(() => {
    if (!theme || !isLoaded) return;
    
    const root = window.document.documentElement;
    
    // Remove all theme classes first
    root.classList.remove("light", "dark");
    
    // Determine the actual theme to apply
    let actualTheme: "light" | "dark";
    
    if (theme === "system") {
      actualTheme = window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
        
      // Listen for system theme changes
      const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
      const handleSystemThemeChange = () => {
        if (theme === "system") {
          const newActualTheme = mediaQuery.matches ? "dark" : "light";
          root.classList.remove("light", "dark");
          root.classList.add(newActualTheme);
        }
      };
      
      mediaQuery.addEventListener("change", handleSystemThemeChange);
      return () => mediaQuery.removeEventListener("change", handleSystemThemeChange);
    } else {
      actualTheme = theme;
    }
    
    // Add the actual theme class
    root.classList.add(actualTheme);
  }, [theme, isLoaded]);

  const value = {
    theme: theme || defaultTheme,
    setTheme: (theme: ColorTheme) => {
      try {
        localStorage?.setItem(storageKey, theme);
      } catch {}
      setThemeState(theme);
      updateSettings({ uiTheme: theme });
      invoke("set_native_theme", { theme }).catch(() => {});
    },
    toggleTheme: () => {
      const currentTheme = theme || defaultTheme;
      const newTheme = currentTheme === "light" ? "dark" : "light";
      try {
        localStorage?.setItem(storageKey, newTheme);
      } catch {}
      setThemeState(newTheme);
      updateSettings({ uiTheme: newTheme });
      invoke("set_native_theme", { theme: newTheme }).catch(() => {});
    },
  };

  return (
    <ThemeProviderContext.Provider {...props} value={value}>
      {children}
    </ThemeProviderContext.Provider>
  );
}

export const useTheme = () => {
  const context = useContext(ThemeProviderContext);

  if (context === undefined)
    throw new Error("useTheme must be used within a ThemeProvider");

  return context;
}; 