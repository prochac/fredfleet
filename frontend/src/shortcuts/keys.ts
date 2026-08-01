import {Environment} from '../../wailsjs/runtime/runtime';

export type Platform = 'darwin' | 'linux' | 'windows';

function guessPlatform(): Platform {
    const ua = navigator.userAgent;
    if (/Mac|iPhone|iPad|iPod/.test(ua)) return 'darwin';
    if (/Win/.test(ua)) return 'windows';
    return 'linux';
}

// Wails' Environment() is authoritative but async, so seed from the user agent
// for the first paint and correct it once the runtime answers.
let platform: Platform = guessPlatform();

export function getPlatform(): Platform {
    return platform;
}

export async function initPlatform(): Promise<Platform> {
    try {
        const env = await Environment();
        if (env.platform === 'darwin' || env.platform === 'linux' || env.platform === 'windows') {
            platform = env.platform;
        }
    } catch {
        // Keep the user-agent guess — a wrong modifier is better than no shortcuts.
    }
    return platform;
}

/**
 * A single key combination.
 *
 * Use `code` (the physical key) for digits and punctuation: on a Czech layout
 * the number row produces ěščřžýáíé and digits need Shift, so matching `key`
 * would leave Mod+1 dead. Use `key` for letters, which is what users expect
 * when they switch layouts.
 */
export type KeySpec = {
    code?: string;
    key?: string;
    /** Cmd on macOS, Ctrl everywhere else. Defaults to false. */
    mod?: boolean;
    /**
     * Defaults to false — Shift must be *absent* unless stated, so Mod+Shift+R
     * can never be swallowed by Mod+R. Use 'any' when Shift is incidental:
     * `?` is Shift+/ on US and Shift+, on Czech, and Mod+digit chords are
     * often typed with Shift on layouts whose number row needs it.
     */
    shift?: boolean | 'any';
};

export function isModifierPressed(e: KeyboardEvent): boolean {
    return getPlatform() === 'darwin' ? e.metaKey : e.ctrlKey;
}

export function matches(e: KeyboardEvent, spec: KeySpec): boolean {
    if (isModifierPressed(e) !== (spec.mod === true)) return false;

    // The *other* platform modifier must stay clear, so macOS Ctrl+K (native
    // "kill to end of line") never fires our Cmd+K.
    const other = getPlatform() === 'darwin' ? e.ctrlKey : e.metaKey;
    if (other) return false;

    // AltGr reports as ctrlKey+altKey on Windows and Linux, and AltGr is how a
    // Czech layout types [ ] { } @ \ | — AltGr+F is '['. Without this, typing a
    // bracket into a filter value would fire (and preventDefault) a Mod chord.
    if (e.altKey) return false;

    const wantShift = spec.shift ?? false;
    if (wantShift !== 'any' && e.shiftKey !== wantShift) return false;

    // Synthetic and virtual-keyboard events carry an empty code; a code-based
    // spec must not match everything in that case.
    if (spec.code) return e.code !== '' && e.code === spec.code;
    if (spec.key) return e.key.toLowerCase() === spec.key.toLowerCase();
    return false;
}

/**
 * A key sequence typed one key after another, vim-style: `g` then `t`.
 *
 * Chords carry no modifier — that is the point of them — so they only fire
 * when focus is not in a text field, and the dispatcher gives up on a
 * half-typed one after CHORD_TIMEOUT_MS rather than leaving the keyboard in a
 * mode the user cannot see.
 */
export type ChordSpec = KeySpec[];

export const CHORD_TIMEOUT_MS = 1500;

const CODE_LABELS: Record<string, string> = {
    Comma: ',',
    Digit0: '0',
    Digit1: '1',
    Digit2: '2',
    Digit3: '3',
    Digit4: '4',
    Slash: '/',
    Escape: 'Esc',
};

function keyLabel(spec: KeySpec): string {
    if (spec.code) return CODE_LABELS[spec.code] ?? spec.code;
    const k = spec.key ?? '';
    return k.length === 1 ? k.toUpperCase() : k;
}

/** Render a spec as <kbd> tokens, e.g. ['⌘', 'K'] on macOS, ['Ctrl', 'K'] elsewhere. */
export function formatShortcut(spec: KeySpec): string[] {
    const mac = getPlatform() === 'darwin';
    const parts: string[] = [];
    if (spec.mod) parts.push(mac ? '⌘' : 'Ctrl');
    // 'any' means Shift is incidental to the layout, not part of the chord.
    if (spec.shift === true) parts.push(mac ? '⇧' : 'Shift');
    parts.push(keyLabel(spec));
    return parts;
}

/**
 * Renders a sequence as one token per step — ['G', 'T'] for `g` then `t`.
 * The help dialog joins them with "then" rather than "+", because pressing
 * them together is exactly what does *not* work.
 */
export function formatChord(chord: ChordSpec): string[] {
    return chord.map((spec) => formatShortcut(spec).join('+'));
}
