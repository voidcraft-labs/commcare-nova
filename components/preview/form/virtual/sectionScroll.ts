/**
 * Flipbook parity for sectioned forms: the pure arithmetic behind
 * "edit→preview opens the page the canvas was scrolled to, preview→edit
 * lands on that page's heading".
 *
 * `VirtualFormList` saves the virtualizer's offset + measured row sizes on
 * unmount and replays them as `initialOffset` / `initialMeasurementsCache`
 * on the next mount. On a sectioned form it ALSO remembers which page the
 * first visible row belonged to, and on mount it compares that page with
 * the one the preview pager left active: if they differ, the restored
 * offset would open on the wrong page, so the list starts at the page's
 * heading instead. Both answers come from these helpers so they can be
 * unit-tested against a row list and a measurements snapshot without a
 * DOM or a virtualizer.
 */

import type { VirtualItem } from "@tanstack/react-virtual";
import type { Uuid } from "@/lib/doc/types";
import type { FormRow } from "./rowModel";

/** The section whose page holds the row at `index`: the nearest
 *  `section-header` at or above it. `undefined` above the first heading
 *  (a sectionless form, or the root insertion row before page one). */
export function sectionOfRowIndex(
	rows: readonly FormRow[],
	index: number,
): Uuid | undefined {
	for (let i = Math.min(index, rows.length - 1); i >= 0; i--) {
		const row = rows[i];
		if (row?.kind === "section-header") return row.uuid;
	}
	return undefined;
}

/** The page a viewer at row `index` is looking at: the nearest header at
 *  or above it, else the first header below (the root insertion gap above
 *  page one shows page one). `undefined` only on a sectionless form. */
export function sectionShownAtRow(
	rows: readonly FormRow[],
	index: number,
): Uuid | undefined {
	const above = sectionOfRowIndex(rows, index);
	if (above !== undefined) return above;
	for (let i = Math.max(index, 0); i < rows.length; i++) {
		const row = rows[i];
		if (row?.kind === "section-header") return row.uuid;
	}
	return undefined;
}

/** Row index of a section's heading, or -1 when the form has no such page. */
export function sectionHeaderIndex(
	rows: readonly FormRow[],
	sectionUuid: string,
): number {
	return rows.findIndex(
		(row) => row.kind === "section-header" && row.uuid === sectionUuid,
	);
}

/** The index of the first row whose extent reaches `offset`, read from the
 *  saved measurements (the same items the virtualizer restores from). An
 *  offset past the measured extent resolves to the last measured row;
 *  no measurements at all resolves to row 0. */
export function firstRowIndexAtOffset(
	measurements: readonly VirtualItem[],
	offset: number,
): number {
	let last = 0;
	for (const item of measurements) {
		last = item.index;
		if (item.start + item.size > offset) return item.index;
	}
	return last;
}

/** The scroll offset at which row `index` sits at the top: the sum of the
 *  sizes of every row before it, measured where a measurement exists and
 *  estimated otherwise. */
export function offsetOfRowIndex(
	index: number,
	measurements: readonly VirtualItem[],
	estimateSize: (index: number) => number,
): number {
	const measured = new Map<number, number>();
	for (const item of measurements) measured.set(item.index, item.size);
	let offset = 0;
	for (let i = 0; i < index; i++) {
		offset += measured.get(i) ?? estimateSize(i);
	}
	return offset;
}

/**
 * Where a remount of the edit canvas should start. `saved` is the scroll
 * the canvas remembered on its last unmount; `activeSection` is the page
 * the preview pager left active (undefined when it never paged). The
 * saved offset wins whenever it already shows that page (or there is no
 * page to honour); otherwise the page's heading is the top row.
 */
export function initialEditOffset(args: {
	readonly rows: readonly FormRow[];
	readonly saved:
		| { readonly offset: number; readonly measurements: VirtualItem[] }
		| undefined;
	/** The session slot holds the uuid as a plain string. */
	readonly activeSection: string | undefined;
	readonly estimateSize: (index: number) => number;
}): number {
	const { rows, saved, activeSection, estimateSize } = args;
	if (activeSection === undefined) return saved?.offset ?? 0;
	const headerIndex = sectionHeaderIndex(rows, activeSection);
	if (headerIndex < 0) return saved?.offset ?? 0;
	if (saved !== undefined) {
		const firstRow = firstRowIndexAtOffset(saved.measurements, saved.offset);
		if (sectionOfRowIndex(rows, firstRow) === activeSection) {
			return saved.offset;
		}
	}
	return offsetOfRowIndex(headerIndex, saved?.measurements ?? [], estimateSize);
}
