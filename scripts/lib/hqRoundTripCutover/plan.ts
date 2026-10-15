/**
 * The fleet's cutover plan: what the cutover will write, decided from the
 * database (and, from the pull request that adds the reads, from HQ), and the
 * digest that is the frozen proof of it.
 *
 * `readFleetSource` reads every app (deleted ones included) with its raw
 * carriers, its active case schemas, its open private work and the
 * deployments that hold a live `app` mapping, and every Project's lookup
 * definitions and members, all on the caller's one transaction.
 * `buildCutoverPlan` then, per Project: builds the lookup context the writer
 * will have made, runs each app's ordered transform, parses and gates the
 * target against that context and the Project's media manifest, compares the
 * target's derived case schemas with the active stored rows, classes each
 * deployment and collects the notice lines.
 *
 * The digest covers every app's base and transform result, every
 * deployment's class and identity rows, the lookup tag renames and every
 * blocker, and no content HQ holds (part 10 of step 2's plan, "The plan and
 * its digest").
 */

import { type Kysely, sql, type Transaction } from "kysely";
import { buildCaseTypeMap } from "@/lib/case-store/store";
import type { PersistedEntityRowText } from "@/lib/db/persistedJson";
import { parsePersistedJsonText } from "@/lib/db/persistedJson";
import type { AppDatabase } from "@/lib/db/pg";
import { deploymentDisplaysAsReached } from "@/lib/deployment/stateMachine";
import {
	deploymentPhaseSchema,
	deploymentStateSchema,
} from "@/lib/deployment/types";
import {
	exportReadinessFindings,
	mutationCommitVerdict,
} from "@/lib/doc/commitVerdicts";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import type { LookupValidationContext } from "@/lib/doc/lookupReferences";
import {
	type BlueprintDoc,
	blueprintDocSchema,
	type CaseType,
	USERCASE_CASE_TYPE,
} from "@/lib/domain";
import { lookupTableIdSchema } from "@/lib/domain/lookupIds";
import { caseTypeToJsonSchema } from "@/lib/domain/predicate/jsonSchema";
import { readLookupDefinitionsInTransaction } from "@/lib/lookup/definitionSnapshot";
import type { LookupDataType } from "@/lib/lookup/types";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { safePersistedSequence } from "@/lib/utils/persistedSequence";
import { behaviorChanges } from "./behavior";
import { credentialOrder, type MemberCredential } from "./credentials";
import { type HolderCensus, readHolderCensus } from "./holders";
import {
	classifyDeployment,
	type DeploymentClass,
	type DeploymentReads,
	type KeyUse,
	type PublishedMenus,
	unreadDeploymentClass,
} from "./hqRead";
import type { IdentityRow, MatchResult, UnpairedEntity } from "./matching";
import { readProjectMediaManifest } from "./mediaManifest";
import {
	cczNeedsProjectSpace,
	type DeploymentNotice,
	deploymentNotices,
} from "./notice";
import {
	type RawCarriers,
	type RawDocument,
	rawDocumentAssembly,
	rawDocumentDigest,
	readRawDocument,
} from "./oldShape";
import {
	type PublishedDocumentGap,
	readPublishedDocument,
} from "./publishedDocument";
import { questionPaths } from "./questionPaths";
import {
	type DeploymentOutcome,
	type DocumentChange,
	type StepDeployment,
	transformDocument,
} from "./transform";

export const CUTOVER = "hq-round-trip-emission";
export const MARKER_BATCH_ID = "fold-baseline:hq-round-trip-emission";
export const MARKER_ACTOR_ID = "system:hq-round-trip-emission";
export const PLAN_FORMAT = "hq-round-trip-emission-1";

/** Every app-level blocker code, each added by the pull request that checks it. */
export const CUTOVER_BLOCKER_CODES = [
	"target-parse",
	"target-gate",
	"target-export-readiness",
	"case-schema-change",
	"unresolved-relative-path",
	"link-identifier-reserved",
	"hidden-menu-is-a-destination",
	"reserved-property-write",
	"form-root-read",
	"app-mapping-without-pushed-revision",
] as const;
export type CutoverBlockerCode = (typeof CUTOVER_BLOCKER_CODES)[number];

/** The Project-level blocker codes. */
export const PROJECT_BLOCKER_CODES = [
	"lookup-tag-unparsable",
	"lookup-tag-rename-collision",
] as const;

/** Content-free: no name, path, expression or tag. */
export interface CutoverBlocker {
	readonly code: CutoverBlockerCode;
	/** The places in this app that meet it. */
	readonly count: number;
	/** For `target-gate` and `target-export-readiness`, the validator codes met, distinct and sorted. */
	readonly findingCodes: readonly string[];
}

export interface ProjectBlocker {
	readonly projectId: string;
	readonly tableId: string;
	readonly code: (typeof PROJECT_BLOCKER_CODES)[number];
	readonly referencingAppIds: readonly string[];
}

