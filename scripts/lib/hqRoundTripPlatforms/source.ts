/**
 * Everything the platforms cutover reads from Nova's database before it
 * decides (part 09 §4, §9): plain `SELECT`s on the caller's one
 * `REPEATABLE READ, READ ONLY` transaction, so the scan's read-only identity
 * runs them and they take no lock.
 *
 * Every app (deleted ones included) is read through the production loader
 * (`loadSchemaAdmittedAppSnapshotFromRowInTransaction`, a strict schema parse
 * with no gate on the source), with its live deployments and their app
 * baselines and its drift against its stored `case_type_schemas` rows
 * (`scripts/lib/schemaDrift.ts::computeSchemaDrift`, the function the drift
 * scan and writer use, so the count and the writer's work are one
 * computation). Every ready image, audio and video row is read for the
 * backfill, and each Project's lookup definitions and media rows for the
 * gate and export readiness.
 *
 * `media_assets` rows are selected whole and never through their
 * `media_format` column, which the migration ledger adds only inside the
 * window: the dry run reads a database at `main`'s ledger.
 */

import { type Kysely, type Selectable, sql, type Transaction } from "kysely";
import type { Database } from "@/lib/case-store/postgres/connection";
import {
	loadSchemaAdmittedAppSnapshotFromRowInTransaction,
	PERSISTED_BLUEPRINT_APP_COLUMNS,
	type PersistedBlueprintAppRow,
} from "@/lib/db/canonicalCommitKernel";
import type { AppDatabase, MediaAssetsTable } from "@/lib/db/pg";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import type { LookupValidationContext } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc } from "@/lib/domain";
import { lookupTableIdSchema } from "@/lib/domain/lookupIds";
import { readLookupDefinitionsInTransaction } from "@/lib/lookup/definitionSnapshot";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { safePersistedSequence } from "@/lib/utils/persistedSequence";
import { type CaseTypeDrift, computeSchemaDrift } from "../schemaDrift";
import { type HolderCensus, readHolderCensus } from "./holders";
import { CLASSIFIED_KINDS, type MediaRow } from "./media";
import type { SourceDeployment } from "./notice";
import { compareText } from "./types";

/** One app as the fleet read gives it. */
export interface SourceApp {
	readonly appId: string;
	readonly projectId: string;
	readonly deleted: boolean;
	readonly baseSeq: number;
	/** The source, parsed and hydrated by the production loader. */
	readonly doc: BlueprintDoc;
	/** Ordered by deployment id. */
	readonly deployments: readonly SourceDeployment[];
	/** Each case type whose stored schema differs from the head's derivation. */
	readonly drift: readonly CaseTypeDrift[];
}

/** One Project as the fleet read gives it. */
export interface SourceProject {
	readonly projectId: string;
	/** Every lookup table definition of the Project, rows-free. */
	readonly lookupContext: LookupValidationContext & { kind: "available" };
	/** Every media row of the Project, whatever its status or kind. */
	readonly mediaRows: readonly Selectable<MediaAssetsTable>[];
}

export interface FleetSource {
	/** In code-point order of id; one app under `--app`. */
	readonly apps: readonly SourceApp[];
	readonly projects: ReadonlyMap<string, SourceProject>;
	/** Every ready image, audio and video row of every Project, by asset id. */
	readonly media: readonly MediaRow[];
	readonly holders: HolderCensus;
	/** Every app, deleted ones included, whatever `--app` names. */
	readonly appsInFleet: number;
	readonly deletedApps: number;
	/** The digest of every app's `(id, mutation_seq)`. */
	readonly fleetSeqDigest: string;
	readonly databaseBytes: number;
}

/** The fleet's sequence digest: every app's `[id, mutation_seq]` in code-point order. */
export function fleetSeqDigestOf(
	apps: readonly { readonly id: string; readonly seq: number }[],
): string {
	return canonicalJsonDigest(
		[...apps]
			.sort((a, b) => compareText(a.id, b.id))
			.map((app) => [app.id, app.seq]),
	);
}

/** Every app row with its three `::text` carriers, without a lock. */
async function readAppRows(
	tx: Transaction<AppDatabase>,
	appId?: string,
): Promise<PersistedBlueprintAppRow[]> {
	let query = tx
		.selectFrom("apps")
		.select(PERSISTED_BLUEPRINT_APP_COLUMNS)
		.select(
			sql<string | null>`${sql.ref("apps.case_types")}::text`.as(
				"case_types_text",
			),
		)
		.select(
			sql<string | null>`${sql.ref("apps.localization")}::text`.as(
				"localization_text",
			),
		)
		.select(
			sql<string | null>`${sql.ref("apps.app_settings")}::text`.as(
				"app_settings_text",
			),
		);
	if (appId !== undefined) query = query.where("id", "=", appId);
	const rows = (await query.execute()) as PersistedBlueprintAppRow[];
	return rows.sort((a, b) => compareText(a.id, b.id));
}

/** One app's sequence and source digest as they stand on the caller's transaction; null where it is gone. */
export async function readAppBase(
	tx: Transaction<AppDatabase>,
	appId: string,
): Promise<{ readonly baseSeq: number; readonly baseDigest: string } | null> {
	const [row] = await readAppRows(tx, appId);
	if (row === undefined) return null;
	const snapshot = await loadSchemaAdmittedAppSnapshotFromRowInTransaction(
		tx,
		row,
	);
	return {
		baseSeq: snapshot.app.mutation_seq,
		baseDigest: canonicalJsonDigest(toPersistableDoc(snapshot.doc)),
	};
}

