import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { sql, type Transaction } from "kysely";
import { type AppDatabase, withAppTx } from "@/lib/db/pg";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { LookupError } from "../errors";
import {
	type ManagedLookupContent,
	refreshManagedLookupTableInTransaction,
} from "../managed";
import {
	advanceLookupProjectRevision,
	lookupTableRevisions,
	notifyCommittedLookupMutation,
	updateLockedLookupTable,
} from "../writerTransaction";
import {
	availableBulkSlot,
	lockLookupBudget,
	lookupStorageRefusal,
} from "./budget";
import {
	type InventoryRow,
	inventoryChunks,
	inventoryRowId,
	measureInventoryRow,
} from "./row";
import {
	type InventoryAccess,
	lockInventoryScope,
	sourceChanged,
} from "./scope";

interface StoredGeneration {
	id: string;
	state: "staging" | "paused" | "complete" | "retired";
	scope_digest: string;
	expected_revision: string;
	definition_digest: string;
	through_digest: string;
	next_ordinal: string;
	payload_bytes: string;
	started_at: Date;
}

export interface InventoryRun {
	access: InventoryAccess;
	id: string;
	scopeDigest: string;
	runnerId: string;
	definitionDigest: string;
	canonicalDefinition: string;
}

const stagedConflict = () =>
	new LookupError(
		"conflict",
		"This refresh no longer has a matching source snapshot. You can start it again.",
	);

export async function beginInventory(
	access: InventoryAccess,
	source: {
		keyDigest: string;
		definitionDigest: string;
		canonicalDefinition: string;
		reconcileDefinition?: true;
		server: string;
		domain: string;
		remoteId: string;
	},
) {
	const { scope, tableId } = access;
	const runnerId = randomUUID();
	return withAppTx(async (tx) => {
		const locked = await lockInventoryScope(tx, access);
		if (
			locked.keyDigest !== source.keyDigest ||
			locked.table.hq_server !== source.server ||
			locked.table.hq_domain !== source.domain ||
			locked.table.hq_remote_id !== source.remoteId ||
			(!source.reconcileDefinition &&
				locked.table.hq_canonical?.definitionDigest !==
					source.canonicalDefinition)
		)
			return sourceChanged();
		const budget = await lockLookupBudget(tx, scope.projectId);
		await sql`UPDATE lookup_generations SET state='paused' WHERE project_id=${scope.projectId} AND state='staging' AND lease_until<=clock_timestamp()`.execute(
			tx,
		);
		await sql`UPDATE lookup_generations SET state='retired' WHERE project_id=${scope.projectId} AND state IN ('staging','paused')
			AND (expires_at<=clock_timestamp() OR (table_id=${tableId} AND actor_id=${scope.actorId} AND
				scope_digest=${locked.scopeDigest} AND (definition_digest<>${source.definitionDigest} OR expected_revision<>${locked.revision})))`.execute(
			tx,
		);
		const match =
			await sql<StoredGeneration>`SELECT * FROM lookup_generations WHERE project_id=${scope.projectId}
			AND table_id=${tableId} AND actor_id=${scope.actorId} AND scope_digest=${locked.scopeDigest} AND state IN ('staging','paused') FOR UPDATE`.execute(
				tx,
			);
		let gen = match.rows[0];
		if (gen?.state === "staging")
			throw new LookupError(
				"conflict",
				"This refresh is already running. Its progress is available in Project data.",
			);
		if (!gen || gen.state === "paused") {
			await availableBulkSlot(tx, scope.projectId, budget.bulk_slots);
			if (gen) {
				await sql`UPDATE lookup_generations SET state='staging',runner_id=${runnerId},lease_until=clock_timestamp()+interval '5 minutes' WHERE project_id=${scope.projectId} AND table_id=${tableId} AND id=${gen.id}`.execute(
					tx,
				);
			}
		}
		if (!gen) {
			const startDigest = createHash("sha256")
				.update(source.definitionDigest)
				.update("\n")
				.digest("hex");
			const inserted =
				await sql<StoredGeneration>`INSERT INTO lookup_generations
				(project_id,table_id,actor_id,scope_digest,expected_revision,definition_digest,through_digest,state,runner_id,lease_until,expires_at)
				VALUES(${scope.projectId},${tableId},${scope.actorId},${locked.scopeDigest},${locked.revision},${source.definitionDigest},${startDigest},'staging',${runnerId},clock_timestamp()+interval '5 minutes',clock_timestamp()+interval '24 hours') RETURNING *`.execute(
					tx,
				);
			gen = inserted.rows[0];
		}
		return {
			run: {
				access,
				id: gen.id,
				runnerId,
				scopeDigest: locked.scopeDigest,
				definitionDigest: source.definitionDigest,
				canonicalDefinition: source.canonicalDefinition,
			} satisfies InventoryRun,
			checkpoint: {
				offset: Number(gen.next_ordinal),
				throughDigest: gen.through_digest,
			},
		};
	});
}

