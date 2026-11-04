/**
 * Everything the case-writes cutover reads from Nova's database before it
 * decides (step 5's part 09, sections 8.1 and 13): plain `SELECT`s on the
 * caller's transaction. The scan and the dry run give it one `REPEATABLE
 * READ, READ ONLY` transaction of their own (`readFleetSourceSnapshot`), so
 * the scan's read-only identity runs it and it takes no lock; the writer
 * calls the same reads on its fleet transaction, under the locks its
 * blocking scan took, so what it compares with the plan is read the way the
 * plan read it.
 *
 * It reads:
 *
 * - every app, deleted ones included, as its persisted carriers (the `apps`
 *   root columns as text and every `blueprint_entities` row), assembled by
 *   `oldShape.ts::readRawDocument` through no schema, with its sequence and
 *   its raw digest (`oldShape.ts::rawDocumentDigest`);
 * - each app's published deployments (section 8.1): a deployment that
 *   displays as having reached `uploaded`
 *   (`lib/deployment/stateMachine.ts::deploymentDisplaysAsReached`) and holds
 *   an `app` mapping a later publish has not left behind, one CommCare HQ
 *   reported missing included, with its baseline read by
 *   `placements.ts::readBaseline`, its identity overrides, its server, its
 *   domain and the mapping's pushed revision;
 * - each app's live deployments (a live `app` mapping CommCare HQ has not
 *   reported gone, published or not), which the deployment lines address;
 * - each Project's lookup definitions, as the canonical kernel builds its
 *   lookup context, and its media records with every built-in icon, as export
 *   readiness reads them;
 * - every active `case_type_schemas` row, as canonical text;
 * - the private work the fleet transaction abandons, and the run holders.
 *
 * An app's entry points are part of its document (`lib/domain/entryPoints.ts::
 * entryPointInventory`), so the carriers already hold them; nothing beside
 * the document is read for them.
 */

import { type Kysely, sql, type Transaction } from "kysely";
import {
	type MediaAssetRecord,
	mediaAssetRecordFromRow,
} from "@/lib/db/mediaAssets";
import type {
	PersistedBlueprintRootText,
	PersistedEntityRowText,
} from "@/lib/db/persistedJson";
import type { AppDatabase } from "@/lib/db/pg";
import { deploymentDisplaysAsReached } from "@/lib/deployment/stateMachine";
import {
	deploymentPhaseSchema,
	deploymentStateSchema,
	isDeploymentServer,
} from "@/lib/deployment/types";
import type { LookupValidationContext } from "@/lib/doc/lookupReferences";
import type { MediaAssetId } from "@/lib/domain";
import { ALL_ICON_SLUGS } from "@/lib/domain/builtinIcons";
import { lookupTableIdSchema } from "@/lib/domain/lookupIds";
import { readLookupDefinitionsInTransaction } from "@/lib/lookup/definitionSnapshot";
import { builtinAssetRows } from "@/lib/media/builtinIconAssets";
import {
	canonicalJsonDigest,
	canonicalJsonText,
} from "@/lib/utils/canonicalJson";
import { safePersistedSequence } from "@/lib/utils/persistedSequence";
import { type HolderCensus, readHolderCensus } from "./holders";
import {
	type RawCarriers,
	type RawDocument,
	rawDocumentDigest,
	readRawDocument,
} from "./oldShape";
import { readBaseline } from "./placements";
import {
	compareText,
	type LiveDeployment,
	type PublishedDeployment,
	type StepContext,
} from "./types";

// ─── What the read gives ──────────────────────────────────────────────────

/** One app as the fleet read gives it. */
export interface SourceApp {
	readonly appId: string;
	readonly projectId: string;
	readonly deleted: boolean;
	/** `apps.mutation_seq` as read. */
	readonly baseSeq: number;
	readonly carriers: RawCarriers;
	/** The carriers assembled through no schema. */
	readonly raw: RawDocument;
	/** `AppPlan.baseDigest`: `rawDocumentDigest(raw)`. */
	readonly baseDigest: string;
	/** What every step reads beside the document: section 8.1's published
	 *  deployments, every live one in deployment-id order, the stored
	 *  schemas, `baseSeq` as `mutationSeq`, and whether the fleet
	 *  transaction abandons an open workspace, change set or active
	 *  candidate of the app. */
	readonly context: StepContext;
}