export interface TagRename {
	readonly projectId: string;
	readonly tableId: string;
	readonly fromTag: string;
	readonly toTag: string;
}

/** One `app_deployment_identities` row the matcher produced. */
export type DeploymentIdentityRow = IdentityRow;

export type DeploymentPairing =
	| {
			readonly path: "published-document";
			readonly source: "stored" | "folded";
	  }
	| {
			readonly path: "evidence";
			readonly reason: PublishedDocumentGap | "hq-differs";
	  }
	| null;

export type { KeyUse };

export interface DeploymentPlan {
	readonly deploymentId: string;
	readonly server: string;
	readonly domain: string;
	/** The live `app` mapping's `remote_id`: the HQ app every read names. */
	readonly remoteAppId: string;
	readonly outcome: DeploymentOutcome;
	/** HQ's `build_spec.version` from the source read; null where none was read. */
	readonly buildSpecVersion: string | null;
	/** Which path paired it; null where no source was read. */
	readonly pairing: DeploymentPairing;
	readonly identities: readonly DeploymentIdentityRow[];
	/** Entities of today's document whose ids change once there, by uuid. */
	readonly unpaired: readonly UnpairedEntity[];
	/** Paired forms whose stored form id no read gave, by uuid. */
	readonly formIdsUnknown: readonly string[];
	readonly keyUses: readonly KeyUse[];
	readonly notices: readonly DeploymentNotice[];
}

export interface AppPlan {
	readonly appId: string;
	readonly projectId: string;
	readonly baseSeq: number;
	/** Of the raw carriers as read. */
	readonly baseDigest: string;
	readonly targetDigest: string;
	readonly blockers: readonly CutoverBlocker[];
	readonly changes: readonly DocumentChange[];
	/** An open workspace or change set of this app is abandoned. */
	readonly discardsPrivateWork: boolean;
	/** Ordered by deployment id; only deployments with a live app mapping. */
	readonly deployments: readonly DeploymentPlan[];
}

export interface CutoverPlan {
	readonly format: typeof PLAN_FORMAT;
	/** Ordered by app id. */
	readonly apps: readonly AppPlan[];
	/** Ordered by Project id, then table uuid. */
	readonly lookupTagRenames: readonly TagRename[];
	readonly projectBlockers: readonly ProjectBlocker[];
	readonly digest: string;
}

/**
 * The digest of what the cutover decides, and of no content HQ holds: every
 * app's base and transform result, every deployment's class and identity
 * rows, the tag renames and every blocker.
 */
export function cutoverPlanDigest(plan: Omit<CutoverPlan, "digest">): string {
	return canonicalJsonDigest({
		format: plan.format,
		apps: plan.apps.map((app) => ({
			appId: app.appId,
			projectId: app.projectId,
			baseSeq: app.baseSeq,
			baseDigest: app.baseDigest,
			targetDigest: app.targetDigest,
			changes: app.changes,
			discardsPrivateWork: app.discardsPrivateWork,
			blockers: app.blockers,
			deployments: app.deployments.map((deployment) => ({
				deploymentId: deployment.deploymentId,
				outcome: deployment.outcome,
				identities: deployment.identities,
			})),
		})),
		lookupTagRenames: plan.lookupTagRenames,
		projectBlockers: plan.projectBlockers,
	});
}

// ── The fleet source ────────────────────────────────────────────────

/** One deployment that holds a live `app` mapping. */
export interface SourceDeployment {
	readonly deploymentId: string;
	readonly server: string;
	readonly domain: string;
	readonly createdBy: string;
	readonly remoteAppId: string;
	/** The live mapping's `pushed_revision`; null where a publish wrote none. */
	readonly pushedRevision: number | null;
	/** The HQ table ids of the deployment's live `lookup-table` mappings. */
	readonly mappedTableIds: readonly string[];
	/** The app's content is on the project space: the deployment displays as uploaded. */
	readonly reached: boolean;
}

export interface SourceApp {
	readonly appId: string;
	readonly projectId: string;
	readonly baseSeq: number;
	readonly deleted: boolean;
	readonly raw: RawDocument;
	readonly discardsPrivateWork: boolean;
	/** Each active `case_type_schemas` row, its schema as stored text. */
	readonly activeSchemas: ReadonlyMap<string, string>;
	/** Ordered by deployment id. */
	readonly deployments: readonly SourceDeployment[];
	/** Deployments with no live `app` mapping, which the plan does not hold. */
	readonly deploymentsWithoutMapping: number;
}

export interface SourceProject {
	readonly projectId: string;
	/** The Project's lookup definitions, every table of it. */
	readonly lookupContext: LookupValidationContext;
	readonly members: readonly MemberCredential[];
}

/** The open private work the cutover abandons. */
export interface PrivateWorkCensus {
	readonly openWorkspaces: number;
	readonly openChangeSets: number;
	readonly activeCandidates: number;
	/** Active pre-app build sessions that hold open work, which the cutover ends. */
	readonly endingSessions: readonly string[];
}

