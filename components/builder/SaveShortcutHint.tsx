/**
 * Platform-aware keyboard shortcut hints for multi-line editors that save on Cmd/Ctrl+Enter.
 *
 * Both say the same thing in the same words ("⌘ Return to save" / "Ctrl Enter
 * to save"); they differ only in the chrome they sit in.
 *
 * - `SaveShortcutHint`: quiet label-row hint, sits at `ml-auto`
 * - `ToolbarSaveHint`: the same hint inside a floating toolbar
 */

"use client";

import { ENTER_LABEL, MOD_SYMBOL } from "@/lib/platform";

/**
 * Inline hint for label rows: sits at `ml-auto` inside a flex container.
 * A quiet sentence-case hint at label size.
 */
export function SaveShortcutHint() {
	return (
		<span className="ml-auto text-xs text-nova-text-secondary font-normal whitespace-nowrap">
			{MOD_SYMBOL} {ENTER_LABEL} to save
		</span>
	);
}

/**
 * Compact hint for floating toolbars: blends with toolbar button chrome.
 *
 * It says the same thing as {@link SaveShortcutHint} in the same words: one
 * gesture should not be announced two ways in one session, and the previous
 * 10px glyph form ("⌘⏎ save") was also a step below the type scale's floor.
 * Only the surrounding chrome differs, so only the padding does.
 */
export function ToolbarSaveHint() {
	return (
		<span className="text-xs text-nova-text-secondary px-1 flex items-center whitespace-nowrap select-none">
			{MOD_SYMBOL} {ENTER_LABEL} to save
		</span>
	);
}
