import "server-only";
import { sql } from "kysely";
import { withAppTx } from "@/lib/db/pg";
import { LookupError } from "../errors";
import { lookupSourceFactsSchema } from "../source";
import { type InventoryAccess, lockInventoryScope } from "./scope";

export interface InventoryCursor {
	generationId: string;
	ordinal: number;
	byteOffset: number;
}

export async function readInventoryStatus(
	access: InventoryAccess,
	verifiedScope?: string,
) {
	return withAppTx(async (tx) => {
		const { table, scopeDigest } = await lockInventoryScope(tx, access);
		if (verifiedScope !== undefined && verifiedScope !== scopeDigest)
			throw new LookupError(
				"not_found",
				"The connection changed. You can reopen the inventory.",
			);
		const source = lookupSourceFactsSchema.safeParse(
			table.hq_canonical?.source,
		);
		const distribution = source.success ? source.data.distribution : "global";
		const { scope, tableId } = access;
		const active = await sql<{
			id: string;
			next_ordinal: string;
			started_at: Date;
			through_digest: string;
		}>`SELECT id,next_ordinal,started_at,through_digest
			FROM lookup_generations WHERE project_id=${scope.projectId} AND table_id=${tableId} AND id=${table.active_generation_id}
			AND state='complete' AND scope_digest=${scopeDigest}`.execute(tx);
		const staged = await sql<{
			id: string;
			next_ordinal: string;
			expires_at: Date;
		}>`SELECT id,next_ordinal,expires_at FROM lookup_generations
			WHERE project_id=${scope.projectId} AND table_id=${tableId} AND state IN ('staging','paused') AND actor_id=${scope.actorId}
			AND scope_digest=${scopeDigest} AND expires_at>clock_timestamp()`.execute(
			tx,
		);
		const live = active.rows[0],
			pending = staged.rows[0];
		return {
			domain: table.hq_domain as string,
			distribution,
			active: live
				? {
						generationId: live.id,
						totalRows: Number(live.next_ordinal),
						recordedAt: (
							table.hq_refreshed_at ?? live.started_at
						).toISOString(),
						digest: live.through_digest,
					}
				: null,
			staged: pending
				? {
						generationId: pending.id,
						rowsRead: Number(pending.next_ordinal),
						expiresAt: pending.expires_at.toISOString(),
					}
				: null,
		};
	});
}

export async function readInventoryPiece(
	access: InventoryAccess,
	cursor?: InventoryCursor,
	verifiedScope?: string,
) {
	return withAppTx(async (tx) => {
		const { table, scopeDigest } = await lockInventoryScope(tx, access);
		if (verifiedScope !== undefined && verifiedScope !== scopeDigest)
			throw new LookupError(
				"not_found",
				"The connection changed. You can reopen the inventory.",
			);
		const id = table.active_generation_id;
		if (!id || (cursor && cursor.generationId !== id))
			throw new LookupError(
				"conflict",
				"The source inventory changed. You can open its latest refresh.",
			);
		const { scope, tableId } = access;
		const current = await sql<{
			next_ordinal: string;
		}>`SELECT next_ordinal FROM lookup_generations WHERE project_id=${scope.projectId}
			AND table_id=${tableId} AND id=${id} AND scope_digest=${scopeDigest} AND state='complete' FOR SHARE`.execute(
			tx,
		);
		if (!current.rows[0])
			throw new LookupError(
				"not_found",
				"This inventory is unavailable with this connection. You can refresh the source with your own account.",
			);
		const totalRows = Number(current.rows[0].next_ordinal),
			ordinal = cursor?.ordinal ?? 0,
			byteOffset = cursor?.byteOffset ?? 0;
		if (totalRows === 0 && ordinal === 0 && byteOffset === 0)
			return { generationId: id, totalRows, item: null, next: null };
		const result = await sql<{
			row_id: string;
			byte_length: string;
			body: Buffer;
		}>`SELECT r.row_id,r.byte_length,b.body FROM lookup_generation_rows r
			JOIN lookup_generation_chunks c USING(project_id,table_id,generation_id,ordinal)
			JOIN lookup_generation_blobs b ON b.project_id=c.project_id AND b.id=c.blob_id
			WHERE r.project_id=${scope.projectId} AND r.table_id=${tableId} AND r.generation_id=${id} AND r.ordinal=${ordinal}
			AND c.byte_offset=${byteOffset}`.execute(tx);
		const piece = result.rows[0];
		if (!piece)
			throw new LookupError(
				"invalid_input",
				"This position is outside the inventory. You can open the first row.",
			);
		const totalBytes = Number(piece.byte_length),
			byteLength = piece.body.length;
		const at = byteOffset + byteLength;
		const next =
			at < totalBytes
				? { generationId: id, ordinal, byteOffset: at }
				: ordinal + 1 < totalRows
					? { generationId: id, ordinal: ordinal + 1, byteOffset: 0 }
					: null;
		return {
			generationId: id,
			totalRows,
			item: {
				rowId: piece.row_id,
				ordinal,
				part: new TextDecoder("utf-8", { fatal: true }).decode(piece.body),
				byteOffset,
				byteLength,
				totalBytes,
			},
			next,
		};
	});
}
