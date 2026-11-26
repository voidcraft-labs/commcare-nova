/**
 * Shared planners for the column slots that have their own granular mutation
 * semantics. Builder auto-save and the SA/MCP tool boundary must make the same
 * content-vs-visibility decision or one surface can reintroduce stale full-body
 * writes that another surface already avoids.
 */

import { produce } from "immer";
import { deepEqual } from "@/lib/doc/deepEqual";
import { wordingSourceUnit } from "@/lib/doc/localizationWorkspace";
import { applyMutations } from "@/lib/doc/mutations";
import type { Mutation, Uuid } from "@/lib/doc/types";
import type { BlueprintDoc, CaseListConfig, Column } from "@/lib/domain";
import {
	type CaseMappingRow,
	caseMappingTextUnit,
} from "@/lib/domain/caseMappingRows";
import {
	columnWordingRole,
	generatedWordingId,
	imageDescriptionWordingId,
} from "@/lib/domain/generatedWording";
import {
	effectiveAppLocalization,
	languageEntries,
	type TranslationEntry,
	type TranslationUnitId,
	translationSourceFingerprintsEqual,
} from "@/lib/domain/localization";
import { snapshotTranslationUnits } from "@/lib/domain/translationUnits";

type ColumnContent = NonNullable<
	Extract<Mutation, { kind: "updateColumn" }>["column"]
>;

/** The content owned by `updateColumn`; independent facets stay separate. */
export function columnContentSnapshot(column: Column): ColumnContent {
	const {
		uuid: _uuid,
		sort: _sort,
		tile: _tile,
		visibleInList: _visibleInList,
		visibleInDetail: _visibleInDetail,
		notOnList: _notOnList,
		...content
	} = column;
	return content;
}

/** Plan one add, preserving independent Results and Details placements. */
export function columnAddMutation(
	moduleUuid: Uuid,
	column: Column,
	placement: {
		readonly afterInList: Uuid | null;
		readonly afterInDetail: Uuid | null;
	},
): Extract<Mutation, { kind: "addColumn" }> {
	return {
		kind: "addColumn",
		moduleUuid,
		column,
		afterInList: placement.afterInList,
		afterInDetail: placement.afterInDetail,
	};
}

/**
 * Plan the independently mergeable tile-placement slot.
 *
 * Placement is deliberately its own write rather than part of a content
 * update: an author dragging a cell and a peer relabelling the same column
 * are edits to different things and must merge, exactly as a move and a
 * relabel already do.
 */
export function columnTileMutations(
	current: Column,
	next: Column,
	moduleUuid: Uuid,
): Mutation[] {
	if (deepEqual(current.tile, next.tile)) return [];
	return [
		{
			kind: "updateColumn",
			moduleUuid,
			uuid: next.uuid,
			tilePatch: next.tile ?? null,
		},
	];
}

/** Compare only the column body owned by `updateColumn`. */
export function columnContentEqualIgnoringGranularSlots(
	a: Column,
	b: Column,
): boolean {
	return deepEqual(stripGranularSlots(a), stripGranularSlots(b));
}

/** A column's list state: shown, hidden and still on the list, or held by
 *  the case's detail alone. */
function listState(column: Column): "shown" | "hidden" | "off" {
	if (column.visibleInList !== false) return "shown";
	return column.notOnList === true ? "off" : "hidden";
}

/**
 * Plan the independent Results/Details visibility changes between snapshots.
 * Results' change carries the column's whole list state, so taking a column
 * off the list or keeping it on is the same granular write as hiding it.
 */
export function columnVisibilityMutations(
	current: Column,
	next: Column,
	moduleUuid: Uuid,
): Mutation[] {
	const mutations: Mutation[] = [];
	const before = listState(current);
	const after = listState(next);
	if (before !== after) {
		mutations.push({
			kind: "updateColumn",
			moduleUuid,
			uuid: next.uuid,
			visibilityPatch:
				after === "shown"
					? { surface: "list", visible: true }
					: {
							surface: "list",
							visible: false,
							...((before === "off") !== (after === "off") && {
								notOnList: after === "off",
							}),
						},
		});
	}
	if (
		(current.visibleInDetail !== false) !==
		(next.visibleInDetail !== false)
	) {
		mutations.push({
			kind: "updateColumn",
			moduleUuid,
			uuid: next.uuid,
			visibilityPatch: {
				surface: "detail",
				visible: next.visibleInDetail !== false,
			},
		});
	}
	return mutations;
}

/** Plan the independently mergeable sort slot. */
export function columnSortMutations(
	current: Column,
	next: Column,
	moduleUuid: Uuid,
): Mutation[] {
	if (deepEqual(current.sort, next.sort)) return [];
	return [
		{
			kind: "updateColumn",
			moduleUuid,
			uuid: next.uuid,
			sortPatch: next.sort ?? null,
		},
	];
}

/**
 * Plan one workspace row replacement into independently mergeable content,
 * visibility, and Results/Details order writes. The reducer resolves every
 * mutation against the fresh column, so a stale inspector edit cannot erase a
 * peer's change to another slot.
 */
