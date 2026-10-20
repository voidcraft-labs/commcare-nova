/**
 * Everything the expressions cutover reads from Nova's database before it
 * decides (part 09 §3 and §4): plain `SELECT`s on the caller's one
 * `REPEATABLE READ, READ ONLY` transaction, so the scan's read-only identity
 * runs them and they take no lock.
 *
 * `readFleetSource` reads every app (deleted ones included) with its raw
 * carriers, its active case schemas, its stored case keys, whether it holds
 * open private work and its deployments with a live `app` mapping, and each
 * Project's lookup definitions and media. `planFleetInTransaction` runs each
 * app's transform over that source, reads what each planned schema change
 * meets in the stored cases (`./schemaPlan.ts`), and hands both to the pure
 * plan builder (`./plan.ts::assemblePlannedFleet`). `readAppBase` and
 * `readPrivateWorkCensus` are the writer's re-reads under its locks, and
 * `readRecipients` the announcement's address list.
 */

import { type Kysely, sql, type Transaction } from "kysely";
import { mediaAssetRecordFromRow } from "@/lib/db/mediaAssets";
import type {
	PersistedBlueprintRootText,
	PersistedEntityRowText,
} from "@/lib/db/persistedJson";
import type { AppDatabase } from "@/lib/db/pg";
import { ALL_ICON_SLUGS } from "@/lib/domain/builtinIcons";
import { lookupTableIdSchema } from "@/lib/domain/lookupIds";
import { readLookupDefinitionsInTransaction } from "@/lib/lookup/definitionSnapshot";
import { builtinAssetRows } from "@/lib/media/builtinIconAssets";
import { safePersistedSequence } from "@/lib/utils/persistedSequence";
import { readHolderCensus } from "./holders";
import {
	type RawCarriers,
	rawDocumentDigest,
	readRawDocument,
} from "./oldShape";
import {
	assemblePlannedFleet,
	type FleetSource,
	fleetSeqDigestOf,
	type PlannedFleet,
	type PrivateWorkCensus,
	type SourceApp,
	type SourceDeployment,
	type SourceProject,
	transformFleet,
} from "./plan";
import { readSchemaChangeImpacts, type SchemaChangeImpact } from "./schemaPlan";
import type { TransformApp } from "./types";

/** The open private work, read on the caller's transaction. */
export async function readPrivateWorkCensus(
	tx: Transaction<AppDatabase>,
): Promise<PrivateWorkCensus> {
	const counts = await sql<{
		workspaces: string;
		change_sets: string;
		candidates: string;
	}>`
		SELECT
			(SELECT count(*) FROM authoring_workspaces WHERE status = 'open')::text AS workspaces,
			(SELECT count(*) FROM design_change_sets WHERE status = 'open')::text AS change_sets,
			(SELECT count(*) FROM authoring_sessions WHERE active_candidate_id IS NOT NULL)::text AS candidates
	`.execute(tx);
	const sessions = await sql<{ id: string }>`
		SELECT session.id FROM design_sessions AS session
		WHERE session.state = 'active' AND session.mode = 'build'
			AND session.app_id IS NULL
			AND (
				EXISTS (SELECT 1 FROM authoring_workspaces AS workspace
					WHERE workspace.design_session_id = session.id AND workspace.status = 'open')
				OR EXISTS (SELECT 1 FROM design_change_sets AS change_set
					WHERE change_set.design_session_id = session.id AND change_set.status = 'open')
			)
		ORDER BY session.id
	`.execute(tx);
	const row = counts.rows[0];
	return {
		openWorkspaces: Number(row?.workspaces ?? "0"),
		openChangeSets: Number(row?.change_sets ?? "0"),
		activeCandidates: Number(row?.candidates ?? "0"),
		endingSessions: sessions.rows.map((session) => session.id),
	};
}

