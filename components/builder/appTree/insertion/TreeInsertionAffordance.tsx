// components/builder/appTree/insertion/TreeInsertionAffordance.tsx
//
// The hover-reveal "+" affordance between app-tree rows — the tree analog of
// the form canvas's `InsertionPoint`. The Base UI Menu/Popover TRIGGER itself
// is the affordance: a full-width, click-anywhere strip that EXPANDS on hover
// (or while its menu/popover is open) so the revealed "+" circle gets room and
// never overlaps the rows above/below. Two exports the menu/popover hosts
// compose:
//   - INSERTION_TRIGGER_CLS — spread onto the `Menu.Trigger` / `Popover.Trigger`.
//   - TreeInsertionLine     — the violet lines + "+" circle rendered inside it.

"use client";
import { Icon } from "@iconify/react/offline";
import tablerPlus from "@iconify-icons/tabler/plus";

/**
 * The insertion trigger: a full-width, pointer-cursor strip (so the WHOLE line
 * is clickable, not just the "+") that grows from a thin idle gap to ~32px on
 * hover or while its popup is open — giving the 20px "+" circle clearance so it
 * doesn't cut into adjacent rows (mirrors the form canvas's expand). `group` +
 * `data-[popup-open]` drive `TreeInsertionLine`'s reveal.
 */
export const INSERTION_TRIGGER_CLS =
	"group relative block w-full cursor-pointer outline-none h-3.5 " +
	"hover:h-8 data-[popup-open]:h-8 transition-[height] duration-150 ease-out";

/**
 * The violet flanking lines + centered "+" circle, faded in on hover/open. All
 * inline (`<span>`) elements so the markup is valid inside the trigger's
 * `<button>`, and `pointer-events-none` so clicks fall through to the trigger —
 * the entire strip is the click target, not just the circle.
 */
export function TreeInsertionLine() {
	return (
		<span className="pointer-events-none absolute inset-x-3 top-1/2 flex -translate-y-1/2 items-center gap-1.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-data-[popup-open]:opacity-100">
			<span className="h-px flex-1 bg-nova-violet/40" />
			<span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-nova-violet/40 bg-nova-surface text-nova-violet">
				<Icon icon={tablerPlus} width="12" height="12" />
			</span>
			<span className="h-px flex-1 bg-nova-violet/40" />
		</span>
	);
}
