/**
 * The platforms cutover's one fleet transaction (part 09 §9) and its
 * postconditions (§10).
 *
 * One transaction for the whole fleet, so any failure rolls everything back,
 * the DDL included: the ledger's two phases run inside it
 * (`./ledger.ts::applyLedgerTo`), the backfill writes every ready media row's
 * format between them, and each changed app is written by the production
 * synthetic writer (`lib/db/apps.ts::appendSyntheticBatchInTransaction`),
 * whose diff, reducer, gate, media admission and edge writers do the writing.
 * The cutover writes no blueprint row and no case-store row by hand.
 *
 * Under `--rehearse` the transaction runs whole and ends in a sentinel
 * rollback, as the runtime database probe does, so a rehearsal leaves
 * nothing, the DDL included.
 */

import { type Kysely, sql, type Transaction } from "kysely";
import { loadCanonicalBlueprintAtSequence } from "@/lib/agent/change-set/baseLoader";
import { appendSyntheticBatchInTransaction } from "@/lib/db/apps";
import {
	blueprintMediaRequirements,
	loadAppInTransaction,
} from "@/lib/db/canonicalCommitKernel";
import { lockAndValidateMediaReferences } from "@/lib/db/mediaAssets";
import type { AppDatabase } from "@/lib/db/pg";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
import type { BlueprintDoc } from "@/lib/domain";
import { migrationNoticeEntriesSchema } from "@/lib/notices/migrationNotice";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { holderCensusIsEmpty, readHolderCensus } from "./holders";
import {
	applyLedgerTo,
	CutoverLockTimeoutError,
	LOCK_NOT_AVAILABLE,
	PHASE_ONE_TARGET,
	readMigrationLedger,
	STACK_MIGRATIONS,
	VALIDATED_MIGRATION,
} from "./ledger";
import { CLASSIFIED_KINDS, mediaRowDigest } from "./media";
import { readAppBase, readReadyMediaRows } from "./source";
import {
	ACTOR_ID,
	ACTOR_REASON,
	batchIdOf,
	CUTOVER,
	compareText,
	type PlatformsCutoverPlan,
} from "./types";

/** The numbered steps of §9, in order. */
export const WRITER_STEPS = [
	"lock",
	"blocking-scan",
	"already-applied",
	"before-images",
	"ledger-phase-1",
	"backfill",
	"apps",
	"notices",
	"ledger-phase-2",
	"postconditions",
	"finish",
] as const;
export type WriterStep = (typeof WRITER_STEPS)[number];

/** The advisory lock key every run of this cutover takes first. */
export const CUTOVER_LOCK_KEY = "cutover:hq-round-trip-platforms";

/** Why the writer stopped before anything was written. */
export type WriterStopCode =
	| "app-changed"
	| "media-changed"
	| "holder"
	| "already-applied"
	| "blocker";

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

function fail(message: string): never {
	throw new CutoverPostconditionError(
		`The cutover's postcondition failed, so nothing was written: ${message}`,
	);
}

/** Everything the fleet transaction writes, decided before it opens. */
export interface WriterInput {
	readonly plan: PlatformsCutoverPlan;
	/** The hydrated target of every app the plan writes, by app id. */
	readonly targets: ReadonlyMap<string, BlueprintDoc>;
}

export interface WriterOptions {
	readonly mode: "rehearse" | "execute";
	readonly input: WriterInput;
	/** Tests only: throw right after the named step, to prove a failure anywhere leaves nothing. */
	readonly failAfter?: WriterStep;
}

export interface WriterReport {
	readonly mode: "rehearse" | "execute";
	/** Milliseconds each numbered step took. */
	readonly durations: Readonly<Record<WriterStep, number>>;
	/** `pg_database_size` before the commit or the rollback. */
	readonly databaseBytes: number;
	/** WAL written from step 1 to step 11. */
	readonly walBytes: number;
	/** The database's growth over the transaction. */
	readonly databaseGrowthBytes: number;
	readonly migrationsApplied: readonly string[];
	readonly mediaRowsBackfilled: number;
	readonly appsWritten: number;
	readonly noticesWritten: number;
}

