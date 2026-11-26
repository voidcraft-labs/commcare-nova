/** Web Apps rounds the number of twelve columns each element gets, then
 * starts a new row before an element that would overflow its current row.
 * A zero count produces Infinity and a count over 24 produces zero. Neither
 * has a Bootstrap column class; the element occupies the full available row. */
export function questionColumnWidth(count: string | undefined): number {
	return count === undefined ? 12 : Math.round(12 / Number(count));
}

export function questionRows<T>(
	items: readonly T[],
	countOf: (item: T) => string | undefined,
) {
	const rows: { item: T; columns: number }[][] = [];
	let used = 0;
	for (const item of items) {
		const width = questionColumnWidth(countOf(item));
		if (!rows.length || used + width > 12) {
			rows.push([]);
			used = 0;
		}
		rows[rows.length - 1].push({
			item,
			columns: Number.isFinite(width) && width > 0 ? width : 12,
		});
		used += width;
	}
	return rows;
}
