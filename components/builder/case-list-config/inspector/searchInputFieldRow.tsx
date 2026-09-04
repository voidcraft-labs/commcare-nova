// components/builder/case-list-config/inspector/searchInputFieldRow.tsx
//
// The one label + control + quiet hint stack the Search field inspectors
// share, so a visible field and a hidden value read as the same surface.

"use client";

import type { ReactNode } from "react";

/** Friendly sentence-case label + control + quiet hint. */
export function FieldRow({
	label,
	hint,
	children,
}: {
	readonly label: string;
	readonly hint?: string;
	readonly children: ReactNode;
}) {
	return (
		/* `gap`, not `space-y`. This row holds popup TRIGGERS, and Base UI mounts
		 * `position: fixed` focus guards as their siblings while a popup is open.
		 * Tailwind's space utilities are sibling-counting (`> :not(:last-child)`),
		 * so those guards change which children are "last" and the spacing moves
		 * under the open popup. `gap` spaces the children of a flex container
		 * without reference to their count or order, so an out-of-flow helper
		 * appearing mid-row cannot shift anything. */
		<div className="flex flex-col gap-2">
			<div className="text-[13px] font-medium leading-5 text-nova-text-secondary">
				{label}
			</div>
			{children}
			{hint !== undefined && (
				<p className="text-[13px] leading-relaxed text-nova-text-muted">
					{hint}
				</p>
			)}
		</div>
	);
}
