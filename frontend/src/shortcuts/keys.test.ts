import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {KeySpec} from './keys';

// keys.ts reads navigator.userAgent at module load to seed the platform before
// Wails' async Environment() answers, so each platform needs a fresh module
// instance with the user agent already in place.
const UA = {
    linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15',
    darwin: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
    windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
};

async function loadKeys(platform: keyof typeof UA) {
    vi.resetModules();
    vi.stubGlobal('navigator', {userAgent: UA[platform]});
    return import('./keys');
}

/** A KeyboardEvent stand-in carrying only the fields matches() reads. */
function ev(init: Partial<KeyboardEvent>): KeyboardEvent {
    return {
        key: '',
        code: '',
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        ...init,
    } as KeyboardEvent;
}

beforeEach(() => {
    vi.stubGlobal('navigator', {userAgent: UA.linux});
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
});

describe('platform detection', () => {
    it('reads the platform off the user agent', async () => {
        expect((await loadKeys('darwin')).getPlatform()).toBe('darwin');
        expect((await loadKeys('windows')).getPlatform()).toBe('windows');
        expect((await loadKeys('linux')).getPlatform()).toBe('linux');
    });
});

describe('matches — the platform modifier', () => {
    const modK: KeySpec = {key: 'k', mod: true};

    it('is Ctrl off macOS and Cmd on macOS', async () => {
        const linux = await loadKeys('linux');
        expect(linux.matches(ev({key: 'k', ctrlKey: true}), modK)).toBe(true);
        expect(linux.matches(ev({key: 'k', metaKey: true}), modK)).toBe(false);

        const mac = await loadKeys('darwin');
        expect(mac.matches(ev({key: 'k', metaKey: true}), modK)).toBe(true);
        expect(mac.matches(ev({key: 'k', ctrlKey: true}), modK)).toBe(false);
    });

    it('rejects the other platform modifier being held too', async () => {
        // macOS Ctrl+K is "kill to end of line"; Cmd+Ctrl+K must not fire ours.
        const mac = await loadKeys('darwin');
        expect(mac.matches(ev({key: 'k', metaKey: true, ctrlKey: true}), modK)).toBe(false);
    });

    it('rejects a bare key when the spec wants the modifier', async () => {
        const linux = await loadKeys('linux');
        expect(linux.matches(ev({key: 'k'}), modK)).toBe(false);
    });

    it('rejects a modified key when the spec wants it bare', async () => {
        const linux = await loadKeys('linux');
        // '?' is a bare chord; Ctrl+? must stay native.
        expect(linux.matches(ev({key: '?', shiftKey: true, ctrlKey: true}), {key: '?', shift: 'any'})).toBe(false);
    });
});

describe('matches — AltGr', () => {
    // AltGr reports as ctrlKey+altKey on Windows and Linux, and AltGr is how a
    // Czech layout types [ ] { } @ \ |. AltGr+F is '[' — typing it into a
    // filter value must not fire, and preventDefault, Mod+F.
    it('never fires while Alt is held', async () => {
        for (const platform of ['linux', 'windows'] as const) {
            const keys = await loadKeys(platform);
            const altGrF = ev({key: '[', code: 'KeyF', ctrlKey: true, altKey: true});
            expect(keys.matches(altGrF, {key: 'f', mod: true})).toBe(false);
            expect(keys.matches(altGrF, {code: 'KeyF', mod: true})).toBe(false);
        }
    });

    it('ignores Option chords on macOS too', async () => {
        const mac = await loadKeys('darwin');
        expect(mac.matches(ev({key: 'f', metaKey: true, altKey: true}), {key: 'f', mod: true})).toBe(false);
    });
});