export interface FleetSource {
	/** Ordered by app id. */
	readonly apps: readonly SourceApp[];
	readonly projects: ReadonlyMap<string, SourceProject>;
	readonly privateWork: PrivateWorkCensus;
}

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

/**
 * Read the root carriers of every app, deleted ones included. No
 * `app_settings` is read: the plan runs only over a fleet the already-applied
 * check found wholly pre-step, where the column is NULL or, before the
 * ledgered DDL, absent.
 */
async function readRootCarriers(tx: Transaction<AppDatabase>) {
	return sql<{
		id: string;
		project_id: string;
		mutation_seq: string;
		deleted_at: Date | null;
		app_name: string;
		connect_type: string | null;
		case_types_text: string | null;
		localization_text: string | null;
		logo: string | null;
	}>`
		SELECT id, project_id, mutation_seq::text AS mutation_seq, deleted_at,
			app_name, connect_type, case_types::text AS case_types_text,
			localization::text AS localization_text, logo
		FROM apps
		ORDER BY id
	`.execute(tx);
}

/**
 * The raw carriers of one app as the writer reads them inside the fleet
 * transaction, after the ledgered DDL: before its writes, where
 * `app_settings` is NULL, and after them, for the postcondition, where step
 * `app-settings` has filled it.
 */
export async function readAppCarriers(
	tx: Transaction<AppDatabase>,
	appId: string,
): Promise<{ carriers: RawCarriers; baseSeq: number } | null> {
	const root = await sql<{
		mutation_seq: string;
		app_name: string;
		connect_type: string | null;
		case_types_text: string | null;
		localization_text: string | null;
		app_settings_text: string | null;
		logo: string | null;
	}>`
		SELECT mutation_seq::text AS mutation_seq, app_name, connect_type,
			case_types::text AS case_types_text,
			localization::text AS localization_text,
			app_settings::text AS app_settings_text, logo
		FROM apps WHERE id = ${appId}
	`.execute(tx);
	const row = root.rows[0];
	if (row === undefined) return null;
	const rows = await readEntityRows(tx, [appId]);
	return {
		baseSeq: safePersistedSequence(
			row.mutation_seq,
			`apps.mutation_seq for app ${appId}`,
		),
		carriers: {
			root: {
				app_name: row.app_name,
				connect_type: row.connect_type as RawCarriers["root"]["connect_type"],
				case_types_text: row.case_types_text,
				localization_text: row.localization_text,
				app_settings_text: row.app_settings_text,
				logo: row.logo as RawCarriers["root"]["logo"],
			},
			rows: rows.get(appId) ?? [],
		},
	};
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
		ORDER BY app_id, uuid
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
	return byApp;
}

/** Every Project's members with what their stored settings hold. */
async function readMembers(
	tx: Transaction<AppDatabase>,
): Promise<Map<string, MemberCredential[]>> {
	const rows = await sql<{
		project_id: string;
		user_id: string;
		joined_at: Date;
		has_stored_key: boolean;
		server: string | null;
		approved_domains: unknown;
	}>`
		SELECT member."organizationId" AS project_id, member."userId" AS user_id,
			member."createdAt" AS joined_at,
			(settings.commcare_username IS NOT NULL AND settings.commcare_username <> ''
				AND settings.commcare_api_key IS NOT NULL AND settings.commcare_api_key <> '')
				AS has_stored_key,
			settings.commcare_server AS server,
			settings.approved_domains AS approved_domains
		FROM auth_member AS member
		LEFT JOIN user_settings AS settings ON settings.user_id = member."userId"
		ORDER BY member."organizationId", member."userId"
	`.execute(tx);
	const byProject = new Map<string, MemberCredential[]>();
	for (const row of rows.rows) {
		const domains = Array.isArray(row.approved_domains)
			? row.approved_domains.flatMap((domain) =>
					domain !== null &&
					typeof domain === "object" &&
					typeof (domain as { name?: unknown }).name === "string"
						? [(domain as { name: string }).name]
						: [],
				)
			: [];
		const list = byProject.get(row.project_id) ?? [];
		list.push({
			userId: row.user_id,
			joinedAt: new Date(row.joined_at),
			hasStoredKey: row.has_stored_key === true,
			server: row.server,
			approvedDomains: domains,
		});
		byProject.set(row.project_id, list);
	}
	return byProject;
}

async function readProjectLookupContext(
	tx: Transaction<AppDatabase>,
	projectId: string,
): Promise<LookupValidationContext> {
	const tables = await tx
		.selectFrom("lookup_tables")
		.select("id")
		.where("project_id", "=", projectId)
		.execute();
	const snapshot = await readLookupDefinitionsInTransaction(
		tx,
		projectId,
		tables.map((table) => lookupTableIdSchema.parse(table.id)),
	);
	return { kind: "available", ...snapshot };
}

