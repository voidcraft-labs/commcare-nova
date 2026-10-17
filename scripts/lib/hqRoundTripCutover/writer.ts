/**
 * The cutover's one fleet transaction (part 10 of step 2's plan, "The fleet
 * transaction, step by step").
 *
 * One transaction for the whole fleet: the event, stream and workspace
 * statements are fleet-wide anyway, and any failure rolls everything back,
 * so a failure before the commit leaves the database as it was. Every write
 * is a raw statement as the migration role or a production writer the commit
 * kernel itself uses, never `lib/deployment/store.ts`: every store writer
 * re-proves an acting member, and the cutover has none.
 *
 * Under `--rehearse` the transaction runs whole and ends in a sentinel
 * rollback, as the runtime database probe does, so beyond the ledgered DDL a
 * rehearsal leaves nothing.
 *
 * The baseline step is here too: `readCutoverBaselines` reads CommCare HQ
 * before the transaction opens, and step 9 writes what it read.
 */

import { gzipSync } from "node:zlib";
import { type Kysely, sql, type Transaction } from "kysely";
import { loadCanonicalBlueprintAtSequence } from "@/lib/agent/change-set/baseLoader";
import type { HqAppSource } from "@/lib/commcare/hq/appSource";
import type { CommCareApiError } from "@/lib/commcare/hq/http";
import { type HqLocation, listHqLocations } from "@/lib/commcare/hq/locations";
import {
	type HqFixtureRow,
	type HqLookupTable,
	listHqLookupTables,
	readHqLookupTableRows,
} from "@/lib/commcare/hq/lookupTables";
import { lookupWireNaming } from "@/lib/commcare/lookup/naming";
import {
	type AssetManifest,
	type ResolvedMediaAsset,
	wirePathFor,
} from "@/lib/commcare/multimedia/assetWirePath";
import { isCommCareServer } from "@/lib/commcare/servers";
import { targetWireIdentity } from "@/lib/commcare/wireIdentity";
import { decomposeBlueprint } from "@/lib/db/blueprintRows";
import {
	denormalize,
	loadAppInTransaction,
	lookupContextForAuthoritativeWrite,
	replaceExactMediaReferencesForApp,
} from "@/lib/db/canonicalCommitKernel";
import {
	abandonPreAppDesignSessionInTransaction,
	lockSessionRow,
} from "@/lib/db/designSessions";
import { replaceLookupReferenceEdges } from "@/lib/db/lookupReferenceEdges";
import { type AppDatabase, notifyAppStream } from "@/lib/db/pg";
import { attachmentUrlTarget } from "@/lib/deployment/attachmentTarget";
import {
	canonicalLookupTable,
	canonicalPlace,
} from "@/lib/deployment/hqResourceBaseline";
import { normalizeHqAppSource } from "@/lib/deployment/hqSourceBaseline";
import { hqImportApplication } from "@/lib/deployment/importApplication";
import { plannedPlacesFor } from "@/lib/deployment/locationResourcePlan";
import { applyObservation } from "@/lib/deployment/stateMachine";
import type { DeploymentTargetKey } from "@/lib/deployment/store";
import {
	type AppOwnership,
	type CanonicalLookupTable,
	type CanonicalPlace,
	type DeploymentRecord,
	deploymentPhaseOutcomesSchema,
	deploymentPhaseSchema,
	deploymentStateSchema,
	NO_DEPLOYMENT_PHASE_OUTCOMES,
} from "@/lib/deployment/types";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import {
	extractLookupReferenceTargets,
	type LookupValidationContext,
} from "@/lib/doc/lookupReferences";
import { asUuid, type BlueprintDoc } from "@/lib/domain";
import type { IconRef } from "@/lib/domain/builtinIcons";
import { collectAssetRefs } from "@/lib/domain/mediaRefs";
import { isMediaKind } from "@/lib/domain/multimedia";
import {
	partitionAssetRefs,
	resolveBuiltinManifestEntries,
} from "@/lib/media/builtinIconAssets";
import { applyOrganizationCommitIntegrity } from "@/lib/organization/commitIntegrity";
import type { StoredLocation } from "@/lib/organization/types";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { credentialOrder } from "./credentials";
import { holderCensusIsEmpty, readHolderCensus } from "./holders";
import {
	type CredentialSource,
	classifyHqFailure,
	type DeploymentReads,
	type HqReadOutcome,
	type HqReadPacer,
	type KeyUse,
	KeyUseRecorder,
	type ReadAnswer,
	type ReadContext,
	readAnsweredThroughCredentials,
} from "./hqRead";
import { type DecryptClock, realClock } from "./kmsDecrypt";
import type { IdentityRow } from "./matching";
import {
	type ProjectMediaManifest,
	readProjectMediaManifest,
} from "./mediaManifest";
import {
	appNoticeEntries,
	baselineNotices,
	type DeploymentNotice,
	type NoticeEntity,
	noticeEntityNames,
} from "./notice";
import { rawDocumentDigest, readRawDocument } from "./oldShape";
import {
	type AppPlan,
	type BuildPlanOptions,
	CUTOVER,
	type CutoverPlanBuild,
	caseSchemaDifferences,
	MARKER_ACTOR_ID,
	MARKER_BATCH_ID,
	type PlannedFleet,
	readAppCarriers,
	readPrivateWorkCensus,
} from "./plan";

/** The numbered steps of the fleet transaction, in order. */
export const WRITER_STEPS = [
	"lock",
	"blocking-scan",
	"already-applied",
	"archive-events",
	"clear-streams",
	"private-work",
	"apps",
	"ledger",
	"notices",
	"postconditions",
] as const;
export type WriterStep = (typeof WRITER_STEPS)[number];

/** Why the writer stopped before anything was written. */
export type WriterStopCode =
	| "app-changed"
	| "holder"
	| "already-applied"
	| "blocker"
	| "transient";

/** Postgres's SQLSTATE for a lock wait that reached `lock_timeout`. */
const LOCK_NOT_AVAILABLE = "55P03";

/** The writer refused to write: the database is as it was. */
export class CutoverStoppedError extends Error {
	readonly name = "CutoverStoppedError";

	constructor(
		readonly code: WriterStopCode,
		message: string,
	) {
		super(message);
	}
}

/** A postcondition failed inside the transaction, so the fleet rolled back. */
export class CutoverPostconditionError extends Error {
	readonly name = "CutoverPostconditionError";
}

export interface WriterReport {
	readonly mode: "rehearse" | "execute";
	/** Milliseconds each numbered step took. */
	readonly durations: Readonly<Record<WriterStep, number>>;
	/** `pg_database_size` read before the commit or the rollback. */
	readonly databaseBytes: number;
	/** WAL written from step 1 to step 11. */
	readonly walBytes: number;
	readonly appsWritten: number;
	readonly identitiesWritten: number;
	readonly deploymentsMarkedMissing: number;
	readonly appBaselinesWritten: number;
	readonly resourceBaselinesWritten: number;
	readonly noticesWritten: number;
	readonly keyReadersWritten: number;
	readonly eventsArchived: number;
	readonly sessionsEnded: number;
}

export interface WriterOptions {
	readonly mode: "rehearse" | "execute";
	readonly build: CutoverPlanBuild;
	/** What `readCutoverBaselines` read for this plan, before the transaction opened. */
	readonly baselines: CutoverBaselines;
	/**
	 * Throw right after the named step, so a test proves that a failure at any
	 * point leaves the database byte-identical.
	 */
	readonly failAfter?: WriterStep;
}

class RehearsalRollback extends Error {
	constructor(readonly report: WriterReport) {
		super("rehearsal rollback");
	}
}

class InjectedWriterFailure extends Error {
	readonly name = "InjectedWriterFailure";
}

function fail(message: string): never {
	throw new CutoverPostconditionError(
		`The cutover's postcondition failed, so nothing was written: ${message}`,
	);
}

