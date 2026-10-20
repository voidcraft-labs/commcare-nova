/**
 * The expressions cutover's one fleet transaction (part 09 of step 3's plan,
 * §9 "The fleet transaction, step by step", and §10 "Postconditions").
 *
 * One transaction for the whole fleet: the event, stream and private-work
 * statements are fleet-wide anyway, and any failure rolls everything back, so
 * a failure before the commit leaves the database as it was. Every write is a
 * raw statement as the migration role or a function the commit kernel itself
 * uses (`lib/db/canonicalCommitKernel.ts`, `lib/db/lookupReferenceEdges.ts`,
 * `lib/organization/commitIntegrity.ts`), never a hand-written equivalent.
 * No `case_type_schemas` row is written here: the drift writer converges
 * them after the deploy (§8, option A).
 *
 * The ledgered DDL runs inside this transaction too, once every check that
 * can stop has passed (the run's digest before it opens; the blocking scan,
 * its holders and the already-applied count under its locks): Kysely's
 * `Migrator` runs on a transaction it is given, so the fold-horizon
 * functions and their `kysely_migration` row commit with the fleet or roll
 * back with it. No stop leaves the database holding a migration `main` does
 * not have.
 *
 * Under `--rehearse` the transaction runs whole and ends in a sentinel
 * rollback, as the runtime database probe does, so a rehearsal leaves
 * nothing, the DDL included.
 *
 * Step 2's writer (`scripts/lib/hqRoundTripCutover/writer.ts` at `f9218b7e`)
 * is the template; its lookup-tag, ledger and baseline steps have no
 * counterpart here.
 */

import { type Kysely, sql, type Transaction } from "kysely";
import { loadCanonicalBlueprintAtSequence } from "@/lib/agent/change-set/baseLoader";
import { runCaseStoreMigrationsWithReport } from "@/lib/case-store/migrate";
import { caseStoreMigrations } from "@/lib/case-store/migrations";
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
import { exportReadinessFindings } from "@/lib/doc/commitVerdicts";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
import {
	extractLookupReferenceTargets,
	type LookupValidationContext,
} from "@/lib/doc/lookupReferences";
import type { BlueprintDoc } from "@/lib/domain";
import type { MigrationNoticeEntry } from "@/lib/notices/migrationNotice";
import { applyOrganizationCommitIntegrity } from "@/lib/organization/commitIntegrity";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { readAppBase, readPrivateWorkCensus } from "./fleet";
import { holderCensusIsEmpty, readHolderCensus } from "./holders";
import {
	type AppPlan,
	CUTOVER,
	type ExpressionsCutoverPlan,
	MARKER_ACTOR_ID,
	MARKER_BATCH_ID,
} from "./plan";
import { plannedSchemaChanges, roundTripFailures } from "./transform";
import type { PlannedSchemaChange } from "./types";

/** The numbered steps of §9, in order. */
export const WRITER_STEPS = [
	"lock",
	"blocking-scan",
	"already-applied",
	"ledger",
	"archive-events",
	"clear-streams",
	"private-work",
	"apps",
	"notices",
	"postconditions",
	"finish",
] as const;
export type WriterStep = (typeof WRITER_STEPS)[number];

/** The advisory lock key every run of this cutover takes first. */
export const CUTOVER_LOCK_KEY = "cutover:hq-round-trip-expressions";

/** The ledgered migration that admits this cutover's horizon. */
export const FOLD_HORIZON_MIGRATION =
	"20261020000000_hq_round_trip_expressions_fold_horizon";

/** What the migration ledger holds, read before any write. */
export interface MigrationLedgerState {
	/** The ledger already holds the fold-horizon migration. */
	readonly foldHorizonApplied: boolean;
	/** Every migration of this tree the ledger does not hold, by name. */
	readonly pendingMigrations: readonly string[];
}

