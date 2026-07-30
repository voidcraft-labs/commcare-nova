/**
 * The one SQL authority for the closed pre-canonical identity repair.
 *
 * This deliberately bypasses the final PersistableDoc writer: its input still
 * contains the exact legacy rows the frozen manifest is meant to repair. It
 * accepts an externally owned transaction, verifies the frozen plan and every
 * source digest, performs only the named row/catalog/history writes, proves
 * the stored result and reverse indexes, and returns without committing.
 */

import { sql, type Transaction } from "kysely";
import {
	captureFrozenStorageSnapshot,
	dispatchFrozenStorageOccurrences,
} from "@/lib/case-store/migrations/20260728000000_canonical_identity_foundation/frozenOccurrenceDispatcher";
import { applyFrozenCanonicalIdentityRepair } from "@/lib/case-store/migrations/20260728000000_canonical_identity_foundation/frozenRepair";
import { CANONICAL_IDENTITY_ROW_DELETES } from "@/lib/case-store/migrations/20260728000000_canonical_identity_foundation/frozenRepairManifest";
import {
	canonicalIdentityDigest,
	type LegacyAppSnapshot,
	type LegacyEntityKind,
	type LegacyEntityRow,
	planCanonicalAppMigration,
} from "@/lib/case-store/migrations/20260728000000_canonical_identity_foundation/frozenTransform";
import { asUuid } from "@/lib/domain";
import { type AppDatabase, notifyAppStream } from "./pg";

type DbTx = Transaction<AppDatabase>;

function entityKind(value: string): LegacyEntityKind {
	switch (value) {
		case "module":
		case "form":
		case "field":
		case "user_property":
		case "user_type":
		case "persona":
			return value;
		default:
			throw new Error(`Unsupported canonical repair entity kind ${value}.`);
	}
}

export async function loadCanonicalIdentityRepairSnapshotsInTransaction(
	tx: DbTx,
): Promise<LegacyAppSnapshot[]> {
	const apps = await tx
		.selectFrom("apps")
		.select([
			"id",
			"app_name",
			"connect_type",
			"case_types",
			"logo",
			"mutation_seq",
		])
		.orderBy("id")
		.execute();
	const entityRows = await tx
		.selectFrom("blueprint_entities")
		.select(["app_id", "uuid", "kind", "parent_uuid", "ordinal", "data"])
		.orderBy("app_id")
		.orderBy("kind")
		.orderBy("parent_uuid")
		.orderBy("ordinal")
		.orderBy("uuid")
		.execute();
	const byApp = new Map<string, LegacyEntityRow[]>();
	for (const row of entityRows) {
		const values = byApp.get(row.app_id) ?? [];
		values.push({
			appId: row.app_id,
			uuid: row.uuid,
			kind: entityKind(row.kind),
			parentUuid: row.parent_uuid,
			ordinal: row.ordinal,
			data: row.data,
		});
		byApp.set(row.app_id, values);
	}
	return apps.map((app) => ({
		appId: app.id,
		appName: app.app_name,
		connectType: app.connect_type,
		caseTypes: app.case_types,
		logo: app.logo,
		mutationSeq: app.mutation_seq,
		rows: byApp.get(app.id) ?? [],
	}));
}

async function assertRepairQuiescence(tx: DbTx): Promise<void> {
	const result = await sql<{
		lease_blockers: string;
		active_streams: string;
		unterminated_chunks: string;
		presence_sessions: string;
	}>`
		SELECT
			(
				SELECT count(*)::text
				FROM apps
				WHERE
					status = 'generating'
					OR awaiting_input
					OR lock_run_id IS NOT NULL
					OR lock_actor_user_id IS NOT NULL
					OR lock_expire_at IS NOT NULL
					OR NOT (
						(
							res_period IS NULL
							AND res_reserved IS NULL
							AND res_settled IS NULL
							AND res_user_id IS NULL
							AND res_run_id IS NULL
						)
						OR (
							res_period IS NOT NULL
							AND res_reserved IS NOT NULL
							AND res_settled IS TRUE
							AND res_user_id IS NOT NULL
						)
					)
			) AS lease_blockers,
			(
				SELECT count(*)::text
				FROM threads
				WHERE active_stream_id IS NOT NULL
				   OR active_holder_nonce IS NOT NULL
			) AS active_streams,
			(
				SELECT count(*)::text
				FROM chat_stream_chunks
				WHERE terminal IS NOT TRUE
			) AS unterminated_chunks,
			(
				SELECT count(*)::text
				FROM presence
			) AS presence_sessions
	`.execute(tx);
	const row = result.rows[0];
	if (
		row?.lease_blockers !== "0" ||
		row.active_streams !== "0" ||
		row.unterminated_chunks !== "0" ||
		row.presence_sessions !== "0"
	) {
		throw new Error(
			"Canonical identity repair requires complete app-lease and stream quiescence.",
		);
	}
}