/**
 * Read everything the plan decides from, on one transaction. The scan runs
 * it inside one `REPEATABLE READ, READ ONLY` transaction and takes no lock;
 * the writer reads again under its own locks.
 */
export async function readFleetSource(
	tx: Transaction<AppDatabase>,
): Promise<FleetSource> {
	const roots = (await readRootCarriers(tx)).rows;
	const appIds = roots.map((root) => root.id);
	const entityRows = await readEntityRows(tx, appIds);

	const privateWork = await sql<{ app_id: string }>`
		SELECT app_id FROM authoring_workspaces
			WHERE status = 'open' AND app_id IS NOT NULL
		UNION
		SELECT app_id FROM design_change_sets
			WHERE status = 'open' AND app_id IS NOT NULL
	`.execute(tx);
	const appsWithPrivateWork = new Set(
		privateWork.rows.map((row) => row.app_id),
	);

	const schemas = await sql<{
		app_id: string;
		case_type: string;
		schema_text: string;
	}>`
		SELECT app_id, case_type, schema::text AS schema_text
		FROM case_type_schemas
		WHERE is_active
		ORDER BY app_id, case_type
	`.execute(tx);
	const schemasByApp = new Map<string, Map<string, string>>();
	for (const row of schemas.rows) {
		const map = schemasByApp.get(row.app_id) ?? new Map<string, string>();
		map.set(row.case_type, row.schema_text);
		schemasByApp.set(row.app_id, map);
	}

	const deployments = await sql<{
		id: string;
		app_id: string;
		server: string;
		domain: string;
		created_by: string;
		state: string;
		resume_phase: string | null;
		remote_id: string | null;
		pushed_revision: string | null;
		mapped_table_ids: string[];
	}>`
		SELECT deployment.id::text AS id, deployment.app_id, deployment.server,
			deployment.domain, deployment.created_by,
			deployment.state, deployment.resume_phase,
			mapping.remote_id, mapping.pushed_revision::text AS pushed_revision,
			ARRAY(SELECT table_mapping.remote_id FROM app_deployment_resources AS table_mapping
				WHERE table_mapping.deployment_id = deployment.id
					AND table_mapping.kind = 'lookup-table'
					AND table_mapping.superseded_at IS NULL
				ORDER BY table_mapping.remote_id) AS mapped_table_ids
		FROM app_deployments AS deployment
		LEFT JOIN app_deployment_resources AS mapping
			ON mapping.deployment_id = deployment.id
			AND mapping.kind = 'app'
			AND mapping.superseded_at IS NULL
		ORDER BY deployment.app_id, deployment.id
	`.execute(tx);
	const deploymentsByApp = new Map<string, SourceDeployment[]>();
	const unmappedByApp = new Map<string, number>();
	for (const row of deployments.rows) {
		if (row.remote_id === null) {
			unmappedByApp.set(row.app_id, (unmappedByApp.get(row.app_id) ?? 0) + 1);
			continue;
		}
		const list = deploymentsByApp.get(row.app_id) ?? [];
		list.push({
			deploymentId: row.id,
			server: row.server,
			domain: row.domain,
			createdBy: row.created_by,
			remoteAppId: row.remote_id,
			pushedRevision:
				row.pushed_revision === null
					? null
					: safePersistedSequence(
							row.pushed_revision,
							`app_deployment_resources.pushed_revision for deployment ${row.id}`,
						),
			mappedTableIds: row.mapped_table_ids,
			// The scan and the dry run read a database the ledger's DDL has not
			// reached, so no `remote_missing_at` is read: before step 2 a live
			// mapping beside a failed upload is the only "gone" there is, and
			// such a deployment never displays as uploaded.
			reached: deploymentDisplaysAsReached(
				{
					state: deploymentStateSchema.parse(row.state),
					resumePhase:
						row.resume_phase === null
							? null
							: deploymentPhaseSchema.parse(row.resume_phase),
				},
				"uploaded",
			),
		});
		deploymentsByApp.set(row.app_id, list);
	}

	const members = await readMembers(tx);
	const projects = new Map<string, SourceProject>();
	for (const projectId of [
		...new Set(roots.map((root) => root.project_id)),
	].sort()) {
		projects.set(projectId, {
			projectId,
			lookupContext: await readProjectLookupContext(tx, projectId),
			members: members.get(projectId) ?? [],
		});
	}

	const apps = roots.map((root): SourceApp => {
		const carriers: RawCarriers = {
			root: {
				app_name: root.app_name,
				connect_type: root.connect_type as RawCarriers["root"]["connect_type"],
				case_types_text: root.case_types_text,
				localization_text: root.localization_text,
				app_settings_text: null,
				logo: root.logo as RawCarriers["root"]["logo"],
			},
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
			raw: readRawDocument(root.id, carriers),
			discardsPrivateWork: appsWithPrivateWork.has(root.id),
			activeSchemas: schemasByApp.get(root.id) ?? new Map(),
			deployments: deploymentsByApp.get(root.id) ?? [],
			deploymentsWithoutMapping: unmappedByApp.get(root.id) ?? 0,
		};
	});
	return { apps, projects, privateWork: await readPrivateWorkCensus(tx) };
}

