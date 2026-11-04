/**
 * The case-writes cutover's one fleet transaction (step 5's part 09,
 * sections 4, 13 and 14), in the named steps of `types.ts::WRITER_STEPS`.
 *
 * One transaction for the whole fleet, so any failure rolls everything back,
 * the DDL included. The window's three ledgered migrations run inside it
 * (`ledger.ts::applyLedgerTo`) once every check that can stop has passed: the
 * plan's digest and its blockers before it opens; the blocking scan, its
 * holders and the already-applied reads under its locks; the before-images.
 * Every write is a raw statement as the migration role or a function the
 * commit kernel itself uses (`lib/db/canonicalCommitKernel.ts`,
 * `lib/db/lookupReferenceEdges.ts`, `lib/organization/commitIntegrity.ts`),
 * never a hand-written equivalent. No `case_type_schemas` row and no case row
 * is written: the drift writer converges the planned schema differences
 * after the deploy (section 12), and the postconditions prove every schema
 * row equals its before-image.
 *
 * Each app is written by step 3's `writeApp`
 * (`scripts/lib/hqRoundTripExpressions/writer.ts` at `733dd193`), copied
 * with this cutover's marker pair: the target replaces the app's root and
 * entity rows, its reference edges are rewritten, and one `fold-baseline`
 * marker at `baseSeq + 1` with its baseline snapshot starts the app's
 * history from the migrated document. The holds ride that document; no
 * mutation batch is written, so the kernel's placement rule has nothing to
 * govern. The archive, stream and private-work statements are step 3's too.
 *
 * Under `--rehearse` the transaction runs whole and ends in a sentinel
 * rollback, as the runtime database probe does, so a rehearsal leaves
 * nothing, the DDL included.
 */

import { type Kysely, sql, type Transaction } from "kysely";
import { loadCanonicalBlueprintAtSequence } from "@/lib/agent/change-set/baseLoader";
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
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
import { extractLookupReferenceTargets } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc } from "@/lib/domain";
import { migrationNoticeEntriesSchema } from "@/lib/notices/migrationNotice";
import { applyOrganizationCommitIntegrity } from "@/lib/organization/commitIntegrity";
import {
	canonicalJsonDigest,
	canonicalJsonText,
} from "@/lib/utils/canonicalJson";
import { constraintDefinition, routineDefinition } from "./catalog";
import { holderCensusIsEmpty, readHolderCensus } from "./holders";
import {
	applyLedgerTo,
	CutoverLockTimeoutError,
	classifyApplied,
	LOCK_NOT_AVAILABLE,
	partiallyApplied,
	readMarkerCount,
	readMigrationLedger,
} from "./ledger";
import { placements } from "./placements";
import {
	type PlannedFleet,
	type PlannedWrite,
	planHasBlockers,
	plannedDeploymentsOf,
} from "./plan";
import {
	type AppDeployments,
	readAppBase,
	readAppDeployments,
	readPrivateWorkCensus,
} from "./source";
import { structurePhase } from "./structure";
import {
	ACTOR_ID,
	ADVISORY_LOCK_KEY,
	type AppPlan,
	type CaseWritesCutoverPlan,
	CUTOVER,
	compareText,
	HORIZON_MIGRATION,
	MARKER_BATCH_ID,
	PENDING_MIGRATIONS,
	type StopCode,
	WRITER_STEPS,
	type WriterStepId,
} from "./types";

// ─── Stops and failures ───────────────────────────────────────────────────

/** The writer refused to write: the database is as it was. */
export class CutoverStoppedError extends Error {
	readonly name = "CutoverStoppedError";

	constructor(
		readonly code: Extract<
			StopCode,
			"blocker" | "holder" | "app-changed" | "baseline-changed" | "digest"
		>,
		message: string,
	) {
		super(message);
	}
}

/** Another run committed this cutover after this one built its plan: the
 *  writer stopped with nothing written, and the run's outcome is
 *  `already-applied`. */
export class CutoverAlreadyAppliedError extends Error {
	readonly name = "CutoverAlreadyAppliedError";
	readonly code = "already-applied";
}

/** A postcondition failed inside the transaction, so the fleet rolled back. */
export class CutoverPostconditionError extends Error {
	readonly name = "CutoverPostconditionError";
}

