import {useEffect, useRef} from 'react';

const FOCUSABLE_SELECTOR = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Returns a ref to attach to the container. While mounted:
 * - Focuses the first focusable descendant on mount.
 * - Traps Tab/Shift+Tab cycling among focusable descendants.
 * - Restores focus to the previously active element on unmount.
 *
 * `initialFocus`, if provided, is a query selector evaluated within the
 * container for the element to focus on mount. If omitted, the first
 * focusable element is chosen.
 */
export function useFocusTrap<T extends HTMLElement = HTMLElement>(
    initialFocus?: string,
) {
    const ref = useRef<T>(null);

    useEffect(() => {
        const container = ref.current;
        if (!container) return;
        const previouslyFocused = document.activeElement as HTMLElement | null;

        // Initial focus.
        const target =
            (initialFocus && container.querySelector<HTMLElement>(initialFocus)) ||
            container.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) ||
            container;
        target.focus();

        const handler = (e: KeyboardEvent) => {
            if (e.key !== 'Tab') return;
            const focusables = Array.from(
                container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
            ).filter((el) => el.offsetParent !== null || el === document.activeElement);
            if (focusables.length === 0) {
                e.preventDefault();
                return;
            }
            const first = focusables[0];
            const last = focusables[focusables.length - 1];
            const active = document.activeElement as HTMLElement | null;
            if (e.shiftKey) {
                if (active === first || !container.contains(active)) {
                    e.preventDefault();
                    last.focus();
                }
            } else {
                if (active === last) {
                    e.preventDefault();
                    first.focus();
                }
            }
        };

        container.addEventListener('keydown', handler);
        return () => {
            container.removeEventListener('keydown', handler);
            if (previouslyFocused && document.contains(previouslyFocused)) {
                previouslyFocused.focus();
            }
        };
    }, [initialFocus]);

    return ref;
}
