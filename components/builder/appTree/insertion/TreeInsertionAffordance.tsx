// components/builder/appTree/insertion/TreeInsertionAffordance.tsx
//
// The hover-reveal "+" gap between tree rows — the app-tree analog of the form
// canvas's `InsertionPoint`. A thin gap that, on hover (or while its menu is
// open), expands to show violet flanking lines around a "+" trigger. The
// trigger itself (a Base UI `Menu.Trigger` / `Popover.Trigger`) is passed in by
// the caller as `children`, so this stays a pure layout/visibility shell — no
// menu logic, no virtualizer/cursor-speed machinery (the tree is a short,
// non-virtualized list, unlike the form canvas).

"use client";
import type { ReactNode } from "react";

/** Shared circular "+" trigger styling — matches the form canvas insertion
 *  point so the two affordances read as one language. Callers spread this onto
 *  the Base UI trigger element. */
export const INSERTION_TRIGGER_CLS =
	"w-5 h-5 flex items-center justify-center rounded-full bg-nova-surface border border-nova-violet/40 text-nova-violet hover:bg-nova-violet/10 transition-colors cursor-pointer shrink-0 outline-none";

interface TreeInsertionAffordanceProps {
	/** Keep the affordance revealed while its menu/popover is open (the gap
	 *  loses hover once the pointer moves into the portal-rendered popup). */
	readonly open?: boolean;
	/** The Base UI trigger element (styled with `INSERTION_TRIGGER_CLS`). */
	readonly children: ReactNode;
}

export function TreeInsertionAffordance({
	open = false,
	children,
}: TreeInsertionAffordanceProps) {
	return (
		<div className="group relative h-3.5" data-tree-insertion>
			<div
				className={`absolute inset-x-3 top-1/2 -translate-y-1/2 flex items-center gap-1.5 transition-opacity duration-150 ${
					open
						? "opacity-100"
						: "opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto"
				}`}
			>
				<div className="flex-1 h-px bg-nova-violet/40" />
				{children}
				<div className="flex-1 h-px bg-nova-violet/40" />
			</div>
		</div>
	);
}