function fail(message: string): never {
	throw new CutoverPostconditionError(
		`The cutover's postcondition failed, so the whole fleet rolled back with nothing written, the migrations included: ${message}. This is a defect of the cutover; reproduce it with --rehearse against a restored copy of the database.`,
	);
}

/** Section 13's refusal of a plan whose digest is not the dry run's. */
export function digestRefusal(
	actual: string,
	expected: string,
): CutoverStoppedError {
	return new CutoverStoppedError(
		"digest",
		`This run's plan has digest ${actual}, not the ${expected} the dry run printed, so it wrote nothing. Something in the database moved after the dry run. Compare the two runs' reports, then run the dry run again and pass its digest.`,
	);
}

/** The refusal of a plan holding any blocker (section 16). */
export function blockerRefusal(
	plan: Pick<CaseWritesCutoverPlan, "apps">,
): CutoverStoppedError {
	const blocked = plan.apps.filter((app) => app.blockers.length > 0);
	const codes = [
		...new Set(
			blocked.flatMap((app) => app.blockers.map((blocker) => blocker.code)),
		),
	].sort(compareText);
	return new CutoverStoppedError(
		"blocker",
		`The plan holds ${blocked.length === 1 ? "a blocker in 1 app" : `blockers in ${blocked.length} apps`} (${codes.join(", ")}), so the cutover wrote nothing. Resolve each by the remedy its code names in the dry run's blocker lines, then run the dry run again and pass its digest.`,
	);
}

// ─── Options and report ───────────────────────────────────────────────────

/** What the writer writes: the plan and each unblocked app's target. */
export type WriterInput = Pick<PlannedFleet, "plan" | "writes">;

interface WriterOptionsBase {
	readonly input: WriterInput;
	/** Tests only: throw right after the named step, so a test proves that a
	 *  failure at any point leaves the database byte-identical. */
	readonly failAfter?: WriterStepId;
	/** The clock the holder census reads; the current time by default. */
	readonly now?: number;
}

export type WriterOptions = WriterOptionsBase &
	(
		| { readonly mode: "rehearse" }
		| {
				readonly mode: "execute";
				/** The digest the dry run printed. */
				readonly expectPlanDigest: string;
		  }
	);

export interface WriterReport {
	readonly mode: "rehearse" | "execute";
	/** Milliseconds each step took. */
	readonly stepMilliseconds: Readonly<Record<WriterStepId, number>>;
	/** `pg_database_size` at step `finish`, before the commit or the rollback. */
	readonly databaseBytes: number;
	/** The database's growth from step `lock` to step `finish`. */
	readonly databaseGrowthBytes: number;
	/** WAL written from step `lock` to step `finish`. */
	readonly walBytes: number;
	/** The migrations the transaction applied, which commit with the fleet. */
	readonly migrationsApplied: readonly string[];
	readonly appsWritten: number;
	readonly noticesWritten: number;
	readonly eventsArchived: number;
	readonly workspacesAbandoned: number;
	readonly changeSetsAbandoned: number;
	readonly candidatesCleared: number;
	readonly sessionsEnded: number;
}

class RehearsalRollback extends Error {
	constructor(readonly report: WriterReport) {
		super("rehearsal rollback");
	}
}

class InjectedWriterFailure extends Error {
	readonly name = "InjectedWriterFailure";
}

function isLockTimeout(error: unknown): boolean {
	return (error as { code?: unknown } | null)?.code === LOCK_NOT_AVAILABLE;
}

// ─── Step `blocking-scan` ─────────────────────────────────────────────────

/** Each app's published deployments as the locked rows give them. */
type LockedDeployments = ReadonlyMap<string, AppDeployments>;

/**
 * Lock the fleet and prove it is the fleet the plan was built from: every
 * app row `FOR UPDATE` in id order, every design session `FOR UPDATE`, every
 * published deployment's baseline `FOR SHARE`; the same apps at the same
 * sequences and raw digests (`app-changed`); the same published deployments
 * with the same baselines (`baseline-changed`); no run holder (`holder`).
 */