/** One Project as the fleet read gives it. */
export interface SourceProject {
	readonly projectId: string;
	/** Every lookup table definition of the Project, rows-free. */
	readonly lookupContext: LookupValidationContext & { kind: "available" };
	/** Every media record of the Project and every built-in icon, by id. */
	readonly mediaRecords: ReadonlyMap<MediaAssetId, MediaAssetRecord>;
}

/** The private work the fleet transaction abandons (part 09 §3, step
 *  `private-work`), and the `mutation` events it archives. */
export interface PrivateWorkCensus {
	readonly openWorkspaces: number;
	readonly openChangeSets: number;
	readonly activeCandidates: number;
	/** Active pre-app build sessions holding open work, which the cutover
	 *  ends through `abandonPreAppDesignSessionInTransaction`, by id. */
	readonly endingSessions: readonly string[];
	/** `events` rows of kind `mutation`. */
	readonly mutationEvents: number;
	/** Apps holding any open work, in code-point order. */
	readonly apps: readonly string[];
}

export interface FleetSource {
	/** In code-point order of id; one app under `--app`. */
	readonly apps: readonly SourceApp[];
	readonly projects: ReadonlyMap<string, SourceProject>;
	readonly privateWork: PrivateWorkCensus;
	readonly holders: HolderCensus;
	/** Every app, deleted ones included, whatever `--app` names. */
	readonly appsInFleet: number;
	readonly deletedApps: number;
	/** The digest of every app's `[id, mutation_seq]`. */
	readonly fleetSeqDigest: string;
	readonly databaseBytes: number;
}

/** The fleet's sequence digest: every app's `[id, mutation_seq]` in
 *  code-point order of id. */
export function fleetSeqDigestOf(
	apps: readonly { readonly id: string; readonly seq: number }[],
): string {
	return canonicalJsonDigest(
		[...apps]
			.sort((a, b) => compareText(a.id, b.id))
			.map((app) => [app.id, app.seq]),
	);
}

// ─── Carriers ─────────────────────────────────────────────────────────────

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

function carriersOf(
	root: RootRow,
	rows: Map<string, PersistedEntityRowText[]>,
): RawCarriers {
	return { root: rootCarriers(root), rows: rows.get(root.id) ?? [] };
}

function sequenceOf(root: RootRow): number {
	return safePersistedSequence(
		root.mutation_seq,
		`apps.mutation_seq for app ${root.id}`,
	);
}

/**
 * One app's sequence and raw digest as they stand on the caller's
 * transaction: what the writer compares with the plan under its locks.
 * Null where the app is gone.
 */
export async function readAppBase(
	tx: Transaction<AppDatabase>,
	appId: string,
): Promise<{ readonly baseSeq: number; readonly baseDigest: string } | null> {
	const [root] = await readRoots(tx, appId);
	if (root === undefined) return null;
	const rows = await readEntityRows(tx, [appId]);
	return {
		baseSeq: sequenceOf(root),
		baseDigest: rawDocumentDigest(
			readRawDocument(appId, carriersOf(root, rows)),
		),
	};
}

// ─── Deployments (section 8.1) ────────────────────────────────────────────

/** Each app's deployments, published and live, as the read gives them. */
export interface AppDeployments {
	/** Section 8.1's published deployments, in deployment-id order. */
	readonly published: readonly PublishedDeployment[];
	/** Every live deployment, in deployment-id order. */
	readonly live: readonly LiveDeployment[];
}

interface DeploymentRow {
	readonly id: string;
	readonly app_id: string;
	readonly server: string;
	readonly domain: string;
	readonly state: string;
	readonly resume_phase: string | null;
	readonly mapping_count: string;
	readonly missing: boolean;
	readonly pushed_revision: string | null;
	readonly origin: string | null;
	readonly source_gzip: Buffer | null;
	readonly source_digest: string | null;
	readonly observed_at: Date | null;
}