/** Read the `kysely_migration` ledger with one plain `SELECT`. */
export async function readMigrationLedger(
	db: Kysely<AppDatabase>,
): Promise<MigrationLedgerState> {
	const exists = await sql<{ present: boolean }>`
		SELECT to_regclass('public.kysely_migration') IS NOT NULL AS present
	`.execute(db);
	const applied = new Set<string>();
	if (exists.rows[0]?.present === true) {
		const rows = await sql<{ name: string }>`
			SELECT name FROM kysely_migration
		`.execute(db);
		for (const row of rows.rows) applied.add(row.name);
	}
	return {
		foldHorizonApplied: applied.has(FOLD_HORIZON_MIGRATION),
		pendingMigrations: Object.keys(caseStoreMigrations)
			.filter((name) => !applied.has(name))
			.sort(),
	};
}

/** Why the writer stopped before anything was written. */
export type WriterStopCode =
	| "app-changed"
	| "holder"
	| "already-applied"
	| "blocker";

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

/** The ledgered DDL failed inside the transaction, so the fleet rolled back. */
export class CutoverLedgerError extends Error {
	readonly name = "CutoverLedgerError";
}

/** Another run held the cutover's lock past the lock timeout. */
export class CutoverLockTimeoutError extends Error {
	readonly name = "CutoverLockTimeoutError";
}

/** One app as the writer writes it: its plan, its target and its notice. */
export interface WriterApp {
	readonly plan: AppPlan;
	/** The parsed and hydrated target the plan's `targetDigest` digests. */
	readonly target: BlueprintDoc;
	/** The notice entries the plan holds for this app; empty writes no row. */
	readonly noticeEntries: readonly MigrationNoticeEntry[];
}

/** Everything the fleet transaction writes, decided before it opens. */
export interface WriterInput {
	readonly plan: ExpressionsCutoverPlan;
	/** By app id, one per `plan.apps` entry. */
	readonly apps: ReadonlyMap<string, WriterApp>;
	/** Each Project's lookup definitions, as the plan judged its targets. */
	readonly lookupContexts: ReadonlyMap<string, LookupValidationContext>;
	/** Each Project's media manifest, as the plan judged export readiness. */
	readonly mediaManifests: ReadonlyMap<
		string,
		Parameters<typeof exportReadinessFindings>[2]
	>;
}

export interface WriterOptions {
	readonly mode: "rehearse" | "execute";
	readonly input: WriterInput;
	/**
	 * Throw right after the named step, so a test proves that a failure at any
	 * point leaves the database byte-identical.
	 */
	readonly failAfter?: WriterStep;
}

