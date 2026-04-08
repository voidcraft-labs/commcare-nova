/**
 * Platform-aware keyboard shortcut hints for multi-line editors that save on Cmd/Ctrl+Enter.
 *
 * Two variants:
 * - `SaveShortcutHint` — uppercase label-row hint (e.g. "⌘ + RETURN TO SAVE" / "Ctrl + ENTER TO SAVE")
 * - `ToolbarSaveHint` — compact inline hint for floating toolbars (e.g. "⌘⏎ save" / "Ctrl⏎ save")
 */

"use client";

import { ENTER_LABEL, MOD_SYMBOL } from "@/lib/platform";

/**
 * Inline hint for label rows — sits at `ml-auto` inside a flex container.
 * Matches the existing uppercase label style at a smaller font size.
 */
export function SaveShortcutHint() {
	return (
		<span className="ml-auto text-[10px] tracking-normal text-nova-text-secondary font-normal whitespace-nowrap">
			{MOD_SYMBOL} + {ENTER_LABEL} TO SAVE
		</span>
	);
}

/**
 * Compact hint for floating toolbars — blends with toolbar button chrome.
 * Uses a return symbol (⏎) instead of spelling out "RETURN/ENTER".
 */
export function ToolbarSaveHint() {
	return (
		<span className="text-[10px] text-nova-text-muted/60 px-1 flex items-center whitespace-nowrap select-none">
			{MOD_SYMBOL}⏎ save
		</span>
	);
}
