import "server-only";
import { createHash } from "node:crypto";
import { sql, type Transaction } from "kysely";
import {
	dataAccessLost,
	lockProjectDataGrant,
	type ProjectDataGrant,
} from "@/lib/auth/dataGrant";
import { NOVA_MCP_FLOOR_SCOPES } from "@/lib/auth-public";
import { resolveAppScopeInTransaction } from "@/lib/db/appAccess";
import { type AppDatabase, withAppTx } from "@/lib/db/pg";
import type { LookupRowId, LookupTableId } from "@/lib/domain/lookupIds";
import { type LookupValueSlot, valueSlotPath } from "./largeValues/input";
import { lookupRowContentSchema, storedLookupRowValuesSchema } from "./schema";
import type { LookupFixtureRow, LookupTableDefinition } from "./types";

export interface ArchiveLookupAccess {
	appId: string;
	projectId: string;
	actorUserId: string;
	grant: ProjectDataGrant;
	recheck?: (tx: Transaction<AppDatabase>) => Promise<void>;
	documentRevision: number;
	projectRevision: string;
	/** Direct publish pins each carried table. An archive pins its whole Project snapshot. */
	tableRevision?: { id: LookupTableId; definition: string; rows: string };
}
interface StoredRow {
	id: LookupRowId;
	order_key: string;
	values: unknown;
	content: unknown;
	inline_bytes: number;
}
interface AtomRef {
	row_id: LookupRowId;
	slot: string[];
	value_id: string;
	digest: string;
	total_bytes: string;
}

/** Restrict the transport read itself. A stale worker/table identity must
 * never convert a previously prepared global fixture into an administrative read. */
async function lockArchiveTable(
	tx: Transaction<AppDatabase>,
	a: ArchiveLookupAccess,
	id: LookupTableId,
) {
	const app = await resolveAppScopeInTransaction(
		tx,
		a.appId,
		a.actorUserId,
		"view",
	);
	if (app.projectId !== a.projectId || app.baseSeq !== a.documentRevision)
		return dataAccessLost();
	await lockProjectDataGrant(tx, a.actorUserId, a.grant, NOVA_MCP_FLOOR_SCOPES);
	const revision = a.tableRevision
		? sql`t.id=${a.tableRevision.id} AND t.definition_revision=${a.tableRevision.definition} AND t.rows_revision=${a.tableRevision.rows}`
		: sql`s.revision=${a.projectRevision}::bigint`;
	const live =
		await sql`SELECT 1 FROM lookup_tables t JOIN lookup_project_state s USING(project_id)
		WHERE t.project_id=${a.projectId} AND t.id=${id} AND (t.hq_remote_id IS NULL OR t.hq_taken_over_at IS NOT NULL) AND t.worker_access='all'
		AND coalesce(t.hq_canonical->'source'->>'distribution','global') <> 'assigned' AND ${revision} FOR SHARE OF t,s`.execute(
			tx,
		);
	if (!live.rows.length) return dataAccessLost();
	await a.recheck?.(tx);
}

async function* readAtom(
	a: ArchiveLookupAccess,
	id: LookupTableId,
	ref: AtomRef,
) {
	const hash = createHash("sha256");
	let position = 0;
	while (position < Number(ref.total_bytes)) {
		const bytes = await withAppTx(async (tx) => {
			await lockArchiveTable(tx, a, id);
			const part = await sql<{
				body: Buffer;
			}>`SELECT b.body FROM lookup_cell_value_refs r
				JOIN lookup_cell_segments s USING(project_id,value_id)
				JOIN lookup_cell_blobs b ON (b.project_id,b.id)=(s.project_id,s.blob_id)
				WHERE (r.project_id,r.table_id,r.row_id,r.slot,r.value_id,r.digest)=(${a.projectId},${id}::uuid,${ref.row_id}::uuid,${ref.slot}::text[],${ref.value_id}::uuid,${ref.digest})
				AND s.byte_offset=${position}`.execute(tx);
			return part.rows[0]?.body ?? dataAccessLost();
		});
		if (!bytes.length || bytes.length > Number(ref.total_bytes) - position)
			return dataAccessLost();
		position += bytes.length;
		hash.update(bytes);
		yield bytes;
	}
	if (hash.digest("hex") !== ref.digest) return dataAccessLost();
}

