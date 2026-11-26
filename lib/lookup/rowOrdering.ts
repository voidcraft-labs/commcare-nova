import { sql, type Transaction } from "kysely";
import type { AppDatabase } from "@/lib/db/pg";
import type { LookupRowId, LookupTableId } from "@/lib/domain/lookupIds";
import { LookupError } from "./errors";
import { keyBetween } from "./orderKeys";

export async function rowOrderForPlacement(
	tx: Transaction<AppDatabase>,
	projectId: string,
	tableId: LookupTableId,
	placement: { toIndex: number } | { afterRowId?: LookupRowId | null },
	movingId?: LookupRowId,
): Promise<string> {
	let siblings = tx
		.selectFrom("lookup_rows")
		.select(["id", "order_key"])
		.where("project_id", "=", projectId)
		.where("table_id", "=", tableId);
	if (movingId) siblings = siblings.where("id", "!=", movingId);
	let lower: string | null = null;
	if ("toIndex" in placement) {
		if (placement.toIndex > 0) {
			const before = await siblings
				.orderBy("order_key")
				.orderBy("id")
				.offset(placement.toIndex - 1)
				.limit(1)
				.executeTakeFirst();
			if (!before)
				throw new LookupError(
					"invalid_input",
					"That row position is no longer in this table.",
				);
			lower = before.order_key;
		}
	} else if (placement.afterRowId === undefined) {
		lower =
			(
				await siblings
					.orderBy("order_key", "desc")
					.orderBy("id", "desc")
					.limit(1)
					.executeTakeFirst()
			)?.order_key ?? null;
	} else if (placement.afterRowId !== null) {
		const anchor = await siblings
			.where("id", "=", placement.afterRowId)
			.executeTakeFirst();
		if (!anchor)
			throw new LookupError(
				"not_found",
				"The selected row is no longer in this table.",
			);
		lower = anchor.order_key;
	}
	// Equal keys are legal resting positions. Advance beyond a tied run
	// exactly as keysForSlot does for a resident column list.
	const upper = await (lower === null
		? siblings
		: siblings.where("order_key", ">", lower)
	)
		.orderBy("order_key")
		.orderBy("id")
		.limit(1)
		.executeTakeFirst();
	return keyBetween(lower, upper?.order_key ?? null);
}

export async function rowIndex(
	tx: Transaction<AppDatabase>,
	projectId: string,
	tableId: LookupTableId,
	rowId: LookupRowId,
): Promise<number> {
	const result = await sql<{ index: number }>`
		SELECT (SELECT count(*)::integer FROM lookup_rows r WHERE r.project_id=a.project_id AND r.table_id=a.table_id
			AND (r.order_key,r.id)<(a.order_key,a.id)) AS index
		FROM lookup_rows a WHERE a.project_id=${projectId} AND a.table_id=${tableId} AND a.id=${rowId}::uuid
	`.execute(tx);
	const row = result.rows[0];
	if (!row)
		throw new LookupError(
			"not_found",
			"The selected row is no longer in this table.",
		);
	return row.index;
}