// ── Deployment classes ──────────────────────────────────────────────

/** The published document's menus, as the matcher reads them. */
function publishedMenus(
	published: Awaited<ReturnType<typeof readPublishedDocument>>,
): PublishedMenus {
	return published.kind === "document"
		? {
				kind: "document",
				source: published.source,
				menus: questionPaths(published.document),
			}
		: published;
}

// ── Building the plan ───────────────────────────────────────────────

/** Per-app facts the report prints and the digest does not cover. */
export interface AppPlanDetail {
	readonly appId: string;
	readonly deleted: boolean;
	/** Each registered step's count of changes for this app, in step order. */
	readonly stepChanges: readonly { stepId: string; changes: number }[];
	/** Each no-write reason's count of entries for this app. */
	readonly behaviorEntries: Readonly<Record<string, number>>;
	readonly deploymentsWithoutMapping: number;
}

/** Per-deployment facts the report prints and the digest does not cover. */
export interface DeploymentPlanDetail {
	readonly deploymentId: string;
	readonly appId: string;
	readonly projectId: string;
	readonly server: string;
	readonly domain: string;
	/** No current member's stored key qualifies, so no read can be sent. */
	readonly noCredential: boolean;
	/** Null where the live mapping holds no `pushed_revision`. */
	readonly publishedDocument:
		| { readonly kind: "stored" | "folded" }
		| { readonly kind: "none"; readonly reason: PublishedDocumentGap }
		| null;
	/** The HQ table ids of the deployment's live `lookup-table` mappings. */
	readonly mappedTableIds: readonly string[];
	/** The pairs and their counts; null where no source was read. */
	readonly match: MatchResult | null;
}

/** What the writer needs beside the plan: each app's target, kept in memory only. */
export interface PlannedTarget {
	readonly raw: RawDocument;
	/** The parsed and hydrated target; absent where it does not parse. */
	readonly doc: BlueprintDoc | undefined;
}

export interface CutoverPlanBuild {
	readonly plan: CutoverPlan;
	readonly targets: ReadonlyMap<string, PlannedTarget>;
	readonly apps: readonly AppPlanDetail[];
	readonly deployments: readonly DeploymentPlanDetail[];
	/** The lookup context each Project's targets were judged against. */
	readonly lookupContexts: ReadonlyMap<string, LookupValidationContext>;
}

export interface BuildPlanOptions {
	/**
	 * Reads one deployment's HQ copy with the members' keys, in the order
	 * given. Absent in the scan and under `--without-hq`, where every
	 * deployment is `unreadable` with no request.
	 */
	readonly readDeployment?: (
		deployment: SourceDeployment,
		credentials: readonly string[],
	) => Promise<DeploymentReads>;
	/** A read still transient classes its deployment `unreadable` or `no-form-ids`. */
	readonly transientAsUnreadable?: boolean;
}

function lookupColumnTypesOf(
	context: LookupValidationContext,
): ReadonlyMap<string, ReadonlyMap<string, LookupDataType>> {
	if (context.kind !== "available") return new Map();
	return new Map(
		context.definitions.map((definition) => [
			definition.id as string,
			new Map(
				definition.columns.map((column) => [
					column.id as string,
					column.dataType,
				]),
			),
		]),
	);
}

function distinctSorted(values: Iterable<string>): string[] {
	return [...new Set(values)].sort();
}

/**
 * The case schemas the cutover compares: the target's derived types and the
 * app's active stored rows, both without the worker's own case. That case
 * derives only from the worker properties, which no cutover step touches, so
 * the transform cannot change it; and an app that predates it holds no row
 * for it, the lazily materialized state `materializeCaseStoreSchemas` heals
 * on first use (`lib/db/materializeCaseStoreSchemas.ts`).
 */
function comparedCaseSchemas(
	target: BlueprintDoc,
	activeSchemas: ReadonlyMap<string, string>,
): {
	derived: ReadonlyMap<string, CaseType>;
	stored: ReadonlyMap<string, string>;
} {
	const derived = new Map(buildCaseTypeMap(target));
	derived.delete(USERCASE_CASE_TYPE);
	const stored = new Map(activeSchemas);
	stored.delete(USERCASE_CASE_TYPE);
	return { derived, stored };
}

/**
 * The derived case schemas of the target against the app's active stored
 * rows: the count of case types that differ, a derived type with no active
 * row and an active row with no derived type included.
 */
