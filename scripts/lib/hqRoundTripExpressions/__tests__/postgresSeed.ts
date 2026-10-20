/**
 * Seeds the frozen pre-step fixtures into a test database as the rows a
 * pre-step deployment of Nova left behind: the app's root and entity rows,
 * its genesis marker and fold baseline at sequence 1, and the stored case
 * schemas the prerequisite scan requires equal to the pre-step derivation.
 *
 * The rows are inserted as they stand, with the database's triggers held for
 * the one seeding transaction (`session_replication_role = replica`, the test
 * database's own superuser), because no writer at the head can write a
 * pre-step document: the fixtures are frozen as rows. The baseline's snapshot
 * is the database's own `nova_current_app_change_fold_snapshot` over those
 * rows, so it is the snapshot a pre-step writer would have stored.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Kysely, sql } from "kysely";
import { buildCaseTypeMap } from "@/lib/case-store/store";
import type {
	PersistedBlueprintRootText,
	PersistedEntityRowText,
} from "@/lib/db/persistedJson";
import type { AppDatabase } from "@/lib/db/pg";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { type BlueprintDoc, USERCASE_CASE_TYPE } from "@/lib/domain";
import { caseTypeToJsonSchema } from "@/lib/domain/expression/jsonSchema";
import type { PlannedSchemaChange } from "../types";

const PRE_STEP = join(import.meta.dirname, "fixtures", "pre-step");

/** One document's raw carriers, exactly as a pre-step writer stored them. */
export interface FixtureCarriers {
	readonly root: PersistedBlueprintRootText;
	readonly rows: readonly PersistedEntityRowText[];
}

export interface FixtureManifestEntry {
	readonly id: string;
	readonly kind: "corpus" | "synthetic";
	readonly steps: readonly string[];
	readonly classes: readonly string[];
	readonly blockers: readonly string[];
	readonly rules: readonly string[];
	readonly reasons: readonly string[];
	readonly context?: Readonly<Record<string, unknown>>;
	readonly faults?: readonly unknown[];
}

export function readFixtureManifest(): readonly FixtureManifestEntry[] {
	return (
		JSON.parse(readFileSync(join(PRE_STEP, "manifest.json"), "utf8")) as {
			fixtures: FixtureManifestEntry[];
		}
	).fixtures;
}

export function readFixtureCarriers(id: string): FixtureCarriers {
	return JSON.parse(
		readFileSync(join(PRE_STEP, id, "carriers.json"), "utf8"),
	) as FixtureCarriers;
}

/**
 * Every fixture the writer takes as it is: none witnesses a blocker, so
 * each one's target parses, passes the gate and export readiness.
 */
export function writableFixtureIds(): readonly string[] {
	return readFixtureManifest()
		.filter(
			(fixture) =>
				fixture.blockers.length === 0 &&
				(fixture.faults ?? []).length === 0 &&
				fixture.context === undefined,
		)
		.map((fixture) => fixture.id);
}

export interface SeedPreStepApp {
	readonly appId: string;
	readonly projectId: string;
	readonly owner: string;
	readonly carriers: FixtureCarriers;
	readonly deletedAt?: Date;
	/** The rows of an app whose `apps.case_types` is NULL. */
	readonly caseTypesNull?: boolean;
}

export function fixtureApp(
	id: string,
	args: { appId: string; projectId: string; owner: string },
): SeedPreStepApp {
	return { ...args, carriers: readFixtureCarriers(id) };
}

