/**
 * Seeds a frozen pre-step fixture into a test database as the rows a
 * pre-step deployment of Nova left behind: the app's root and entity rows,
 * its genesis marker and fold baseline at sequence 1, each history row after
 * it, the active case schemas its stored document derived, and the
 * Project's lookup definitions and ready media rows.
 *
 * The rows are inserted as they stand, with the database's triggers held for
 * the one seeding transaction (`session_replication_role = replica`, the
 * test database's own superuser), because no writer of the tree at a later
 * head of the stack can write a pre-step document: the fixtures are frozen
 * as rows.
 */

import { type Kysely, sql } from "kysely";
import type { AppDatabase } from "@/lib/db/pg";
import { rawDocumentAssembly, readRawDocument } from "../../oldShape";
import {
	type FixtureCarriers,
	type FixtureHistory,
	type FixtureProject,
	readFixtureCarriers,
	readFixtureProject,
	readFixtureSchemas,
} from "./preStep";

export interface SeedFixtureApp {
	readonly appId: string;
	readonly projectId: string;
	readonly owner: string;
	readonly carriers: FixtureCarriers;
	/** Each active case schema row, by case type. */
	readonly schemas: Readonly<Record<string, unknown>>;
	/** History rows after the baseline; the baseline's snapshot defaults to the carriers' document. */
	readonly history?: FixtureHistory;
	/** Rows appended after the history's, as stored: a project move, or a row no fold reads. */
	readonly extraRows?: readonly {
		readonly seq: number;
		readonly kind: string;
		readonly mutationsText: string;
		readonly fromProjectId?: string;
		readonly toProjectId?: string;
	}[];
	readonly deletedAt?: Date;
	/** The rows of an app whose `apps.case_types` is NULL. */
	readonly caseTypesNull?: boolean;
}

/** One fixture by id, at the head of its history where one is named. */
export function fixtureApp(
	id: string,
	args: { appId: string; projectId: string; owner: string },
): SeedFixtureApp {
	return {
		...args,
		carriers: readFixtureCarriers(id),
		schemas: readFixtureSchemas(id),
	};
}

function counts(carriers: FixtureCarriers) {
	return {
		modules: carriers.rows.filter((row) => row.kind === "module").length,
		forms: carriers.rows.filter((row) => row.kind === "form").length,
	};
}