/** A stored deployment's progress, its closed vocabularies reasserted as
 *  `lib/deployment/store.ts` reasserts them. */
function progressOf(row: DeploymentRow) {
	const state = deploymentStateSchema.safeParse(row.state);
	const resumePhase =
		row.resume_phase === null
			? null
			: deploymentPhaseSchema.safeParse(row.resume_phase);
	if (!state.success || (resumePhase !== null && !resumePhase.success))
		throw new Error(
			`Deployment ${row.id} of app ${row.app_id} is stored in state "${row.state}" resuming at "${row.resume_phase ?? "nothing"}", which Nova does not know, so the cutover cannot tell whether it was published. Look at the row before running the cutover again.`,
		);
	return {
		state: state.data,
		resumePhase: resumePhase === null ? null : resumePhase.data,
	};
}

/**
 * Every deployment of the given apps holding an `app` mapping no later
 * publish left behind: the published ones (section 8.1) with their
 * baselines and overrides, and the live ones (those CommCare HQ has not
 * reported gone).
 */
export async function readAppDeployments(
	tx: Transaction<AppDatabase>,
	appIds: readonly string[],
): Promise<Map<string, AppDeployments>> {
	const byApp = new Map<
		string,
		{ published: PublishedDeployment[]; live: LiveDeployment[] }
	>();
	if (appIds.length === 0) return byApp;
	const rows = await sql<DeploymentRow>`
		SELECT deployment.id::text AS id, deployment.app_id, deployment.server,
			deployment.domain, deployment.state, deployment.resume_phase,
			mapping.mapping_count, mapping.missing, mapping.pushed_revision,
			baseline.origin, baseline.source_gzip, baseline.source_digest,
			baseline.observed_at
		FROM app_deployments AS deployment
		CROSS JOIN LATERAL (
			SELECT count(*)::text AS mapping_count,
				bool_or(resource.remote_missing_at IS NOT NULL) AS missing,
				max(resource.pushed_revision)::text AS pushed_revision
			FROM app_deployment_resources AS resource
			WHERE resource.deployment_id = deployment.id
				AND resource.kind = 'app'
				AND resource.superseded_at IS NULL
		) AS mapping
		LEFT JOIN app_deployment_baselines AS baseline
			ON baseline.deployment_id = deployment.id
		WHERE deployment.app_id = ANY(${[...appIds]}::text[])
			AND mapping.mapping_count <> '0'
	`.execute(tx);
	const overrides = await readOverrides(
		tx,
		rows.rows.map((row) => row.id),
	);
	for (const row of rows.rows) {
		if (row.mapping_count !== "1")
			throw new Error(
				`Deployment ${row.id} of app ${row.app_id} holds ${row.mapping_count} live app mappings, where Nova keeps one, so the cutover cannot tell which app CommCare HQ holds. Look at its app_deployment_resources rows before running the cutover again.`,
			);
		if (!isDeploymentServer(row.server))
			throw new Error(
				`Deployment ${row.id} of app ${row.app_id} names CommCare server "${row.server}", which Nova does not know. Look at the row before running the cutover again.`,
			);
		const entry = byApp.get(row.app_id) ?? { published: [], live: [] };
		const target = {
			deploymentId: row.id,
			server: row.server,
			domain: row.domain,
		};
		if (!row.missing) entry.live.push(target);
		if (deploymentDisplaysAsReached(progressOf(row), "uploaded")) {
			entry.published.push({
				...target,
				baseline: readBaseline(
					// `observed_at` is NOT NULL wherever a baseline row exists.
					row.origin === null
						? null
						: {
								origin: row.origin,
								source_gzip: row.source_gzip,
								source_digest: row.source_digest,
								observed_at: row.observed_at as Date,
							},
				),
				overrides: overrides.get(row.id) ?? [],
				pushedRevision:
					row.pushed_revision === null
						? null
						: safePersistedSequence(
								row.pushed_revision,
								`the pushed revision of deployment ${row.id}`,
							),
			});
		}
		byApp.set(row.app_id, entry);
	}
	for (const entry of byApp.values()) {
		entry.published.sort((a, b) => compareText(a.deploymentId, b.deploymentId));
		entry.live.sort((a, b) => compareText(a.deploymentId, b.deploymentId));
	}
	return byApp;
}