interface RootRow {
	readonly id: string;
	readonly project_id: string;
	readonly mutation_seq: string;
	readonly deleted_at: Date | null;
	readonly app_name: string;
	readonly connect_type: string | null;
	readonly case_types_text: string | null;
	readonly localization_text: string | null;
	readonly app_settings_text: string | null;
	readonly logo: string | null;
}

function rootCarriers(row: RootRow): PersistedBlueprintRootText {
	return {
		app_name: row.app_name,
		connect_type:
			row.connect_type as PersistedBlueprintRootText["connect_type"],
		case_types_text: row.case_types_text,
		localization_text: row.localization_text,
		app_settings_text: row.app_settings_text,
		logo: row.logo as PersistedBlueprintRootText["logo"],
	};
}

async function readRoots(
	tx: Transaction<AppDatabase>,
	appId?: string,
): Promise<RootRow[]> {
	const rows = await sql<RootRow>`
		SELECT id, project_id, mutation_seq::text AS mutation_seq, deleted_at,
			app_name, connect_type, case_types::text AS case_types_text,
			localization::text AS localization_text,
			app_settings::text AS app_settings_text, logo
		FROM apps
		${appId === undefined ? sql`` : sql`WHERE id = ${appId}`}
	`.execute(tx);
	return [...rows.rows].sort((a, b) => compareText(a.id, b.id));
}

async function readEntityRows(
	tx: Transaction<AppDatabase>,
	appIds: readonly string[],
): Promise<Map<string, PersistedEntityRowText[]>> {
	const byApp = new Map<string, PersistedEntityRowText[]>();
	if (appIds.length === 0) return byApp;
	const rows = await sql<{
		app_id: string;
		uuid: string;
		kind: string;
		parent_uuid: string | null;
		ordinal: number;
		data_text: string;
	}>`
		SELECT app_id, uuid, kind, parent_uuid, ordinal, data::text AS data_text
		FROM blueprint_entities
		WHERE app_id = ANY(${[...appIds]}::text[])
	`.execute(tx);
	for (const row of rows.rows) {
		const list = byApp.get(row.app_id) ?? [];
		list.push({
			uuid: row.uuid as PersistedEntityRowText["uuid"],
			kind: row.kind as PersistedEntityRowText["kind"],
			parent_uuid: row.parent_uuid as PersistedEntityRowText["parent_uuid"],
			ordinal: row.ordinal,
			data_text: row.data_text,
		});
		byApp.set(row.app_id, list);
	}
	for (const list of byApp.values())
		list.sort((a, b) => compareText(a.uuid, b.uuid));
	return byApp;
}

/**
 * One app's sequence and raw-carrier digest as they stand on the caller's
 * transaction: what the writer compares with the plan under its locks.
 * Null where the app is gone.
 */
export async function readAppBase(
	tx: Transaction<AppDatabase>,
	appId: string,
): Promise<{ readonly baseSeq: number; readonly baseDigest: string } | null> {
	const [root] = await readRoots(tx, appId);
	if (root === undefined) return null;
	const rows = (await readEntityRows(tx, [appId])).get(appId) ?? [];
	return {
		baseSeq: safePersistedSequence(
			root.mutation_seq,
			`apps.mutation_seq for app ${appId}`,
		),
		baseDigest: rawDocumentDigest(
			readRawDocument(appId, { root: rootCarriers(root), rows }),
		),
	};
}

async function readStoredCaseSchemas(
	tx: Transaction<AppDatabase>,
	appIds: readonly string[],
): Promise<Map<string, Map<string, string>>> {
	const byApp = new Map<string, Map<string, string>>();
	if (appIds.length === 0) return byApp;
	const rows = await sql<{
		app_id: string;
		case_type: string;
		schema_text: string;
	}>`
		SELECT app_id, case_type, schema::text AS schema_text
		FROM case_type_schemas
		WHERE is_active AND app_id = ANY(${[...appIds]}::text[])
	`.execute(tx);
	for (const row of rows.rows) {
		const map = byApp.get(row.app_id) ?? new Map<string, string>();
		map.set(row.case_type, row.schema_text);
		byApp.set(row.app_id, map);
	}
	return byApp;
}

