// components/builder/appTree/insertion/interleaveInsertions.ts
//
// Interleave hover-reveal insertion points between tree rows — the shape the
// module list (AppTree) and a module's form list (ModuleCard) both need: a
// leading insertion point, then each rendered row followed by a trailing one,
// UNLESS suppressed (the app is locked or a search filter is active), where
// only the rows render. Homing the leading-vs-trailing split, the suppress
// gate, the `atIndex` math, and the stable insertion keys here keeps the two
// call sites from drifting (an off-by-one fixed in one but not the other).

import type { ReactNode } from "react";

interface InterleaveOpts<T> {
	/** Render rows only, no insertion points — locked app or active filter. */
	readonly suppress: boolean;
	/** Render a row; return `null` to omit it (e.g. filtered out by search). */
	readonly renderItem: (item: T, index: number) => ReactNode | null;
	/** Render the insertion point that inserts at `atIndex`, under `key`. */
	readonly renderInsertion: (atIndex: number, key: string) => ReactNode;
	/** Stable key fragment for the insertion AFTER `item` (never an array index). */
	readonly itemKey: (item: T) => string;
}

export function interleaveInsertions<T>(
	items: readonly T[],
	{ suppress, renderItem, renderInsertion, itemKey }: InterleaveOpts<T>,
): ReactNode[] {
	const nodes: ReactNode[] = [];
	if (!suppress) nodes.push(renderInsertion(0, "ins-lead"));
	items.forEach((item, index) => {
		const row = renderItem(item, index);
		if (row == null) return;
		nodes.push(row);
		if (!suppress) {
			nodes.push(renderInsertion(index + 1, `ins-after-${itemKey(item)}`));
		}
	});
	return nodes;
}