export function columnSnapshotMutations(
	moduleUuid: Uuid,
	current: Column,
	replacement: Column,
): Mutation[] {
	const next = { ...replacement, uuid: current.uuid } as Column;
	const mutations: Mutation[] = [];
	if (!columnContentEqualIgnoringGranularSlots(current, next)) {
		mutations.push({
			kind: "updateColumn",
			moduleUuid,
			uuid: current.uuid,
			column: columnContentSnapshot(next),
		});
	}
	mutations.push(...columnVisibilityMutations(current, next, moduleUuid));
	mutations.push(...columnSortMutations(current, next, moduleUuid));
	mutations.push(...columnTileMutations(current, next, moduleUuid));
	// No order arm: a column snapshot carries no place, so a content edit cannot
	// express a move and cannot clobber a concurrent one. Reordering is
	// `moveColumn` against the config's arrays, and nothing else.
	return mutations;
}

/**
 * Diff an editor-produced column snapshot without treating absence as remove.
 * Existing rows retain independently mergeable edits. Newly authored rows are
 * born at the end of each independent surface sequence, including the hidden
 * information created when an author adds a default-order rule.
 * Peer-added rows absent from a stale snapshot survive replay.
 */
export function columnSnapshotBatchMutations(
	moduleUuid: Uuid,
	current: CaseListConfig,
	next: readonly Column[],
): Mutation[] {
	const currentByUuid = new Map(
		current.columns.map((column) => [column.uuid, column] as const),
	);
	const mutations: Mutation[] = [];
	let afterInList = current.listColumnOrder.at(-1) ?? null;
	let afterInDetail = current.detailColumnOrder.at(-1) ?? null;
	for (const column of next) {
		const existing = currentByUuid.get(column.uuid);
		if (existing !== undefined) {
			mutations.push(...columnSnapshotMutations(moduleUuid, existing, column));
		} else {
			mutations.push(
				columnAddMutation(moduleUuid, column, { afterInList, afterInDetail }),
			);
			afterInList = column.uuid;
			afterInDetail = column.uuid;
		}
	}
	return mutations;
}

function stripGranularSlots(column: Column): unknown {
	const {
		sort: _sort,
		visibleInList: _visibleInList,
		visibleInDetail: _visibleInDetail,
		notOnList: _notOnList,
		tile: _tile,
		...content
	} = column;
	return content;
}

/**
 * The translations an edit in place carries from a mapping row's old text unit to its new one.
 * A row saved before rows carried identities is keyed by its saved value
 * (`caseMappingRows.ts::caseMappingTextUnit`), so giving it an identity (as it becomes a
 * condition) or changing that value moves its label, and an image row's description, to
 * another unit; the row is the same row, and so are its words in every language. Rows are
 * paired by place, and only where both lists hold the same number of rows and neither unit is
 * another row's. Each view's own wording of the row (its generated override, in the original
 * language too) moves with it. `before` clears each old entry while its unit still exists; `after`
 * writes it under the new unit once `columnMutations` (the column's update, as the gate reads it:
 * in the Builder, as its worker-language lens shapes it) has made that unit, so the batch is
 * `[...before, ...columnMutations, ...after]`. A language whose words the edit itself writes
 * under the new unit keeps those.
 *
 * An entry whose source no longer matches the new unit's (the edit changed the row's text too, or
 * the entry was already out of date) moves as the draft it is, out of date against the new unit,
 * as an edit in place leaves it: it is written against the new unit's source (`restoreAgainst`),
 * which target admission admits, rather than as a current translation, which it refuses.
 */
