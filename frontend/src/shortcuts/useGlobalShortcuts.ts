import {useEffect} from 'react';
import {COMMANDS, type CommandDef, type CommandId} from './commands';
import {matches} from './keys';

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

/**
 * The one and only global keydown listener. Mounted by ShortcutProvider.
 *
 * `run` returns false when nothing is subscribed to the command, in which case
 * we deliberately skip preventDefault so the key stays native.
 */
export function useGlobalShortcuts(run: (id: CommandId) => boolean, overlay: OverlayState) {
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            // Czech typing goes through dead keys (ˇ then s = š), which arrive
            // as composition events with key 'Dead' / keyCode 229.
            if (e.isComposing || e.keyCode === 229) return;
            // Holding Mod+R must not queue dozens of catalog scans.
            if (e.repeat) return;

            for (const cmd of COMMANDS) {
                for (const spec of cmd.keys) {
                    if (!matches(e, spec)) continue;

                    if (!scopeAllows(cmd, overlay)) return;

                    const firesWhileTyping = cmd.firesWhileTyping ?? spec.mod === true;
                    if (!firesWhileTyping && isTyping(e.target)) return;

                    const handled = run(cmd.id);
                    // An unregistered command is inert — leave the key native.
                    // The exception is a chord that shadows a destructive
                    // browser default (Mod+R reloads the webview and wipes all
                    // app state), which must be swallowed either way.
                    if (handled || cmd.alwaysPreventDefault) e.preventDefault();
                    return;
                }
            }
        };

        document.addEventListener('keydown', handler);
        return () => document.removeEventListener('keydown', handler);
    }, [run, overlay]);
}
