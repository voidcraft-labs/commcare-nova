/**
 * Carry an existing case-list item's identity and its tile placement onto a
 * rebuilt body.
 *
 * Column and search-input editors rebuild their content before the workspace
 * lowers the replacement into granular mutations. Carrying the saved identity
 * keeps the edit attached to the same item, including when a factory minted a
 * new UUID. A column's saved placement survives the content replacement too.
 *
 * Sequence is NOT among the slots this carries: Results and Details order live
 * in the config's two arrays, which a column-body rebuild cannot reach. A tile
 * cell is the one position that does live on the item, and losing it costs
 * more than a place in a list: a column the tile SHOWS has to hold a square,
 * so a rebuild that dropped the cell would be refused outright by the commit
 * gate, and changing a field's display style would read as broken.
 */
export function withPreservedIdentity<
	T extends { uuid: string; tile?: unknown },
>(existing: T, next: T): T {
	return {
		...next,
		uuid: existing.uuid,
		...(existing.tile !== undefined && { tile: existing.tile }),
	};
}
