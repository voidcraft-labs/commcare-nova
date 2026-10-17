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
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { extractLookupReferenceTargets } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc } from "@/lib/domain";
import { applyOrganizationCommitIntegrity } from "@/lib/organization/commitIntegrity";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { holderCensusIsEmpty, readHolderCensus } from "./holders";
import { appNoticeEntries } from "./notice";
import { rawDocumentDigest, readRawDocument } from "./oldShape";
import {
	type AppPlan,
	CUTOVER,
	type CutoverPlanBuild,
	caseSchemaDifferences,
	MARKER_ACTOR_ID,
	MARKER_BATCH_ID,
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
	"notices",
	"postconditions",
] as const;
export type WriterStep = (typeof WRITER_STEPS)[number];

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

export interface WriterReport {
	readonly mode: "rehearse" | "execute";
	/** Milliseconds each numbered step took. */
	readonly durations: Readonly<Record<WriterStep, number>>;
	/** `pg_database_size` read before the commit or the rollback. */
	readonly databaseBytes: number;
	/** WAL written from step 1 to step 11. */
	readonly walBytes: number;
	readonly appsWritten: number;
	readonly noticesWritten: number;
	readonly keyReadersWritten: number;
	readonly eventsArchived: number;
	readonly sessionsEnded: number;
}

export interface WriterOptions {
	readonly mode: "rehearse" | "execute";
	readonly build: CutoverPlanBuild;
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

/** Step 10: the notice rows and the key-readers record. */
async function writeNotices(
	tx: Transaction<AppDatabase>,
	build: CutoverPlanBuild,
): Promise<{ notices: number; keyReaders: number }> {
	let notices = 0;
	for (const app of build.plan.apps) {
		const target = build.targets.get(app.appId);
		const entries = appNoticeEntries(app, target?.raw.appName ?? "");
		if (entries.length === 0) continue;
		await sql`
			INSERT INTO app_migration_notices (app_id, cutover, entries)
			VALUES (${app.appId}, ${CUTOVER}, ${JSON.stringify(entries)}::jsonb)
		`.execute(tx);
		notices += 1;
	}
	const uses = keyReaderRows(build);
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

/** Each member, server and domain whose key the run sent, with the span of its uses. */
export function keyReaderRows(build: CutoverPlanBuild): {
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
	for (const app of build.plan.apps) {
		for (const deployment of app.deployments) {
			for (const use of deployment.keyUses) {
				const key = JSON.stringify([
					use.userId,
					deployment.server,
					deployment.domain,
				]);
				const row = rows.get(key);
				if (row === undefined) {
					rows.set(key, {
						userId: use.userId,
						server: deployment.server,
						domain: deployment.domain,
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
		}
	}
	return [...rows.entries()]
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([, row]) => row);
}

/** Step 11: the postconditions, checked inside the transaction. */
async function checkPostconditions(
	tx: Transaction<AppDatabase>,
	build: CutoverPlanBuild,
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
		const target = build.targets.get(app.appId);
		const expected =
			appNoticeEntries(app, target?.raw.appName ?? "").length > 0 ? 1 : 0;
		const notices = await sql<{ count: string }>`
			SELECT count(*)::text AS count FROM app_migration_notices
			WHERE app_id = ${app.appId} AND cutover = ${CUTOVER}
		`.execute(tx);
		if (Number(notices.rows[0]?.count ?? "0") !== expected) {
			fail(`app ${app.appId} does not hold exactly its planned notice`);
		}
	}
	for (const use of keyReaderRows(build)) {
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
	const { build } = options;
	if (
		build.plan.projectBlockers.length > 0 ||
		build.plan.apps.some((app) => app.blockers.length > 0)
	) {
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
			const written = await timed("notices", () => writeNotices(tx, build));
			const growth = await timed("postconditions", async () => {
				await checkPostconditions(tx, build, before);
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