/** Insert one pre-step app's rows at sequence 1, with the triggers held. */
export async function seedPreStepApp(
	db: Kysely<AppDatabase>,
	app: SeedPreStepApp,
): Promise<void> {
	const { root, rows } = app.carriers;
	const modules = rows.filter((row) => row.kind === "module").length;
	const forms = rows.filter((row) => row.kind === "form").length;
	await db.transaction().execute(async (tx) => {
		await sql`SET LOCAL session_replication_role = replica`.execute(tx);
		await sql`
			INSERT INTO apps (id, owner, project_id, app_name, app_name_lower, connect_type,
				case_types, localization, app_settings, logo, module_count, form_count,
				mutation_seq, status, deleted_at, recoverable_until)
			VALUES (${app.appId}, ${app.owner}, ${app.projectId}, ${root.app_name},
				${root.app_name.toLowerCase()}, ${root.connect_type},
				${app.caseTypesNull === true ? null : root.case_types_text}::jsonb,
				${root.localization_text ?? null}::jsonb, ${root.app_settings_text}::jsonb,
				${root.logo}, ${modules}, ${forms}, 1, 'complete',
				${app.deletedAt ?? null}::timestamptz,
				${app.deletedAt === undefined ? null : new Date(app.deletedAt.getTime() + 30 * 86_400_000)}::timestamptz)
		`.execute(tx);
		for (const row of rows) {
			await sql`
				INSERT INTO blueprint_entities (app_id, uuid, kind, parent_uuid, ordinal, data)
				VALUES (${app.appId}, ${row.uuid}, ${row.kind}, ${row.parent_uuid}, ${row.ordinal},
					${row.data_text}::jsonb)
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
 * Store the case schemas a pre-step deploy left for an app: the target's
 * derivation with each planned change undone, a declared property absent and
 * every property the catalog leaves untyped stored untyped, as it was before
 * step 3's inference typed it. Only the declared changes are read from the
 * plan, since an inferred change is planned against the stored rows this
 * writes. The prerequisite drift scan (part 09 §14,
 * step 1) holds that the stored rows equal the pre-step derivation, and the
 * plan's changes are by definition the whole difference the target derives,
 * so this is that derivation. The worker's own case is left unstored, as an
 * app that predates it holds it.
 */
export async function seedStoredSchemas(
	db: Kysely<AppDatabase>,
	appId: string,
	target: BlueprintDoc,
	changes: readonly PlannedSchemaChange[],
): Promise<void> {
	const persistable = toPersistableDoc(target);
	const catalogTyped = new Set(
		(persistable.caseTypes ?? []).flatMap((caseType) =>
			caseType.properties
				.filter((property) => property.data_type !== undefined)
				.map((property) => JSON.stringify([caseType.name, property.name])),
		),
	);
	const declared = new Set(
		changes
			.filter((change) => change.source === "declared")
			.map((change) => JSON.stringify([change.caseType, change.property])),
	);
	await db.transaction().execute(async (tx) => {
		await sql`SET LOCAL session_replication_role = replica`.execute(tx);
		for (const [name, caseType] of buildCaseTypeMap(persistable)) {
			if (name === USERCASE_CASE_TYPE) continue;
			const properties = caseType.properties.flatMap((property) => {
				const key = JSON.stringify([name, property.name]);
				if (declared.has(key)) return [];
				if (catalogTyped.has(key)) return [property];
				/* A property the catalog leaves untyped had no type before step 3's
				 * inference: it was stored untyped, which the case store holds as
				 * text. */
				const { data_type: _inferred, ...untyped } = property;
				return [untyped];
			});
			await sql`
				INSERT INTO case_type_schemas (app_id, case_type, schema, synced_seq)
				VALUES (${appId}, ${name},
					${JSON.stringify(caseTypeToJsonSchema({ ...caseType, properties }))}::jsonb, 1)
			`.execute(tx);
		}
	});
}

/** Insert one stored case of an app, with the triggers held. */
export async function seedCase(
	db: Kysely<AppDatabase>,
	args: {
		readonly caseId: string;
		readonly appId: string;
		readonly projectId: string;
		readonly caseType: string;
		readonly ownerId: string;
		readonly properties: Readonly<Record<string, unknown>>;
	},
): Promise<void> {
	await db.transaction().execute(async (tx) => {
		await sql`SET LOCAL session_replication_role = replica`.execute(tx);
		await sql`
			INSERT INTO cases (
				case_id, app_id, case_type, project_id, owner_id, status,
				opened_on, modified_on, closed_on, case_name, external_id,
				parent_case_id, properties
			)
			VALUES (
				${args.caseId}, ${args.appId}, ${args.caseType}, ${args.projectId},
				${args.ownerId}, 'open', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z',
				NULL, ${args.caseId}, NULL, NULL, ${JSON.stringify(args.properties)}::jsonb
			)
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
		["parked_case_values", "id"],
		["events", "id"],
		["threads", "thread_id"],
		["chat_stream_chunks", "stream_id, first_index"],
		["presence", "app_id, user_id, session_id"],
		["authoring_sessions", "id"],
		["authoring_workspaces", "id"],
		["design_change_sets", "id"],
		["design_sessions", "id"],
		["design_slice_attempts", "id"],
		["app_migration_notices", "id"],
		["media_asset_refs", "app_id, asset_id"],
		["lookup_table_references", "app_id, table_id"],
		["lookup_column_references", "app_id, table_id, column_id"],
		["app_location_references", "app_id"],
		["credit_months", "user_id, period"],
	] as const;
	const parts: string[] = [];
	for (const [table, order] of tables) {
		const rows = await sql<{ row: string }>`
			SELECT t::text AS row FROM ${sql.table(table)} AS t ORDER BY ${sql.raw(order)}
		`.execute(db);
		parts.push(`${table}:${rows.rows.map((row) => row.row).join("\n")}`);
	}
	return parts.join("\n\n");
}