export interface ArchiveRow {
	row: LookupFixtureRow;
	external: ReadonlyMap<string, { bytes: number }>;
	read: (atom: {
		slot: LookupValueSlot;
	}) => AsyncIterable<Uint8Array> | undefined;
}

export function archiveTableReader(
	access: ArchiveLookupAccess,
	tableId: LookupTableId,
	count: number,
) {
	const page = async (
		after: { key: string; id: LookupRowId } | null,
		at?: number,
	) =>
		withAppTx(async (tx) => {
			await lockArchiveTable(tx, access, tableId);
			const window = await sql<{
				id: LookupRowId;
				order_key: string;
				inline_bytes: number;
			}>`SELECT id,order_key,octet_length(values::text)+octet_length(content::text) AS inline_bytes
			FROM lookup_rows WHERE project_id=${access.projectId} AND table_id=${tableId}
			${after ? sql`AND (order_key,id)>(${after.key},${after.id}::uuid)` : sql``}
			ORDER BY order_key,id LIMIT ${at === undefined ? 64 : 1} ${at === undefined ? sql`` : sql`OFFSET ${at - 1}`}`.execute(
				tx,
			);
			const ids: LookupRowId[] = [];
			let bytes = 0;
			for (const row of window.rows) {
				if (ids.length && bytes + row.inline_bytes > 1024 * 1024) break;
				if (row.inline_bytes > 16 * 1024 * 1024)
					throw new Error(
						"This stored row exceeds the archive workspace. Its large values need to be moved to segmented storage.",
					);
				ids.push(row.id);
				bytes += row.inline_bytes;
			}
			if (!ids.length) return [];
			const rows =
				await sql<StoredRow>`SELECT id,order_key,values,content,value_bytes AS inline_bytes FROM lookup_rows
			WHERE project_id=${access.projectId} AND table_id=${tableId} AND id=ANY(${ids}::uuid[]) ORDER BY order_key,id`.execute(
					tx,
				);
			const refs =
				await sql<AtomRef>`SELECT row_id,slot,value_id,digest,total_bytes::text FROM lookup_cell_value_refs
			WHERE project_id=${access.projectId} AND table_id=${tableId} AND row_id=ANY(${ids}::uuid[])`.execute(
					tx,
				);
			return rows.rows.map((stored) => {
				const slots = new Map(
					refs.rows
						.filter((ref) => ref.row_id === stored.id)
						.map((ref) => [JSON.stringify(ref.slot), ref]),
				);
				const data: ArchiveRow = {
					row: {
						id: stored.id,
						values: storedLookupRowValuesSchema.parse(stored.values),
						...lookupRowContentSchema.parse(stored.content),
					},
					external: new Map(
						[...slots].map(([k, v]) => [k, { bytes: Number(v.total_bytes) }]),
					),
					read(atom) {
						const ref = slots.get(JSON.stringify(valueSlotPath(atom.slot)));
						return ref ? readAtom(access, tableId, ref) : undefined;
					},
				};
				return { key: stored.order_key, id: stored.id, data };
			});
		});
	return {
		check: () => withAppTx((tx) => lockArchiveTable(tx, access, tableId)),
		async *rows(): AsyncGenerator<ArchiveRow> {
			let after: { key: string; id: LookupRowId } | null = null,
				total = 0;
			for (;;) {
				const rows = await page(after);
				if (!rows.length) break;
				for (const item of rows) {
					total++;
					yield item.data;
					after = item;
				}
			}
			if (total !== count) return dataAccessLost();
		},
		async reopenRow(position: number) {
			if (!Number.isSafeInteger(position) || position < 1 || position > count)
				return dataAccessLost();
			return (await page(null, position))[0]?.data ?? dataAccessLost();
		},
	};
}

export interface StreamingLookupTable {
	definition: LookupTableDefinition;
	reader: ReturnType<typeof archiveTableReader>;
	count: number;
}
