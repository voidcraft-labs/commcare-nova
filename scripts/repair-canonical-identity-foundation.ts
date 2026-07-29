/**
 * ⚠️ WRITES WITH --apply — exact, all-app-atomic canonical identity repair.
 *
 * This is not a general repair utility. It accepts only the checked-in,
 * content-free manifest and aborts on any source, finding, consumer, reverse
 * index, or result digest drift. Production apply belongs inside the reviewed
 * maintenance fence after the authoritative post-quiescence backup completes.
 */

import "dotenv/config";
import { Command } from "commander";
import { sql, type Transaction } from "kysely";
import { applyFrozenCanonicalIdentityRepair } from "@/lib/case-store/migrations/20260728000000_canonical_identity_foundation/frozenRepair";
import {
	CANONICAL_IDENTITY_AFFECTED_APPS,
	CANONICAL_IDENTITY_REPAIR_RESULT_DIGEST,
	CANONICAL_IDENTITY_REPAIR_VERSION,
	CANONICAL_IDENTITY_ROW_DELETES,
} from "@/lib/case-store/migrations/20260728000000_canonical_identity_foundation/frozenRepairManifest";
import {
	canonicalIdentityDigest,
	type LegacyAppSnapshot,
	type LegacyEntityKind,
	type LegacyEntityRow,
	planCanonicalAppMigration,
} from "@/lib/case-store/migrations/20260728000000_canonical_identity_foundation/frozenTransform";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { type AppDatabase, getAppDb } from "@/lib/db/pg";
import { asUuid } from "@/lib/domain";
import { runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";

interface Options {
	readonly prod?: boolean;
	readonly apply?: boolean;
	readonly confirm?: string;
}

const program = new Command();
program
	.name("repair-canonical-identity-foundation")
	.description(
		"Verify or atomically apply the exact canonical identity repair manifest.",
	)
	.option("--prod", "target production through the operator IAM connection")
	.option("--apply", "write the repair; default is a rolled-back dry run")
	.option(
		"--confirm <version>",
		`required with --apply; must equal ${CANONICAL_IDENTITY_REPAIR_VERSION}`,
	);
program.parse();
const options = program.opts<Options>();
if (options.prod) targetProdDb();
if (options.apply && options.confirm !== CANONICAL_IDENTITY_REPAIR_VERSION) {
	throw new Error(
		`--apply requires --confirm ${CANONICAL_IDENTITY_REPAIR_VERSION}`,
	);
}

type DbTx = Transaction<AppDatabase>;

async function loadSnapshots(tx: DbTx): Promise<LegacyAppSnapshot[]> {
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
			kind: row.kind as LegacyEntityKind,
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

async function applyRepair(
	tx: DbTx,
	before: readonly LegacyAppSnapshot[],
): Promise<{
	readonly affectedApps: number;
	readonly deletedRows: number;
	readonly updatedEntityRows: number;
	readonly updatedCatalogs: number;
}> {
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
			"Canonical identity repair blocked: a deleted field gained a form attachment consumer",
		);
	}

	let updatedCatalogs = 0;
	let updatedEntityRows = 0;
	for (const appId of affectedIds) {
		const oldSnapshot = beforeById.get(appId);
		const newSnapshot = afterById.get(appId);
		if (oldSnapshot === undefined || newSnapshot === undefined) {
			throw new Error("Canonical identity repair lost an affected snapshot");
		}
		if (
			canonicalIdentityDigest(oldSnapshot.caseTypes) !==
			canonicalIdentityDigest(newSnapshot.caseTypes)
		) {
			await tx
				.updateTable("apps")
				.set({ case_types: JSON.stringify(newSnapshot.caseTypes) })
				.where("id", "=", appId)
				.executeTakeFirstOrThrow();
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
						`Canonical identity repair could not update row ${row.uuid}`,
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
			throw new Error("Canonical identity repair row-delete app disappeared");
		}
		const row = beforeById
			.get(app.appId)
			?.rows.find((candidate) => candidate.uuid === rowUuid);
		if (row === undefined || canonicalIdentityDigest(row) !== rowDigest) {
			throw new Error(
				`Canonical identity repair row ${rowUuid} changed before delete`,
			);
		}
		const result = await tx
			.deleteFrom("blueprint_entities")
			.where("app_id", "=", app.appId)
			.where("uuid", "=", asUuid(rowUuid))
			.executeTakeFirstOrThrow();
		if (Number(result.numDeletedRows) !== 1) {
			throw new Error(
				`Canonical identity repair could not delete row ${rowUuid}`,
			);
		}
	}

	const storedBeforeHorizon = await loadSnapshots(tx);
	const storedDigests = digestByApp(storedBeforeHorizon);
	for (const repaired of repair.affected) {
		if (storedDigests.get(repaired.appId) !== repaired.afterDigest) {
			throw new Error(
				`Canonical identity repair stored result drifted for ${repaired.appDigest}`,
			);
		}
	}
	if ((await reverseIndexDigest(tx, affectedIds)) !== reverseBefore) {
		throw new Error("Canonical identity repair changed a reverse index");
	}

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
				`Canonical identity repair could not append horizon for ${repaired.appDigest}`,
			);
		}
	}

	const markerCount = await tx
		.selectFrom("accepted_mutations")
		.select(({ fn }) => fn.countAll<string>().as("count"))
		.where("app_id", "in", affectedIds)
		.where("batch_id", "=", "migration:canonical-identity-repair-v1")
		.where("actor_id", "=", "system:canonical-identity-repair")
		.where("kind", "=", "migration")
		.executeTakeFirstOrThrow();
	if (Number(markerCount.count) !== repair.affected.length) {
		throw new Error("Canonical identity repair horizon cardinality drifted");
	}

	return {
		affectedApps: repair.affected.length,
		deletedRows: repair.deletedRows,
		updatedEntityRows,
		updatedCatalogs,
	};
}