/** Insert one fixture app's rows, with the triggers held. */
export async function seedFixtureApp(
	db: Kysely<AppDatabase>,
	app: SeedFixtureApp,
): Promise<void> {
	const raw = readRawDocument(app.appId, app.carriers);
	const headSeq = Math.max(
		1,
		...(app.history?.rows ?? []).map((row) => row.seq),
		...(app.extraRows ?? []).map((row) => row.seq),
	);
	const snapshotText =
		app.history?.baseline.snapshotText ??
		JSON.stringify(rawDocumentAssembly(app.appId, raw));
	const { modules, forms } = counts(app.carriers);
	await db.transaction().execute(async (tx) => {
		await sql`SET LOCAL session_replication_role = replica`.execute(tx);
		await sql`
			INSERT INTO apps (id, owner, project_id, app_name, app_name_lower, connect_type,
				case_types, localization, logo, module_count, form_count, mutation_seq, status,
				deleted_at, recoverable_until)
			VALUES (${app.appId}, ${app.owner}, ${app.projectId}, ${app.carriers.root.app_name},
				${app.carriers.root.app_name.toLowerCase()}, ${app.carriers.root.connect_type},
				${app.caseTypesNull === true ? null : app.carriers.root.case_types_text}::jsonb,
				${app.carriers.root.localization_text ?? null}::jsonb, ${app.carriers.root.logo},
				${modules}, ${forms}, ${headSeq}, 'complete',
				${app.deletedAt ?? null}::timestamptz,
				${app.deletedAt === undefined ? null : new Date(app.deletedAt.getTime() + 30 * 86_400_000)}::timestamptz)
		`.execute(tx);
		for (const row of app.carriers.rows) {
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
			VALUES (${app.appId}, 1, ${app.projectId}, ${snapshotText}::jsonb,
				nova_app_change_fold_snapshot_digest(${snapshotText}::jsonb))
		`.execute(tx);
		for (const row of app.history?.rows ?? []) {
			await sql`
				INSERT INTO app_changes (app_id, seq, batch_id, run_id, actor_id, kind, mutations,
					from_project_id, to_project_id)
				VALUES (${app.appId}, ${row.seq}, ${row.batchId}, NULL, ${app.owner}, 'autosave',
					${row.mutationsText}::jsonb, NULL, NULL)
			`.execute(tx);
		}
		for (const row of app.extraRows ?? []) {
			await sql`
				INSERT INTO app_changes (app_id, seq, batch_id, run_id, actor_id, kind, mutations,
					from_project_id, to_project_id)
				VALUES (${app.appId}, ${row.seq}, ${`extra:${row.seq}`}, NULL, ${app.owner}, ${row.kind},
					${row.mutationsText}::jsonb, ${row.fromProjectId ?? null}, ${row.toProjectId ?? null})
			`.execute(tx);
		}
		for (const [caseType, schema] of Object.entries(app.schemas)) {
			await sql`
				INSERT INTO case_type_schemas (app_id, case_type, schema, synced_seq)
				VALUES (${app.appId}, ${caseType}, ${JSON.stringify(schema)}::jsonb, ${headSeq})
			`.execute(tx);
		}
	});
}

/** Insert a Project's lookup definitions and its ready media rows, as a fixture names them. */
export async function seedFixtureProject(
	db: Kysely<AppDatabase>,
	projectId: string,
	project: FixtureProject,
	owner: string,
): Promise<void> {
	const lookup = project.lookup as
		| {
				definitions: {
					id: string;
					name: string;
					tag: string;
					columns: {
						id: string;
						wireName: string;
						label: string;
						dataType: string;
					}[];
				}[];
		  }
		| undefined;
	await db.transaction().execute(async (tx) => {
		await sql`SET LOCAL session_replication_role = replica`.execute(tx);
		for (const table of lookup?.definitions ?? []) {
			await sql`
				INSERT INTO lookup_tables (project_id, id, name, tag, definition_revision,
					rows_revision, column_count, created_by, updated_by)
				VALUES (${projectId}, ${table.id}::uuid, ${table.name}, ${table.tag}, 1, 1,
					${table.columns.length}, ${owner}, ${owner})
			`.execute(tx);
			for (const [index, column] of table.columns.entries()) {
				await sql`
					INSERT INTO lookup_columns (project_id, table_id, id, wire_name, label, data_type, order_key)
					VALUES (${projectId}, ${table.id}::uuid, ${column.id}::uuid, ${column.wireName},
						${column.label}, ${column.dataType}, ${`a${index + 1}`})
				`.execute(tx);
			}
		}
		for (const [id, asset] of Object.entries(project.media ?? {})) {
			await sql`
				INSERT INTO media_assets (id, project_id, owner, content_hash, mime_type, extension,
					size_bytes, kind, gcs_object_key, original_filename, status)
				VALUES (${id}, ${projectId}, ${owner}, ${asset.sha256}, ${asset.mimeType},
					${asset.extension}, ${asset.sizeBytes}, ${asset.kind},
					${`projects/${projectId}/media/${asset.sha256}${asset.extension}`},
					${`${id}${asset.extension}`}, 'ready')
			`.execute(tx);
		}
	});
}

/** Seed one fixture as an app of its own Project, with that Project's data. */
export async function seedFixture(
	db: Kysely<AppDatabase>,
	id: string,
	args: { appId: string; projectId: string; owner: string },
): Promise<void> {
	await seedFixtureProject(
		db,
		args.projectId,
		readFixtureProject(id),
		args.owner,
	);
	await seedFixtureApp(db, fixtureApp(id, args));
}