interface BeforeImages {
	readonly cases: ReadonlyMap<string, { count: string; digest: string | null }>;
	readonly schemas: readonly string[];
	readonly mutationEvents: { count: string; bytes: string };
	/** Events already archived, by an earlier cutover, with their archived bytes. */
	readonly archivedEvents: { count: string; bytes: string };
}

async function captureBeforeImages(
	tx: Transaction<AppDatabase>,
): Promise<BeforeImages> {
	const cases = await sql<{
		app_id: string;
		count: string;
		digest: string | null;
	}>`
		SELECT app_id, count(*)::text AS count,
			encode(sha256(convert_to(string_agg(c::text, E'\n' ORDER BY c.case_id), 'UTF8')), 'hex') AS digest
		FROM cases AS c
		GROUP BY app_id
		ORDER BY app_id
	`.execute(tx);
	const schemas = await sql<{ row_text: string }>`
		SELECT s::text AS row_text FROM case_type_schemas AS s
		ORDER BY s.app_id, s.case_type
	`.execute(tx);
	const events = await sql<{ count: string; bytes: string }>`
		SELECT count(*)::text AS count,
			COALESCE(sum(octet_length(event::text)), 0)::text AS bytes
		FROM events WHERE kind = 'mutation'
	`.execute(tx);
	const archived = await archivedEventImage(tx);
	return {
		cases: new Map(
			cases.rows.map((row) => [
				row.app_id,
				{ count: row.count, digest: row.digest },
			]),
		),
		schemas: schemas.rows.map((row) => row.row_text),
		mutationEvents: events.rows[0] ?? { count: "0", bytes: "0" },
		archivedEvents: archived,
	};
}

async function archivedEventImage(
	tx: Transaction<AppDatabase>,
): Promise<{ count: string; bytes: string }> {
	const row = await sql<{ count: string; bytes: string }>`
		SELECT count(*)::text AS count,
			COALESCE(sum(octet_length((event -> 'archived')::text)), 0)::text AS bytes
		FROM events WHERE kind = 'archived-mutation'
	`.execute(tx);
	return row.rows[0] ?? { count: "0", bytes: "0" };
}

/** Step 2: lock the fleet and prove it is the fleet the plan was built from. */
async function blockingScan(
	tx: Transaction<AppDatabase>,
	build: CutoverPlanBuild,
): Promise<void> {
	const locked = await tx
		.selectFrom("apps")
		.select("id")
		.orderBy("id")
		.forUpdate()
		.execute();
	await tx
		.selectFrom("design_sessions")
		.select("id")
		.orderBy("id")
		.forUpdate()
		.execute();
	const planned = build.plan.apps.map((app) => app.appId);
	const present = locked.map((app) => app.id);
	if (
		planned.length !== present.length ||
		planned.some((appId, index) => present[index] !== appId)
	) {
		throw new CutoverStoppedError(
			"app-changed",
			"The set of apps changed after the plan was built, so the cutover stopped with nothing written. Build the plan again.",
		);
	}
	for (const app of build.plan.apps) {
		const current = await readAppCarriers(tx, app.appId);
		if (
			current === null ||
			current.baseSeq !== app.baseSeq ||
			rawDocumentDigest(readRawDocument(app.appId, current.carriers)) !==
				app.baseDigest
		) {
			throw new CutoverStoppedError(
				"app-changed",
				`App ${app.appId} changed after the plan was built, so the cutover stopped with nothing written. Build the plan again.`,
			);
		}
	}
	const census = await readHolderCensus(tx);
	if (!holderCensusIsEmpty(census)) {
		throw new CutoverStoppedError(
			"holder",
			"A run still holds an app or a design session, or a hold is unsettled, so the cutover stopped with nothing written. Settle the holders and try again.",
		);
	}
}

async function markedAppCount(
	tx: Transaction<AppDatabase> | Kysely<AppDatabase>,
): Promise<number> {
	const row = await sql<{ marked: string }>`
		SELECT count(*)::text AS marked FROM apps AS app
		WHERE EXISTS (
			SELECT 1 FROM app_changes AS marker
			WHERE marker.app_id = app.id AND marker.batch_id = ${MARKER_BATCH_ID}
		)
	`.execute(tx);
	return Number(row.rows[0]?.marked ?? "0");
}

/** Step 6: abandon every open private workspace and change set. */
async function abandonPrivateWork(
	tx: Transaction<AppDatabase>,
): Promise<number> {
	const { endingSessions } = await readPrivateWorkCensus(tx);
	await tx
		.updateTable("authoring_sessions")
		.set({ active_candidate_id: null })
		.where("active_candidate_id", "is not", null)
		.execute();
	await tx
		.updateTable("authoring_workspaces")
		.set({ status: "abandoned", updated_at: new Date() })
		.where("status", "=", "open")
		.execute();
	await tx
		.updateTable("design_change_sets")
		.set({ status: "abandoned", updated_at: new Date() })
		.where("status", "=", "open")
		.execute();
	for (const id of endingSessions) {
		const row = await lockSessionRow(tx, id);
		if (row === undefined) continue;
		await abandonPreAppDesignSessionInTransaction(tx, row);
	}
	return endingSessions.length;
}

/** Step 8, for one app: write the target and establish its horizon. */
async function writeApp(
	tx: Transaction<AppDatabase>,
	app: AppPlan,
	doc: BlueprintDoc,
): Promise<void> {
	const seq = app.baseSeq + 1;
	const persistable = toPersistableDoc(doc);
	const lookupTargets = extractLookupReferenceTargets(doc);
	await lookupContextForAuthoritativeWrite(tx, app.projectId, lookupTargets);
	await tx
		.updateTable("apps")
		.set({ ...denormalize(persistable), mutation_seq: seq })
		.where("id", "=", app.appId)
		.execute();
	await tx
		.deleteFrom("blueprint_entities")
		.where("app_id", "=", app.appId)
		.execute();
	const rows = decomposeBlueprint(persistable);
	if (rows.length > 0) {
		await tx
			.insertInto("blueprint_entities")
			.values(
				rows.map((row) => ({
					app_id: app.appId,
					uuid: row.uuid,
					kind: row.kind,
					parent_uuid: row.parent_uuid,
					ordinal: row.ordinal,
					data: JSON.stringify(row.data),
				})),
			)
			.execute();
	}
	await replaceExactMediaReferencesForApp(tx, {
		appId: app.appId,
		projectId: app.projectId,
		candidateDoc: doc,
	});
	await replaceLookupReferenceEdges(tx, {
		appId: app.appId,
		projectId: app.projectId,
		targets: lookupTargets,
	});
	// No step changes an organization level or a location property, so the
	// target is its own previous document: the integrity pass re-proves the
	// places it references and rewrites its location edges.
	await applyOrganizationCommitIntegrity(tx, {
		appId: app.appId,
		previousDoc: doc,
		candidateDoc: doc,
	});
	await tx
		.insertInto("app_changes")
		.values({
			app_id: app.appId,
			seq,
			batch_id: MARKER_BATCH_ID,
			run_id: null,
			actor_id: MARKER_ACTOR_ID,
			kind: "fold-baseline",
			mutations: "[]",
			from_project_id: null,
			to_project_id: null,
		})
		.execute();
	await sql`
		INSERT INTO app_change_fold_baselines
			(app_id, seq, project_id, snapshot, snapshot_digest)
		SELECT app.id, ${seq}, app.project_id, current.snapshot,
			nova_app_change_fold_snapshot_digest(current.snapshot)
		FROM apps AS app,
			LATERAL (
				SELECT nova_current_app_change_fold_snapshot(app.id) AS snapshot
			) AS current
		WHERE app.id = ${app.appId}
	`.execute(tx);
}

/**
 * Step 9: the ledger rows. Each deployment's identity rows; for a deployment
 * whose HQ app the reads found deleted, `remote_missing_at` on its live
 * `app` mapping with the `remote_app_missing` upload failure folded as an
 * observation folds it, so its next publish creates a new app there; then
 * the baselines.
 */