export function caseSchemaDifferences(
	target: BlueprintDoc,
	activeSchemas: ReadonlyMap<string, string>,
): number {
	const { derived, stored: storedSchemas } = comparedCaseSchemas(
		target,
		activeSchemas,
	);
	let differences = 0;
	for (const [name, caseType] of derived) {
		const stored = storedSchemas.get(name);
		if (
			stored === undefined ||
			canonicalJsonDigest(
				parsePersistedJsonText(stored, `case_type_schemas.schema for ${name}`),
			) !== canonicalJsonDigest(caseTypeToJsonSchema(caseType))
		) {
			differences += 1;
		}
	}
	for (const name of storedSchemas.keys()) {
		if (!derived.has(name)) differences += 1;
	}
	return differences;
}

/** The parse, gate, export-readiness and case-schema blockers of one target. */
function judgeTarget(
	app: SourceApp,
	target: RawDocument,
	lookupContext: LookupValidationContext,
	media: Awaited<ReturnType<typeof readProjectMediaManifest>> | null,
): { blockers: CutoverBlocker[]; doc: BlueprintDoc | undefined } {
	const parsed = blueprintDocSchema.safeParse(
		rawDocumentAssembly(app.appId, target),
	);
	if (!parsed.success) {
		return {
			blockers: [
				{
					code: "target-parse",
					count: parsed.error.issues.length,
					findingCodes: [],
				},
			],
			doc: undefined,
		};
	}
	const doc = hydratePersistedBlueprint(parsed.data);
	const blockers: CutoverBlocker[] = [];
	const verdict = mutationCommitVerdict(doc, [], lookupContext);
	if (!verdict.ok) {
		blockers.push({
			code: "target-gate",
			count: verdict.findings.length,
			findingCodes: distinctSorted(
				verdict.findings.map((finding) => finding.code),
			),
		});
	}
	const notExportable = exportReadinessFindings(
		doc,
		lookupContext,
		media ?? new Map(),
	);
	if (notExportable.length > 0) {
		blockers.push({
			code: "target-export-readiness",
			count: notExportable.length,
			findingCodes: distinctSorted(
				notExportable.map((finding) => finding.code),
			),
		});
	}
	const schemaDifferences = caseSchemaDifferences(doc, app.activeSchemas);
	if (schemaDifferences > 0) {
		blockers.push({
			code: "case-schema-change",
			count: schemaDifferences,
			findingCodes: [],
		});
	}
	return { blockers, doc };
}

/**
 * Build the fleet's plan from its source, on the transaction the source was
 * read on (the published documents and the media manifests read it too).
 */