describe('matches — Shift', () => {
    it('keeps Mod+R and Mod+Shift+R apart', async () => {
        const keys = await loadKeys('linux');
        const modR: KeySpec = {key: 'r', mod: true};
        const modShiftR: KeySpec = {key: 'r', mod: true, shift: true};

        const plain = ev({key: 'r', ctrlKey: true});
        const shifted = ev({key: 'R', ctrlKey: true, shiftKey: true});

        expect(keys.matches(plain, modR)).toBe(true);
        expect(keys.matches(plain, modShiftR)).toBe(false);
        // Shift must be absent unless asked for, or Mod+Shift+R (refresh the
        // whole index) would also trigger Mod+R (refresh this table).
        expect(keys.matches(shifted, modR)).toBe(false);
        expect(keys.matches(shifted, modShiftR)).toBe(true);
    });

    it("treats shift: 'any' as incidental", async () => {
        const keys = await loadKeys('linux');
        // The Czech number row needs Shift for digits, so Mod+1 arrives with
        // and without it depending on the layout.
        const spec: KeySpec = {code: 'Digit1', mod: true, shift: 'any'};
        expect(keys.matches(ev({code: 'Digit1', ctrlKey: true}), spec)).toBe(true);
        expect(keys.matches(ev({code: 'Digit1', ctrlKey: true, shiftKey: true}), spec)).toBe(true);
    });
});

describe('matches — code vs key', () => {
    it('matches digits by physical key, whatever the layout produces', async () => {
        const keys = await loadKeys('linux');
        const spec: KeySpec = {code: 'Digit1', mod: true, shift: 'any'};
        // A Czech layout unshifted number row yields 'ě' on Digit1; matching
        // e.key would leave Mod+1 dead there.
        expect(keys.matches(ev({key: 'ě', code: 'Digit1', ctrlKey: true}), spec)).toBe(true);
        expect(keys.matches(ev({key: '1', code: 'Digit1', ctrlKey: true, shiftKey: true}), spec)).toBe(true);
    });

    it('matches letters by key, so a Dvorak user gets the same chord', async () => {
        const keys = await loadKeys('linux');
        expect(keys.matches(ev({key: 'K', code: 'KeyV', ctrlKey: true}), {key: 'k', mod: true})).toBe(true);
    });

    it('never matches a code spec against an empty code', async () => {
        const keys = await loadKeys('linux');
        // Virtual keyboards and synthetic events carry code: ''.
        expect(keys.matches(ev({key: '1', code: '', ctrlKey: true}), {code: 'Digit1', mod: true, shift: 'any'})).toBe(false);
    });

    it('rejects a spec with neither code nor key', async () => {
        const keys = await loadKeys('linux');
        expect(keys.matches(ev({key: 'k', ctrlKey: true}), {mod: true})).toBe(false);
    });
});

describe('formatShortcut', () => {
    it('renders macOS glyphs and spelled-out modifiers elsewhere', async () => {
        const mac = await loadKeys('darwin');
        expect(mac.formatShortcut({key: 'k', mod: true})).toEqual(['⌘', 'K']);
        expect(mac.formatShortcut({key: 'd', mod: true, shift: true})).toEqual(['⌘', '⇧', 'D']);

        const linux = await loadKeys('linux');
        expect(linux.formatShortcut({key: 'k', mod: true})).toEqual(['Ctrl', 'K']);
        expect(linux.formatShortcut({key: 'd', mod: true, shift: true})).toEqual(['Ctrl', 'Shift', 'D']);
    });

    it('labels codes by what the key prints, not its code name', async () => {
        const keys = await loadKeys('linux');
        expect(keys.formatShortcut({code: 'Digit1', mod: true, shift: 'any'})).toEqual(['Ctrl', '1']);
        expect(keys.formatShortcut({code: 'Comma', mod: true})).toEqual(['Ctrl', ',']);
        expect(keys.formatShortcut({code: 'Escape'})).toEqual(['Esc']);
    });

    it("omits Shift when it is incidental", async () => {
        const keys = await loadKeys('linux');
        // The help dialog must not advertise Ctrl+Shift+1 for what is Ctrl+1.
        expect(keys.formatShortcut({code: 'Digit1', mod: true, shift: 'any'})).not.toContain('Shift');
    });
});
