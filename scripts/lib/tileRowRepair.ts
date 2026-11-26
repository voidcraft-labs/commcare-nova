/**
 * The one-time repair of saved case tiles to the rows CommCare HQ's own pages
 * keep: a row for each field a screen shows, at least six
 * (`lib/domain/modules.ts::tileRowLimit`). Before it, Nova let a cell reach any
 * row up to twelve; HQ's Case List and Case Detail pages offer a start row and
 * height only up to `max(columns, 6)` and their next save moves a cell past
 * that to the first row or makes it one row tall (proof 4 over
 * `targeted-tile-row-bound`), and Nova's gate now refuses such a cell.
 *
 * The repair, decided from what each runtime draws, and moving nothing
 * silently (every move is a line of the reviewed plan, with its reason):
 *
 * 1. **Empty rows go first, from the bottom up, only as many as it takes.** A
 *    row no stored cell covers draws nothing. Web Apps sizes each tile row to
 *    its content (`cloudcare/partials/case_list/cell_grid_style.html`,
 *    `grid-template-rows: repeat(n, min-content)`, no gap), and so does
 *    Preview (`lib/preview/caseTileLayout.ts::tileGridTemplateRows`), so an
 *    empty row there is no height and removing it changes nothing a worker
 *    sees. Android gives every row of a tile the same height and sizes the
 *    tile by its row count (`views/EntityViewTile.java`,
 *    `setCellWidthAndHeight`, `computeNumTilesPerScreen`), so on Android the
 *    tile loses that blank band and is that much shorter; nothing else moves
 *    relative to anything else. Grouped Results retain their header depth:
 *    a case row can move only within the per-case band, since moving it
 *    into the header would show only the first case's value.
 * 2. **Only where no empty row is left to remove**, each cell still below the
 *    rows is fitted back as an edit that removes a field fits it
 *    (`lib/domain/tilePlacement.ts::fitTileCellIntoRows`): raised in its own
 *    columns, else the first free place of its size, else shorter. That one
 *    changes what a worker sees on both platforms, which is why the plan names
 *    it apart (`how: "fitted"`) for the reviewer.
 *
 * A tile that fits is never touched. Production holds no app published to
 * CommCare HQ with a custom tile, so no HQ-held app changes under a repair.
 */
import { z } from "zod";
import { loadCanonicalBlueprintAtSequence } from "@/lib/agent/change-set/baseLoader";
import { caseTileGrouping } from "@/lib/commcare/validator/rules/case-list/caseTileGrouping";
import { caseTileLayout } from "@/lib/commcare/validator/rules/case-list/caseTileLayout";
import { lockActorGenerationGateForAppHolder } from "@/lib/db/actorGenerationGate";
import { appendSyntheticBatchInTransaction } from "@/lib/db/apps";
import { LEASE_COLUMNS, leaseView } from "@/lib/db/leaseView";
import { getAppDb, withAppTx } from "@/lib/db/pg";
import { designSessionLeaseState, runLeaseState } from "@/lib/db/runLiveness";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
import {
	type BlueprintDoc,
	type CaseListConfig,
	detailsTileFieldCount,
	type PersistableDoc,
	resultsTileFieldCount,
	type TileCell,
	tileCellBottomEdge,
	tileCellSchema,
	tileRowLimit,
	type Uuid,
} from "@/lib/domain";
import { fitTileCellIntoRows } from "@/lib/domain/tilePlacement";
import { uuidSchema } from "@/lib/domain/uuid";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import {
	nextPersistedSequence,
	safePersistedSequence,
} from "@/lib/utils/persistedSequence";
import {
	loadPersistedBlueprintInTransaction,
	loadPersistedBlueprintReadOnly,
} from "./loadPersistedBlueprint";

const moveSchema = z.strictObject({
	moduleUuid: uuidSchema,
	screen: z.enum(["results", "details"]),
	columnUuid: uuidSchema,
	before: tileCellSchema,
	after: tileCellSchema,
	how: z.enum(["empty-rows-removed", "fitted"]),
});
export type TileRowMove = z.infer<typeof moveSchema>;

export const tileRowRepairSchema = z.strictObject({
	appId: z.string().min(1),
	expectedBaseSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
	baseDigest: z.string().min(1),
	targetDigest: z.string().min(1),
	reason: z.string().min(1),
	moves: z.array(moveSchema).min(1),
});
export type TileRowRepair = z.infer<typeof tileRowRepairSchema>;

const ACTOR = "system:tile-rows";

/**
 * One screen's cells fitted into `rows`: empty rows removed from the bottom up
 * while any cell ends below `rows`, then each cell still below fitted around
 * the cells `drawn` says are drawn. Rows before `firstRow` form a fixed
 * header. Returns the moves in cell order.
 */