export async function buildCutoverPlan(
	tx: Transaction<AppDatabase>,
	source: FleetSource,
	options: BuildPlanOptions = {},
): Promise<CutoverPlanBuild> {
	const targets = new Map<string, PlannedTarget>();
	const appDetails: AppPlanDetail[] = [];
	const deploymentDetails: DeploymentPlanDetail[] = [];
	const lookupContexts = new Map<string, LookupValidationContext>();
	const appPlans = new Map<string, AppPlan>();

	// The published documents are read on the plan's transaction, one after
	// another; the HQ reads then run together, paced per project space, and
	// hold no lock.
	const pending: {
		app: SourceApp;
		deployment: SourceDeployment;
		credentials: readonly string[];
		published: PublishedMenus | null;
	}[] = [];
	for (const app of source.apps) {
		const members = source.projects.get(app.projectId)?.members ?? [];
		for (const deployment of app.deployments) {
			const credentials = credentialOrder(deployment, members);
			const published =
				deployment.pushedRevision === null
					? null
					: await readPublishedDocument(tx, {
							appId: app.appId,
							pushedRevision: deployment.pushedRevision,
							baseSeq: app.baseSeq,
							stored: app.raw,
						});
			pending.push({
				app,
				deployment,
				credentials,
				published: published === null ? null : publishedMenus(published),
			});
			deploymentDetails.push({
				deploymentId: deployment.deploymentId,
				appId: app.appId,
				projectId: app.projectId,
				server: deployment.server,
				domain: deployment.domain,
				noCredential: credentials.length === 0,
				publishedDocument:
					published === null
						? null
						: published.kind === "document"
							? { kind: published.source }
							: { kind: "none", reason: published.reason },
				mappedTableIds: deployment.mappedTableIds,
				match: null,
			});
		}
	}
	const { readDeployment } = options;
	const classes = await Promise.all(
		pending.map(async ({ app, deployment, credentials, published }) => {
			// A mapping with no pushed revision is the blocker
			// `app-mapping-without-pushed-revision`, and a deployment no key
			// qualifies for is `no-credential`: neither sends a request.
			if (
				readDeployment === undefined ||
				published === null ||
				credentials.length === 0
			) {
				return unreadDeploymentClass();
			}
			return classifyDeployment({
				reads: await readDeployment(deployment, credentials),
				today: questionPaths(app.raw),
				published,
				transientAsUnreadable: options.transientAsUnreadable === true,
			});
		}),
	);
	const classOf = new Map<string, DeploymentClass>();
	pending.forEach((entry, index) => {
		const classification = classes[index] as DeploymentClass;
		classOf.set(entry.deployment.deploymentId, classification);
		const detail = deploymentDetails[index];
		if (detail !== undefined) {
			deploymentDetails[index] = { ...detail, match: classification.match };
		}
	});

	for (const project of source.projects.values()) {
		const projectApps = source.apps.filter(
			(app) => app.projectId === project.projectId,
		);
		// No tag rename is planned yet, so the context the gate judges against
		// is the Project's definitions as they stand.
		const lookupContext = project.lookupContext;
		lookupContexts.set(project.projectId, lookupContext);
		const lookupColumnTypes = lookupColumnTypesOf(lookupContext);

		const transformed = [];
		for (const app of projectApps) {
			const stepDeployments: StepDeployment[] = app.deployments.map(
				(deployment) => {
					const classification = classOf.get(
						deployment.deploymentId,
					) as DeploymentClass;
					return {
						deploymentId: deployment.deploymentId,
						outcome: classification.outcome,
						profileProperties: classification.profileProperties,
					};
				},
			);
			const result = transformDocument(app.raw, {
				appId: app.appId,
				projectId: app.projectId,
				lookupColumnTypes,
				deployments: stepDeployments,
			});
			transformed.push({ app, result });
		}

		// One manifest per Project, over the union of every target's references.
		const parsedTargets = transformed.flatMap(({ app, result }) => {
			const parsed = blueprintDocSchema.safeParse(
				rawDocumentAssembly(app.appId, result.target),
			);
			return parsed.success ? [hydratePersistedBlueprint(parsed.data)] : [];
		});
		const media = await readProjectMediaManifest(
			tx,
			project.projectId,
			parsedTargets,
		);

		for (const { app, result } of transformed) {
			const judged = judgeTarget(app, result.target, lookupContext, media);
			const withoutPushedRevision = app.deployments.filter(
				(deployment) => deployment.pushedRevision === null,
			).length;
			const blockers: CutoverBlocker[] =
				withoutPushedRevision === 0
					? judged.blockers
					: [
							...judged.blockers,
							{
								code: "app-mapping-without-pushed-revision",
								count: withoutPushedRevision,
								findingCodes: [],
							},
						];
			const classified = new Map(
				app.deployments.map((deployment) => [
					deployment.deploymentId,
					classOf.get(deployment.deploymentId) as DeploymentClass,
				]),
			);
			targets.set(app.appId, { raw: result.target, doc: judged.doc });
			const behavior =
				judged.doc === undefined ? [] : behaviorChanges(judged.doc);
			const behaviorEntries: Record<string, number> = {};
			for (const change of behavior) {
				behaviorEntries[change.reason] =
					(behaviorEntries[change.reason] ?? 0) + 1;
			}
			appDetails.push({
				appId: app.appId,
				deleted: app.deleted,
				stepChanges: result.steps.map((step) => ({
					stepId: step.stepId,
					changes: step.changes.length,
				})),
				behaviorEntries,
				deploymentsWithoutMapping: app.deploymentsWithoutMapping,
			});
			appPlans.set(app.appId, {
				appId: app.appId,
				projectId: app.projectId,
				baseSeq: app.baseSeq,
				baseDigest: rawDocumentDigest(app.raw),
				targetDigest: rawDocumentDigest(result.target),
				blockers,
				changes: [
					...result.changes,
					...behavior,
					...cczNeedsProjectSpace({
						appName: result.target.appName,
						deleted: app.deleted,
						reachedAfterCutover: app.deployments.some(
							(deployment) =>
								deployment.reached &&
								classified.get(deployment.deploymentId)?.outcome !== "deleted",
						),
					}),
				],
				discardsPrivateWork: app.discardsPrivateWork,
				deployments: app.deployments.map((deployment) => {
					const classification = classified.get(
						deployment.deploymentId,
					) as DeploymentClass;
					return {
						deploymentId: deployment.deploymentId,
						server: deployment.server,
						domain: deployment.domain,
						remoteAppId: deployment.remoteAppId,
						outcome: classification.outcome,
						buildSpecVersion: classification.buildSpecVersion,
						pairing: classification.pairing,
						identities: classification.identities,
						unpaired: classification.unpaired,
						formIdsUnknown: classification.formIdsUnknown,
						keyUses: classification.keyUses,
						notices:
							judged.doc === undefined
								? []
								: deploymentNotices(classification, judged.doc),
					};
				}),
			});
		}
	}

	const apps = source.apps.map((app) => appPlans.get(app.appId) as AppPlan);
	const unsigned = {
		format: PLAN_FORMAT,
		apps,
		lookupTagRenames: [],
		projectBlockers: [],
	} satisfies Omit<CutoverPlan, "digest">;
	return {
		plan: { ...unsigned, digest: cutoverPlanDigest(unsigned) },
		targets,
		apps: appDetails,
		deployments: deploymentDetails,
		lookupContexts,
	};
}

