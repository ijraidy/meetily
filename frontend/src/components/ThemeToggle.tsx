'use client';

import { Moon, Sun } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTheme, type Theme } from '@/contexts/ThemeContext';

const OPTIONS: { value: Theme; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
];

interface ThemeToggleProps {
  className?: string;
}

/** Small segmented control that switches between the light and dark themes. */
export function ThemeToggle({ className }: ThemeToggleProps) {
  const { theme, setTheme } = useTheme();

  return (
    <div
      role="radiogroup"
      aria-label="Appearance"
      className={cn(
        'inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-gray-100 p-1',
        className
      )}
    >
      {OPTIONS.map(({ value, label, icon: Icon }) => {
        const active = theme === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => setTheme(value)}
            className={cn(
              'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500',
              active
                ? 'bg-white text-gray-900 shadow-sm'
                : 'text-gray-600 hover:text-gray-900'
            )}
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
            {label}
          </button>
        );
      })}
    </div>
  );
}

export default ThemeToggle;