async function blockingScan(
	tx: Transaction<AppDatabase>,
	plan: CaseWritesCutoverPlan,
	now: number,
): Promise<LockedDeployments> {
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
	const published = plan.apps
		.flatMap((app) => app.deployments.map((entry) => entry.deploymentId))
		.sort(compareText);
	if (published.length > 0) {
		await sql`
			SELECT deployment_id FROM public.app_deployment_baselines
			WHERE deployment_id = ANY(${published}::uuid[])
			ORDER BY deployment_id
			FOR SHARE
		`.execute(tx);
	}
	// The plan lists apps in code-point order; `ORDER BY id` follows the
	// database's collation, which orders mixed-case ids differently.
	const planned = plan.apps.map((app) => app.appId);
	const present = locked.map((app) => app.id).sort(compareText);
	if (
		planned.length !== present.length ||
		planned.some((appId, index) => present[index] !== appId)
	) {
		throw new CutoverStoppedError(
			"app-changed",
			`The fleet holds ${present.length} apps where the plan was built over ${planned.length}, or other ones, so the cutover stopped with nothing written. Run the dry run again and pass its digest.`,
		);
	}
	for (const app of plan.apps) {
		const current = await readAppBase(tx, app.appId);
		if (
			current === null ||
			current.baseSeq !== app.baseSeq ||
			current.baseDigest !== app.baseDigest
		) {
			throw new CutoverStoppedError(
				"app-changed",
				`App ${app.appId} changed after the plan was built, so the cutover stopped with nothing written. Run the dry run again and pass its digest.`,
			);
		}
	}
	const deployments = await readAppDeployments(tx, planned);
	for (const app of plan.apps) {
		const current = plannedDeploymentsOf(
			deployments.get(app.appId)?.published ?? [],
		);
		if (canonicalJsonText(current) !== canonicalJsonText(app.deployments)) {
			throw new CutoverStoppedError(
				"baseline-changed",
				`A published deployment of app ${app.appId}, or what Nova stored as read of it, changed after the plan was built, so the cutover stopped with nothing written. Run the dry run again and pass its digest.`,
			);
		}
	}
	if (!holderCensusIsEmpty(await readHolderCensus(tx, now))) {
		throw new CutoverStoppedError(
			"holder",
			"A run still holds an app or a design session, or a hold is unsettled, so the cutover stopped with nothing written. Settle the holders with --settle-holders, wait for any live run to finish, then run again.",
		);
	}
	return deployments;
}

// ─── Step `before-images` ─────────────────────────────────────────────────

/** Every `public.app_deployment_*` relation, read whole and never written. */
const DEPLOYMENT_TABLES = [
	"app_deployments",
	"app_deployment_resources",
	"app_deployment_identities",
	"app_deployment_confirmations",
	"app_deployment_baselines",
] as const;

interface EventImage {
	readonly count: string;
	readonly bytes: string;
}

interface BeforeImages {
	readonly schemas: readonly string[];
	/** Each app's `cases` count. */
	readonly cases: ReadonlyMap<string, string>;
	readonly deployments: ReadonlyMap<string, readonly string[]>;
	readonly mutationEvents: EventImage;
	/** Events an earlier cutover archived, with their archived bytes. */
	readonly archivedEvents: EventImage;
}

/** Every row of `public.<table>` as text, in code-point order of that text. */
async function rowsAsText(
	tx: Transaction<AppDatabase>,
	table: string,
): Promise<string[]> {
	const rows = await sql<{ row: string }>`
		SELECT t::text AS row FROM ${sql.table(`public.${table}`)} AS t
		ORDER BY t::text COLLATE "C"
	`.execute(tx);
	return rows.rows.map((row) => row.row);
}

/** The case store's `cases` relation, resolved as
 *  `nova_create_app_test_namespace` resolves it: `nova_case_runtime` where it
 *  holds it, else `public`. */
async function casesSchema(
	tx: Transaction<AppDatabase>,
): Promise<"nova_case_runtime" | "public"> {
	const located = await sql<{ schema: string | null }>`
		SELECT CASE
			WHEN pg_catalog.to_regclass('nova_case_runtime.cases') IS NOT NULL THEN 'nova_case_runtime'
			WHEN pg_catalog.to_regclass('public.cases') IS NOT NULL THEN 'public'
		END AS schema
	`.execute(tx);
	const schema = located.rows[0]?.schema;
	if (schema === "nova_case_runtime" || schema === "public") return schema;
	throw new Error(
		"Neither nova_case_runtime.cases nor public.cases exists, so the cutover cannot prove it leaves every app's cases as they are. The case store's migrations have not run on this database; compare the ledger with main's migrations.",
	);
}

/** The `mutation` events with their bytes, and the archived ones with the
 *  bytes of the event each archives, so the archive is proved byte for byte. */