async function writeLedger(
	tx: Transaction<AppDatabase>,
	build: CutoverPlanBuild,
	baselines: CutoverBaselines,
): Promise<{
	identities: number;
	missing: number;
	appBaselines: number;
	resourceBaselines: number;
}> {
	const now = new Date();
	let identities = 0;
	let missing = 0;
	for (const app of build.plan.apps) {
		for (const deployment of app.deployments) {
			if (deployment.identities.length > 0) {
				await tx
					.insertInto("app_deployment_identities")
					.values(
						deployment.identities.map((row) => ({
							deployment_id: deployment.deploymentId,
							entity_kind: row.entityKind,
							nova_entity_uuid: row.novaEntityUuid,
							unique_id: row.remoteUniqueId,
							xmlns: row.remoteXmlns,
						})),
					)
					.execute();
				identities += deployment.identities.length;
			}
			if (deployment.outcome !== "deleted") continue;
			await tx
				.updateTable("app_deployment_resources")
				.set({
					remote_missing_at: sql<Date>`COALESCE(remote_missing_at, ${now})`,
				})
				.where("deployment_id", "=", deployment.deploymentId)
				.where("kind", "=", "app")
				.where("remote_id", "=", deployment.remoteAppId)
				.where("superseded_at", "is", null)
				.execute();
			const row = await tx
				.selectFrom("app_deployments")
				.select(["state", "resume_phase", "phases"])
				.where("id", "=", deployment.deploymentId)
				.executeTakeFirstOrThrow();
			const record = {
				state: deploymentStateSchema.parse(row.state),
				resumePhase:
					row.resume_phase === null
						? null
						: deploymentPhaseSchema.parse(row.resume_phase),
				phases: deploymentPhaseOutcomesSchema.parse({
					...NO_DEPLOYMENT_PHASE_OUTCOMES,
					...row.phases,
				}),
			} as DeploymentRecord;
			const next = applyObservation(record, [
				[
					"upload",
					{
						status: "failed",
						at: now.toISOString(),
						failure: {
							code: "remote_app_missing",
							message: `The app Nova published to “${deployment.domain}” isn't there any more: CommCare HQ reported it deleted when Nova read it during an update. Publish again to create a new one.`,
							details: [],
						},
					},
				],
			]);
			await tx
				.updateTable("app_deployments")
				.set({
					state: next.state,
					resume_phase: next.resumePhase,
					phases: JSON.stringify(next.phases),
					updated_at: now,
				})
				.where("id", "=", deployment.deploymentId)
				.execute();
			missing += 1;
		}
	}
	const written = await writeBaselines(tx, baselines);
	return { identities, missing, ...written };
}

/**
 * The baseline rows, as raw statements under the `observed_at` rule the
 * store's writers use, so a read no newer than the stored one changes
 * nothing; app baselines in deployment order, then table and place
 * baselines in `(kind, remote_id)` order. They carry no discard: nobody
 * confirmed one.
 */
async function writeBaselines(
	tx: Transaction<AppDatabase>,
	baselines: CutoverBaselines,
): Promise<{ appBaselines: number; resourceBaselines: number }> {
	const apps = [...baselines.apps.values()].sort((a, b) =>
		compareText(a.deploymentId, b.deploymentId),
	);
	for (const baseline of apps) {
		const read = baseline.origin === "cutover" ? baseline : null;
		await sql`
			INSERT INTO app_deployment_baselines AS existing (
				deployment_id, remote_app_id, origin, source_gzip, source_bytes,
				source_digest, ownership, observed_at, observed_by
			) VALUES (
				${baseline.deploymentId}::uuid, ${baseline.remoteAppId}, ${baseline.origin},
				${read?.sourceGzip ?? null}, ${read?.sourceBytes ?? null},
				${read?.sourceDigest ?? null},
				${read === null ? null : JSON.stringify(read.ownership)}::jsonb,
				${baseline.observedAt}::timestamptz, ${baseline.observedBy}
			)
			ON CONFLICT (deployment_id) DO UPDATE SET
				remote_app_id = EXCLUDED.remote_app_id,
				origin = EXCLUDED.origin,
				source_gzip = EXCLUDED.source_gzip,
				source_bytes = EXCLUDED.source_bytes,
				source_digest = EXCLUDED.source_digest,
				ownership = EXCLUDED.ownership,
				observed_at = EXCLUDED.observed_at,
				observed_by = EXCLUDED.observed_by,
				discarded_digest = CASE WHEN EXCLUDED.remote_app_id = existing.remote_app_id
					THEN existing.discarded_digest END,
				discarded_by = CASE WHEN EXCLUDED.remote_app_id = existing.remote_app_id
					THEN existing.discarded_by END,
				discarded_at = CASE WHEN EXCLUDED.remote_app_id = existing.remote_app_id
					THEN existing.discarded_at END
			WHERE existing.remote_app_id <> EXCLUDED.remote_app_id
				OR existing.observed_at <= EXCLUDED.observed_at
		`.execute(tx);
	}
	const resources = [...baselines.resources].sort(
		(a, b) =>
			compareText(a.kind, b.kind) ||
			compareText(a.remoteId, b.remoteId) ||
			compareText(a.projectId, b.projectId) ||
			compareText(a.server, b.server) ||
			compareText(a.domain, b.domain) ||
			compareText(a.observedFromAppId, b.observedFromAppId),
	);
	for (const baseline of resources) {
		await sql`
			INSERT INTO project_space_resource_baselines AS existing (
				project_id, server, domain, kind, remote_id, origin, canonical,
				digest, observed_at, observed_by, observed_from_app_id
			) VALUES (
				${baseline.projectId}, ${baseline.server}, ${baseline.domain},
				${baseline.kind}, ${baseline.remoteId}, ${baseline.origin},
				${baseline.canonical === null ? null : JSON.stringify(baseline.canonical)}::jsonb,
				${baseline.digest}, ${baseline.observedAt}::timestamptz,
				${baseline.observedBy}, ${baseline.observedFromAppId}
			)
			ON CONFLICT (project_id, server, domain, kind, remote_id) DO UPDATE SET
				origin = EXCLUDED.origin,
				canonical = EXCLUDED.canonical,
				digest = EXCLUDED.digest,
				observed_at = EXCLUDED.observed_at,
				observed_by = EXCLUDED.observed_by,
				observed_from_app_id = EXCLUDED.observed_from_app_id
			WHERE existing.observed_at <= EXCLUDED.observed_at
		`.execute(tx);
	}
	return { appBaselines: apps.length, resourceBaselines: resources.length };
}

// ── The baselines (part 02 of step 2's plan, "The cutover's baselines") ──

/** `observed_by` of a baseline no member's key could read. */
export const UNREAD_OBSERVER = MARKER_ACTOR_ID;

/** One `app_deployment_baselines` row the fleet transaction writes. */
export type CutoverAppBaseline =
	| {
			readonly origin: "cutover";
			readonly deploymentId: string;
			readonly remoteAppId: string;
			readonly sourceGzip: Buffer;
			readonly sourceBytes: number;
			readonly sourceDigest: string;
			readonly ownership: AppOwnership;
			readonly observedAt: string;
			readonly observedBy: string;
	  }
	| {
			readonly origin: "unread";
			readonly deploymentId: string;
			readonly remoteAppId: string;
			readonly observedAt: string;
			readonly observedBy: string;
	  };

/** One `project_space_resource_baselines` row the fleet transaction writes. */
export interface CutoverResourceBaseline {
	readonly projectId: string;
	readonly server: string;
	readonly domain: string;
	readonly kind: "lookup-table" | "location";
	readonly remoteId: string;
	readonly origin: "cutover" | "unread";
	readonly canonical: CanonicalLookupTable | CanonicalPlace | null;
	readonly digest: string | null;
	readonly observedAt: string;
	readonly observedBy: string;
	readonly observedFromAppId: string;
}

/** A project space read still transient after its attempts, which stops the run. */
export interface TransientBaselineRead {
	readonly server: string;
	readonly domain: string;
	readonly read: "lookup-tables" | "lookup-table-rows" | "locations";
	/** The deployments whose live mappings name what the read was for. */
	readonly deploymentIds: readonly string[];
}