/** Whether the plan holds a blocker anywhere. */
export function planHasBlockers(plan: CutoverPlan): boolean {
	return (
		plan.projectBlockers.length > 0 ||
		plan.apps.some((app) => app.blockers.length > 0)
	);
}

/** Whether any deployment's reads ended transient. */
export function planHasTransientDeployments(plan: CutoverPlan): boolean {
	return plan.apps.some((app) =>
		app.deployments.some((deployment) => deployment.outcome === "transient"),
	);
}

/** One validator finding with the entities its location names. */
function findingDetail(finding: {
	readonly code: string;
	readonly message: string;
	readonly location: object;
}): { code: string; where: string; message: string } {
	const where = Object.entries(finding.location as Record<string, unknown>)
		.filter(([, value]) => value !== undefined)
		.map(([key, value]) => `${key}=${String(value)}`)
		.join(" ");
	return {
		code: finding.code,
		where: where || "app",
		message: finding.message,
	};
}

/**
 * Every place each blocker met in one app, for `--debug-details`: the parse
 * issues by path, each validator finding with its location, and each case
 * type whose derived schema differs from its active stored row.
 */
export async function blockerDetails(
	tx: Transaction<AppDatabase>,
	source: FleetSource,
	build: CutoverPlanBuild,
	appId: string,
): Promise<{
	parse: { path: string; message: string }[];
	gate: { code: string; where: string; message: string }[];
	exportReadiness: { code: string; where: string; message: string }[];
	caseSchemas: string[];
}> {
	const app = source.apps.find((candidate) => candidate.appId === appId);
	const target = build.targets.get(appId);
	if (app === undefined || target === undefined) {
		throw new Error(`App ${appId} is not in the plan, so it has no details.`);
	}
	const parsed = blueprintDocSchema.safeParse(
		rawDocumentAssembly(appId, target.raw),
	);
	if (!parsed.success) {
		return {
			parse: parsed.error.issues.map((issue) => ({
				path: issue.path.map(String).join("."),
				message: issue.message,
			})),
			gate: [],
			exportReadiness: [],
			caseSchemas: [],
		};
	}
	const doc = hydratePersistedBlueprint(parsed.data);
	const lookupContext = build.lookupContexts.get(app.projectId) ?? {
		kind: "unavailable" as const,
	};
	const verdict = mutationCommitVerdict(doc, [], lookupContext);
	const media = await readProjectMediaManifest(tx, app.projectId, [doc]);
	const { derived, stored: storedSchemas } = comparedCaseSchemas(
		doc,
		app.activeSchemas,
	);
	return {
		parse: [],
		gate: verdict.ok ? [] : verdict.findings.map(findingDetail),
		exportReadiness: exportReadinessFindings(doc, lookupContext, media).map(
			findingDetail,
		),
		caseSchemas: [...new Set([...derived.keys(), ...storedSchemas.keys()])]
			.filter((name) => {
				const caseType = derived.get(name);
				const stored = storedSchemas.get(name);
				return (
					caseType === undefined ||
					stored === undefined ||
					canonicalJsonDigest(
						parsePersistedJsonText(
							stored,
							`case_type_schemas.schema for ${name}`,
						),
					) !== canonicalJsonDigest(caseTypeToJsonSchema(caseType))
				);
			})
			.sort(),
	};
}

/** Everything one run reads before it decides, from one snapshot. */
export interface PlannedFleet {
	readonly source: FleetSource;
	readonly build: CutoverPlanBuild;
	readonly holders: HolderCensus;
	readonly databaseBytes: number;
}

/**
 * Read the fleet and build its plan inside one `REPEATABLE READ, READ ONLY`
 * transaction, which takes no row lock, so the scan's read-only identity runs
 * it too. With `appId`, the source holds that one app.
 */
export async function readPlannedFleet(
	db: Kysely<AppDatabase>,
	options: BuildPlanOptions & { readonly appId?: string } = {},
): Promise<PlannedFleet> {
	return db
		.transaction()
		.setIsolationLevel("repeatable read")
		.setAccessMode("read only")
		.execute(async (tx) => {
			const fleet = await readFleetSource(tx);
			const source =
				options.appId === undefined ? fleet : onlyApp(fleet, options.appId);
			const build = await buildCutoverPlan(tx, source, options);
			const size = await sql<{ size: string }>`
				SELECT pg_database_size(current_database())::text AS size
			`.execute(tx);
			return {
				source,
				build,
				holders: await readHolderCensus(tx),
				databaseBytes: Number(size.rows[0]?.size ?? "0"),
			};
		});
}

function onlyApp(source: FleetSource, appId: string): FleetSource {
	const app = source.apps.find((candidate) => candidate.appId === appId);
	if (app === undefined) {
		throw new Error(`App ${appId} was not found, so there is nothing to scan.`);
	}
	const project = source.projects.get(app.projectId);
	return {
		apps: [app],
		projects: new Map(project === undefined ? [] : [[app.projectId, project]]),
		privateWork: source.privateWork,
	};
}
