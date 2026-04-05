/**
 * Keyboard shortcut hints for multi-line editors that use Cmd/Ctrl+Enter to save.
 *
 * Two variants:
 * - `SaveShortcutHint` — uppercase label-row hint ("⌘ + RETURN TO SAVE")
 * - `ToolbarSaveHint` — compact inline hint for floating toolbars ("⌘⏎ save")
 *
 * Platform detection is pre-computed at module load — safe because both variants
 * are client components that only run in the browser.
 */

"use client";

/** Pre-computed at module load — safe in client components (always in the browser). */
const isMac =
	typeof navigator !== "undefined" &&
	/Macintosh|Mac OS|iPhone|iPad/.test(navigator.userAgent);

const modifier = isMac ? "⌘" : "Ctrl";
const enterLabel = isMac ? "RETURN" : "ENTER";

/**
 * Inline hint for label rows — sits at `ml-auto` inside a flex container.
 * Matches the existing uppercase label style at a smaller font size.
 */
export function SaveShortcutHint() {
	return (
		<span className="ml-auto text-[10px] tracking-normal text-nova-text-secondary font-normal whitespace-nowrap">
			{modifier} + {enterLabel} TO SAVE
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
			{modifier}⏎ save
		</span>
	);
}
