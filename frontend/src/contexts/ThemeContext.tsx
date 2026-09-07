'use client';

import React, {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
} from 'react';

export type Theme = 'dark' | 'light';

/** localStorage key used to persist the user's appearance choice. */
export const THEME_STORAGE_KEY = 'meetly.theme';

/** Dark is the brand default when nothing has been saved yet. */
export const DEFAULT_THEME: Theme = 'dark';

/**
 * Inline bootstrap script rendered in layout.tsx before hydration so the
 * `dark` class is on <html> before the first paint (no flash of light theme).
 * Keep in sync with readStoredTheme()/applyThemeToDocument() below.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem('${THEME_STORAGE_KEY}');var d=t!=='light';var r=document.documentElement;if(d){r.classList.add('dark')}else{r.classList.remove('dark')}r.style.colorScheme=d?'dark':'light'}catch(e){document.documentElement.classList.add('dark')}})();`;

interface ThemeContextValue {
  theme: Theme;
  isDark: boolean;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

export function readStoredTheme(): Theme {
  if (typeof window === 'undefined') return DEFAULT_THEME;
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return stored === 'light' ? 'light' : 'dark';
  } catch {
    return DEFAULT_THEME;
  }
}

export function applyThemeToDocument(theme: Theme): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.classList.toggle('dark', theme === 'dark');
  root.style.colorScheme = theme;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // Start from the brand default so server/prerender output is stable; the
  // real stored value is picked up before paint in the layout effect below.
  const [theme, setThemeState] = useState<Theme>(DEFAULT_THEME);

  useLayoutEffect(() => {
    const stored = readStoredTheme();
    setThemeState(stored);
    applyThemeToDocument(stored);
  }, []);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    applyThemeToDocument(next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // localStorage may be unavailable; the in-memory state still applies.
    }
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme(theme === 'dark' ? 'light' : 'dark');
  }, [theme, setTheme]);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, isDark: theme === 'dark', setTheme, toggleTheme }),
    [theme, setTheme, toggleTheme]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

const FALLBACK: ThemeContextValue = {
  theme: DEFAULT_THEME,
  isDark: DEFAULT_THEME === 'dark',
  setTheme: () => {},
  toggleTheme: () => {},
};

/**
 * Read the current theme. Safe to call outside a ThemeProvider (returns the
 * dark default) so isolated components/tests keep working.
 */
export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext) ?? FALLBACK;
}