async function lockedRun(tx: Transaction<AppDatabase>, run: InventoryRun) {
	const { access } = run;
	const { scope, tableId } = access;
	const locked = await lockInventoryScope(tx, access);
	if (locked.scopeDigest !== run.scopeDigest) return sourceChanged();
	const record =
		await sql<StoredGeneration>`SELECT * FROM lookup_generations WHERE project_id=${scope.projectId} AND table_id=${tableId}
		AND id=${run.id} AND actor_id=${scope.actorId} AND scope_digest=${run.scopeDigest} AND definition_digest=${run.definitionDigest}
		AND state='staging' AND runner_id=${run.runnerId} AND lease_until>clock_timestamp() AND expires_at>clock_timestamp() FOR UPDATE`.execute(
			tx,
		);
	const gen = record.rows[0];
	if (!gen || gen.expected_revision !== locked.revision) return sourceChanged();
	return { locked, gen };
}

export async function stageInventoryPage(
	run: InventoryRun,
	page: {
		start: number;
		offset: number;
		throughDigest: string;
		rows: readonly InventoryRow[];
	},
) {
	const { scope, tableId } = run.access;
	if (
		!Number.isSafeInteger(page.start) ||
		page.start < 0 ||
		page.offset !== page.start + page.rows.length ||
		!page.rows.length ||
		!/^[a-f0-9]{64}$/.test(page.throughDigest)
	)
		throw stagedConflict();
	const measures = page.rows.map(measureInventoryRow);
	const pageDigest = canonicalJsonDigest(measures);
	try {
		await withAppTx(async (tx) => {
			const { locked, gen } = await lockedRun(tx, run);
			const prior = await sql<{
				end_ordinal: string;
				page_digest: string;
				through_digest: string;
			}>`SELECT end_ordinal,page_digest,through_digest FROM lookup_generation_pages
				WHERE project_id=${scope.projectId} AND table_id=${tableId} AND generation_id=${run.id} AND first_ordinal=${page.start}`.execute(
				tx,
			);
			const receipt = prior.rows[0];
			if (receipt) {
				if (
					Number(receipt.end_ordinal) !== page.offset ||
					receipt.page_digest !== pageDigest ||
					receipt.through_digest !== page.throughDigest
				)
					throw stagedConflict();
				return;
			}
			if (Number(gen.next_ordinal) !== page.start) throw stagedConflict();
			const measuredBytes = measures.reduce((sum, m) => sum + m.bytes, 0);
			// SQL admits new physical bytes (including each metadata row) under this
			// lock. A byte-identical blob already charged to this Project is reused.
			await lockLookupBudget(tx, scope.projectId);
			for (const [index, row] of page.rows.entries()) {
				const ordinal = page.start + index;
				const inserted =
					await sql`INSERT INTO lookup_generation_rows(project_id,table_id,generation_id,ordinal,source_id,row_id,byte_length)
					VALUES(${scope.projectId},${tableId},${run.id},${ordinal},${row.sourceId},coalesce((SELECT id FROM lookup_rows WHERE project_id=${scope.projectId} AND table_id=${tableId} AND hq_row_id=${row.sourceId}),
							${inventoryRowId(tableId, row.sourceId, [locked.origin.server, locked.origin.domain, locked.origin.remoteId])}::uuid),${measures[index].bytes})
					ON CONFLICT DO NOTHING RETURNING ordinal`.execute(tx);
				if (!inserted.rows.length) throw stagedConflict();
				let offset = 0;
				const parts: ReturnType<typeof sql>[] = [];
				const bodies: ReturnType<typeof sql>[] = [];
				const flush = async () => {
					if (!parts.length) return;
					await sql`INSERT INTO lookup_generation_blobs(project_id,id,body) VALUES ${sql.join(bodies)} ON CONFLICT DO NOTHING`.execute(
						tx,
					);
					await sql`INSERT INTO lookup_generation_chunks(project_id,table_id,generation_id,ordinal,byte_offset,blob_id) VALUES ${sql.join(parts)}`.execute(
						tx,
					);
					parts.length = 0;
					bodies.length = 0;
				};
				for (const chunk of inventoryChunks(row)) {
					const digest = createHash("sha256").update(chunk).digest("hex");
					bodies.push(sql`(${scope.projectId},${digest},${chunk})`);
					parts.push(
						sql`(${scope.projectId},${tableId},${run.id},${ordinal},${offset},${digest})`,
					);
					offset += chunk.length;
					if (parts.length >= 16) await flush();
				}
				await flush();
			}
			await sql`INSERT INTO lookup_generation_pages(project_id,table_id,generation_id,first_ordinal,end_ordinal,page_digest,through_digest)
				VALUES(${scope.projectId},${tableId},${run.id},${page.start},${page.offset},${pageDigest},${page.throughDigest})`.execute(
				tx,
			);
			await sql`UPDATE lookup_generations SET next_ordinal=${page.offset},through_digest=${page.throughDigest},payload_bytes=payload_bytes+${measuredBytes}
				WHERE project_id=${scope.projectId} AND table_id=${tableId} AND id=${run.id}`.execute(
				tx,
			);
		});
	} catch (err) {
		throw lookupStorageRefusal(err) ?? err;
	}
}