async function eventImages(tx: Transaction<AppDatabase>): Promise<{
	readonly mutation: EventImage;
	readonly archived: EventImage;
}> {
	const mutation = await sql<EventImage>`
		SELECT count(*)::text AS count,
			COALESCE(sum(octet_length(event::text)), 0)::text AS bytes
		FROM public.events WHERE kind = 'mutation'
	`.execute(tx);
	const archived = await sql<EventImage>`
		SELECT count(*)::text AS count,
			COALESCE(sum(octet_length((event -> 'archived')::text)), 0)::text AS bytes
		FROM public.events WHERE kind = 'archived-mutation'
	`.execute(tx);
	return {
		mutation: mutation.rows[0] ?? { count: "0", bytes: "0" },
		archived: archived.rows[0] ?? { count: "0", bytes: "0" },
	};
}

async function captureImages(
	tx: Transaction<AppDatabase>,
): Promise<BeforeImages> {
	const schema = await casesSchema(tx);
	const cases = await sql<{ app_id: string; count: string }>`
		SELECT app_id, count(*)::text AS count
		FROM ${sql.table(`${schema}.cases`)}
		GROUP BY app_id
	`.execute(tx);
	const deployments = new Map<string, readonly string[]>();
	for (const table of DEPLOYMENT_TABLES) {
		deployments.set(table, await rowsAsText(tx, table));
	}
	const events = await eventImages(tx);
	return {
		schemas: await rowsAsText(tx, "case_type_schemas"),
		cases: new Map(cases.rows.map((row) => [row.app_id, row.count])),
		deployments,
		mutationEvents: events.mutation,
		archivedEvents: events.archived,
	};
}

function sameRows(
	a: readonly string[] | undefined,
	b: readonly string[] | undefined,
): boolean {
	return (
		a !== undefined &&
		b !== undefined &&
		a.length === b.length &&
		a.every((row, index) => row === b[index])
	);
}

// ─── Step `private-work` ──────────────────────────────────────────────────

interface AbandonedWork {
	readonly workspaces: number;
	readonly changeSets: number;
	readonly candidates: number;
	readonly sessionsEnded: number;
}

/**
 * Step 3's `abandonPrivateWork`: end each pre-app build session that held
 * open work through the one body a discard ends it with, then clear every
 * active candidate and abandon every open workspace and change set.
 */
async function abandonPrivateWork(
	tx: Transaction<AppDatabase>,
): Promise<AbandonedWork> {
	const census = await readPrivateWorkCensus(tx);
	/* A pre-app session ends first, through its own body, so its change sets
	 * and slice attempts retire the way a discard retires them. */
	for (const id of census.endingSessions) {
		const row = await lockSessionRow(tx, id);
		if (row === undefined) continue;
		await abandonPreAppDesignSessionInTransaction(tx, row);
	}
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
	return {
		workspaces: census.openWorkspaces,
		changeSets: census.openChangeSets,
		candidates: census.activeCandidates,
		sessionsEnded: census.endingSessions.length,
	};
}

// ─── Step `apps` (section 4) ──────────────────────────────────────────────