/**
 * Each app's deployments with a live `app` mapping (one a later publish has
 * not left behind and that CommCare HQ has not reported gone), with its app
 * baseline where it holds one.
 */
async function readDeployments(
	tx: Transaction<AppDatabase>,
	appIds: readonly string[],
): Promise<Map<string, SourceDeployment[]>> {
	const byApp = new Map<string, SourceDeployment[]>();
	if (appIds.length === 0) return byApp;
	const rows = await sql<{
		id: string;
		app_id: string;
		server: string;
		domain: string;
		origin: string | null;
		source_gzip: Buffer | null;
		source_digest: string | null;
	}>`
		SELECT deployment.id::text AS id, deployment.app_id, deployment.server,
			deployment.domain, baseline.origin, baseline.source_gzip,
			baseline.source_digest
		FROM app_deployments AS deployment
		LEFT JOIN app_deployment_baselines AS baseline
			ON baseline.deployment_id = deployment.id
		WHERE deployment.app_id = ANY(${[...appIds]}::text[])
			AND EXISTS (
				SELECT 1 FROM app_deployment_resources AS mapping
				WHERE mapping.deployment_id = deployment.id
					AND mapping.kind = 'app'
					AND mapping.superseded_at IS NULL
					AND mapping.remote_missing_at IS NULL
			)
	`.execute(tx);
	for (const row of rows.rows) {
		byApp.set(row.app_id, [
			...(byApp.get(row.app_id) ?? []),
			{
				deploymentId: row.id,
				server: row.server,
				domain: row.domain,
				baseline:
					row.origin === null
						? null
						: {
								origin: row.origin,
								sourceGzip: row.source_gzip,
								sourceDigest: row.source_digest,
							},
			},
		]);
	}
	for (const list of byApp.values())
		list.sort((a, b) => compareText(a.deploymentId, b.deploymentId));
	return byApp;
}

async function readProject(
	tx: Transaction<AppDatabase>,
	projectId: string,
): Promise<SourceProject> {
	const tables = await tx
		.selectFrom("lookup_tables")
		.select("id")
		.where("project_id", "=", projectId)
		.orderBy("id")
		.execute();
	const snapshot = await readLookupDefinitionsInTransaction(
		tx,
		projectId,
		tables.map((table) => lookupTableIdSchema.parse(table.id)),
	);
	const mediaRows = await tx
		.selectFrom("media_assets")
		.selectAll()
		.where("project_id", "=", projectId)
		.execute();
	return {
		projectId,
		lookupContext: { kind: "available", ...snapshot },
		mediaRows: [...mediaRows].sort((a, b) => compareText(a.id, b.id)),
	};
}

/** Every ready image, audio and video row, in asset-id order. */
export async function readReadyMediaRows(
	tx: Transaction<AppDatabase> | Kysely<AppDatabase>,
): Promise<MediaRow[]> {
	const rows = await tx
		.selectFrom("media_assets")
		.select([
			"id",
			"project_id",
			"status",
			"kind",
			"mime_type",
			"extension",
			"content_hash",
			"gcs_object_key",
		])
		.where("status", "=", "ready")
		.where("kind", "in", [...CLASSIFIED_KINDS])
		.execute();
	return rows.sort((a, b) => compareText(a.id, b.id));
}

/**
 * Read everything the plan decides from, on one transaction. `appId` limits
 * the planned apps to one (`--app`); the fleet's counts, its sequence digest
 * and the media rows still cover every app.
 */
export async function readFleetSource(
	tx: Transaction<AppDatabase>,
	options: { readonly appId?: string } = {},
): Promise<FleetSource> {
	const fleet = await sql<{
		id: string;
		mutation_seq: string;
		deleted: boolean;
	}>`
		SELECT id, mutation_seq::text AS mutation_seq, deleted_at IS NOT NULL AS deleted
		FROM apps
	`.execute(tx);
	const rows = await readAppRows(tx, options.appId);
	const deployments = await readDeployments(
		tx,
		rows.map((row) => row.id),
	);
	const apps: SourceApp[] = [];
	for (const row of rows) {
		const snapshot = await loadSchemaAdmittedAppSnapshotFromRowInTransaction(
			tx,
			row,
		);
		apps.push({
			appId: row.id,
			projectId: row.project_id,
			deleted: row.deleted_at !== null,
			baseSeq: snapshot.app.mutation_seq,
			doc: snapshot.doc,
			deployments: deployments.get(row.id) ?? [],
			drift: await computeSchemaDrift(
				tx as unknown as Kysely<Database>,
				row.id,
				toPersistableDoc(snapshot.doc),
			),
		});
	}
	const projects = new Map<string, SourceProject>();
	for (const projectId of [...new Set(rows.map((row) => row.project_id))].sort(
		compareText,
	)) {
		projects.set(projectId, await readProject(tx, projectId));
	}
	const size = await sql<{ bytes: string }>`
		SELECT pg_database_size(current_database())::text AS bytes
	`.execute(tx);
	return {
		apps,
		projects,
		media: await readReadyMediaRows(tx),
		holders: await readHolderCensus(tx),
		appsInFleet: fleet.rows.length,
		deletedApps: fleet.rows.filter((row) => row.deleted).length,
		fleetSeqDigest: fleetSeqDigestOf(
			fleet.rows.map((row) => ({
				id: row.id,
				seq: safePersistedSequence(
					row.mutation_seq,
					`apps.mutation_seq for app ${row.id}`,
				),
			})),
		),
		databaseBytes: Number(size.rows[0]?.bytes ?? "0"),
	};
}