/** Each deployment's identity overrides, by deployment id, in the order
 *  `lib/deployment/store.ts` reads them. */
async function readOverrides(
	tx: Transaction<AppDatabase>,
	deploymentIds: readonly string[],
): Promise<Map<string, PublishedDeployment["overrides"]>> {
	const byDeployment = new Map<
		string,
		PublishedDeployment["overrides"][number][]
	>();
	if (deploymentIds.length === 0) return byDeployment;
	const rows = await sql<{
		deployment_id: string;
		entity_kind: string;
		nova_entity_uuid: string;
		unique_id: string | null;
		xmlns: string | null;
	}>`
		SELECT deployment_id::text AS deployment_id, entity_kind,
			nova_entity_uuid::text AS nova_entity_uuid, unique_id, xmlns
		FROM app_deployment_identities
		WHERE deployment_id = ANY(${[...deploymentIds]}::uuid[])
	`.execute(tx);
	const sorted = [...rows.rows].sort(
		(a, b) =>
			compareText(a.deployment_id, b.deployment_id) ||
			compareText(a.entity_kind, b.entity_kind) ||
			compareText(a.nova_entity_uuid, b.nova_entity_uuid),
	);
	for (const row of sorted) {
		if (row.entity_kind !== "module" && row.entity_kind !== "form")
			throw new Error(
				`Deployment ${row.deployment_id} records an id for a "${row.entity_kind}", which Nova does not know. Look at its app_deployment_identities rows before running the cutover again.`,
			);
		const list = byDeployment.get(row.deployment_id) ?? [];
		list.push({
			entityKind: row.entity_kind,
			novaEntityUuid: row.nova_entity_uuid,
			uniqueId: row.unique_id,
			xmlns: row.xmlns,
		});
		byDeployment.set(row.deployment_id, list);
	}
	return byDeployment;
}

// ─── Projects, schemas and private work ───────────────────────────────────

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
	 * what its targets reference, read by id as export readiness reads it.
	 * An id another Project holds stays out, so it reads as not found. */
	const assets = await tx
		.selectFrom("media_assets")
		.selectAll()
		.where("project_id", "=", projectId)
		.execute();
	const records = [
		...[...assets]
			.sort((a, b) => compareText(a.id, b.id))
			.map(mediaAssetRecordFromRow),
		...builtinAssetRows(ALL_ICON_SLUGS),
	];
	return {
		projectId,
		lookupContext: { kind: "available", ...snapshot },
		mediaRecords: new Map(records.map((record) => [record.id, record])),
	};
}

/** Each app's active `case_type_schemas` rows, each schema as canonical
 *  text, by case type. */
async function readStoredSchemas(
	tx: Transaction<AppDatabase>,
	appIds: readonly string[],
): Promise<Map<string, Map<string, string>>> {
	const byApp = new Map<string, Map<string, string>>();
	if (appIds.length === 0) return byApp;
	const rows = await sql<{
		app_id: string;
		case_type: string;
		schema: unknown;
	}>`
		SELECT app_id, case_type, schema
		FROM case_type_schemas
		WHERE is_active AND app_id = ANY(${[...appIds]}::text[])
	`.execute(tx);
	const sorted = [...rows.rows].sort(
		(a, b) =>
			compareText(a.app_id, b.app_id) || compareText(a.case_type, b.case_type),
	);
	for (const row of sorted) {
		const types = byApp.get(row.app_id) ?? new Map<string, string>();
		types.set(row.case_type, canonicalJsonText(row.schema));
		byApp.set(row.app_id, types);
	}
	return byApp;
}

/** The open private work and the `mutation` events, read on the caller's
 *  transaction: the census the report prints and the writer's
 *  `private-work` step ends. */