/** Write one app's target and start its history at `baseSeq + 1`. */
async function writeApp(
	tx: Transaction<AppDatabase>,
	app: AppPlan,
	doc: BlueprintDoc,
): Promise<void> {
	const { appId, projectId } = app;
	const seq = app.baseSeq + 1;
	const persistable = toPersistableDoc(doc);
	const lookupTargets = extractLookupReferenceTargets(doc);
	// 1. The Project's lookup tables locked for the reference write.
	await lookupContextForAuthoritativeWrite(tx, projectId, lookupTargets);
	// 2. The root slots and the denormalized list columns, both from
	// `denormalize`, the kernel's own projection. `updated_at` is left as it
	// stood: nobody edited the app.
	await tx
		.updateTable("apps")
		.set({ ...denormalize(persistable), mutation_seq: seq })
		.where("id", "=", appId)
		.execute();
	// 3. The entity rows, replaced whole.
	await tx
		.deleteFrom("blueprint_entities")
		.where("app_id", "=", appId)
		.execute();
	const rows = decomposeBlueprint(persistable);
	if (rows.length > 0) {
		await tx
			.insertInto("blueprint_entities")
			.values(
				rows.map((row) => ({
					app_id: appId,
					uuid: row.uuid,
					kind: row.kind,
					parent_uuid: row.parent_uuid,
					ordinal: row.ordinal,
					data: JSON.stringify(row.data),
				})),
			)
			.execute();
	}
	// 4. The reference edges, through the kernel's own writers. No step
	// changes an organization level, a location property or a place, so the
	// target is its own previous document: the integrity pass re-proves the
	// places it references and rewrites its location edges.
	await replaceExactMediaReferencesForApp(tx, {
		appId,
		projectId,
		candidateDoc: doc,
	});
	await replaceLookupReferenceEdges(tx, {
		appId,
		projectId,
		targets: lookupTargets,
	});
	await applyOrganizationCommitIntegrity(tx, {
		appId,
		previousDoc: doc,
		candidateDoc: doc,
	});
	// 5. The marker.
	await tx
		.insertInto("app_changes")
		.values({
			app_id: appId,
			seq,
			batch_id: MARKER_BATCH_ID,
			run_id: null,
			actor_id: ACTOR_ID,
			kind: "fold-baseline",
			mutations: "[]",
			from_project_id: null,
			to_project_id: null,
		})
		.execute();
	// 6. The baseline: the database's own snapshot of the rows just written.
	await sql`
		INSERT INTO app_change_fold_baselines
			(app_id, seq, project_id, snapshot, snapshot_digest)
		SELECT app.id, ${seq}, app.project_id, current.snapshot,
			public.nova_app_change_fold_snapshot_digest(current.snapshot)
		FROM public.apps AS app,
			LATERAL (
				SELECT public.nova_current_app_change_fold_snapshot(app.id) AS snapshot
			) AS current
		WHERE app.id = ${appId}
	`.execute(tx);
}

function writeOf(input: WriterInput, app: AppPlan): PlannedWrite {
	const write = input.writes.get(app.appId);
	if (write === undefined || app.targetDigest === null)
		fail(`app ${app.appId} has no target to write`);
	return write;
}

// ─── Step `notices` ───────────────────────────────────────────────────────

/** The entries one app's notice row holds, parsed before they are written. */
function noticeEntriesOf(app: AppPlan) {
	return migrationNoticeEntriesSchema.parse(app.notice);
}

async function writeNotices(
	tx: Transaction<AppDatabase>,
	plan: CaseWritesCutoverPlan,
): Promise<number> {
	let written = 0;
	for (const app of plan.apps) {
		if (app.notice.length === 0) continue;
		const entries = noticeEntriesOf(app);
		await sql`
			INSERT INTO app_migration_notices (app_id, cutover, entries)
			VALUES (${app.appId}, ${CUTOVER}, ${JSON.stringify(entries)}::jsonb)
		`.execute(tx);
		written += 1;
	}
	return written;
}

// ─── Step `postconditions` (section 14) ───────────────────────────────────

/**
 * Step 15 again, over the stored target and the deployments the blocking
 * scan locked: the holds the target carries must be exactly the plan's, the
 * head must emit each at its identity (section 8.4), and each one held
 * because a baseline carried it must still be carried by a locked baseline.
 * A target holding every hold already writes nothing more.
 */
function checkPlacements(
	app: AppPlan,
	write: PlannedWrite,
	stored: BlueprintDoc,
	locked: LockedDeployments,
): void {
	const deployments = locked.get(app.appId)?.published ?? [];
	if (deployments.length === 0) {
		if (app.held.length > 0)
			fail(`app ${app.appId} holds placements and no published deployment`);
		return;
	}
	const raw = write.source.raw;
	const again = placements({
		raw,
		target: stored,
		facts: structurePhase(raw).facts,
		deployments,
		mutationSeq: app.baseSeq,
		...(write.carriedCreates !== undefined && {
			carriedCreates: write.carriedCreates,
		}),
	});
	if (again.blockers.length > 0)
		fail(
			`the stored target of app ${app.appId} meets ${again.blockers.map((blocker) => blocker.code).join(", ")} over the locked baselines`,
		);
	if (canonicalJsonDigest(toPersistableDoc(again.target)) !== app.targetDigest)
		fail(`the stored target of app ${app.appId} lacks a planned hold`);
	if (canonicalJsonText(again.held) !== canonicalJsonText(app.held))
		fail(
			`the stored target of app ${app.appId} holds placements other than the plan's, or for other reasons`,
		);
}