export async function promoteInventory(
	run: InventoryRun,
	witness: {
		definitionDigest: string;
		throughDigest: string;
		offset: number;
		totalCount: number;
	},
	canonical: Readonly<Record<string, unknown>>,
	definition?: ManagedLookupContent,
) {
	const { scope, tableId } = run.access;
	return withAppTx(async (tx) => {
		const { locked, gen } = await lockedRun(tx, run);
		if (
			(locked.table.hq_canonical?.definitionDigest !==
				run.canonicalDefinition &&
				!definition) ||
			canonical.definitionDigest !== run.canonicalDefinition ||
			witness.definitionDigest !== gen.definition_digest ||
			witness.throughDigest !== gen.through_digest ||
			witness.offset !== witness.totalCount ||
			witness.offset !== Number(gen.next_ordinal)
		)
			throw stagedConflict();
		if (
			locked.table.active_generation_id &&
			locked.table.hq_canonical?.digest === canonical.digest
		) {
			const identical =
				await sql`SELECT 1 FROM lookup_generations WHERE project_id=${scope.projectId} AND table_id=${tableId}
				AND id=${locked.table.active_generation_id} AND state='complete' AND through_digest=${witness.throughDigest}
				AND scope_digest=${run.scopeDigest} AND definition_digest=${witness.definitionDigest} AND next_ordinal=${witness.offset}`.execute(
					tx,
				);
			if (identical.rows.length) {
				await sql`UPDATE lookup_generations SET state='retired' WHERE project_id=${scope.projectId} AND table_id=${tableId} AND id=${run.id}`.execute(
					tx,
				);
				await updateLockedLookupTable(tx, scope.projectId, tableId, {
					hq_refreshed_at: gen.started_at,
					hq_refreshed_by: scope.actorId,
				});
				return {
					...lookupTableRevisions(locked.table),
					changed: "nothing" as const,
					addedColumns: [],
					removedColumns: [],
					keptGoneColumns: [],
				};
			}
		}
		if (locked.table.active_generation_id) {
			await sql`UPDATE lookup_generations SET state='retired' WHERE project_id=${scope.projectId} AND table_id=${tableId} AND id=${locked.table.active_generation_id}`.execute(
				tx,
			);
		}
		await sql`UPDATE lookup_generations SET state='complete' WHERE project_id=${scope.projectId} AND table_id=${tableId} AND id=${run.id}`.execute(
			tx,
		);
		if (definition)
			return refreshManagedLookupTableInTransaction(tx, locked.authority, {
				mode: "refresh",
				tableId,
				content: definition,
				origin: { ...locked.origin, canonical },
				at: gen.started_at,
				olderReadYields: false,
				verifiedGeneration: {
					id: run.id,
					count: witness.totalCount,
					bytes: gen.payload_bytes,
				},
			});
		const revision = await advanceLookupProjectRevision(tx, scope.projectId);
		const table = await updateLockedLookupTable(tx, scope.projectId, tableId, {
			active_generation_id: run.id,
			rows_revision: revision,
			row_count: witness.totalCount,
			data_bytes: gen.payload_bytes,
			hq_canonical: JSON.stringify(canonical),
			hq_refreshed_at: gen.started_at,
			hq_refreshed_by: scope.actorId,
			updated_at: new Date(),
			updated_by: scope.actorId,
		});
		await notifyCommittedLookupMutation(tx, scope.projectId, revision);
		return {
			...lookupTableRevisions(table),
			changed: "rows" as const,
			addedColumns: [],
			removedColumns: [],
			keptGoneColumns: [],
		};
	});
}

/** Only the incomplete generation an actor admitted can be cancelled. Old range
 * calls must name the currently visible generation to acquire bytes. */
export async function cancelInventory(access: InventoryAccess, id?: string) {
	return withAppTx(async (tx) => {
		const locked = await lockInventoryScope(tx, access);
		const { scope, tableId } = access;
		await sql`UPDATE lookup_generations SET state='retired' WHERE project_id=${scope.projectId} AND table_id=${tableId}
			AND scope_digest=${locked.scopeDigest} AND actor_id=${scope.actorId} AND state IN ('staging','paused') ${id ? sql`AND id=${id}` : sql``}`.execute(
			tx,
		);
	});
}

export async function checkInventoryRun(run: InventoryRun) {
	await withAppTx(async (tx) => {
		await lockedRun(tx, run);
		const { scope, tableId } = run.access;
		await sql`UPDATE lookup_generations SET lease_until=clock_timestamp()+interval '5 minutes' WHERE project_id=${scope.projectId}
			AND table_id=${tableId} AND id=${run.id}`.execute(tx);
	});
}

/** A failed stream may release only its own work slot. This private transition
 * never grants a read, refunds a byte, or changes the visible table. */
export async function pauseInventory(run: InventoryRun) {
	const { scope, tableId } = run.access;
	await withAppTx(async (tx) => {
		await sql`UPDATE lookup_generations SET state='paused' WHERE project_id=${scope.projectId} AND table_id=${tableId}
			AND id=${run.id} AND actor_id=${scope.actorId} AND scope_digest=${run.scopeDigest} AND runner_id=${run.runnerId} AND state='staging'`.execute(
			tx,
		);
	});
}