async function main(): Promise<void> {
	const db = await getAppDb();
	const report = await db
		.transaction()
		.setIsolationLevel("serializable")
		.execute(async (tx) => {
			if (options.apply) {
				await sql`
					LOCK TABLE
						apps,
						blueprint_entities,
						accepted_mutations,
						media_asset_refs,
						lookup_table_references,
						lookup_column_references,
						form_attachments
					IN SHARE ROW EXCLUSIVE MODE
				`.execute(tx);
			}
			const generating = await tx
				.selectFrom("apps")
				.select(({ fn }) => fn.countAll<string>().as("count"))
				.where("status", "=", "generating")
				.executeTakeFirstOrThrow();
			const activeStreams = await tx
				.selectFrom("threads")
				.select(({ fn }) => fn.countAll<string>().as("count"))
				.where("active_stream_id", "is not", null)
				.executeTakeFirstOrThrow();
			if (Number(generating.count) !== 0 || Number(activeStreams.count) !== 0) {
				throw new Error(
					"Canonical identity repair requires zero generating apps and zero active streams",
				);
			}
			const before = await loadSnapshots(tx);
			const verified = applyFrozenCanonicalIdentityRepair(before);
			if (
				verified.resultDigest !== CANONICAL_IDENTITY_REPAIR_RESULT_DIGEST ||
				verified.affected.length !== CANONICAL_IDENTITY_AFFECTED_APPS.length
			) {
				throw new Error("Canonical identity repair manifest result drifted");
			}
			if (!options.apply) {
				return {
					mode: "dry-run",
					version: verified.version,
					affectedApps: verified.affected.length,
					deletedRows: verified.deletedRows,
					appendedProperties: verified.appendedProperties,
					repairedLabelTokens: verified.repairedLabelTokens,
					clearedCatalogSlots: verified.clearedCatalogSlots,
					resultDigest: verified.resultDigest,
				};
			}
			return {
				mode: "applied",
				version: verified.version,
				resultDigest: verified.resultDigest,
				...(await applyRepair(tx, before)),
			};
		});
	console.log(JSON.stringify(report, null, 2));
	await closeCaseStoreDatabase();
}

runMain(main);
