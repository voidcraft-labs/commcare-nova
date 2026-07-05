/**
 * Carry an existing case-list item's IDENTITY (`uuid`) and DISPLAY POSITION
 * (`order`) onto a rebuilt body.
 *
 * The column / search-input editors rebuild the body (`preservedColumnSwap`,
 * `simpleSearchInputDef` / `advancedSearchInputDef`) without re-emitting these
 * slots, so a bare replace through the workspace's wholesale
 * `updateModule({ caseListConfig })` path would drop the `order` key — sorting
 * the item ahead of its keyed siblings under `bySortKey` until a reload's
 * backfill — and, if the rebuild re-minted a uuid, read as a remove+add (a lost
 * identity) on the auto-save diff. Applying this at the workspace level makes
 * the preservation independent of whichever editor produced the body.
 */
export function withPreservedIdentity<
	T extends { uuid?: string; order?: string },
>(existing: T, next: T): T {
	return {
		...next,
		uuid: existing.uuid,
		...(existing.order !== undefined && { order: existing.order }),
	};
}