async function checkPostconditions(
	tx: Transaction<AppDatabase>,
	input: WriterInput,
	before: BeforeImages,
	locked: LockedDeployments,
): Promise<void> {
	const { plan } = input;
	for (const app of plan.apps) {
		const write = writeOf(input, app);
		const seq = app.baseSeq + 1;
		// The app loads under the strict schema and the absolute gate, and is
		// the planned target.
		const loaded = await loadAppInTransaction(tx, app.appId);
		if (loaded === null) fail(`app ${app.appId} no longer loads`);
		if (loaded.mutation_seq !== seq)
			fail(`app ${app.appId} is not at sequence ${seq}`);
		const stored = hydratePersistedBlueprint(loaded.blueprint);
		if (canonicalJsonDigest(toPersistableDoc(stored)) !== app.targetDigest)
			fail(`app ${app.appId} does not hold its planned target`);
		// Its marker, and its history folds from the new baseline to it.
		const marker = await sql<{
			batch_id: string;
			actor_id: string;
			kind: string;
			run_id: string | null;
			mutations: string;
		}>`
			SELECT batch_id, actor_id, kind, run_id, mutations::text AS mutations
			FROM public.app_changes WHERE app_id = ${app.appId} AND seq = ${seq}
		`.execute(tx);
		const row = marker.rows[0];
		if (
			marker.rows.length !== 1 ||
			row === undefined ||
			row.batch_id !== MARKER_BATCH_ID ||
			row.actor_id !== ACTOR_ID ||
			row.kind !== "fold-baseline" ||
			row.run_id !== null ||
			row.mutations !== "[]"
		)
			fail(`app ${app.appId} has no horizon marker at sequence ${seq}`);
		const baseline = await sql<{ count: string }>`
			SELECT count(*)::text AS count FROM public.app_change_fold_baselines
			WHERE app_id = ${app.appId} AND seq = ${seq}
		`.execute(tx);
		if (baseline.rows[0]?.count !== "1")
			fail(`app ${app.appId} has no fold baseline at sequence ${seq}`);
		await loadCanonicalBlueprintAtSequence(tx, {
			appId: app.appId,
			seq,
			expectedDigest: app.targetDigest,
		});
		checkPlacements(app, write, stored, locked);
	}

	// No mutation event, private work or stream holder is left.
	const after = await captureImages(tx);
	if (
		after.mutationEvents.count !== "0" ||
		BigInt(after.archivedEvents.count) !==
			BigInt(before.archivedEvents.count) +
				BigInt(before.mutationEvents.count) ||
		BigInt(after.archivedEvents.bytes) !==
			BigInt(before.archivedEvents.bytes) + BigInt(before.mutationEvents.bytes)
	)
		fail("the archived events are not the mutation events, byte for byte");
	const left = await sql<{
		workspaces: string;
		change_sets: string;
		candidates: string;
		threads: string;
		chunks: string;
		presence: string;
	}>`
		SELECT
			(SELECT count(*) FROM public.authoring_workspaces WHERE status = 'open')::text AS workspaces,
			(SELECT count(*) FROM public.design_change_sets WHERE status = 'open')::text AS change_sets,
			(SELECT count(*) FROM public.authoring_sessions WHERE active_candidate_id IS NOT NULL)::text AS candidates,
			(SELECT count(*) FROM public.threads
				WHERE active_stream_id IS NOT NULL OR active_holder_nonce IS NOT NULL)::text AS threads,
			(SELECT count(*) FROM public.chat_stream_chunks)::text AS chunks,
			(SELECT count(*) FROM public.presence)::text AS presence
	`.execute(tx);
	const open = left.rows[0];
	if (
		open === undefined ||
		open.workspaces !== "0" ||
		open.change_sets !== "0" ||
		open.candidates !== "0"
	)
		fail("private work was left open");
	if (open.threads !== "0" || open.chunks !== "0" || open.presence !== "0")
		fail("a stream holder was left");

	// The case store and the deployment ledger are as they were.
	if (!sameRows(after.schemas, before.schemas))
		fail("a case_type_schemas row changed");
	if (
		after.cases.size !== before.cases.size ||
		[...after.cases].some(([appId, count]) => before.cases.get(appId) !== count)
	)
		fail("an app's count of cases changed");
	for (const table of DEPLOYMENT_TABLES) {
		if (!sameRows(after.deployments.get(table), before.deployments.get(table)))
			fail(`a ${table} row changed`);
	}

	// Exactly the planned notice rows.
	const notices = await sql<{ app_id: string; entries: string }>`
		SELECT app_id, entries::text AS entries FROM public.app_migration_notices
		WHERE cutover = ${CUTOVER}
	`.execute(tx);
	const written = new Map<string, string[]>();
	for (const notice of notices.rows) {
		const list = written.get(notice.app_id) ?? [];
		list.push(canonicalJsonText(JSON.parse(notice.entries) as unknown));
		written.set(notice.app_id, list);
	}
	for (const app of plan.apps) {
		const rows = written.get(app.appId) ?? [];
		written.delete(app.appId);
		if (app.notice.length === 0) {
			if (rows.length > 0) fail(`app ${app.appId} holds an unplanned notice`);
			continue;
		}
		if (
			rows.length !== 1 ||
			rows[0] !== canonicalJsonText(noticeEntriesOf(app))
		)
			fail(`app ${app.appId} does not hold exactly its planned notice`);
	}
	if (written.size > 0)
		fail("a notice row of this cutover names an app the plan does not hold");

	// The ledger holds the three migrations, and the catalog their objects.
	const ledger = await readMigrationLedger(tx);
	if (
		!ledger.horizonApplied ||
		PENDING_MIGRATIONS.some((name) => ledger.pendingMigrations.includes(name))
	)
		fail("the ledger does not hold the window's three migrations");
	for (const signature of [
		"nova_admit_app_change_fold_baseline_insert()",
		"nova_require_app_change_fold_baseline()",
	]) {
		if (
			!(await routineDefinition(tx, "public", signature)).includes(
				`'${MARKER_BATCH_ID}'`,
			)
		)
			fail(`public.${signature} does not admit this cutover's horizon`);
	}
	if (
		!(
			await routineDefinition(tx, "public", "nova_admit_app_change_insert()")
		).includes("'publish-placement'")
	)
		fail("public.nova_admit_app_change_insert() does not admit a placement");
	if (
		!(
			await constraintDefinition(
				tx,
				"public",
				"app_deployment_confirmations",
				"app_deployment_confirmations_kind_check",
			)
		).includes("'commtrack-off'")
	)
		fail(
			"app_deployment_confirmations_kind_check does not admit commtrack-off",
		);
	await constraintDefinition(
		tx,
		"public",
		"app_deployment_confirmations",
		"app_deployment_confirmations_commtrack_subject",
	);
}