export async function readPrivateWorkCensus(
	tx: Transaction<AppDatabase>,
): Promise<PrivateWorkCensus> {
	const counts = await sql<{
		workspaces: string;
		change_sets: string;
		candidates: string;
		mutation_events: string;
	}>`
		SELECT
			(SELECT count(*) FROM authoring_workspaces WHERE status = 'open')::text AS workspaces,
			(SELECT count(*) FROM design_change_sets WHERE status = 'open')::text AS change_sets,
			(SELECT count(*) FROM authoring_sessions WHERE active_candidate_id IS NOT NULL)::text AS candidates,
			(SELECT count(*) FROM events WHERE kind = 'mutation')::text AS mutation_events
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
	`.execute(tx);
	const apps = await sql<{ app_id: string }>`
		SELECT app_id FROM authoring_workspaces
			WHERE status = 'open' AND app_id IS NOT NULL
		UNION
		SELECT app_id FROM design_change_sets
			WHERE status = 'open' AND app_id IS NOT NULL
		UNION
		SELECT app_id FROM authoring_sessions
			WHERE active_candidate_id IS NOT NULL AND app_id IS NOT NULL
	`.execute(tx);
	const row = counts.rows[0];
	return {
		openWorkspaces: Number(row?.workspaces ?? "0"),
		openChangeSets: Number(row?.change_sets ?? "0"),
		activeCandidates: Number(row?.candidates ?? "0"),
		endingSessions: sessions.rows
			.map((session) => session.id)
			.sort(compareText),
		mutationEvents: Number(row?.mutation_events ?? "0"),
		apps: apps.rows.map((entry) => entry.app_id).sort(compareText),
	};
}

// ─── The fleet ────────────────────────────────────────────────────────────

/**
 * Read everything the plan decides from, on the caller's transaction.
 * `appId` limits the planned apps to one (`--app`); the fleet's counts and
 * its sequence digest still cover every app.
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
	const roots = await readRoots(tx, options.appId);
	const appIds = roots.map((root) => root.id);
	const entityRows = await readEntityRows(tx, appIds);
	const deployments = await readAppDeployments(tx, appIds);
	const schemas = await readStoredSchemas(tx, appIds);
	const privateWork = await readPrivateWorkCensus(tx);
	const projects = new Map<string, SourceProject>();
	for (const projectId of [
		...new Set(roots.map((root) => root.project_id)),
	].sort(compareText)) {
		projects.set(projectId, await readProject(tx, projectId));
	}
	const withWork = new Set(privateWork.apps);
	const apps = roots.map((root): SourceApp => {
		const project = projects.get(root.project_id);
		if (project === undefined)
			throw new Error(
				`App ${root.id}'s Project ${root.project_id} was not read, so the cutover cannot plan it. This is a defect of the cutover's fleet read.`,
			);
		const carriers = carriersOf(root, entityRows);
		const raw = readRawDocument(root.id, carriers);
		const appDeployments = deployments.get(root.id);
		return {
			appId: root.id,
			projectId: root.project_id,
			deleted: root.deleted_at !== null,
			baseSeq: sequenceOf(root),
			carriers,
			raw,
			baseDigest: rawDocumentDigest(raw),
			context: {
				appId: root.id,
				projectId: root.project_id,
				lookupContext: project.lookupContext,
				mediaRecords: project.mediaRecords,
				deployments: appDeployments?.published ?? [],
				storedSchemas: schemas.get(root.id) ?? new Map(),
				liveDeployments: appDeployments?.live ?? [],
				mutationSeq: sequenceOf(root),
				discardsPrivateWork: withWork.has(root.id),
			},
		};
	});
	const size = await sql<{ bytes: string }>`
		SELECT pg_database_size(current_database())::text AS bytes
	`.execute(tx);
	return {
		apps,
		projects,
		privateWork,
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

/** `readFleetSource` in one `REPEATABLE READ, READ ONLY` transaction of its
 *  own: the scan's and every plan-building mode's read before any lock. */
export async function readFleetSourceSnapshot(
	db: Kysely<AppDatabase>,
	options: { readonly appId?: string } = {},
): Promise<FleetSource> {
	return db
		.transaction()
		.setIsolationLevel("repeatable read")
		.setAccessMode("read only")
		.execute((tx) => readFleetSource(tx, options));
}
