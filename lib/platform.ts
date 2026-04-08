/**
 * Platform detection and keyboard shortcut formatting.
 *
 * Single source of truth for Mac-vs-other detection and shortcut display.
 * Mac shortcuts use symbol glyphs without separators (⌘⇧Z).
 * Non-Mac shortcuts use word labels joined with "+" (Ctrl+Shift+Z).
 *
 * Usage:
 *   shortcutLabel("mod", "Z")           → "⌘Z" / "Ctrl+Z"
 *   shortcutLabel("mod", "shift", "Z")  → "⌘⇧Z" / "Ctrl+Shift+Z"
 *   MOD_SYMBOL                           → "⌘" / "Ctrl"
 *   ENTER_LABEL                          → "RETURN" / "ENTER"
 */

/** Cached platform detection — safe in client code (only runs in the browser). */
export const IS_MAC =
	typeof navigator !== "undefined" &&
	/Mac|iPod|iPhone|iPad/.test(navigator.userAgent);

/** Modifier-token → display-symbol map, keyed by platform. */
const SYMBOLS: Record<string, string> = IS_MAC
	? {
			mod: "⌘",
			ctrl: "⌃",
			shift: "⇧",
			alt: "⌥",
			enter: "⏎",
			escape: "⎋",
			backspace: "Del",
			delete: "⌦",
			capslock: "⇪",
		}
	: {
			mod: "Ctrl",
			ctrl: "Ctrl",
			shift: "Shift",
			alt: "Alt",
			enter: "Enter",
			escape: "Esc",
			backspace: "Backspace",
			delete: "Delete",
			capslock: "CapsLock",
		};

/** The platform modifier symbol alone — "⌘" on Mac, "Ctrl" on non-Mac. */
export const MOD_SYMBOL = SYMBOLS.mod;

/** Platform-aware enter key label — "RETURN" on Mac, "ENTER" on non-Mac (uppercase for hint UIs). */
export const ENTER_LABEL = IS_MAC ? "RETURN" : "ENTER";

/**
 * Format a keyboard shortcut for display.
 *
 * Pass modifier tokens (lowercase) and a final key (uppercase):
 *   shortcutLabel("mod", "Z")           → "⌘Z" / "Ctrl+Z"
 *   shortcutLabel("mod", "shift", "Z")  → "⌘⇧Z" / "Ctrl+Shift+Z"
 *
 * Tokens are resolved via the platform symbol map. Unrecognized tokens
 * pass through unchanged (e.g. a final "Z" or "D" stays as-is).
 */
export function shortcutLabel(...tokens: string[]): string {
	const formatted = tokens.map(
		(t) => SYMBOLS[t.toLowerCase()] ?? t.toUpperCase(),
	);
	return IS_MAC ? formatted.join("") : formatted.join("+");
}
