/**
 * Platform-aware keyboard shortcut hints for multi-line editors that save on Cmd/Ctrl+Enter.
 *
 * Two variants:
 * - `SaveShortcutHint`: quiet label-row hint (e.g. "⌘ Return to save" / "Ctrl Enter to save")
 * - `ToolbarSaveHint`: compact inline hint for floating toolbars (e.g. "⌘⏎ save" / "Ctrl⏎ save")
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
 * Uses a return symbol (⏎) instead of spelling out "RETURN/ENTER".
 */
export function ToolbarSaveHint() {
	return (
		<span className="text-[10px] text-nova-text-muted px-1 flex items-center whitespace-nowrap select-none">
			{MOD_SYMBOL}⏎ save
		</span>
	);
}