/** Everything the baseline step read, for the writer and the report. */
export interface CutoverBaselines {
	/** By deployment id; a deployment HQ reported deleted has none. */
	readonly apps: ReadonlyMap<string, CutoverAppBaseline>;
	/** In `(kind, remote_id)` order, the order the writer upserts them in. */
	readonly resources: readonly CutoverResourceBaseline[];
	/** Each deployment's drift lines, by deployment id. */
	readonly notices: ReadonlyMap<string, readonly DeploymentNotice[]>;
	/** Each member, server and domain whose key a table or place read sent. */
	readonly keyUses: readonly {
		readonly userId: string;
		readonly server: string;
		readonly domain: string;
		readonly firstUsedAt: string;
		readonly lastUsedAt: string;
	}[];
	/** Empty unless a read was still transient and the run is not told to treat it as unreadable. */
	readonly transient: readonly TransientBaselineRead[];
}

/** One read's outcome with whose key it came back to. */
export interface AnsweredRead<T> {
	/** Null where no member qualifies, so nothing was sent. */
	readonly outcome: HqReadOutcome<T> | null;
	readonly answer: ReadAnswer | null;
}

/** The rows of one lookup table as HQ served them. */
export interface HqLookupRows {
	readonly totalCount: number;
	readonly rows: readonly HqFixtureRow[];
}

/** What one project space's table and place reads asked for. */
export interface ProjectSpaceReadRequest {
	readonly server: string;
	readonly domain: string;
	readonly credentials: readonly string[];
	/** The HQ ids of the tables live mappings name; empty reads no table. */
	readonly tableIds: readonly string[];
	/** Whether any live mapping names a place, so the inventory is read. */
	readonly places: boolean;
}

/** What one project space's table and place reads answered. */
export interface ProjectSpaceReads {
	/** Null where no table was asked for. */
	readonly tables: AnsweredRead<readonly HqLookupTable[]> | null;
	/** Each asked-for table the list holds, by its HQ id. */
	readonly rows: ReadonlyMap<string, AnsweredRead<HqLookupRows>>;
	/** Null where no place was asked for. */
	readonly places: AnsweredRead<readonly HqLocation[]> | null;
	readonly keyUses: readonly KeyUse[];
}

export type ProjectSpaceReader = (
	request: ProjectSpaceReadRequest,
) => Promise<ProjectSpaceReads>;

/** A client's answer as a read outcome: its value, or its failure classed. */
function outcomeOf<T extends object>(
	result: T | CommCareApiError,
): HqReadOutcome<T> {
	return "success" in result
		? classifyHqFailure(result as CommCareApiError)
		: { kind: "ok", value: result as T };
}

/**
 * The table and place reads of one project space, through the credential
 * order and the run's pacer, as the source and form id reads are made: the
 * table list once, the rows of each mapped table the list holds, and the
 * place inventory once. All three are limited reads.
 */
export function hqProjectSpaceReader(options: {
	readonly credentialSource: CredentialSource;
	readonly pacer: HqReadPacer;
	readonly clock?: DecryptClock;
}): ProjectSpaceReader {
	return async (request) => {
		const keyUses = new KeyUseRecorder();
		const context: ReadContext = {
			server: request.server,
			domain: request.domain,
			pacer: options.pacer,
			clock: options.clock ?? realClock,
			credentials: request.credentials,
			credentialSource: options.credentialSource,
			keyUses,
		};
		const tables =
			request.tableIds.length === 0
				? null
				: await readAnsweredThroughCredentials(context, true, async (creds) =>
						outcomeOf(await listHqLookupTables(creds, request.domain)),
					);
		const rows = new Map<string, AnsweredRead<HqLookupRows>>();
		if (tables?.outcome?.kind === "ok") {
			const listed = new Set(tables.outcome.value.map((table) => table.id));
			for (const tableId of request.tableIds) {
				if (!listed.has(tableId)) continue;
				rows.set(
					tableId,
					await readAnsweredThroughCredentials(context, true, async (creds) =>
						outcomeOf(
							await readHqLookupTableRows(creds, request.domain, tableId),
						),
					),
				);
			}
		}
		const places = request.places
			? await readAnsweredThroughCredentials(context, true, async (creds) =>
					outcomeOf(await listHqLocations(creds, request.domain)),
				)
			: null;
		return { tables, rows, places, keyUses: keyUses.all() };
	};
}

/**
 * Keeps each deployment's two reads as the plan's reader returned them, so
 * the baseline step stores the source read the identity step already made
 * and sends no second one.
 */
export class DeploymentReadRecorder {
	private readonly reads = new Map<string, DeploymentReads>();

	wrap(
		read: NonNullable<BuildPlanOptions["readDeployment"]>,
	): NonNullable<BuildPlanOptions["readDeployment"]> {
		return async (deployment, credentials) => {
			const reads = await read(deployment, credentials);
			this.reads.set(deployment.deploymentId, reads);
			return reads;
		};
	}

	of(deploymentId: string): DeploymentReads | undefined {
		return this.reads.get(deploymentId);
	}
}

/** One live `lookup-table` or `location` mapping of a planned deployment. */
interface ResourceMapping {
	readonly deploymentId: string;
	readonly kind: "lookup-table" | "location";
	readonly novaResourceId: string;
	readonly remoteId: string;
	readonly pushedIdentity: string | null;
}

async function readResourceMappings(
	tx: Transaction<AppDatabase>,
	deploymentIds: readonly string[],
): Promise<ResourceMapping[]> {
	if (deploymentIds.length === 0) return [];
	const rows = await sql<{
		deployment_id: string;
		kind: "lookup-table" | "location";
		nova_resource_id: string;
		remote_id: string;
		pushed_identity: string | null;
	}>`
		SELECT deployment_id::text AS deployment_id, kind, nova_resource_id,
			remote_id, pushed_identity
		FROM app_deployment_resources
		WHERE deployment_id = ANY(${[...deploymentIds]}::uuid[])
			AND kind IN ('lookup-table', 'location')
			AND superseded_at IS NULL
		ORDER BY deployment_id, kind, remote_id
	`.execute(tx);
	return rows.rows.map((row) => ({
		deploymentId: row.deployment_id,
		kind: row.kind,
		novaResourceId: row.nova_resource_id,
		remoteId: row.remote_id,
		pushedIdentity: row.pushed_identity,
	}));
}

async function readAppPlaces(
	tx: Transaction<AppDatabase>,
	appIds: readonly string[],
): Promise<Map<string, StoredLocation[]>> {
	const byApp = new Map<string, StoredLocation[]>();
	if (appIds.length === 0) return byApp;
	const rows = await tx
		.selectFrom("app_locations")
		.selectAll()
		.where("app_id", "in", [...appIds])
		.orderBy("app_id")
		.orderBy("order_key")
		.orderBy("id")
		.execute();
	for (const row of rows) {
		const list = byApp.get(row.app_id) ?? [];
		list.push({
			id: asUuid(row.id),
			levelUuid: row.level_uuid,
			parentId: row.parent_id === null ? null : asUuid(row.parent_id),
			siteCode: row.site_code,
			name: row.name,
			externalId: row.external_id,
			latitude: row.latitude,
			longitude: row.longitude,
			values: row.values,
			archivedAt: row.archived_at,
			orderKey: row.order_key,
		});
		byApp.set(row.app_id, list);
	}
	return byApp;
}

/**
 * The media manifest the body's emission reads: each asset the target
 * references, as `resolveMediaManifest` resolves it with no bytes, from the
 * plan-time rows rather than a second read through the runtime pool.
 */
