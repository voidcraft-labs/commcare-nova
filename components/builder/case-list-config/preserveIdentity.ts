/**
 * Carry an existing case-list item's identity and its tile placement onto a
 * rebuilt body.
 *
 * The column / search-input editors rebuild the body (`preservedColumnSwap`,
 * `simpleSearchInputDef` / `advancedSearchInputDef`) without re-emitting these
 * slots, so a bare replace through the workspace's wholesale
 * `updateModule({ caseListConfig })` path would read as a remove+add, a lost
 * identity: on the auto-save diff whenever the rebuild re-minted a uuid.
 * Applying this at the workspace level makes the preservation independent of
 * whichever editor produced the body.
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