function fitScreen(
	cells: ReadonlyMap<Uuid, TileCell>,
	rows: number,
	drawn: (uuid: Uuid) => boolean,
	firstRow = 0,
): Map<Uuid, { after: TileCell; how: TileRowMove["how"] }> {
	const current = new Map(cells);
	const moved = new Map<Uuid, { after: TileCell; how: TileRowMove["how"] }>();
	const bottom = () =>
		Math.max(0, ...[...current.values()].map(tileCellBottomEdge));
	for (let row = bottom() - 1; row >= firstRow && bottom() > rows; row--) {
		const covered = [...current.values()].some(
			(cell) => cell.y <= row && row < tileCellBottomEdge(cell),
		);
		if (covered) continue;
		for (const [uuid, cell] of current) {
			if (cell.y <= row) continue;
			const after = { ...cell, y: cell.y - 1 };
			current.set(uuid, after);
			moved.set(uuid, { after, how: "empty-rows-removed" });
		}
	}
	for (const [uuid, cell] of current) {
		if (tileCellBottomEdge(cell) <= rows) continue;
		// Keep any cell in the header in place. If the header itself exceeds
		// the row limit or a case cell has no safe place, certification will
		// report the remaining findings for manual review.
		if (cell.y < firstRow || firstRow >= rows) continue;
		const intoBand = (cell: TileCell) => ({ ...cell, y: cell.y - firstRow });
		const others = (onlyDrawn: boolean) =>
			[...current]
				.filter(
					([other, placed]) =>
						other !== uuid &&
						tileCellBottomEdge(placed) > firstRow &&
						(!onlyDrawn || drawn(other)),
				)
				.map(([, placed]) => intoBand(placed));
		const bandCell = intoBand(cell);
		const bandRows = rows - firstRow;
		const fitted =
			fitTileCellIntoRows(bandCell, others(false), bandRows) ??
			fitTileCellIntoRows(bandCell, others(true), bandRows);
		if (fitted === null) continue;
		const after = { ...fitted, y: fitted.y + firstRow };
		current.set(uuid, after);
		moved.set(uuid, { after, how: "fitted" });
	}
	return moved;
}

/** The moves that fit every saved tile of `doc` into its rows, in module order. */
export function tileRowMoves(doc: BlueprintDoc): TileRowMove[] {
	const moves: TileRowMove[] = [];
	for (const moduleUuid of doc.moduleOrder) {
		const config = doc.modules[moduleUuid]?.caseListConfig;
		if (!config) continue;
		const results = new Map(
			config.columns.flatMap((column) =>
				column.tile ? [[column.uuid, column.tile] as const] : [],
			),
		);
		const shownOnResults = new Set(
			config.columns
				.filter((column) => column.visibleInList !== false)
				.map((column) => column.uuid),
		);
		for (const [columnUuid, { after, how }] of fitScreen(
			results,
			tileRowLimit(resultsTileFieldCount(config)),
			(uuid) => shownOnResults.has(uuid),
			config.tile?.grouping?.headerRows,
		)) {
			const before = results.get(columnUuid) as TileCell;
			moves.push({
				moduleUuid,
				screen: "results",
				columnUuid,
				before,
				after,
				how,
			});
		}
		const details = new Map(
			Object.entries(config.detailTile?.cells ?? {}) as [Uuid, TileCell][],
		);
		for (const [columnUuid, { after, how }] of fitScreen(
			details,
			tileRowLimit(detailsTileFieldCount(config)),
			() => true,
		)) {
			const before = details.get(columnUuid) as TileCell;
			moves.push({
				moduleUuid,
				screen: "details",
				columnUuid,
				before,
				after,
				how,
			});
		}
	}
	return moves;
}

/** `before` with each move applied: the repaired document. Throws where a
 *  move's cell is not the one the document holds. */
export function repairedTileRows(
	before: PersistableDoc,
	moves: readonly TileRowMove[],
): PersistableDoc {
	const target = hydratePersistedBlueprint(structuredClone(before));
	for (const move of moves) {
		const config: CaseListConfig | undefined =
			target.modules[move.moduleUuid]?.caseListConfig;
		const held =
			move.screen === "results"
				? config?.columns.find((column) => column.uuid === move.columnUuid)
						?.tile
				: config?.detailTile?.cells[move.columnUuid];
		if (
			!config ||
			canonicalJsonDigest(held) !== canonicalJsonDigest(move.before)
		)
			throw new Error("A tile cell differs from its reviewed repair basis.");
		if (move.screen === "results") {
			config.columns = config.columns.map((column) =>
				column.uuid === move.columnUuid
					? { ...column, tile: move.after }
					: column,
			);
		} else if (config.detailTile) {
			config.detailTile = {
				cells: { ...config.detailTile.cells, [move.columnUuid]: move.after },
			};
		}
	}
	return toPersistableDoc(target);
}

/** A row move has to preserve every tile's geometry and group bands. */
function tileFindings(doc: BlueprintDoc) {
	return doc.moduleOrder.flatMap((uuid) => {
		const module = doc.modules[uuid];
		return module === undefined
			? []
			: [
					...caseTileLayout(module, uuid, doc),
					...caseTileGrouping(module, uuid, doc),
				];
	});
}