async function bodyAssetManifest(
	doc: BlueprintDoc,
	media: ProjectMediaManifest,
): Promise<AssetManifest> {
	const { realIds, builtinSlugs } = partitionAssetRefs([
		...collectAssetRefs(doc),
	]);
	const manifest = new Map<IconRef, ResolvedMediaAsset>();
	for (const id of realIds) {
		const record = media.get(id);
		if (
			record === undefined ||
			record.status !== "ready" ||
			!isMediaKind(record.kind)
		) {
			continue;
		}
		manifest.set(id, {
			assetId: id,
			wirePath: wirePathFor(record.contentHash, record.extension),
			kind: record.kind,
			mimeType: record.mimeType,
			contentHash: record.contentHash,
			extension: record.extension,
		});
	}
	for (const [id, asset] of await resolveBuiltinManifestEntries(
		builtinSlugs,
		false,
	)) {
		manifest.set(id, asset);
	}
	return manifest;
}

/**
 * The ownership of the body Nova would now send for the migrated document
 * over this source read: `hqImportApplication`'s own, so an HQ-side edit to
 * a key Nova stops writing in step 2 never stops a publish.
 */
async function cutoverOwnership(input: {
	readonly doc: BlueprintDoc;
	readonly target: DeploymentTargetKey;
	readonly remoteAppId: string;
	readonly source: HqAppSource;
	readonly identities: readonly IdentityRow[];
	readonly lookupContext: LookupValidationContext | undefined;
	readonly media: ProjectMediaManifest;
}): Promise<AppOwnership> {
	const lookupContext = input.lookupContext;
	return hqImportApplication({
		prepared: {
			doc: input.doc,
			assets: await bodyAssetManifest(input.doc, input.media),
			attachmentTarget: attachmentUrlTarget(input.target),
			...(lookupContext?.kind === "available" && {
				lookupNaming: lookupWireNaming(lookupContext.definitions),
			}),
		},
		target: input.target,
		/* No compatibility check runs at the cutover, so the derived Search
		 * key reads as unverified and the body keeps the read's profile. */
		compatibility: { advisories: [] },
		update: { appId: input.remoteAppId, source: input.source },
		identity: targetWireIdentity(
			input.identities.map((row) => ({
				entityKind: row.entityKind,
				novaEntityUuid: row.novaEntityUuid,
				uniqueId: row.remoteUniqueId,
				xmlns: row.remoteXmlns,
			})),
		),
	}).ownership;
}

/** What a read gave a resource: content, an `unread` baseline, or a stop. */
type ResourceRead<T> =
	| { readonly kind: "value"; readonly value: T; readonly answer: ReadAnswer }
	| { readonly kind: "unread" }
	| { readonly kind: "transient" };

function resourceRead<T>(
	read: AnsweredRead<T> | null | undefined,
	transientAsUnreadable: boolean,
): ResourceRead<T> {
	const outcome = read?.outcome;
	const answer = read?.answer ?? null;
	if (outcome?.kind === "ok" && answer !== null) {
		return { kind: "value", value: outcome.value, answer };
	}
	if (outcome?.kind === "transient" && !transientAsUnreadable) {
		return { kind: "transient" };
	}
	return { kind: "unread" };
}

/** The sorted place-information slugs a push of this place would model. */
function ownedPlaceKeys(
	doc: BlueprintDoc | undefined,
	places: readonly StoredLocation[],
	locationUuid: string,
): readonly string[] {
	if (doc === undefined) return [];
	const planned = plannedPlacesFor(doc, places).find(
		(place) => place.locationUuid === locationUuid,
	);
	return planned === undefined ? [] : Object.keys(planned.values).sort();
}

/**
 * The cutover's baseline step, outside the per-app transform (part 02 of
 * step 2's plan, "The cutover's baselines"; part 10, "Job steps outside the
 * per-app transform"). It runs after the plan is built and before the fleet
 * transaction opens, so no lock spans an HQ request, and ingress is closed,
 * so no publish lands between a read and its baseline.
 *
 * - **App.** A deployment classed `read-in-full` or `no-form-ids` stores the
 *   source read its identity step made, normalized, as a `cutover` baseline
 *   whose ownership is the body Nova would now send over it. One classed
 *   `unreadable` or `unsupported` stores `unread`, so every live app mapping
 *   has a baseline or `remote_missing_at`. One HQ reported deleted stores
 *   none.
 * - **Tables and places.** Each project space's table list, the rows of
 *   each mapped table it holds, and its place inventory are read once
 *   through the first of its deployments' credential orders. A table or
 *   place the read holds stores a `cutover` baseline; one the read could not
 *   give stores `unread`; one HQ no longer lists stores none, since the
 *   comparison names it whatever its baseline. A read still transient stops
 *   the run, or under `--transient-as-unreadable` stores `unread`.
 *
 * Without a project space reader (the scan's database, `--without-hq`)
 * every table and place stores `unread`, as an app no key read does.
 */
