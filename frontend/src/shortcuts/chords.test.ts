import {describe, expect, it} from 'vitest';
import {COMMANDS} from './commands';
import {formatChord, matches, type KeySpec} from './keys';

/**
 * The chord *dispatcher* lives in a React hook and needs a DOM to exercise;
 * what is pinned here is the part that decides whether a keystroke advances a
 * sequence — plus the invariants of the chord table itself, which are the
 * things that break silently when a binding is added later.
 */

function press(over: Partial<KeyboardEvent> = {}): KeyboardEvent {
    return {
        key: 'g',
        code: 'KeyG',
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        ...over,
    } as KeyboardEvent;
}

const chordCommands = COMMANDS.filter((c) => (c.chords?.length ?? 0) > 0);

describe('the chord table', () => {
    it('binds some sequences at all', () => {
        expect(chordCommands.length).toBeGreaterThan(0);
    });

    it('never puts a modifier in a sequence', () => {
        // A chord is typed one key after another; a modifier step would be a
        // different kind of binding and the dispatcher does not treat it as one.
        for (const cmd of chordCommands) {
            for (const chord of cmd.chords!) {
                for (const step of chord) {
                    expect(step.mod, `${cmd.id}`).not.toBe(true);
                }
            }
        }
    });

    it('has at least two steps in every sequence', () => {
        for (const cmd of chordCommands) {
            for (const chord of cmd.chords!) {
                expect(chord.length, `${cmd.id}`).toBeGreaterThanOrEqual(2);
            }
        }
    });

    it('leaves every sequence prefix unbound as a single key', () => {
        // A single-key binding wins over a sequence that starts with the same
        // key, which would make the sequence unreachable.
        const singles = COMMANDS.flatMap((c) => c.keys).filter((k) => !k.mod);
        for (const cmd of chordCommands) {
            for (const chord of cmd.chords!) {
                const first = chord[0];
                const clash = singles.find(
                    (s) => s.key && first.key && s.key.toLowerCase() === first.key.toLowerCase(),
                );
                expect(clash, `${cmd.id} starts with a key that is also bound alone`).toBeUndefined();
            }
        }
    });

    it('does not bind the same sequence to two commands', () => {
        const seen = new Map<string, string>();
        for (const cmd of chordCommands) {
            for (const chord of cmd.chords!) {
                const sig = formatChord(chord).join(' ');
                expect(seen.get(sig), `${sig} is bound twice`).toBeUndefined();
                seen.set(sig, cmd.id);
            }
        }
    });

    it('uses physical codes for digit steps, so they survive a Czech layout', () => {
        // Same reasoning as the Mod+digit bindings: the Czech number row types
        // ěščřžýáíé and digits need Shift.
        for (const cmd of chordCommands) {
            for (const chord of cmd.chords!) {
                for (const step of chord) {
                    if (step.key && /^\d$/.test(step.key)) {
                        throw new Error(`${cmd.id} matches a digit by key, not by code`);
                    }
                    if (step.code?.startsWith('Digit')) {
                        expect(step.shift, `${cmd.id}`).toBe('any');
                    }
                }
            }
        }
    });
});

describe('advancing a sequence', () => {
    const gt = chordCommands.find((c) => c.id === 'focus.tree')!.chords![0];

    it('matches the first step on a bare key', () => {
        expect(matches(press({key: 'g', code: 'KeyG'}), gt[0])).toBe(true);
    });

    it('does not match the first step when a modifier is held', () => {
        expect(matches(press({key: 'g', code: 'KeyG', ctrlKey: true}), gt[0])).toBe(false);
        // AltGr arrives as ctrl+alt on Linux and Windows, and is how a Czech
        // layout types brackets — it must never start a sequence.
        expect(matches(press({key: 'g', ctrlKey: true, altKey: true}), gt[0])).toBe(false);
    });

    it('matches the second step and rejects an unrelated key', () => {
        expect(matches(press({key: 't', code: 'KeyT'}), gt[1])).toBe(true);
        expect(matches(press({key: 'x', code: 'KeyX'}), gt[1])).toBe(false);
    });

    it('matches a digit step by position, with or without Shift', () => {
        const g1 = chordCommands.find((c) => c.id === 'tab.preview')!.chords![0];
        expect(matches(press({key: '1', code: 'Digit1'}), g1[1])).toBe(true);
        // Czech layout: the same physical key, shifted, still means "1".
        expect(matches(press({key: '+', code: 'Digit1', shiftKey: true}), g1[1])).toBe(true);
    });
});

describe('formatChord', () => {
    it('renders one token per step rather than a joined combination', () => {
        expect(formatChord([{key: 'g'}, {key: 't'}])).toEqual(['G', 'T']);
    });

    it('labels a digit step by the digit it stands for', () => {
        expect(formatChord([{key: 'g'}, {code: 'Digit1', shift: 'any'}])).toEqual(['G', '1']);
    });
});

describe('the `/` binding', () => {
    const filter = COMMANDS.find((c) => c.id === 'focus.filter')!;

    it('exists and carries no modifier, so it can be typed vim-style', () => {
        const slash = filter.keys.find((k) => k.key === '/');
        expect(slash).toBeDefined();
        expect(slash!.mod).toBeUndefined();
    });

    it('tolerates Shift, because `/` needs it on some layouts', () => {
        const slash = filter.keys.find((k) => k.key === '/')!;
        expect(slash.shift).toBe('any');
        expect(matches(press({key: '/', code: 'Slash', shiftKey: true}), slash)).toBe(true);
    });

    it('keeps Mod+F alongside it', () => {
        // Mod+F still has to work from inside a filter input, which the
        // per-spec firesWhileTyping default handles — `/` there is a literal
        // slash the user is typing into a value.
        expect(filter.keys.some((k) => k.key === 'f' && k.mod)).toBe(true);
        expect(filter.firesWhileTyping).toBeUndefined();
    });
});