/** Read one app from one snapshot: its tile findings and the repair plan that
 *  fits them, certified to leave no tile finding behind. */
export async function inspectTileRows(appId: string) {
	const db = await getAppDb();
	return db
		.transaction()
		.setIsolationLevel("repeatable read")
		.setAccessMode("read only")
		.execute(async (tx) => {
			const app = await tx
				.selectFrom("apps")
				.select(["id", "mutation_seq"])
				.where("id", "=", appId)
				.executeTakeFirstOrThrow();
			const blueprint = await loadPersistedBlueprintReadOnly(tx, appId);
			if (!blueprint) throw new Error("App disappeared.");
			const doc = hydratePersistedBlueprint(structuredClone(blueprint));
			const moves = tileRowMoves(doc);
			const findings = tileFindings(doc);
			if (moves.length === 0)
				return { appId, findings, plan: null, left: findings };
			const target = repairedTileRows(blueprint, moves);
			const left = tileFindings(
				hydratePersistedBlueprint(structuredClone(target)),
			);
			if (left.length > 0) return { appId, findings, plan: null, left };
			const plan: TileRowRepair = {
				appId,
				expectedBaseSeq: safePersistedSequence(app.mutation_seq),
				baseDigest: canonicalJsonDigest(blueprint),
				targetDigest: canonicalJsonDigest(target),
				reason:
					"Fit each saved case tile into the rows CommCare HQ's own pages keep: a row for each field, at least six",
				moves,
			};
			return { appId, findings, plan, left };
		});
}

export async function migrateTileRows(plan: TileRowRepair) {
	return withAppTx(async (tx) => {
		await lockActorGenerationGateForAppHolder(tx, plan.appId);
		const app = await tx
			.selectFrom("apps")
			.select(["id", "mutation_seq", ...LEASE_COLUMNS])
			.where("id", "=", plan.appId)
			.forUpdate()
			.executeTakeFirstOrThrow();
		const sessions = await tx
			.selectFrom("design_sessions")
			.selectAll()
			.where("app_id", "=", plan.appId)
			.orderBy("id")
			.forUpdate()
			.execute();
		const lease = runLeaseState(leaseView(app));
		if (
			lease.present ||
			lease.markerSettleable ||
			sessions.some((session) => {
				const state = designSessionLeaseState(session);
				return state.present || state.markerSettleable;
			})
		)
			throw new Error("A run or unsettled reservation still holds this app.");
		const batchId = `tile-rows:${canonicalJsonDigest(plan)}`;
		const receipt = await tx
			.selectFrom("app_changes")
			.select(["seq", "actor_id", "kind"])
			.where("app_id", "=", plan.appId)
			.where("batch_id", "=", batchId)
			.executeTakeFirst();
		if (receipt) {
			if (
				receipt.actor_id !== ACTOR ||
				receipt.kind !== "blueprint-migration" ||
				safePersistedSequence(receipt.seq) !==
					nextPersistedSequence(plan.expectedBaseSeq)
			)
				throw new Error("Repair receipt does not match its plan.");
			await loadCanonicalBlueprintAtSequence(tx, {
				appId: plan.appId,
				seq: safePersistedSequence(receipt.seq),
				expectedDigest: plan.targetDigest,
			});
			return { appId: plan.appId, status: "already-applied" };
		}
		const before = await loadPersistedBlueprintInTransaction(tx, plan.appId);
		if (
			before === null ||
			safePersistedSequence(app.mutation_seq) !== plan.expectedBaseSeq ||
			canonicalJsonDigest(before) !== plan.baseDigest
		)
			throw new Error(
				"App differs from its reviewed repair basis. Scan and review it again.",
			);
		const recomputed = tileRowMoves(
			hydratePersistedBlueprint(structuredClone(before)),
		);
		if (canonicalJsonDigest(recomputed) !== canonicalJsonDigest(plan.moves))
			throw new Error("Repair moves do not match its plan.");
		const targetDoc = repairedTileRows(before, plan.moves);
		if (canonicalJsonDigest(targetDoc) !== plan.targetDigest)
			throw new Error("Repair target does not match its plan.");
		if (
			tileFindings(hydratePersistedBlueprint(structuredClone(targetDoc))).length
		)
			throw new Error(
				"This tile still needs a manual repair. Review its layout before applying a plan.",
			);
		const result = await appendSyntheticBatchInTransaction(tx, {
			appId: plan.appId,
			expectedBaseSeq: plan.expectedBaseSeq,
			targetDoc,
			batchId,
			authority: { kind: "system", actorId: ACTOR, reason: plan.reason },
		});
		await loadCanonicalBlueprintAtSequence(tx, {
			appId: plan.appId,
			seq: result.seq,
			expectedDigest: plan.targetDigest,
		});
		return { appId: plan.appId, status: result.kind, seq: result.seq };
	});
}