export async function readCutoverBaselines(
	db: Kysely<AppDatabase>,
	fleet: Pick<PlannedFleet, "source" | "build">,
	options: {
		readonly deploymentReads: DeploymentReadRecorder | null;
		readonly readProjectSpace: ProjectSpaceReader | null;
		readonly transientAsUnreadable: boolean;
		readonly clock?: DecryptClock;
	},
): Promise<CutoverBaselines> {
	const { source, build } = fleet;
	const clock = options.clock ?? realClock;
	const askedAt = () => new Date(clock.now()).toISOString();
	const planned = build.plan.apps.flatMap((app) =>
		app.deployments.map((deployment) => ({ app, deployment })),
	);
	const loaded = await db
		.transaction()
		.setIsolationLevel("repeatable read")
		.setAccessMode("read only")
		.execute(async (tx) => {
			const mappings = await readResourceMappings(
				tx,
				planned.map(({ deployment }) => deployment.deploymentId),
			);
			const appIds = [...new Set(planned.map(({ app }) => app.appId))].sort();
			const places = await readAppPlaces(tx, appIds);
			const media = new Map<string, ProjectMediaManifest>();
			for (const projectId of [
				...new Set(planned.map(({ app }) => app.projectId)),
			].sort()) {
				const docs = build.plan.apps.flatMap((app) => {
					const doc = build.targets.get(app.appId)?.doc;
					return app.projectId === projectId && doc !== undefined ? [doc] : [];
				});
				media.set(
					projectId,
					await readProjectMediaManifest(tx, projectId, docs),
				);
			}
			return { mappings, places, media };
		});

	// ── App baselines ──
	const apps = new Map<string, CutoverAppBaseline>();
	for (const { app, deployment } of planned) {
		if (deployment.outcome === "deleted" || deployment.outcome === "transient")
			continue;
		const unread: CutoverAppBaseline = {
			origin: "unread",
			deploymentId: deployment.deploymentId,
			remoteAppId: deployment.remoteAppId,
			observedAt: askedAt(),
			observedBy: UNREAD_OBSERVER,
		};
		const reads = options.deploymentReads?.of(deployment.deploymentId);
		const doc = build.targets.get(app.appId)?.doc;
		if (
			(deployment.outcome !== "read-in-full" &&
				deployment.outcome !== "no-form-ids") ||
			reads?.source?.kind !== "ok" ||
			reads.sourceAnswer === null ||
			doc === undefined ||
			!isCommCareServer(deployment.server)
		) {
			apps.set(deployment.deploymentId, unread);
			continue;
		}
		const normalized = normalizeHqAppSource(reads.source.value.raw);
		if ("malformed" in normalized) {
			apps.set(deployment.deploymentId, unread);
			continue;
		}
		apps.set(deployment.deploymentId, {
			origin: "cutover",
			deploymentId: deployment.deploymentId,
			remoteAppId: deployment.remoteAppId,
			sourceGzip: gzipSync(Buffer.from(normalized.text, "utf8")),
			sourceBytes: normalized.bytes,
			sourceDigest: normalized.digest,
			ownership: await cutoverOwnership({
				doc,
				target: { server: deployment.server, domain: deployment.domain },
				remoteAppId: deployment.remoteAppId,
				source: reads.source.value,
				identities: deployment.identities,
				lookupContext: build.lookupContexts.get(app.projectId),
				media: loaded.media.get(app.projectId) ?? new Map(),
			}),
			observedAt: reads.sourceAnswer.at,
			observedBy: reads.sourceAnswer.userId,
		});
	}

	// ── Table and place baselines, one project space at a time ──
	const plannedById = new Map(
		planned.map((entry) => [entry.deployment.deploymentId, entry]),
	);
	const sourceDeployments = new Map(
		source.apps.flatMap((app) =>
			app.deployments.map((deployment) => [
				deployment.deploymentId,
				deployment,
			]),
		),
	);
	const spaces = new Map<
		string,
		{
			projectId: string;
			server: string;
			domain: string;
			mappings: ResourceMapping[];
		}
	>();
	for (const mapping of loaded.mappings) {
		const entry = plannedById.get(mapping.deploymentId);
		if (entry === undefined) continue;
		const key = JSON.stringify([
			entry.app.projectId,
			entry.deployment.server,
			entry.deployment.domain,
		]);
		const space = spaces.get(key) ?? {
			projectId: entry.app.projectId,
			server: entry.deployment.server,
			domain: entry.deployment.domain,
			mappings: [],
		};
		space.mappings.push(mapping);
		spaces.set(key, space);
	}

	const resources: CutoverResourceBaseline[] = [];
	const unreadByDeployment = new Map<string, NoticeEntity[]>();
	const keyUses: CutoverBaselines["keyUses"][number][] = [];
	const transient: TransientBaselineRead[] = [];
	for (const key of [...spaces.keys()].sort()) {
		const space = spaces.get(key) as NonNullable<ReturnType<typeof spaces.get>>;
		const first = space.mappings
			.map((mapping) => sourceDeployments.get(mapping.deploymentId))
			.find((deployment) => deployment !== undefined);
		const members = source.projects.get(space.projectId)?.members ?? [];
		const credentials =
			first === undefined ? [] : credentialOrder(first, members);
		const tableIds = [
			...new Set(
				space.mappings
					.filter((mapping) => mapping.kind === "lookup-table")
					.map((mapping) => mapping.remoteId),
			),
		].sort();
		const anyPlace = space.mappings.some(
			(mapping) => mapping.kind === "location",
		);
		const reads =
			options.readProjectSpace === null || credentials.length === 0
				? null
				: await options.readProjectSpace({
						server: space.server,
						domain: space.domain,
						credentials,
						tableIds,
						places: anyPlace,
					});
		for (const use of reads?.keyUses ?? []) {
			keyUses.push({ ...use, server: space.server, domain: space.domain });
		}
		const tables = resourceRead(reads?.tables, options.transientAsUnreadable);
		const places = resourceRead(reads?.places, options.transientAsUnreadable);
		const stopped = (
			read: TransientBaselineRead["read"],
			kind: ResourceMapping["kind"],
			remoteId?: string,
		) =>
			transient.push({
				server: space.server,
				domain: space.domain,
				read,
				deploymentIds: [
					...new Set(
						space.mappings
							.filter(
								(mapping) =>
									mapping.kind === kind &&
									(remoteId === undefined || mapping.remoteId === remoteId),
							)
							.map((mapping) => mapping.deploymentId),
					),
				].sort(),
			});
		if (tables.kind === "transient") stopped("lookup-tables", "lookup-table");
		if (places.kind === "transient") stopped("locations", "location");
		const rowReads = new Map<string, ResourceRead<HqLookupRows>>();
		if (tables.kind === "value") {
			for (const tableId of tableIds) {
				if (!tables.value.some((table) => table.id === tableId)) continue;
				const rows = resourceRead(
					reads?.rows.get(tableId),
					options.transientAsUnreadable,
				);
				if (rows.kind === "transient") {
					stopped("lookup-table-rows", "lookup-table", tableId);
				}
				rowReads.set(tableId, rows);
			}
		}

		for (const mapping of space.mappings) {
			const entry = plannedById.get(mapping.deploymentId);
			if (entry === undefined) continue;
			const base = {
				projectId: space.projectId,
				server: space.server,
				domain: space.domain,
				kind: mapping.kind,
				remoteId: mapping.remoteId,
				observedFromAppId: entry.app.appId,
			};
			let baseline: CutoverResourceBaseline | null = null;
			if (mapping.kind === "lookup-table") {
				if (tables.kind === "value") {
					const table = tables.value.find(
						(candidate) => candidate.id === mapping.remoteId,
					);
					const rows = rowReads.get(mapping.remoteId);
					if (table === undefined || rows === undefined) baseline = null;
					else if (rows.kind === "value") {
						const canonical = canonicalLookupTable(table, rows.value.rows);
						baseline = {
							...base,
							origin: "cutover",
							canonical,
							digest: canonical.digest,
							observedAt: rows.answer.at,
							observedBy: rows.answer.userId,
						};
					} else if (rows.kind === "unread") {
						baseline = unreadResource(base, askedAt());
					}
				} else if (tables.kind === "unread") {
					baseline = unreadResource(base, askedAt());
				}
			} else if (places.kind === "value") {
				const place = places.value.find(
					(candidate) => candidate.locationId === mapping.remoteId,
				);
				if (place !== undefined) {
					const canonical = canonicalPlace(
						place,
						ownedPlaceKeys(
							build.targets.get(entry.app.appId)?.doc,
							loaded.places.get(entry.app.appId) ?? [],
							mapping.novaResourceId,
						),
					);
					baseline = {
						...base,
						origin: "cutover",
						canonical,
						digest: canonical.digest,
						observedAt: places.answer.at,
						observedBy: places.answer.userId,
					};
				}
			} else if (places.kind === "unread") {
				baseline = unreadResource(base, askedAt());
			}
			if (baseline === null) continue;
			resources.push(baseline);
			if (baseline.origin === "unread") {
				const list = unreadByDeployment.get(mapping.deploymentId) ?? [];
				list.push(
					resourceNoticeEntity(
						mapping,
						entry.app,
						build,
						loaded.places.get(entry.app.appId) ?? [],
					),
				);
				unreadByDeployment.set(mapping.deploymentId, list);
			}
		}
	}
	resources.sort(
		(a, b) =>
			compareText(a.projectId, b.projectId) ||
			compareText(a.server, b.server) ||
			compareText(a.domain, b.domain) ||
			compareText(a.kind, b.kind) ||
			compareText(a.remoteId, b.remoteId) ||
			compareText(a.observedFromAppId, b.observedFromAppId),
	);

	const notices = new Map<string, readonly DeploymentNotice[]>();
	for (const { deployment } of planned) {
		const lines = baselineNotices({
			outcome: deployment.outcome,
			app: apps.get(deployment.deploymentId)?.origin ?? null,
			unreadResources: unreadByDeployment.get(deployment.deploymentId) ?? [],
		});
		if (lines.length > 0) notices.set(deployment.deploymentId, lines);
	}
	return { apps, resources, notices, keyUses, transient };
}

function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function unreadResource(
	base: Omit<
		CutoverResourceBaseline,
		"origin" | "canonical" | "digest" | "observedAt" | "observedBy"
	>,
	observedAt: string,
): CutoverResourceBaseline {
	return {
		...base,
		origin: "unread",
		canonical: null,
		digest: null,
		observedAt,
		observedBy: UNREAD_OBSERVER,
	};
}

/** A table or place a drift line names: the author's name for it, else the name it was pushed under. */
function resourceNoticeEntity(
	mapping: ResourceMapping,
	app: AppPlan,
	build: CutoverPlanBuild,
	places: readonly StoredLocation[],
): NoticeEntity {
	if (mapping.kind === "lookup-table") {
		const context = build.lookupContexts.get(app.projectId);
		const definition =
			context?.kind === "available"
				? context.definitions.find(
						(candidate) => candidate.id === mapping.novaResourceId,
					)
				: undefined;
		return {
			kind: "lookupTable",
			uuid: mapping.novaResourceId,
			name: definition?.name ?? mapping.pushedIdentity ?? "",
		};
	}
	const place = places.find(
		(candidate) => candidate.id === mapping.novaResourceId,
	);
	return {
		kind: "location",
		uuid: mapping.novaResourceId,
		name: place?.name ?? mapping.pushedIdentity ?? "",
	};
}

