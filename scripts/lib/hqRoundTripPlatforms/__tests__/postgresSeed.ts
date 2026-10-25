/**
 * Seeds the platforms cutover's Postgres tests at `main`'s migration prefix:
 * the rows a pre-step deployment of Nova left behind, written as raw SQL,
 * because the head's production writers read `media_assets.media_format`,
 * which that prefix does not hold (step 3's helper of the same name is the
 * template).
 *
 * An app is its root row and entity rows (the production projection,
 * `denormalize` and `decomposeBlueprint`, of a document built with
 * `buildDoc`), its genesis marker and its fold baseline at sequence 1, the
 * baseline's snapshot the database's own
 * `nova_current_app_change_fold_snapshot` over those rows. The database's
 * triggers are held for each seeding transaction
 * (`session_replication_role = replica`, the test database's own superuser),
 * as no writer at the head writes at the prefix.
 */

import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { type Kysely, sql } from "kysely";
import { buildCaseTypeMap } from "@/lib/case-store/store";
import { decomposeBlueprint } from "@/lib/db/blueprintRows";
import { denormalize } from "@/lib/db/canonicalCommitKernel";
import type { AppDatabase } from "@/lib/db/pg";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { type BlueprintDoc, USERCASE_CASE_TYPE } from "@/lib/domain";
import type { CasePropertyDataType } from "@/lib/domain/casePropertyTypes";
import { caseTypeToJsonSchema } from "@/lib/domain/expression/jsonSchema";
import { collectRealAssetRefs } from "@/lib/domain/mediaRefs";

export interface SeedApp {
	readonly appId: string;
	readonly projectId: string;
	readonly owner: string;
	readonly doc: BlueprintDoc;
	readonly deletedAt?: Date;
}

/** Insert one app's rows at sequence 1, with the triggers held. */
export async function seedPlatformsApp(
	db: Kysely<AppDatabase>,
	app: SeedApp,
): Promise<void> {
	const persistable = toPersistableDoc({ ...app.doc, appId: app.appId });
	const root = denormalize(persistable);
	const rows = decomposeBlueprint(persistable);
	await db.transaction().execute(async (tx) => {
		await sql`SET LOCAL session_replication_role = replica`.execute(tx);
		await sql`
			INSERT INTO apps (id, owner, project_id, app_name, app_name_lower, connect_type,
				case_types, localization, app_settings, logo, module_count, form_count,
				mutation_seq, status, deleted_at, recoverable_until)
			VALUES (${app.appId}, ${app.owner}, ${app.projectId}, ${root.app_name},
				${root.app_name_lower}, ${root.connect_type}, ${root.case_types}::jsonb,
				${root.localization}::jsonb, ${root.app_settings}::jsonb, ${root.logo},
				${root.module_count}, ${root.form_count}, 1, 'complete',
				${app.deletedAt ?? null}::timestamptz,
				${app.deletedAt === undefined ? null : new Date(app.deletedAt.getTime() + 30 * 86_400_000)}::timestamptz)
		`.execute(tx);
		for (const row of rows) {
			await sql`
				INSERT INTO blueprint_entities (app_id, uuid, kind, parent_uuid, ordinal, data)
				VALUES (${app.appId}, ${row.uuid}, ${row.kind}, ${row.parent_uuid}, ${row.ordinal},
					${JSON.stringify(row.data)}::jsonb)
			`.execute(tx);
		}
		await sql`
			INSERT INTO app_changes (app_id, seq, batch_id, run_id, actor_id, kind, mutations,
				from_project_id, to_project_id)
			VALUES (${app.appId}, 1, ${`genesis:${app.appId}`}, NULL, ${app.owner}, 'fold-baseline',
				'[]'::jsonb, NULL, NULL)
		`.execute(tx);
		await sql`
			INSERT INTO app_change_fold_baselines (app_id, seq, project_id, snapshot, snapshot_digest)
			SELECT app.id, 1, app.project_id, current.snapshot,
				nova_app_change_fold_snapshot_digest(current.snapshot)
			FROM apps AS app,
				LATERAL (SELECT nova_current_app_change_fold_snapshot(app.id) AS snapshot) AS current
			WHERE app.id = ${app.appId}
		`.execute(tx);
	});
}

/**
 * Store the case schemas a pre-step deploy left for an app: the head's
 * derivation, with each property `retype` names stored as the type given
 * instead (`main`'s derivation of a property the merged code types anew).
 */
export async function seedStoredSchemas(
	db: Kysely<AppDatabase>,
	appId: string,
	doc: BlueprintDoc,
	retype: Readonly<Record<string, CasePropertyDataType>> = {},
): Promise<void> {
	await db.transaction().execute(async (tx) => {
		await sql`SET LOCAL session_replication_role = replica`.execute(tx);
		for (const [name, caseType] of buildCaseTypeMap(toPersistableDoc(doc))) {
			if (name === USERCASE_CASE_TYPE) continue;
			const properties = caseType.properties.map((property) =>
				Object.hasOwn(retype, property.name)
					? { ...property, data_type: retype[property.name] }
					: property,
			);
			await sql`
				INSERT INTO case_type_schemas (app_id, case_type, schema, synced_seq)
				VALUES (${appId}, ${name},
					${JSON.stringify(caseTypeToJsonSchema({ ...caseType, properties }))}::jsonb, 1)
			`.execute(tx);
		}
	});
}