async function reverseIndexDigest(
	tx: DbTx,
	appIds: readonly string[],
): Promise<string> {
	const media = await tx
		.selectFrom("media_asset_refs")
		.select(["app_id", "asset_id"])
		.where("app_id", "in", appIds)
		.orderBy("app_id")
		.orderBy("asset_id")
		.execute();
	const tables = await tx
		.selectFrom("lookup_table_references")
		.select(["app_id", "project_id", "table_id"])
		.where("app_id", "in", appIds)
		.orderBy("app_id")
		.orderBy("project_id")
		.orderBy("table_id")
		.execute();
	const columns = await tx
		.selectFrom("lookup_column_references")
		.select(["app_id", "project_id", "table_id", "column_id"])
		.where("app_id", "in", appIds)
		.orderBy("app_id")
		.orderBy("project_id")
		.orderBy("table_id")
		.orderBy("column_id")
		.execute();
	return canonicalIdentityDigest({ media, tables, columns });
}

function digestByApp(
	snapshots: readonly LegacyAppSnapshot[],
): ReadonlyMap<string, string> {
	return new Map(
		snapshots.map((snapshot) => [
			snapshot.appId,
			planCanonicalAppMigration(snapshot).beforeDigest,
		]),
	);
}

export interface CanonicalIdentityFoundationRepairProof {
	readonly affectedApps: number;
	readonly deletedRows: number;
	readonly updatedEntityRows: number;
	readonly updatedCatalogs: number;
	readonly resultDigest: string;
	readonly occurrenceSourceDigest: string;
	readonly occurrenceResultDigest: string;
}

export type CanonicalIdentityRepairFailureStage = "rows" | "horizons" | "proof";

export interface CanonicalIdentityRepairOptions {
	/** Transaction-atomicity proof hook; production callers omit it. */
	readonly failAfterStage?: CanonicalIdentityRepairFailureStage;
}

function injectReviewedRepairFailure(
	options: CanonicalIdentityRepairOptions,
	stage: CanonicalIdentityRepairFailureStage,
): void {
	if (options.failAfterStage === stage) {
		throw new Error(
			`Injected canonical identity repair failure after ${stage}.`,
		);
	}
}