class RehearsalRollback extends Error {
	constructor(readonly report: WriterReport) {
		super("rehearsal rollback");
	}
}

class InjectedWriterFailure extends Error {
	readonly name = "InjectedWriterFailure";
}

// ── Step 2: the blocking scan under the locks ───────────────────────

async function blockingScan(
	tx: Transaction<AppDatabase>,
	plan: PlatformsCutoverPlan,
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
	await tx
		.selectFrom("media_assets")
		.select("id")
		.where("status", "=", "ready")
		.where("kind", "in", [...CLASSIFIED_KINDS])
		.orderBy("id")
		.forUpdate()
		.execute();
	const planned = plan.apps.map((app) => app.appId);
	const present = locked.map((app) => app.id).sort(compareText);
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
	const rows = await readReadyMediaRows(tx);
	const plannedMedia = new Map(
		plan.media.map((media) => [media.assetId, media.rowDigest]),
	);
	if (
		rows.length !== plannedMedia.size ||
		rows.some((row) => plannedMedia.get(row.id) !== mediaRowDigest(row))
	) {
		throw new CutoverStoppedError(
			"media-changed",
			"A ready media row appeared, left or changed after the plan was built, so the cutover stopped with nothing written. Build the plan again.",
		);
	}
	if (!holderCensusIsEmpty(await readHolderCensus(tx))) {
		throw new CutoverStoppedError(
			"holder",
			"A run still holds an app or a design session, or a hold is unsettled, so the cutover stopped with nothing written. Settle the holders and try again.",
		);
	}
}

// ── Step 4: before-images ───────────────────────────────────────────

interface BeforeImages {
	readonly schemas: readonly string[];
	readonly cases: ReadonlyMap<string, string>;
}

async function captureImages(
	tx: Transaction<AppDatabase>,
): Promise<BeforeImages> {
	const schemas = await sql<{ row_text: string }>`
		SELECT s::text AS row_text FROM case_type_schemas AS s
		ORDER BY s.app_id, s.case_type, s::text
	`.execute(tx);
	const cases = await sql<{ app_id: string; count: string }>`
		SELECT app_id, count(*)::text AS count FROM cases GROUP BY app_id
	`.execute(tx);
	return {
		schemas: schemas.rows.map((row) => row.row_text),
		cases: new Map(cases.rows.map((row) => [row.app_id, row.count])),
	};
}

// ── Step 6: the backfill ────────────────────────────────────────────

async function backfill(
	tx: Transaction<AppDatabase>,
	plan: PlatformsCutoverPlan,
): Promise<number> {
	if (plan.media.length === 0) return 0;
	const result = await sql`
		UPDATE media_assets AS row SET media_format = planned.format
		FROM unnest(${plan.media.map((media) => media.assetId)}::text[],
			${plan.media.map((media) => media.format)}::text[]) AS planned(id, format)
		WHERE row.id = planned.id AND row.status = 'ready'
	`.execute(tx);
	const updated = Number(result.numAffectedRows ?? BigInt(0));
	if (updated !== plan.media.length) {
		fail(
			`the backfill wrote ${updated} media rows where the plan holds ${plan.media.length}`,
		);
	}
	return updated;
}

// ── Step 7: each changed app ────────────────────────────────────────

async function writeApps(
	tx: Transaction<AppDatabase>,
	input: WriterInput,
): Promise<number> {
	let written = 0;
	for (const app of input.plan.apps) {
		if (app.targetDigest === null) continue;
		const target = input.targets.get(app.appId);
		if (target === undefined) fail(`app ${app.appId} has no target to write`);
		const result = await appendSyntheticBatchInTransaction(tx, {
			appId: app.appId,
			expectedBaseSeq: app.baseSeq,
			targetDoc: toPersistableDoc(target),
			batchId: batchIdOf(app.appId),
			authority: { kind: "system", actorId: ACTOR_ID, reason: ACTOR_REASON },
		});
		if (result.kind !== "committed" || result.seq !== app.baseSeq + 1) {
			fail(
				`app ${app.appId} was ${result.kind} at sequence ${result.seq} where the plan writes it at ${app.baseSeq + 1}`,
			);
		}
		written += 1;
	}
	return written;
}