export interface WriterReport {
	readonly mode: "rehearse" | "execute";
	/** Milliseconds each numbered step took. */
	readonly durations: Readonly<Record<WriterStep, number>>;
	/** `pg_database_size` read at step 10, before the commit or the rollback. */
	readonly databaseBytes: number;
	/** WAL written from step 1 to step 10. */
	readonly walBytes: number;
	/** The migrations the transaction applied and committed with the fleet. */
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

function fail(message: string): never {
	throw new CutoverPostconditionError(
		`The cutover's postcondition failed, so nothing was written: ${message}`,
	);
}

// ── Step 2: the blocking scan under the locks ───────────────────────

/** Lock the fleet and prove it is the fleet the plan was built from. */
async function blockingScan(
	tx: Transaction<AppDatabase>,
	plan: ExpressionsCutoverPlan,
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
	const planned = plan.apps.map((app) => app.appId);
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
	for (const app of plan.apps) {
		const current = await readAppBase(tx, app.appId);
		if (
			current === null ||
			current.baseSeq !== app.baseSeq ||
			current.baseDigest !== app.baseDigest
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

// ── Step 3: already applied ─────────────────────────────────────────

async function markedAppCount(
	db: Transaction<AppDatabase> | Kysely<AppDatabase>,
): Promise<number> {
	const row = await sql<{ marked: string }>`
		SELECT count(*)::text AS marked FROM apps AS app
		WHERE EXISTS (
			SELECT 1 FROM app_changes AS marker
			WHERE marker.app_id = app.id AND marker.batch_id = ${MARKER_BATCH_ID}
		)
	`.execute(db);
	return Number(row.rows[0]?.marked ?? "0");
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

// ── Step 4: before-images ───────────────────────────────────────────

interface BeforeImages {
	readonly cases: ReadonlyMap<string, { count: string; digest: string | null }>;
	readonly schemas: readonly string[];
	readonly mutationEvents: { count: string; bytes: string };
	/** Events already archived, by an earlier cutover, with their archived bytes. */
	readonly archivedEvents: { count: string; bytes: string };
}

async function captureImages(
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
	return {
		cases: new Map(
			cases.rows.map((row) => [
				row.app_id,
				{ count: row.count, digest: row.digest },
			]),
		),
		schemas: schemas.rows.map((row) => row.row_text),
		mutationEvents: events.rows[0] ?? { count: "0", bytes: "0" },
		archivedEvents: await archivedEventImage(tx),
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

// ── Step 6: private work ────────────────────────────────────────────

interface AbandonedWork {
	readonly workspaces: number;
	readonly changeSets: number;
	readonly candidates: number;
	readonly sessionsEnded: number;
}

/**
 * Clear every active candidate, abandon every open workspace and change set,
 * and end each pre-app build session that held open work through the one
 * body a discard ends it with.
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

// ── Step 7: one app ─────────────────────────────────────────────────

/** Write one app's target and establish its horizon. */
async function writeApp(
	tx: Transaction<AppDatabase>,
	app: WriterApp,
): Promise<void> {
	const { appId, projectId } = app.plan;
	const seq = app.plan.baseSeq + 1;
	const doc = app.target;
	const persistable = toPersistableDoc(doc);
	const lookupTargets = extractLookupReferenceTargets(doc);
	await lookupContextForAuthoritativeWrite(tx, projectId, lookupTargets);
	/* The root slots (`blueprintScalars`) and the denormalized list columns,
	 * both from `denormalize`, the kernel's own projection. `updated_at` is
	 * left as it stood: nobody edited the app. */
	await tx
		.updateTable("apps")
		.set({ ...denormalize(persistable), mutation_seq: seq })
		.where("id", "=", appId)
		.execute();
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
	/* No step changes an organization level, a location property or a place,
	 * so the target is its own previous document: the integrity pass re-proves
	 * the places it references and rewrites its location edges. */
	await applyOrganizationCommitIntegrity(tx, {
		appId,
		previousDoc: doc,
		candidateDoc: doc,
	});
	await tx
		.insertInto("app_changes")
		.values({
			app_id: appId,
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
		WHERE app.id = ${appId}
	`.execute(tx);
}

// ── Step 8: notices ─────────────────────────────────────────────────

async function writeNotices(
	tx: Transaction<AppDatabase>,
	input: WriterInput,
): Promise<number> {
	let written = 0;
	for (const planned of input.plan.apps) {
		const app = input.apps.get(planned.appId);
		if (app === undefined || app.noticeEntries.length === 0) continue;
		await sql`
			INSERT INTO app_migration_notices (app_id, cutover, entries)
			VALUES (${planned.appId}, ${CUTOVER}, ${JSON.stringify(app.noticeEntries)}::jsonb)
		`.execute(tx);
		written += 1;
	}
	return written;
}

// ── Step 9: postconditions ──────────────────────────────────────────

/** The two schema-change lists, as one canonical comparison. */
function schemaChangesKey(changes: readonly PlannedSchemaChange[]): string {
	return canonicalJsonDigest(
		[...changes]
			.map((change) => ({
				caseType: change.caseType,
				property: change.property,
				from: change.from,
				to: change.to,
				source: change.source,
			}))
			.sort((a, b) =>
				a.caseType === b.caseType
					? a.property < b.property
						? -1
						: a.property > b.property
							? 1
							: 0
					: a.caseType < b.caseType
						? -1
						: 1,
			),
	);
}

/** §10, inside the transaction: any failure rolls the fleet back. */
async function checkPostconditions(
	tx: Transaction<AppDatabase>,
	input: WriterInput,
	before: BeforeImages,
): Promise<void> {
	for (const planned of input.plan.apps) {
		const seq = planned.baseSeq + 1;
		const loaded = await loadAppInTransaction(tx, planned.appId);
		if (loaded === null) fail(`app ${planned.appId} no longer loads`);
		if (loaded.mutation_seq !== seq) {
			fail(`app ${planned.appId} is not at its planned sequence`);
		}
		const doc = hydratePersistedBlueprint(loaded.blueprint);
		if (canonicalJsonDigest(toPersistableDoc(doc)) !== planned.targetDigest) {
			fail(`app ${planned.appId} does not hold its planned target`);
		}
		const lookupContext = input.lookupContexts.get(planned.projectId);
		if (lookupContext === undefined) {
			fail(`app ${planned.appId}'s Project has no lookup context`);
		}
		if (
			exportReadinessFindings(
				doc,
				lookupContext,
				input.mediaManifests.get(planned.projectId),
			).length > 0
		) {
			fail(`app ${planned.appId} is not ready to export`);
		}
		await loadCanonicalBlueprintAtSequence(tx, {
			appId: planned.appId,
			seq,
			expectedDigest: planned.targetDigest,
		});
		if (roundTripFailures(doc, { lookup: lookupContext }) > 0) {
			fail(`an expression of app ${planned.appId} does not survive its print`);
		}
		const schemas = await sql<{ case_type: string; schema_text: string }>`
			SELECT case_type, schema::text AS schema_text FROM case_type_schemas
			WHERE app_id = ${planned.appId} AND is_active
		`.execute(tx);
		const derived = plannedSchemaChanges(
			toPersistableDoc(doc),
			new Map(schemas.rows.map((row) => [row.case_type, row.schema_text])),
			new Set(
				planned.schemaChanges
					.filter((change) => change.source === "declared")
					.map((change) => JSON.stringify([change.caseType, change.property])),
			),
		);
		if (
			derived.unplanned > 0 ||
			schemaChangesKey(derived.changes) !==
				schemaChangesKey(planned.schemaChanges)
		) {
			fail(
				`app ${planned.appId}'s derived case schemas differ from its stored ones by more than the plan's changes`,
			);
		}
	}
	const after = await captureImages(tx);
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
	if (
		after.mutationEvents.count !== "0" ||
		BigInt(after.archivedEvents.count) !==
			BigInt(before.archivedEvents.count) +
				BigInt(before.mutationEvents.count) ||
		BigInt(after.archivedEvents.bytes) !==
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
	const notices = await sql<{ app_id: string; count: string }>`
		SELECT app_id, count(*)::text AS count FROM app_migration_notices
		WHERE cutover = ${CUTOVER}
		GROUP BY app_id
	`.execute(tx);
	const noticeCounts = new Map(
		notices.rows.map((row) => [row.app_id, Number(row.count)]),
	);
	for (const planned of input.plan.apps) {
		const expected =
			(input.apps.get(planned.appId)?.noticeEntries.length ?? 0) > 0 ? 1 : 0;
		if ((noticeCounts.get(planned.appId) ?? 0) !== expected) {
			fail(`app ${planned.appId} does not hold exactly its planned notice`);
		}
		noticeCounts.delete(planned.appId);
	}
	if (noticeCounts.size > 0) {
		fail("a notice row names an app the plan does not hold");
	}
}

// ── The transaction ─────────────────────────────────────────────────

/**
 * Run the fleet transaction for a plan with no blocker. Returns the report of
 * a committed execute run or a rolled-back rehearsal; throws
 * `CutoverStoppedError` when a check refuses before any write, and any other
 * error after rolling the whole fleet back.
 */
export async function runFleetTransaction(
	db: Kysely<AppDatabase>,
	options: WriterOptions,
): Promise<WriterReport> {
	const { input } = options;
	if (input.plan.apps.some((app) => app.blockers.length > 0)) {
		throw new CutoverStoppedError(
			"blocker",
			"The plan holds a blocker, so the cutover writes nothing. Resolve each by its remedy and build the plan again.",
		);
	}
	for (const planned of input.plan.apps) {
		if (!input.apps.has(planned.appId)) {
			throw new CutoverStoppedError(
				"blocker",
				`App ${planned.appId} has no target to write, so the cutover writes nothing. Build the plan again.`,
			);
		}
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
			// 1. The cutover's lock, the lock timeout and the WAL position.
			const lsn = await timed("lock", async () => {
				/* The timeout comes first so it bounds the cutover's own lock too:
				 * a second run waits 15 seconds for the first, then stops. */
				await sql`SET LOCAL lock_timeout = '15s'`.execute(tx);
				try {
					await sql`SELECT pg_advisory_xact_lock(hashtextextended(${CUTOVER_LOCK_KEY}, 0))`.execute(
						tx,
					);
				} catch (error) {
					if ((error as { code?: unknown })?.code === LOCK_NOT_AVAILABLE) {
						throw new CutoverLockTimeoutError(
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
			// 2. The blocking scan under the locks.
			await timed("blocking-scan", () => blockingScan(tx, input.plan));
			// 3. Already applied, again.
			await timed("already-applied", async () => {
				if ((await markedAppCount(tx)) > 0) {
					throw new CutoverStoppedError(
						"already-applied",
						"Another run established this cutover's horizon after this one started, so it stopped with nothing written.",
					);
				}
			});
			// The ledgered DDL, now that nothing before the writes can stop:
			// it commits with the fleet or rolls back with it.
			const migrationsApplied = await timed("ledger", async () => {
				let applied: readonly string[];
				try {
					applied = (
						await runCaseStoreMigrationsWithReport(
							tx as unknown as Kysely<unknown>,
						)
					).appliedMigrationNames;
				} catch (error) {
					throw new CutoverLedgerError(
						"A ledgered migration failed inside the fleet transaction, so the whole fleet rolled back with nothing written, the migration included.",
						{ cause: error },
					);
				}
				/* Kysely's migration lock sets its own transaction-local lock
				 * timeout; every later statement keeps the cutover's. */
				await sql`SET LOCAL lock_timeout = '15s'`.execute(tx);
				return applied;
			});
			// 4. Before-images, then step 2's event archive, verbatim.
			const before = await timed("archive-events", async () => {
				const images = await captureImages(tx);
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
			// 5. Clear live streams.
			await timed("clear-streams", async () => {
				await sql`
					UPDATE threads SET active_stream_id = NULL, active_holder_nonce = NULL
					WHERE active_stream_id IS NOT NULL OR active_holder_nonce IS NOT NULL
				`.execute(tx);
				await sql`DELETE FROM chat_stream_chunks`.execute(tx);
				await sql`DELETE FROM presence`.execute(tx);
			});
			// 6. Abandon private work.
			const abandoned = await timed("private-work", () =>
				abandonPrivateWork(tx),
			);
			// 7. Each app, in id order.
			await timed("apps", async () => {
				for (const planned of input.plan.apps) {
					const app = input.apps.get(planned.appId);
					if (app === undefined) fail(`app ${planned.appId} has no target`);
					await writeApp(tx, app);
				}
			});
			// 8. Notices.
			const noticesWritten = await timed("notices", () =>
				writeNotices(tx, input),
			);
			// 9. Postconditions.
			await timed("postconditions", () =>
				checkPostconditions(tx, input, before),
			);
			// 10. Size and WAL, then each app's stream poke; commit or roll back.
			const growth = await timed("finish", async () => {
				const row = await sql<{ size: string; wal: string }>`
					SELECT pg_database_size(current_database())::text AS size,
						pg_wal_lsn_diff(pg_current_wal_lsn(), ${lsn}::pg_lsn)::text AS wal
				`.execute(tx);
				if (options.mode === "execute") {
					for (const planned of input.plan.apps) {
						await notifyAppStream(tx, planned.appId, planned.baseSeq + 1);
					}
				}
				return {
					databaseBytes: Number(row.rows[0]?.size ?? "0"),
					walBytes: Number(row.rows[0]?.wal ?? "0"),
				};
			});
			const report: WriterReport = {
				mode: options.mode,
				durations,
				...growth,
				migrationsApplied,
				appsWritten: input.plan.apps.length,
				noticesWritten,
				eventsArchived: Number(before.mutationEvents.count),
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