export async function applyCanonicalIdentityFoundationRepairInTransaction(
	tx: DbTx,
	before: readonly LegacyAppSnapshot[],
	options: CanonicalIdentityRepairOptions = {},
): Promise<CanonicalIdentityFoundationRepairProof> {
	await assertRepairQuiescence(tx);
	const storedSource =
		await loadCanonicalIdentityRepairSnapshotsInTransaction(tx);
	if (
		canonicalIdentityDigest(storedSource) !== canonicalIdentityDigest(before)
	) {
		throw new Error(
			"Canonical identity repair source snapshots changed before write.",
		);
	}
	const occurrenceSource = dispatchFrozenStorageOccurrences(
		await captureFrozenStorageSnapshot(tx),
	);
	const repair = applyFrozenCanonicalIdentityRepair(before);
	const beforeById = new Map(
		before.map((snapshot) => [snapshot.appId, snapshot]),
	);
	const afterById = new Map(
		repair.snapshots.map((snapshot) => [snapshot.appId, snapshot]),
	);
	const affectedIds = repair.affected.map((entry) => entry.appId);
	const reverseBefore = await reverseIndexDigest(tx, affectedIds);

	const orphanUuids = CANONICAL_IDENTITY_ROW_DELETES.map(([, uuid]) =>
		asUuid(uuid),
	);
	const attachmentConsumers = await tx
		.selectFrom("form_attachments")
		.select(({ fn }) => fn.countAll<string>().as("count"))
		.where("field_uuid", "in", orphanUuids)
		.executeTakeFirstOrThrow();
	if (Number(attachmentConsumers.count) !== 0) {
		throw new Error(
			"Canonical identity repair blocked: a deleted field gained a form attachment consumer.",
		);
	}

	let updatedCatalogs = 0;
	let updatedEntityRows = 0;
	for (const appId of affectedIds) {
		const oldSnapshot = beforeById.get(appId);
		const newSnapshot = afterById.get(appId);
		if (oldSnapshot === undefined || newSnapshot === undefined) {
			throw new Error("Canonical identity repair lost an affected snapshot.");
		}
		if (
			canonicalIdentityDigest(oldSnapshot.caseTypes) !==
			canonicalIdentityDigest(newSnapshot.caseTypes)
		) {
			const result = await tx
				.updateTable("apps")
				.set({ case_types: JSON.stringify(newSnapshot.caseTypes) })
				.where("id", "=", appId)
				.executeTakeFirstOrThrow();
			if (Number(result.numUpdatedRows) !== 1) {
				throw new Error("Canonical identity repair lost its app row lock.");
			}
			updatedCatalogs++;
		}
		const oldRows = new Map(oldSnapshot.rows.map((row) => [row.uuid, row]));
		for (const row of newSnapshot.rows) {
			const old = oldRows.get(row.uuid);
			if (
				old !== undefined &&
				canonicalIdentityDigest(old.data) !== canonicalIdentityDigest(row.data)
			) {
				const result = await tx
					.updateTable("blueprint_entities")
					.set({ data: JSON.stringify(row.data) })
					.where("app_id", "=", appId)
					.where("uuid", "=", asUuid(row.uuid))
					.executeTakeFirstOrThrow();
				if (Number(result.numUpdatedRows) !== 1) {
					throw new Error(
						`Canonical identity repair could not update row ${row.uuid}.`,
					);
				}
				updatedEntityRows++;
			}
		}
	}

	for (const [
		appDigest,
		rowUuid,
		rowDigest,
	] of CANONICAL_IDENTITY_ROW_DELETES) {
		const app = repair.affected.find((entry) => entry.appDigest === appDigest);
		if (app === undefined) {
			throw new Error("Canonical identity repair row-delete app disappeared.");
		}
		const row = beforeById
			.get(app.appId)
			?.rows.find((candidate) => candidate.uuid === rowUuid);
		if (row === undefined || canonicalIdentityDigest(row) !== rowDigest) {
			throw new Error(
				`Canonical identity repair row ${rowUuid} changed before delete.`,
			);
		}
		const result = await tx
			.deleteFrom("blueprint_entities")
			.where("app_id", "=", app.appId)
			.where("uuid", "=", asUuid(rowUuid))
			.executeTakeFirstOrThrow();
		if (Number(result.numDeletedRows) !== 1) {
			throw new Error(
				`Canonical identity repair could not delete row ${rowUuid}.`,
			);
		}
	}

	const storedBeforeHorizon =
		await loadCanonicalIdentityRepairSnapshotsInTransaction(tx);
	const storedDigests = digestByApp(storedBeforeHorizon);
	for (const repaired of repair.affected) {
		if (storedDigests.get(repaired.appId) !== repaired.afterDigest) {
			throw new Error(
				`Canonical identity repair stored result drifted for ${repaired.appDigest}.`,
			);
		}
	}
	if ((await reverseIndexDigest(tx, affectedIds)) !== reverseBefore) {
		throw new Error("Canonical identity repair changed a reverse index.");
	}
	injectReviewedRepairFailure(options, "rows");

	for (const repaired of repair.affected) {
		const marker = await sql<{ seq: string }>`
			WITH appended AS (
				INSERT INTO accepted_mutations
					(app_id, seq, batch_id, run_id, actor_id, kind, mutations)
				SELECT
					id,
					mutation_seq + 1,
					'migration:canonical-identity-repair-v1',
					NULL,
					'system:canonical-identity-repair',
					'migration',
					'[]'::jsonb
				FROM apps
				WHERE id = ${repaired.appId}
				RETURNING app_id, seq
			), advanced AS (
				UPDATE apps
				SET mutation_seq = appended.seq
				FROM appended
				WHERE apps.id = appended.app_id
				RETURNING apps.mutation_seq::text AS seq
			)
			SELECT seq FROM advanced
		`.execute(tx);
		if (marker.rows.length !== 1) {
			throw new Error(
				`Canonical identity repair could not append horizon for ${repaired.appDigest}.`,
			);
		}
		const seq = Number(marker.rows[0]?.seq);
		if (!Number.isSafeInteger(seq)) {
			throw new Error(
				`Canonical identity repair horizon is not a safe stream sequence for ${repaired.appDigest}.`,
			);
		}
		await notifyAppStream(tx, repaired.appId, seq);
	}
	injectReviewedRepairFailure(options, "horizons");

	const markerCount = await tx
		.selectFrom("accepted_mutations")
		.select(({ fn }) => fn.countAll<string>().as("count"))
		.where("app_id", "in", affectedIds)
		.where("batch_id", "=", "migration:canonical-identity-repair-v1")
		.where("actor_id", "=", "system:canonical-identity-repair")
		.where("kind", "=", "migration")
		.executeTakeFirstOrThrow();
	if (Number(markerCount.count) !== repair.affected.length) {
		throw new Error("Canonical identity repair horizon cardinality drifted.");
	}
	const occurrenceResult = dispatchFrozenStorageOccurrences(
		await captureFrozenStorageSnapshot(tx),
	);
	injectReviewedRepairFailure(options, "proof");

	return {
		affectedApps: repair.affected.length,
		deletedRows: repair.deletedRows,
		updatedEntityRows,
		updatedCatalogs,
		resultDigest: repair.resultDigest,
		occurrenceSourceDigest: canonicalIdentityDigest(occurrenceSource),
		occurrenceResultDigest: canonicalIdentityDigest(occurrenceResult),
	};
}
