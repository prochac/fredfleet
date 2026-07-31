import {useSyncExternalStore} from 'react';
import {
    WindowSetDarkTheme,
    WindowSetLightTheme,
    WindowSetSystemDefaultTheme,
} from '../wailsjs/runtime/runtime';

/** What the user picked. 'system' follows the OS and is the default. */
export type ThemePreference = 'system' | 'light' | 'dark';
/** What that resolves to right now — the only thing the CSS cares about. */
export type ResolvedTheme = 'light' | 'dark';

const MEDIA = '(prefers-color-scheme: dark)';
// WebKitGTK keeps localStorage under ~/.local/share/fredfleet, so the choice
// survives a restart. If a platform ever drops it we fall back to 'system',
// which is the right default anyway.
const STORAGE_KEY = 'fredfleet.theme';

const CYCLE: ThemePreference[] = ['system', 'light', 'dark'];

let preference: ThemePreference = load();
let resolved: ResolvedTheme = resolve(preference);
const listeners = new Set<() => void>();

function load(): ThemePreference {
    try {
        const v = localStorage.getItem(STORAGE_KEY);
        if (v === 'system' || v === 'light' || v === 'dark') return v;
    } catch {
        // Private mode or a webview without storage — 'system' is fine.
    }
    return 'system';
}

function systemTheme(): ResolvedTheme {
    return window.matchMedia(MEDIA).matches ? 'dark' : 'light';
}

function resolve(p: ThemePreference): ResolvedTheme {
    return p === 'system' ? systemTheme() : p;
}

function apply() {
    const root = document.documentElement;
    root.dataset.theme = resolved;
    // Tells the engine to render form controls, scrollbars and the default
    // canvas dark. Without it WebKit paints a white scrollbar track next to a
    // dark table, and <select> popups come up light.
    root.style.colorScheme = resolved;

    // Windows-only in effect (window chrome); no-ops on Linux and macOS, where
    // the native appearance follows the OS. Keep the pinned choice honest on
    // the platform that can honour it.
    try {
        if (preference === 'system') WindowSetSystemDefaultTheme();
        else if (preference === 'dark') WindowSetDarkTheme();
        else WindowSetLightTheme();
    } catch {
        // Runtime not injected (plain `vite dev`) — CSS still switches.
    }
}

function update(next: ThemePreference) {
    preference = next;
    resolved = resolve(next);
    apply();
    for (const l of listeners) l();
}

export function setThemePreference(next: ThemePreference) {
    if (next !== preference) {
        try {
            localStorage.setItem(STORAGE_KEY, next);
        } catch {
            // Not persisting is survivable; the session still switches.
        }
    }
    update(next);
}

/** system → light → dark → system. What the sidebar button and Mod+Shift+D do. */
export function cycleThemePreference() {
    setThemePreference(CYCLE[(CYCLE.indexOf(preference) + 1) % CYCLE.length]);
}

/**
 * Applies the stored preference and starts following the OS. Called once from
 * App; the returned cleanup detaches the media listener.
 */
export function initTheme(): () => void {
    const mq = window.matchMedia(MEDIA);
    // Only meaningful under 'system', but staying subscribed means switching
    // back to 'system' picks up an OS change that happened while pinned.
    const handler = () => update(preference);
    mq.addEventListener('change', handler);
    apply();
    return () => mq.removeEventListener('change', handler);
}

function subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
}

export function useTheme(): {preference: ThemePreference; resolved: ResolvedTheme} {
    return {
        preference: useSyncExternalStore(subscribe, () => preference),
        resolved: useSyncExternalStore(subscribe, () => resolved),
    };
}

// Applied at import time, before React's first paint, so a dark-mode user
// never sees a white flash.
apply();