// ─── The transaction ──────────────────────────────────────────────────────

/**
 * Run the fleet transaction over a plan with no blocker. Returns the report
 * of a committed execute run or a rolled-back rehearsal. Throws
 * `CutoverStoppedError` when a check refuses before any write,
 * `CutoverAlreadyAppliedError` when another run committed the cutover,
 * `ledger.ts`'s `CutoverLockTimeoutError`, `CutoverLedgerError` or
 * `CutoverPartiallyAppliedError` for their stops, and any other error after
 * rolling the whole fleet back.
 */
export async function runFleetTransaction(
	db: Kysely<AppDatabase>,
	options: WriterOptions,
): Promise<WriterReport> {
	const { input } = options;
	const { plan } = input;
	if (options.mode === "execute" && plan.digest !== options.expectPlanDigest)
		throw digestRefusal(plan.digest, options.expectPlanDigest);
	if (planHasBlockers(plan)) throw blockerRefusal(plan);
	for (const app of plan.apps) writeOf(input, app);
	const now = options.now ?? Date.now();
	const durations = Object.fromEntries(
		WRITER_STEPS.map((step) => [step, 0]),
	) as Record<WriterStepId, number>;
	const timed = async <T>(step: WriterStepId, body: () => Promise<T>) => {
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
			const start = await timed("lock", async () => {
				/* The timeout comes first so it bounds the cutover's own lock too:
				 * a second run waits 15 seconds for the first, then stops. */
				await sql`SET LOCAL lock_timeout = '15s'`.execute(tx);
				try {
					await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${ADVISORY_LOCK_KEY}, 0))`.execute(
						tx,
					);
				} catch (error) {
					if (isLockTimeout(error)) {
						throw new CutoverLockTimeoutError(
							"Another run of this cutover held its lock for 15 seconds, so this run stopped with nothing written. Let that run finish, then read its report before running again.",
							{ cause: error },
						);
					}
					throw error;
				}
				const row = await sql<{ lsn: string; size: string }>`
					SELECT pg_catalog.pg_current_wal_lsn()::text AS lsn,
						pg_catalog.pg_database_size(pg_catalog.current_database())::text AS size
				`.execute(tx);
				return {
					lsn: row.rows[0]?.lsn ?? "0/0",
					size: Number(row.rows[0]?.size ?? "0"),
				};
			});
			const locked = await timed("blocking-scan", async () => {
				try {
					return await blockingScan(tx, plan, now);
				} catch (error) {
					if (isLockTimeout(error)) {
						throw new CutoverLockTimeoutError(
							"Another session held a lock on an app, a design session or a deployment baseline for 15 seconds, so this run stopped with nothing written. Let that session finish, or end it, then run the dry run again.",
							{ cause: error },
						);
					}
					throw error;
				}
			});
			await timed("already-applied", async () => {
				const ledger = await readMigrationLedger(tx);
				const markers = await readMarkerCount(tx);
				const state = classifyApplied(ledger, markers);
				if (state === "already-applied") {
					throw new CutoverAlreadyAppliedError(
						"Another run committed this cutover after this one built its plan, so it stopped with nothing written.",
					);
				}
				if (state === "partially-applied")
					throw partiallyApplied(ledger, markers);
			});
			const before = await timed("before-images", () => captureImages(tx));
			const migrationsApplied = await timed("ledger", () =>
				applyLedgerTo(tx, HORIZON_MIGRATION),
			);
			const eventsArchived = await timed("archive-events", async () => {
				const archived = await sql`
					UPDATE events SET kind = 'archived-mutation',
						event = jsonb_build_object('kind', 'archived-mutation', 'runId', event -> 'runId', 'ts', event -> 'ts',
							'seq', event -> 'seq', 'source', event -> 'source', 'archived', event)
					WHERE kind = 'mutation'
				`.execute(tx);
				const count = String(archived.numAffectedRows ?? BigInt(0));
				if (count !== before.mutationEvents.count)
					fail("the event archive did not rewrite every mutation event");
				return Number(count);
			});
			await timed("clear-streams", async () => {
				await sql`
					UPDATE threads SET active_stream_id = NULL, active_holder_nonce = NULL
					WHERE active_stream_id IS NOT NULL OR active_holder_nonce IS NOT NULL
				`.execute(tx);
				await sql`DELETE FROM chat_stream_chunks`.execute(tx);
				await sql`DELETE FROM presence`.execute(tx);
			});
			const abandoned = await timed("private-work", () =>
				abandonPrivateWork(tx),
			);
			await timed("apps", async () => {
				for (const app of plan.apps) {
					await writeApp(tx, app, writeOf(input, app).target);
				}
			});
			const noticesWritten = await timed("notices", () =>
				writeNotices(tx, plan),
			);
			await timed("postconditions", () =>
				checkPostconditions(tx, input, before, locked),
			);
			const growth = await timed("finish", async () => {
				const row = await sql<{ size: string; wal: string }>`
					SELECT pg_catalog.pg_database_size(pg_catalog.current_database())::text AS size,
						pg_catalog.pg_wal_lsn_diff(pg_catalog.pg_current_wal_lsn(), ${start.lsn}::pg_lsn)::text AS wal
				`.execute(tx);
				if (options.mode === "execute") {
					for (const app of plan.apps) {
						await notifyAppStream(tx, app.appId, app.baseSeq + 1);
					}
				}
				const size = Number(row.rows[0]?.size ?? "0");
				return {
					databaseBytes: size,
					databaseGrowthBytes: size - start.size,
					walBytes: Number(row.rows[0]?.wal ?? "0"),
				};
			});
			const report: WriterReport = {
				mode: options.mode,
				stepMilliseconds: durations,
				...growth,
				migrationsApplied,
				appsWritten: plan.apps.length,
				noticesWritten,
				eventsArchived,
				workspacesAbandoned: abandoned.workspaces,
				changeSetsAbandoned: abandoned.changeSets,
				candidatesCleared: abandoned.candidates,
				sessionsEnded: abandoned.sessionsEnded,
			};
			if (options.mode === "rehearse") throw new RehearsalRollback(report);
			return report;
		});
	} catch (error) {
		if (error instanceof RehearsalRollback) return error.report;
		throw error;
	}
}
