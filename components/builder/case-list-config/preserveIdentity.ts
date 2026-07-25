/**
 * Carry an existing case-list item's identity and every persisted display
 * position onto a rebuilt body.
 *
 * The column / search-input editors rebuild the body (`preservedColumnSwap`,
 * `simpleSearchInputDef` / `advancedSearchInputDef`) without re-emitting these
 * slots, so a bare replace through the workspace's wholesale
 * `updateModule({ caseListConfig })` path would drop the `order` key — sorting
 * the item ahead of its keyed siblings under `bySortKey` until a reload's
 * backfill — and, if the rebuild re-minted a uuid, read as a remove+add (a lost
 * identity) on the auto-save diff. Applying this at the workspace level makes
 * the preservation independent of whichever editor produced the body.
 *
 * A tile cell is one more such position, and losing it costs more than a
 * sequence key: a column that a tile SHOWS has to hold a place, so a
 * rebuild that dropped the cell would be refused outright by the commit
 * gate — changing a field's display style would read as broken.
 */
export function withPreservedIdentity<
	T extends {
		uuid?: string;
		order?: string;
		listOrder?: string;
		detailOrder?: string;
		tile?: unknown;
	},
>(existing: T, next: T): T {
	return {
		...next,
		uuid: existing.uuid,
		...(existing.order !== undefined && { order: existing.order }),
		...(existing.listOrder !== undefined && {
			listOrder: existing.listOrder,
		}),
		...(existing.detailOrder !== undefined && {
			detailOrder: existing.detailOrder,
		}),
		...(existing.tile !== undefined && { tile: existing.tile }),
	};
}