export function mappingRowTranslationCarry(
	doc: BlueprintDoc,
	current: Column,
	next: Column,
	columnMutations: readonly Mutation[],
): { readonly before: Mutation[]; readonly after: Mutation[] } {
	const before: Mutation[] = [];
	const after: Mutation[] = [];
	if (
		(current.kind !== "id-mapping" && current.kind !== "image-map") ||
		next.kind !== current.kind
	)
		return { before, after };
	const role = current.kind === "image-map" ? "image-description" : "mapping";
	const moves = mappingRowUnitMoves(
		current.uuid,
		current.mapping,
		next.mapping,
		role,
	);
	// Each moved row's own unit, and each view's own wording of it
	// (`generatedWording.ts`): an image rule's description by the rule, a
	// label by the unit it overrides.
	const pairs: { from: TranslationUnitId; to: TranslationUnitId }[] = [];
	for (const [index, move] of moves) {
		pairs.push(move);
		for (const search of [false, true])
			for (const detail of [false, true]) {
				const view = columnWordingRole(search, detail);
				pairs.push(
					current.kind === "image-map" && next.kind === "image-map"
						? {
								from: imageDescriptionWordingId(
									current.uuid,
									view,
									current.mapping[index],
								),
								to: imageDescriptionWordingId(
									current.uuid,
									view,
									next.mapping[index],
								),
							}
						: {
								from: generatedWordingId(current.uuid, view, move.from),
								to: generatedWordingId(current.uuid, view, move.to),
							},
				);
			}
	}
	const localization = effectiveAppLocalization(doc.localization);
	const moving: {
		language: string;
		to: TranslationUnitId;
		entry: TranslationEntry;
	}[] = [];
	for (const { from, to } of pairs) {
		if (from === to) continue;
		for (const language of localization.languageOrder) {
			const entry = languageEntries(localization, language)?.[from];
			if (entry === undefined) continue;
			before.push({
				kind: "setTranslation",
				language,
				unitId: from,
				entry: null,
			});
			moving.push({ language, to, entry });
		}
	}
	if (moving.length === 0) return { before, after };
	// The new units as admission reads each write: after the clears and the column's update, and
	// after each original-language wording already moved, which a generated unit's source reads.
	const sourceLanguage = localization.sourceLanguage;
	moving.sort(
		(left, right) =>
			Number(left.language !== sourceLanguage) -
			Number(right.language !== sourceLanguage),
	);
	let projected = produce(doc, (draft) => {
		applyMutations(draft, [...before, ...columnMutations]);
	});
	const written = new Set(
		columnMutations.flatMap((mutation) =>
			mutation.kind === "setTranslation"
				? [`${mutation.language}\u0000${mutation.unitId}`]
				: [],
		),
	);
	for (const { language, to, entry } of moving) {
		if (written.has(`${language}\u0000${to}`)) continue;
		const raw = snapshotTranslationUnits(projected).get(to);
		if (raw === undefined) continue;
		const unit = wordingSourceUnit(projected, raw);
		const restoring =
			entry.workerFallback !== undefined ||
			!translationSourceFingerprintsEqual(
				entry.sourceFingerprint,
				unit.sourceFingerprint,
			);
		const previous =
			languageEntries(
				effectiveAppLocalization(projected.localization),
				language,
			)?.[to] ?? null;
		const write: Mutation = {
			kind: "setTranslation",
			language,
			unitId: to,
			entry: structuredClone(entry),
			...(restoring && {
				restoreAgainst: {
					sourceFingerprint: unit.sourceFingerprint,
					previous: previous && structuredClone(previous),
				},
			}),
		};
		after.push(write);
		if (language === sourceLanguage)
			projected = produce(projected, (draft) => {
				applyMutations(draft, [write]);
			});
	}
	return { before, after };
}

/**
 * The mapping rows an edit in place moves to another text unit, by the place of the row in
 * `next`: rows are paired by place, only where both lists hold the same number of rows, and a
 * pair counts only where its units differ and neither unit is another row's. This is the one
 * pairing both the carry above and the Builder's language projection
 * (`projectBuilderLanguageMutations`) read, so an edit under a worker language reads a moved row
 * as the row it was rather than as new source content.
 */
export function mappingRowUnitMoves(
	columnUuid: Uuid,
	current: readonly CaseMappingRow[],
	next: readonly CaseMappingRow[],
	role: "mapping" | "image-description",
): ReadonlyMap<
	number,
	{ readonly from: TranslationUnitId; readonly to: TranslationUnitId }
> {
	const moves = new Map<
		number,
		{ readonly from: TranslationUnitId; readonly to: TranslationUnitId }
	>();
	if (next.length !== current.length) return moves;
	const was = current.map((row) => caseMappingTextUnit(columnUuid, row, role));
	const now = next.map((row) => caseMappingTextUnit(columnUuid, row, role));
	for (const [index, from] of was.entries()) {
		const to = now[index];
		if (
			to === undefined ||
			from === to ||
			now.includes(from) ||
			was.includes(to)
		)
			continue;
		moves.set(index, { from, to });
	}
	return moves;
}

function holdsLoadBehavior(column: Column | undefined): boolean {
	return (
		column !== undefined &&
		"loadBehavior" in column &&
		column.loadBehavior !== undefined
	);
}

/**
 * The case list's faster loading as the Builder's column edits keep it: one column's first load
 * behavior turns it on in the same save (`before` the column's update, so the column commits
 * with it on), and the edit or removal (`next` undefined) that clears the last behavior any
 * column holds turns it off (`after`). An edit that neither gives nor takes a behavior leaves the
 * setting as it is, so a list that holds faster loading with no column's choice (an app brought
 * in from CommCare HQ, or one a tool turned on) keeps it.
 */
export function fasterLoadingFollowsColumn(
	moduleUuid: Uuid,
	config: CaseListConfig,
	current: Column,
	next: Column | undefined,
): { readonly before: Mutation[]; readonly after: Mutation[] } {
	const had = holdsLoadBehavior(current);
	const has = holdsLoadBehavior(next);
	if (has && config.optimizations !== true)
		return {
			before: [
				{
					kind: "setCaseListMeta",
					uuid: moduleUuid,
					patch: { optimizations: true },
				},
			],
			after: [],
		};
	const othersHold = config.columns.some(
		(column) => column.uuid !== current.uuid && holdsLoadBehavior(column),
	);
	if (had && !has && !othersHold && config.optimizations === true)
		return {
			before: [],
			after: [
				{
					kind: "setCaseListMeta",
					uuid: moduleUuid,
					patch: { optimizations: null },
				},
			],
		};
	return { before: [], after: [] };
}