/** Step 10: the notice rows and the key-readers record. */
async function writeNotices(
	tx: Transaction<AppDatabase>,
	build: CutoverPlanBuild,
	baselines: CutoverBaselines,
): Promise<{ notices: number; keyReaders: number }> {
	let notices = 0;
	for (const app of build.plan.apps) {
		const entries = noticeEntriesOf(build, app, baselines);
		if (entries.length === 0) continue;
		await sql`
			INSERT INTO app_migration_notices (app_id, cutover, entries)
			VALUES (${app.appId}, ${CUTOVER}, ${JSON.stringify(entries)}::jsonb)
		`.execute(tx);
		notices += 1;
	}
	const uses = keyReaderRows(build, baselines);
	for (const use of uses) {
		await sql`
			INSERT INTO app_migration_notice_key_readers
				(cutover, user_id, server, domain, first_used_at, last_used_at)
			VALUES (${CUTOVER}, ${use.userId}, ${use.server}, ${use.domain},
				${use.firstUsedAt}::timestamptz, ${use.lastUsedAt}::timestamptz)
			ON CONFLICT (cutover, user_id, server, domain) DO UPDATE
				SET first_used_at = LEAST(app_migration_notice_key_readers.first_used_at, EXCLUDED.first_used_at),
					last_used_at = GREATEST(app_migration_notice_key_readers.last_used_at, EXCLUDED.last_used_at)
		`.execute(tx);
	}
	return { notices, keyReaders: uses.length };
}

/** One app's notice entries, its entities named by its target, its baselines' lines merged in. */
export function noticeEntriesOf(
	build: CutoverPlanBuild,
	app: AppPlan,
	baselines: Pick<CutoverBaselines, "notices">,
) {
	const target = build.targets.get(app.appId);
	return appNoticeEntries(
		app,
		target?.raw.appName ?? "",
		target === undefined ? new Map() : noticeEntityNames(target.raw),
		baselines.notices,
	);
}

/**
 * Each member, server and domain whose key the run sent, with the span of
 * its uses: the deployments' reads and the table and place reads alike.
 */
export function keyReaderRows(
	build: CutoverPlanBuild,
	baselines: Pick<CutoverBaselines, "keyUses">,
): {
	userId: string;
	server: string;
	domain: string;
	firstUsedAt: string;
	lastUsedAt: string;
}[] {
	const rows = new Map<
		string,
		{
			userId: string;
			server: string;
			domain: string;
			firstUsedAt: string;
			lastUsedAt: string;
		}
	>();
	const uses = [
		...build.plan.apps.flatMap((app) =>
			app.deployments.flatMap((deployment) =>
				deployment.keyUses.map((use) => ({
					...use,
					server: deployment.server,
					domain: deployment.domain,
				})),
			),
		),
		...baselines.keyUses,
	];
	for (const use of uses) {
		const key = JSON.stringify([use.userId, use.server, use.domain]);
		const row = rows.get(key);
		if (row === undefined) {
			rows.set(key, {
				userId: use.userId,
				server: use.server,
				domain: use.domain,
				firstUsedAt: use.firstUsedAt,
				lastUsedAt: use.lastUsedAt,
			});
			continue;
		}
		if (Date.parse(use.firstUsedAt) < Date.parse(row.firstUsedAt))
			row.firstUsedAt = use.firstUsedAt;
		if (Date.parse(use.lastUsedAt) > Date.parse(row.lastUsedAt))
			row.lastUsedAt = use.lastUsedAt;
	}
	return [...rows.entries()]
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([, row]) => row);
}

/** Step 11: the postconditions, checked inside the transaction. */
async function checkPostconditions(
	tx: Transaction<AppDatabase>,
	build: CutoverPlanBuild,
	baselines: CutoverBaselines,
	before: BeforeImages,
): Promise<void> {
	for (const app of build.plan.apps) {
		const target = build.targets.get(app.appId);
		if (target?.doc === undefined) fail(`app ${app.appId} has no target`);
		const loaded = await loadAppInTransaction(tx, app.appId);
		if (loaded === null) fail(`app ${app.appId} no longer loads`);
		const stored = await readAppCarriers(tx, app.appId);
		if (
			stored === null ||
			stored.baseSeq !== app.baseSeq + 1 ||
			rawDocumentDigest(readRawDocument(app.appId, stored.carriers)) !==
				app.targetDigest
		) {
			fail(`app ${app.appId} does not hold its planned target`);
		}
		await loadCanonicalBlueprintAtSequence(tx, {
			appId: app.appId,
			seq: app.baseSeq + 1,
			expectedDigest: canonicalJsonDigest(toPersistableDoc(target.doc)),
		});
		const schemas = await sql<{ case_type: string; schema_text: string }>`
			SELECT case_type, schema::text AS schema_text FROM case_type_schemas
			WHERE app_id = ${app.appId} AND is_active
		`.execute(tx);
		if (
			caseSchemaDifferences(
				target.doc,
				new Map(schemas.rows.map((row) => [row.case_type, row.schema_text])),
			) > 0
		) {
			fail(`app ${app.appId}'s stored case schemas differ from its target's`);
		}
	}
	const after = await captureBeforeImages(tx);
	if (
		after.schemas.length !== before.schemas.length ||
		after.schemas.some((row, index) => row !== before.schemas[index])
	) {
		fail("a case_type_schemas row changed");
	}
	if (
		after.cases.size !== before.cases.size ||
		[...after.cases].some(([appId, image]) => {
			const prior = before.cases.get(appId);
			return prior?.count !== image.count || prior.digest !== image.digest;
		})
	) {
		fail("a case row changed");
	}
	const archived = await archivedEventImage(tx);
	const remaining = await sql<{ count: string }>`
		SELECT count(*)::text AS count FROM events WHERE kind = 'mutation'
	`.execute(tx);
	if (
		remaining.rows[0]?.count !== "0" ||
		BigInt(archived.count) !==
			BigInt(before.archivedEvents.count) +
				BigInt(before.mutationEvents.count) ||
		BigInt(archived.bytes) !==
			BigInt(before.archivedEvents.bytes) + BigInt(before.mutationEvents.bytes)
	) {
		fail(
			"the archived mutation events are not the events archived, byte for byte",
		);
	}
	const open = await sql<{
		workspaces: string;
		change_sets: string;
		candidates: string;
	}>`
		SELECT
			(SELECT count(*) FROM authoring_workspaces WHERE status = 'open')::text AS workspaces,
			(SELECT count(*) FROM design_change_sets WHERE status = 'open')::text AS change_sets,
			(SELECT count(*) FROM authoring_sessions WHERE active_candidate_id IS NOT NULL)::text AS candidates
	`.execute(tx);
	const work = open.rows[0];
	if (
		work === undefined ||
		work.workspaces !== "0" ||
		work.change_sets !== "0" ||
		work.candidates !== "0"
	) {
		fail("private work was left open");
	}
	for (const app of build.plan.apps) {
		const expected = noticeEntriesOf(build, app, baselines).length > 0 ? 1 : 0;
		const notices = await sql<{ count: string }>`
			SELECT count(*)::text AS count FROM app_migration_notices
			WHERE app_id = ${app.appId} AND cutover = ${CUTOVER}
		`.execute(tx);
		if (Number(notices.rows[0]?.count ?? "0") !== expected) {
			fail(`app ${app.appId} does not hold exactly its planned notice`);
		}
	}
	for (const app of build.plan.apps) {
		for (const deployment of app.deployments) {
			const recorded = await sql<{ count: string }>`
				SELECT count(*)::text AS count FROM app_deployment_identities
				WHERE deployment_id = ${deployment.deploymentId}
			`.execute(tx);
			if (
				Number(recorded.rows[0]?.count ?? "0") !== deployment.identities.length
			) {
				fail(
					`deployment ${deployment.deploymentId} does not hold its planned identity rows`,
				);
			}
			const held = await sql<{ held: boolean }>`
				SELECT EXISTS (
					SELECT 1 FROM app_deployment_baselines
					WHERE deployment_id = ${deployment.deploymentId}::uuid
				) OR EXISTS (
					SELECT 1 FROM app_deployment_resources
					WHERE deployment_id = ${deployment.deploymentId}::uuid AND kind = 'app'
						AND superseded_at IS NULL AND remote_missing_at IS NOT NULL
				) AS held
			`.execute(tx);
			if (held.rows[0]?.held !== true) {
				fail(
					`deployment ${deployment.deploymentId} holds a live app mapping with neither a baseline nor remote_missing_at`,
				);
			}
			if (deployment.outcome !== "deleted") continue;
			const gone = await sql<{ missing: boolean }>`
				SELECT EXISTS (
					SELECT 1 FROM app_deployment_resources
					WHERE deployment_id = ${deployment.deploymentId} AND kind = 'app'
						AND superseded_at IS NULL AND remote_missing_at IS NOT NULL
				) AS missing
			`.execute(tx);
			if (gone.rows[0]?.missing !== true) {
				fail(
					`deployment ${deployment.deploymentId} was found deleted and its mapping does not say so`,
				);
			}
		}
	}
	for (const use of keyReaderRows(build, baselines)) {
		const covered = await sql<{ covered: boolean }>`
			SELECT EXISTS (
				SELECT 1 FROM app_migration_notice_key_readers
				WHERE cutover = ${CUTOVER} AND user_id = ${use.userId}
					AND server = ${use.server} AND domain = ${use.domain}
					AND first_used_at <= ${use.firstUsedAt}::timestamptz
					AND last_used_at >= ${use.lastUsedAt}::timestamptz
			) AS covered
		`.execute(tx);
		if (covered.rows[0]?.covered !== true) {
			fail("a key use has no key-readers row covering it");
		}
	}
}