/** Per app, per case type, per property key: the `cases` rows holding it. */
async function readStoredCaseKeys(
	tx: Transaction<AppDatabase>,
	appIds: readonly string[],
): Promise<Map<string, Map<string, Map<string, number>>>> {
	const byApp = new Map<string, Map<string, Map<string, number>>>();
	if (appIds.length === 0) return byApp;
	const rows = await sql<{
		app_id: string;
		case_type: string;
		key: string;
		count: string;
	}>`
		SELECT cases.app_id, cases.case_type, held.key, count(*)::text AS count
		FROM cases CROSS JOIN LATERAL jsonb_object_keys(cases.properties) AS held(key)
		WHERE cases.app_id = ANY(${[...appIds]}::text[])
		GROUP BY cases.app_id, cases.case_type, held.key
	`.execute(tx);
	for (const row of rows.rows) {
		const types = byApp.get(row.app_id) ?? new Map();
		const keys = types.get(row.case_type) ?? new Map<string, number>();
		keys.set(row.key, Number(row.count));
		types.set(row.case_type, keys);
		byApp.set(row.app_id, types);
	}
	return byApp;
}

async function readAppsWithPrivateWork(
	tx: Transaction<AppDatabase>,
): Promise<Set<string>> {
	const rows = await sql<{ app_id: string }>`
		SELECT app_id FROM authoring_workspaces
			WHERE status = 'open' AND app_id IS NOT NULL
		UNION
		SELECT app_id FROM design_change_sets
			WHERE status = 'open' AND app_id IS NOT NULL
	`.execute(tx);
	return new Set(rows.rows.map((row) => row.app_id));
}

/**
 * Each app's deployments with a live `app` mapping: one a later publish has
 * not left behind and that CommCare HQ has not reported gone. A deployment
 * with none holds no app the next publish updates.
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
	}>`
		SELECT deployment.id::text AS id, deployment.app_id, deployment.server,
			deployment.domain
		FROM app_deployments AS deployment
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
		const list = byApp.get(row.app_id) ?? [];
		list.push({
			deploymentId: row.id,
			server: row.server,
			domain: row.domain,
		});
		byApp.set(row.app_id, list);
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
	/* Every asset the Project holds and every built-in icon: a superset of
	 * what its targets reference, read by plain SELECT, since the cutover
	 * changes no media reference and export readiness reads by id. An id
	 * another Project holds stays out, so it reads as not found. */
	const assets = await tx
		.selectFrom("media_assets")
		.selectAll()
		.where("project_id", "=", projectId)
		.orderBy("id")
		.execute();
	return {
		projectId,
		lookupContext: { kind: "available", ...snapshot },
		mediaAssets: new Map(
			[
				...assets.map(mediaAssetRecordFromRow),
				...builtinAssetRows(ALL_ICON_SLUGS),
			].map((record) => [record.id as string, record]),
		),
	};
}

