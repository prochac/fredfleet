import {useEffect, useRef} from 'react';
import {COMMANDS, type CommandDef, type CommandId} from './commands';
import {CHORD_TIMEOUT_MS, matches, type KeySpec} from './keys';

export type OverlayState = 'none' | 'palette' | 'modal';

const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

function scopeAllows(cmd: CommandDef, overlay: OverlayState): boolean {
    if (overlay === 'none') return true;
    if (overlay === 'palette') return cmd.scope === 'palette';
    return false;
}

function isTyping(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    if (!el) return false;
    return TYPING_TAGS.has(el.tagName) || el.isContentEditable === true;
}

type Candidate = {cmd: CommandDef; chord: KeySpec[]};

/**
 * The one and only global keydown listener. Mounted by ShortcutProvider.
 *
 * `run` returns false when nothing is subscribed to the command, in which case
 * we deliberately skip preventDefault so the key stays native.
 */
export function useGlobalShortcuts(run: (id: CommandId) => boolean, overlay: OverlayState) {
    // A half-typed chord (`g` waiting for its second key) lives across events,
    // so it is a ref rather than state — re-rendering the whole app between
    // two keystrokes would be absurd.
    const pending = useRef<{step: number; candidates: Candidate[]} | null>(null);
    const timer = useRef<number | null>(null);

    useEffect(() => {
        const clearPending = () => {
            pending.current = null;
            if (timer.current !== null) {
                window.clearTimeout(timer.current);
                timer.current = null;
            }
        };

        const armTimeout = () => {
            if (timer.current !== null) window.clearTimeout(timer.current);
            // Abandon a chord nobody finished, so the next unrelated keystroke
            // is not swallowed by a mode the user forgot they were in.
            timer.current = window.setTimeout(clearPending, CHORD_TIMEOUT_MS);
        };

        const handler = (e: KeyboardEvent) => {
            // Czech typing goes through dead keys (ˇ then s = š), which arrive
            // as composition events with key 'Dead' / keyCode 229.
            if (e.isComposing || e.keyCode === 229) return;
            // Holding Mod+R must not queue dozens of catalog scans.
            if (e.repeat) return;

            const typing = isTyping(e.target);

            // --- continue a chord already in progress ---
            if (pending.current) {
                if (e.key === 'Escape') {
                    clearPending();
                    return;
                }
                const {step, candidates} = pending.current;
                const survivors: Candidate[] = [];
                for (const c of candidates) {
                    if (!matches(e, c.chord[step])) continue;
                    if (step + 1 === c.chord.length) {
                        clearPending();
                        if (scopeAllows(c.cmd, overlay) && run(c.cmd.id)) e.preventDefault();
                        return;
                    }
                    survivors.push(c);
                }
                if (survivors.length > 0) {
                    pending.current = {step: step + 1, candidates: survivors};
                    armTimeout();
                    e.preventDefault();
                    return;
                }
                // Nothing matched: drop the chord and let this key be itself.
                clearPending();
            }

            // --- single-key and modifier bindings ---
            for (const cmd of COMMANDS) {
                for (const spec of cmd.keys) {
                    if (!matches(e, spec)) continue;

                    if (!scopeAllows(cmd, overlay)) return;

                    const firesWhileTyping = cmd.firesWhileTyping ?? spec.mod === true;
                    if (!firesWhileTyping && typing) return;

                    const handled = run(cmd.id);
                    // An unregistered command is inert — leave the key native.
                    // The exception is a chord that shadows a destructive
                    // browser default (Mod+R reloads the webview and wipes all
                    // app state), which must be swallowed either way.
                    if (handled || cmd.alwaysPreventDefault) e.preventDefault();
                    return;
                }
            }

            // --- start a chord ---
            // Last, so a single-key binding always wins over a sequence that
            // happens to begin with the same key. Never while typing: `g` is a
            // letter long before it is a prefix.
            if (typing || overlay !== 'none') return;
            const starters: Candidate[] = [];
            for (const cmd of COMMANDS) {
                for (const chord of cmd.chords ?? []) {
                    if (chord.length > 0 && matches(e, chord[0])) starters.push({cmd, chord});
                }
            }
            if (starters.length > 0) {
                pending.current = {step: 1, candidates: starters};
                armTimeout();
                e.preventDefault();
            }
        };

        document.addEventListener('keydown', handler);
        return () => {
            document.removeEventListener('keydown', handler);
            clearPending();
        };
    }, [run, overlay]);
}