/**
 * Run the fleet transaction for a plan with no blocker. Returns the report
 * of a committed execute run or a rolled-back rehearsal; throws
 * `CutoverStoppedError` when a check refuses before any write, and any other
 * error after rolling the whole fleet back.
 */
export async function runFleetTransaction(
	db: Kysely<AppDatabase>,
	options: WriterOptions,
): Promise<WriterReport> {
	const { build, baselines } = options;
	if (
		build.plan.projectBlockers.length > 0 ||
		build.plan.apps.some((app) => app.blockers.length > 0)
	) {
		throw new CutoverStoppedError(
			"blocker",
			"The plan holds a blocker, so the cutover writes nothing. Resolve each by its remedy and build the plan again.",
		);
	}
	if (baselines.transient.length > 0) {
		throw new CutoverStoppedError(
			"transient",
			"A lookup table or place read of CommCare HQ was still failing after its attempts, so the cutover writes nothing. Run it again in a later window, or pass --transient-as-unreadable in a second one.",
		);
	}
	const durations = Object.fromEntries(
		WRITER_STEPS.map((step) => [step, 0]),
	) as Record<WriterStep, number>;
	const timed = async <T>(step: WriterStep, body: () => Promise<T>) => {
		const started = performance.now();
		const result = await body();
		durations[step] = Math.round(performance.now() - started);
		if (options.failAfter === step) {
			throw new InjectedWriterFailure(`injected failure after ${step}`);
		}
		return result;
	};
	try {
		return await db.transaction().execute(async (tx) => {
			const lsn = await timed("lock", async () => {
				/* The timeout comes first so it bounds the cutover's own lock too:
				 * a second run waits 15 seconds for the first, then stops. */
				await sql`SET LOCAL lock_timeout = '15s'`.execute(tx);
				try {
					await sql`SELECT pg_advisory_xact_lock(hashtextextended('cutover:hq-round-trip-emission', 0))`.execute(
						tx,
					);
				} catch (error) {
					if ((error as { code?: unknown })?.code === LOCK_NOT_AVAILABLE) {
						throw new Error(
							"Another run of this cutover held its lock for 15 seconds, so this run stopped with nothing written. Let that run finish, then read its report before running again.",
							{ cause: error },
						);
					}
					throw error;
				}
				const row = await sql<{ lsn: string }>`
					SELECT pg_current_wal_lsn()::text AS lsn
				`.execute(tx);
				return row.rows[0]?.lsn ?? "0/0";
			});
			await timed("blocking-scan", () => blockingScan(tx, build));
			await timed("already-applied", async () => {
				if ((await markedAppCount(tx)) > 0) {
					throw new CutoverStoppedError(
						"already-applied",
						"Another run established this cutover's horizon after this one started, so it stopped with nothing written.",
					);
				}
			});
			const before = await timed("archive-events", async () => {
				const images = await captureBeforeImages(tx);
				const archived = await sql`
					UPDATE events SET kind = 'archived-mutation',
						event = jsonb_build_object('kind', 'archived-mutation', 'runId', event -> 'runId', 'ts', event -> 'ts',
							'seq', event -> 'seq', 'source', event -> 'source', 'archived', event)
					WHERE kind = 'mutation'
				`.execute(tx);
				if (
					String(archived.numAffectedRows ?? BigInt(0)) !==
					images.mutationEvents.count
				) {
					fail("the event archive did not rewrite every mutation event");
				}
				return images;
			});
			await timed("clear-streams", async () => {
				await sql`
					UPDATE threads SET active_stream_id = NULL, active_holder_nonce = NULL
					WHERE active_stream_id IS NOT NULL OR active_holder_nonce IS NOT NULL
				`.execute(tx);
				await sql`DELETE FROM chat_stream_chunks`.execute(tx);
				await sql`DELETE FROM presence`.execute(tx);
			});
			const sessionsEnded = await timed("private-work", () =>
				abandonPrivateWork(tx),
			);
			await timed("apps", async () => {
				for (const app of build.plan.apps) {
					const doc = build.targets.get(app.appId)?.doc;
					if (doc === undefined) fail(`app ${app.appId} has no target`);
					await writeApp(tx, app, doc);
				}
			});
			const ledger = await timed("ledger", () =>
				writeLedger(tx, build, baselines),
			);
			const written = await timed("notices", () =>
				writeNotices(tx, build, baselines),
			);
			const growth = await timed("postconditions", async () => {
				await checkPostconditions(tx, build, baselines, before);
				const row = await sql<{ size: string; wal: string }>`
					SELECT pg_database_size(current_database())::text AS size,
						pg_wal_lsn_diff(pg_current_wal_lsn(), ${lsn}::pg_lsn)::text AS wal
				`.execute(tx);
				return {
					databaseBytes: Number(row.rows[0]?.size ?? "0"),
					walBytes: Number(row.rows[0]?.wal ?? "0"),
				};
			});
			const report: WriterReport = {
				mode: options.mode,
				durations,
				...growth,
				appsWritten: build.plan.apps.length,
				identitiesWritten: ledger.identities,
				deploymentsMarkedMissing: ledger.missing,
				appBaselinesWritten: ledger.appBaselines,
				resourceBaselinesWritten: ledger.resourceBaselines,
				noticesWritten: written.notices,
				keyReadersWritten: written.keyReaders,
				eventsArchived: Number(before.mutationEvents.count),
				sessionsEnded,
			};
			if (options.mode === "rehearse") throw new RehearsalRollback(report);
			for (const app of build.plan.apps) {
				await notifyAppStream(tx, app.appId, app.baseSeq + 1);
			}
			return report;
		});
	} catch (error) {
		if (error instanceof RehearsalRollback) return error.report;
		throw error;
	}
}

/** How many apps already carry this cutover's marker, read outside any lock. */
export async function readMarkedAppCounts(
	db: Kysely<AppDatabase>,
): Promise<{ marked: number; apps: number }> {
	const row = await sql<{ apps: string }>`
		SELECT count(*)::text AS apps FROM apps
	`.execute(db);
	return {
		marked: await markedAppCount(db),
		apps: Number(row.rows[0]?.apps ?? "0"),
	};
}