/** Insert the authored media references an app's document holds, as its pre-step writer left them. */
export async function seedMediaReferences(
	db: Kysely<AppDatabase>,
	app: Pick<SeedApp, "appId" | "projectId" | "doc">,
): Promise<void> {
	for (const assetId of new Set(collectRealAssetRefs(app.doc))) {
		await sql`
			INSERT INTO media_asset_refs (project_id, asset_id, app_id)
			VALUES (${app.projectId}, ${assetId}, ${app.appId})
		`.execute(db);
	}
}

export interface SeedMedia {
	readonly id: string;
	readonly projectId: string;
	readonly kind: string;
	readonly mime: string;
	readonly extension: string;
	readonly status?: "ready" | "pending";
	readonly key?: string;
	readonly name?: string;
}

/** Insert one media row as the prefix holds it: no format column. */
export async function seedMediaRow(
	db: Kysely<AppDatabase>,
	row: SeedMedia,
): Promise<void> {
	const hash = createHash("sha256").update(row.id).digest("hex");
	await sql`
		INSERT INTO media_assets (id, project_id, owner, content_hash, mime_type,
			extension, size_bytes, kind, gcs_object_key, original_filename, status)
		VALUES (${row.id}, ${row.projectId}, 'owner', ${hash}, ${row.mime},
			${row.extension}, 100, ${row.kind}, ${row.key ?? `projects/${row.projectId}/${hash}`},
			${row.name ?? `file${row.extension}`}, ${row.status ?? "ready"})
	`.execute(db);
}

/**
 * Insert one live deployment of an app (its live `app` mapping) with an app
 * baseline of `origin` holding `source`, or none where `source` is absent.
 */
export async function seedDeployment(
	db: Kysely<AppDatabase>,
	args: {
		readonly id: string;
		readonly appId: string;
		readonly projectId: string;
		readonly domain: string;
		readonly origin?: "push" | "cutover" | "create";
		readonly source?: unknown;
	},
): Promise<void> {
	await sql`
		INSERT INTO app_deployments (id, app_id, project_id, server, domain, state, phases, created_by)
		VALUES (${args.id}::uuid, ${args.appId}, ${args.projectId}, 'production',
			${args.domain}, 'uploaded', '{}'::jsonb, 'owner')
	`.execute(db);
	await sql`
		INSERT INTO app_deployment_resources (deployment_id, kind, nova_resource_id,
			remote_id, ownership, pushed_at, pushed_revision)
		VALUES (${args.id}::uuid, 'app', 'app', ${`remote-${args.appId}`},
			'nova-created', '2026-10-01T00:00:00Z', 1)
	`.execute(db);
	if (args.source === undefined) return;
	const text = Buffer.from(JSON.stringify(args.source), "utf8");
	await sql`
		INSERT INTO app_deployment_baselines (deployment_id, remote_app_id, origin,
			source_gzip, source_bytes, source_digest, ownership, observed_at, observed_by)
		VALUES (${args.id}::uuid, ${`remote-${args.appId}`}, ${args.origin ?? "push"},
			${gzipSync(text)}, ${text.length},
			${createHash("sha256").update(text).digest("hex")}, '{}'::jsonb, now(), 'owner')
	`.execute(db);
}

/** Insert one stored case of an app, with the triggers held. */
export async function seedCase(
	db: Kysely<AppDatabase>,
	args: {
		readonly caseId: string;
		readonly appId: string;
		readonly projectId: string;
		readonly caseType: string;
		readonly properties: Readonly<Record<string, unknown>>;
	},
): Promise<void> {
	await db.transaction().execute(async (tx) => {
		await sql`SET LOCAL session_replication_role = replica`.execute(tx);
		await sql`
			INSERT INTO cases (case_id, app_id, case_type, project_id, owner_id, status,
				opened_on, modified_on, closed_on, case_name, external_id, parent_case_id, properties)
			VALUES (${args.caseId}, ${args.appId}, ${args.caseType}, ${args.projectId},
				'owner', 'open', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z', NULL,
				${args.caseId}, NULL, NULL, ${JSON.stringify(args.properties)}::jsonb)
		`.execute(tx);
	});
}

/** Every row the cutover could touch, as text, so two images compare byte for byte. */
export async function databaseImage(db: Kysely<AppDatabase>): Promise<string> {
	const tables = [
		["apps", "id"],
		["blueprint_entities", "app_id, uuid"],
		["app_changes", "app_id, seq"],
		["app_change_fold_baselines", "app_id, seq"],
		["case_type_schemas", "app_id, case_type"],
		["cases", "app_id, case_id"],
		["design_sessions", "id"],
		["app_migration_notices", "id"],
		["media_assets", "id"],
		["media_asset_refs", "app_id, asset_id"],
		["lookup_table_references", "app_id, table_id"],
		["app_location_references", "app_id"],
		["app_deployments", "id"],
		["credit_months", "user_id, period"],
		["kysely_migration", "name"],
	] as const;
	const parts: string[] = [];
	for (const [table, order] of tables) {
		const rows = await sql<{ row: string }>`
			SELECT t::text AS row FROM ${sql.table(table)} AS t ORDER BY ${sql.raw(order)}
		`.execute(db);
		parts.push(`${table}:${rows.rows.map((row) => row.row).join("\n")}`);
	}
	const constraint = await sql<{ definition: string }>`
		SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
		WHERE conname = 'form_attachments_size_check'
	`.execute(db);
	parts.push(`size-check:${constraint.rows[0]?.definition ?? ""}`);
	return parts.join("\n\n");
}