/**
 * Read everything the plan decides from, on one transaction: plain
 * `SELECT`s, so the scan's read-only identity runs it and it takes no lock.
 * `appId` limits the planned apps to one (`--app`); the fleet's counts and
 * sequence digest still cover every app.
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
	const sequences = fleet.rows.map((row) => ({
		id: row.id,
		seq: safePersistedSequence(
			row.mutation_seq,
			`apps.mutation_seq for app ${row.id}`,
		),
	}));
	const roots = await readRoots(tx, options.appId);
	const appIds = roots.map((root) => root.id);
	const entityRows = await readEntityRows(tx, appIds);
	const schemas = await readStoredCaseSchemas(tx, appIds);
	const caseKeys = await readStoredCaseKeys(tx, appIds);
	const privateWork = await readAppsWithPrivateWork(tx);
	const deployments = await readDeployments(tx, appIds);
	const projects = new Map<string, SourceProject>();
	for (const projectId of [
		...new Set(roots.map((root) => root.project_id)),
	].sort(compareText)) {
		projects.set(projectId, await readProject(tx, projectId));
	}
	const size = await sql<{ bytes: string }>`
		SELECT pg_database_size(current_database())::text AS bytes
	`.execute(tx);
	const apps = roots.map((root): SourceApp => {
		const carriers: RawCarriers = {
			root: rootCarriers(root),
			rows: entityRows.get(root.id) ?? [],
		};
		return {
			appId: root.id,
			projectId: root.project_id,
			baseSeq: safePersistedSequence(
				root.mutation_seq,
				`apps.mutation_seq for app ${root.id}`,
			),
			deleted: root.deleted_at !== null,
			carriers,
			raw: readRawDocument(root.id, carriers),
			discardsPrivateWork: privateWork.has(root.id),
			storedCaseSchemas: schemas.get(root.id) ?? new Map(),
			storedCaseKeys: caseKeys.get(root.id) ?? new Map(),
			deployments: deployments.get(root.id) ?? [],
		};
	});
	return {
		apps,
		projects,
		privateWork: await readPrivateWorkCensus(tx),
		holders: await readHolderCensus(tx),
		appsInFleet: fleet.rows.length,
		deletedApps: fleet.rows.filter((row) => row.deleted).length,
		fleetSeqDigest: fleetSeqDigestOf(sequences),
		databaseBytes: Number(size.rows[0]?.bytes ?? "0"),
	};
}

/**
 * The plan over the fleet, read in one `REPEATABLE READ, READ ONLY`
 * transaction: the source, each app's transform, and what each planned
 * schema change meets in the stored cases, all from one snapshot.
 */
export async function planFleetInTransaction(
	tx: Transaction<AppDatabase>,
	transform: TransformApp,
	options: { readonly appId?: string } = {},
): Promise<PlannedFleet> {
	const source = await readFleetSource(tx, options);
	const transformed = transformFleet(source, transform);
	const impacts = new Map<string, readonly SchemaChangeImpact[]>();
	for (const { source: app, result } of transformed) {
		if (result.schemaChanges.length === 0) continue;
		impacts.set(
			app.appId,
			await readSchemaChangeImpacts(tx, app.appId, result.schemaChanges),
		);
	}
	return assemblePlannedFleet(source, transformed, impacts);
}

/** `planFleetInTransaction` in a read-only snapshot of its own. */
export async function readPlannedFleet(
	db: Kysely<AppDatabase>,
	options: { readonly appId?: string } = {},
): Promise<PlannedFleet> {
	const { transformApp } = await import("./transform");
	return db
		.transaction()
		.setIsolationLevel("repeatable read")
		.setAccessMode("read only")
		.execute((tx) => planFleetInTransaction(tx, transformApp, options));
}

/**
 * `--recipients`: the address list of the window's announcement, or of one
 * app's Project members. Printed on the operator's terminal only and never
 * archived with the evidence.
 */
export async function readRecipients(
	tx: Transaction<AppDatabase>,
	appId?: string,
): Promise<string[]> {
	if (appId === undefined) {
		const rows = await sql<{ email: string }>`
			SELECT email FROM auth_user ORDER BY email
		`.execute(tx);
		return rows.rows.map((row) => row.email);
	}
	const app = await tx
		.selectFrom("apps")
		.select("project_id")
		.where("id", "=", appId)
		.executeTakeFirst();
	if (app === undefined) {
		throw new Error(
			`App ${appId} was not found, so it has no members to list. Check the id against the scan's report.`,
		);
	}
	const rows = await sql<{ email: string }>`
		SELECT DISTINCT person.email FROM auth_member AS member
		JOIN auth_user AS person ON person.id = member."userId"
		WHERE member."organizationId" = ${app.project_id}
		ORDER BY person.email
	`.execute(tx);
	return rows.rows.map((row) => row.email);
}

/** Code-point order, so nothing depends on the database's collation. */
function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
