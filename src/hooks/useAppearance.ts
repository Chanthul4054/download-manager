import { useEffect } from 'react';
import type { Settings } from '@/types/models';

const dark = window.matchMedia('(prefers-color-scheme: dark)');

/** Applies the theme (resolving "system") and the font size, which scales the whole UI. */
export function applyAppearance(a: Settings['appearance']) {
  const root = document.documentElement;
  root.dataset.theme = a.theme === 'system' ? (dark.matches ? 'dark' : 'light') : a.theme;
  root.style.fontSize = (a.fontSize || 13) + 'px';
}

export function useAppearance(a: Settings['appearance'] | undefined) {
  useEffect(() => {
    if (!a) return;
    applyAppearance(a);
    if (a.theme !== 'system') return;
    const onChange = () => applyAppearance(a);
    dark.addEventListener('change', onChange);
    return () => dark.removeEventListener('change', onChange);
  }, [a]);
}