// ── Step 8: notices ─────────────────────────────────────────────────

async function writeNotices(
	tx: Transaction<AppDatabase>,
	plan: PlatformsCutoverPlan,
): Promise<number> {
	let written = 0;
	for (const app of plan.apps) {
		if (app.notice.length === 0) continue;
		const entries = migrationNoticeEntriesSchema.parse(app.notice);
		await sql`
			INSERT INTO app_migration_notices (app_id, cutover, entries)
			VALUES (${app.appId}, ${CUTOVER}, ${JSON.stringify(entries)}::jsonb)
		`.execute(tx);
		written += 1;
	}
	return written;
}

// ── Step 10: postconditions ─────────────────────────────────────────

async function checkPostconditions(
	tx: Transaction<AppDatabase>,
	plan: PlatformsCutoverPlan,
	before: BeforeImages,
): Promise<void> {
	for (const app of plan.apps) {
		const loaded = await loadAppInTransaction(tx, app.appId);
		if (loaded === null) fail(`app ${app.appId} no longer loads`);
		const doc = hydratePersistedBlueprint(loaded.blueprint);
		const expected = app.targetDigest ?? app.baseDigest;
		if (canonicalJsonDigest(toPersistableDoc(doc)) !== expected) {
			fail(`app ${app.appId} does not hold its planned document`);
		}
		await lockAndValidateMediaReferences(
			tx,
			app.projectId,
			blueprintMediaRequirements(doc),
		);
		if (app.targetDigest === null) continue;
		const seq = app.baseSeq + 1;
		const change = await tx
			.selectFrom("app_changes")
			.select(["batch_id", "actor_id", "kind", "run_id"])
			.where("app_id", "=", app.appId)
			.where("seq", "=", seq)
			.executeTakeFirst();
		if (
			change === undefined ||
			change.batch_id !== batchIdOf(app.appId) ||
			change.actor_id !== ACTOR_ID ||
			change.kind !== "blueprint-migration" ||
			change.run_id !== null
		) {
			fail(`app ${app.appId} has no cutover change at sequence ${seq}`);
		}
		await loadCanonicalBlueprintAtSequence(tx, {
			appId: app.appId,
			seq,
			expectedDigest: app.targetDigest,
		});
	}
	const media = await tx
		.selectFrom("media_assets")
		.select(["id", sql<string | null>`media_format`.as("media_format")])
		.where("status", "=", "ready")
		.where("kind", "in", [...CLASSIFIED_KINDS])
		.execute();
	const formats = new Map(plan.media.map((row) => [row.assetId, row.format]));
	if (
		media.length !== formats.size ||
		media.some((row) => formats.get(row.id) !== row.media_format)
	) {
		fail("a ready media row does not hold its planned format");
	}
	const constraint = await sql<{ convalidated: boolean }>`
		SELECT convalidated FROM pg_constraint
		WHERE conname = 'media_assets_ready_media_format'
	`.execute(tx);
	if (constraint.rows[0]?.convalidated !== true) {
		fail("media_assets_ready_media_format is not validated");
	}
	const column = await sql<{ present: boolean }>`
		SELECT EXISTS (
			SELECT 1 FROM information_schema.columns
			WHERE table_name = 'app_deployments' AND column_name = 'target_web_apps_enabled'
		) AS present
	`.execute(tx);
	if (column.rows[0]?.present !== false) {
		fail("app_deployments still has target_web_apps_enabled");
	}
	const size = await sql<{ definition: string }>`
		SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
		WHERE conname = 'form_attachments_size_check'
	`.execute(tx);
	if (!(size.rows[0]?.definition ?? "").includes("15727616")) {
		fail("form_attachments_size_check is not the capture size check");
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
		[...after.cases].some(([appId, count]) => before.cases.get(appId) !== count)
	) {
		fail("an app's count of cases changed");
	}
	const notices = await sql<{ app_id: string; count: string }>`
		SELECT app_id, count(*)::text AS count FROM app_migration_notices
		WHERE cutover = ${CUTOVER}
		GROUP BY app_id
	`.execute(tx);
	const noticeCounts = new Map(
		notices.rows.map((row) => [row.app_id, Number(row.count)]),
	);
	for (const app of plan.apps) {
		const expected = app.notice.length > 0 ? 1 : 0;
		if ((noticeCounts.get(app.appId) ?? 0) !== expected) {
			fail(`app ${app.appId} does not hold exactly its planned notice`);
		}
		noticeCounts.delete(app.appId);
	}
	if (noticeCounts.size > 0) {
		fail("a notice row names an app the plan does not hold");
	}
	const ledger = await readMigrationLedger(tx);
	if (
		STACK_MIGRATIONS.some((name) => ledger.pendingMigrations.includes(name))
	) {
		fail("the ledger does not hold the five migrations of the window");
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
			const start = await timed("lock", async () => {
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
				const row = await sql<{ lsn: string; size: string }>`
					SELECT pg_current_wal_lsn()::text AS lsn,
						pg_database_size(current_database())::text AS size
				`.execute(tx);
				return {
					lsn: row.rows[0]?.lsn ?? "0/0",
					size: Number(row.rows[0]?.size ?? "0"),
				};
			});
			// 2. The blocking scan under the locks.
			await timed("blocking-scan", () => blockingScan(tx, input.plan));
			// 3. Already applied, again.
			await timed("already-applied", async () => {
				if ((await readMigrationLedger(tx)).validatedApplied) {
					throw new CutoverStoppedError(
						"already-applied",
						"Another run applied this cutover after this one started, so it stopped with nothing written.",
					);
				}
			});
			// 4. Before-images.
			const before = await timed("before-images", () => captureImages(tx));
			// 5. Ledger phase 1: the first four of the stack's migrations.
			const phaseOne = await timed("ledger-phase-1", () =>
				applyLedgerTo(tx, PHASE_ONE_TARGET, {
					pending: STACK_MIGRATIONS,
					applied: STACK_MIGRATIONS.slice(0, 4),
				}),
			);
			// 6. The backfill.
			const mediaRowsBackfilled = await timed("backfill", () =>
				backfill(tx, input.plan),
			);
			// 7. Each changed app, in code-point order of id.
			const appsWritten = await timed("apps", () => writeApps(tx, input));
			// 8. Notices.
			const noticesWritten = await timed("notices", () =>
				writeNotices(tx, input.plan),
			);
			// 9. Ledger phase 2: the validation.
			const phaseTwo = await timed("ledger-phase-2", () =>
				applyLedgerTo(tx, VALIDATED_MIGRATION, {
					pending: [VALIDATED_MIGRATION],
					applied: [VALIDATED_MIGRATION],
				}),
			);
			// 10. Postconditions.
			await timed("postconditions", () =>
				checkPostconditions(tx, input.plan, before),
			);
			// 11. Size and WAL.
			const growth = await timed("finish", async () => {
				const row = await sql<{ size: string; wal: string }>`
					SELECT pg_database_size(current_database())::text AS size,
						pg_wal_lsn_diff(pg_current_wal_lsn(), ${start.lsn}::pg_lsn)::text AS wal
				`.execute(tx);
				const size = Number(row.rows[0]?.size ?? "0");
				return {
					databaseBytes: size,
					databaseGrowthBytes: size - start.size,
					walBytes: Number(row.rows[0]?.wal ?? "0"),
				};
			});
			const report: WriterReport = {
				mode: options.mode,
				durations,
				...growth,
				migrationsApplied: [...phaseOne, ...phaseTwo],
				mediaRowsBackfilled,
				appsWritten,
				noticesWritten,
			};
			// 12. A rehearsal's sentinel rollback; 13. the commit.
			if (options.mode === "rehearse") throw new RehearsalRollback(report);
			return report;
		});
	} catch (error) {
		if (error instanceof RehearsalRollback) return error.report;
		throw error;
	}
}
