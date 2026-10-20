/**
 * The expressions cutover's fleet transaction over the frozen pre-step
 * fixtures (part 09 §15, the writer row): from `main`'s migration prefix,
 * where the run applies the stack's migrations itself, and in a migrated
 * database, for what it writes, what it refuses, and that nothing it refuses
 * or rolls back leaves a trace.
 */

import {
	Kysely,
	PostgresAdapter,
	PostgresDialect,
	type PostgresPool,
	sql,
} from "kysely";
import { Client, Pool } from "pg";
import { beforeEach, describe, expect, it } from "vitest";
import { loadCanonicalBlueprintAtSequence } from "@/lib/agent/change-set/baseLoader";
import { caseStoreMigrations } from "@/lib/case-store/migrations";
import {
	type AppStateTestDb,
	setupAppStateTestDb,
} from "@/lib/db/__tests__/appStateTestDb";
import { loadAppInTransaction } from "@/lib/db/canonicalCommitKernel";
import type { AppDatabase } from "@/lib/db/pg";
import { runCanonicalRuntimeDatabaseProbe } from "@/lib/db/runtimeDatabaseProbe";
import { readPlannedFleet } from "../fleet";
import { errorClassOf, runMigrate, writerInputOf } from "../run";
import {
	CutoverLedgerError,
	CutoverLockTimeoutError,
	type CutoverStoppedError,
	runFleetTransaction,
	WRITER_STEPS,
} from "../writer";
import {
	databaseImage,
	fixtureApp,
	readFixtureManifest,
	seedPreStepApp,
	seedStoredSchemas,
	writableFixtureIds,
} from "./postgresSeed";

/** The stack's one migration; `main`'s ledger ends before it. */
const FIRST_STACK_MIGRATION =
	"20261020000000_hq_round_trip_expressions_fold_horizon";
const MARKER_BATCH_ID = "fold-baseline:hq-round-trip-expressions";
const MARKER_ACTOR_ID = "system:hq-round-trip-expressions";

/** The harness of the describe block running the current test. */
let h: AppStateTestDb;

function useHarness(prefix: string, caseStoreMigrationsBefore?: string): void {
	const harness = setupAppStateTestDb(prefix, {
		authSchema: "migrated",
		...(caseStoreMigrationsBefore !== undefined && {
			caseStoreMigrationsBefore,
		}),
	});
	beforeEach(() => {
		h = harness;
	});
}

const OWNER = "owner-expressions-cutover";
const PROJECT = "project-expressions-cutover";

/**
 * One fixture as an app of the shared Project, with the stored case schemas
 * its pre-step deploy left: the plan's target derivation with the plan's own
 * changes undone (`seedStoredSchemas`).
 */
async function seedApp(
	id: string,
	appId: string,
	options: { deletedAt?: Date; caseTypesNull?: boolean } = {},
): Promise<void> {
	await seedPreStepApp(h.db(), {
		...fixtureApp(id, { appId, projectId: PROJECT, owner: OWNER }),
		...options,
	});
	const planned = await readPlannedFleet(h.db(), { appId });
	const target = planned.targets.get(appId);
	const app = planned.plan.apps.find((candidate) => candidate.appId === appId);
	if (target === undefined || app === undefined) {
		throw new Error(`Fixture ${id} has no target to derive its schemas from.`);
	}
	await seedStoredSchemas(h.db(), appId, target, app.schemaChanges);
}

interface SeededFleet {
	readonly appIds: readonly string[];
	readonly deletedAppId: string;
}

/**
 * Every writable fixture as an app, `form-logic` among them with NULL
 * `case_types`, and one more app soft-deleted.
 */
async function seedFleet(): Promise<SeededFleet> {
	await h.seedProjectMember(OWNER, PROJECT, "owner");
	const appIds: string[] = [];
	for (const [index, id] of writableFixtureIds().entries()) {
		const appId = `app-${String(index).padStart(2, "0")}-${id}`;
		await seedApp(id, appId);
		appIds.push(appId);
	}
	const deletedAppId = "app-99-deleted";
	await seedApp("choices", deletedAppId, {
		deletedAt: new Date("2026-10-01T00:00:00Z"),
	});
	appIds.push(deletedAppId);
	return { appIds, deletedAppId };
}

async function seedMutationEvents(appId: string): Promise<void> {
	for (const seq of [1, 2]) {
		await sql`
			INSERT INTO events (app_id, run_id, ts, seq, source, kind, event)
			VALUES (${appId}, 'run-history', ${1_700_000_000_000 + seq}, ${seq}, 'chat', 'mutation',
				${JSON.stringify({
					kind: "mutation",
					runId: "run-history",
					ts: 1_700_000_000_000 + seq,
					seq,
					source: "chat",
					actor: "agent",
					mutation: { kind: "retired-vocabulary", xpath: { parts: [] } },
				})}::jsonb)
		`.execute(h.db());
	}
}

/** The fleet line's `planDigest` of a run. */
function planDigestOf(result: Awaited<ReturnType<typeof runMigrate>>): string {
	return result.report.all().find((line) => line.section === "fleet")
		?.planDigest as string;
}

/** The advisory locks any session holds in this test's database. */
async function advisoryLockCount(): Promise<number> {
	const observer = new Client({ connectionString: h.uri() });
	await observer.connect();
	try {
		const row = await observer.query<{ held: string }>(`
			SELECT count(*)::text AS held FROM pg_locks
			WHERE locktype = 'advisory'
				AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
		`);
		return Number(row.rows[0]?.held ?? "0");
	} finally {
		await observer.end();
	}
}

/** What the rejected promise threw, for assertions on its fields. */
async function rejectionOf(run: Promise<unknown>): Promise<unknown> {
	try {
		await run;
	} catch (error) {
		return error;
	}
	throw new Error("The run was expected to stop, and it finished.");
}

async function appliedMigrations(db: Kysely<AppDatabase>): Promise<string[]> {
	const rows = await sql<{ name: string }>`
		SELECT name FROM kysely_migration ORDER BY name
	`.execute(db);
	return rows.rows.map((row) => row.name);
}

describe("the fleet transaction from main's migration prefix", () => {
	useHarness("hq_expr_prefix_", FIRST_STACK_MIGRATION);

	it("applies the DDL only inside the committed fleet transaction: a dry run, a rehearsal and every stop leave the ledger as main has it", async () => {
		const fleet = await seedFleet();
		const ledger = await appliedMigrations(h.db());
		expect(ledger).not.toContain(FIRST_STACK_MIGRATION);

		const dryRun = await runMigrate(h.db(), { mode: "dry-run" });
		expect(dryRun.outcome).toEqual({ outcome: "ok" });
		expect(
			dryRun.report.all().find((line) => line.section === "fleet")?.ledger,
		).toEqual({
			foldHorizonApplied: false,
			pendingMigrations: [FIRST_STACK_MIGRATION],
		});
		const digest = planDigestOf(dryRun);
		expect(digest).toMatch(/^[0-9a-f]{64}$/);

		const image = await databaseImage(h.db());
		const rehearsal = await runMigrate(h.db(), { mode: "rehearse" });
		expect(rehearsal.outcome).toEqual({ outcome: "ok" });
		expect(planDigestOf(rehearsal)).toBe(digest);
		expect(
			rehearsal.report.all().find((line) => line.section === "writer")
				?.migrationsApplied,
		).toEqual([FIRST_STACK_MIGRATION]);
		expect(await appliedMigrations(h.db())).toEqual(ledger);
		expect(await databaseImage(h.db())).toBe(image);

		// A digest stop, and a failure right after the DDL ran in the
		// transaction, leave no migration main does not hold.
		const refused = await runMigrate(h.db(), {
			mode: "execute",
			expectPlanDigest: "0".repeat(64),
		});
		expect(refused.outcome).toEqual({
			outcome: "stopped",
			stoppedBy: ["digest"],
		});
		const printed: string[] = [];
		await expect(
			runMigrate(h.db(), {
				mode: "execute",
				expectPlanDigest: digest,
				failAfter: "ledger",
				onLine: (line) => printed.push(line.section),
			}),
		).rejects.toThrow("injected failure after ledger");
		expect(printed[0]).toBe("fleet");
		expect(printed.at(-1)).toBe("outcome");
		expect(await appliedMigrations(h.db())).toEqual(ledger);
		expect(await databaseImage(h.db())).toBe(image);

		const execute = await runMigrate(h.db(), {
			mode: "execute",
			expectPlanDigest: digest,
		});
		expect(execute.outcome).toEqual({ outcome: "ok" });
		expect(await appliedMigrations(h.db())).toContain(FIRST_STACK_MIGRATION);
		const markers = await sql<{ app_id: string }>`
			SELECT app_id FROM app_changes WHERE batch_id = ${MARKER_BATCH_ID}
			ORDER BY app_id
		`.execute(h.db());
		expect(markers.rows.map((row) => row.app_id)).toEqual(
			[...fleet.appIds].sort(),
		);
	}, 120_000);
});

describe("the fleet transaction over the frozen fixtures", () => {
	/* The production database lacks exactly the fold-horizon migration, and
	 * the writer refuses any other ledger, so every run starts from main's. */
	useHarness("hq_expr_writer_", FIRST_STACK_MIGRATION);

	it("establishes one horizon per app and commits only under the dry run's digest", async () => {
		const fleet = await seedFleet();
		const [eventApp] = fleet.appIds;
		if (eventApp === undefined) throw new Error("The fleet is empty.");
		await seedMutationEvents(eventApp);
		const before = await sql<{
			id: string;
			updated_at: Date;
			mutation_seq: string;
			case_types: unknown;
		}>`
			SELECT id, updated_at, mutation_seq::text AS mutation_seq, case_types
			FROM apps ORDER BY id
		`.execute(h.db());
		const schemasBefore = await sql<{ row: string }>`
			SELECT s::text AS row FROM case_type_schemas AS s ORDER BY app_id, case_type
		`.execute(h.db());
		const casesBefore = await sql<{ row: string }>`
			SELECT c::text AS row FROM cases AS c ORDER BY app_id, case_id
		`.execute(h.db());

		const dryRun = await runMigrate(h.db(), { mode: "dry-run" });
		expect(dryRun.outcome).toEqual({ outcome: "ok" });
		const digest = planDigestOf(dryRun);

		const execute = await runMigrate(h.db(), {
			mode: "execute",
			expectPlanDigest: digest,
		});
		expect(execute.outcome).toEqual({ outcome: "ok" });
		expect(planDigestOf(execute)).toBe(digest);

		const after = await sql<{
			id: string;
			updated_at: Date;
			mutation_seq: string;
		}>`
			SELECT id, updated_at, mutation_seq::text AS mutation_seq FROM apps ORDER BY id
		`.execute(h.db());
		// Nobody edited an app: `updated_at` stands, and the horizon is `+1`.
		expect(after.rows.map((row) => row.updated_at.toISOString())).toEqual(
			before.rows.map((row) => row.updated_at.toISOString()),
		);
		expect(after.rows.map((row) => Number(row.mutation_seq))).toEqual(
			before.rows.map((row) => Number(row.mutation_seq) + 1),
		);
		// The app with NULL case types keeps them NULL.
		const nullCaseTypes = before.rows
			.filter((row) => row.case_types === null)
			.map((row) => row.id);
		expect(nullCaseTypes.length).toBeGreaterThan(0);
		const stillNull = await sql<{ id: string }>`
			SELECT id FROM apps WHERE case_types IS NULL ORDER BY id
		`.execute(h.db());
		expect(stillNull.rows.map((row) => row.id)).toEqual(nullCaseTypes);

		const markers = await sql<{ app_id: string; seq: string }>`
			SELECT app_id, seq::text AS seq FROM app_changes
			WHERE batch_id = ${MARKER_BATCH_ID} AND actor_id = ${MARKER_ACTOR_ID}
				AND run_id IS NULL AND kind = 'fold-baseline' AND mutations = '[]'::jsonb
			ORDER BY app_id
		`.execute(h.db());
		expect(markers.rows).toEqual(
			after.rows.map((row) => ({ app_id: row.id, seq: row.mutation_seq })),
		);

		// The stored schemas and cases are byte-identical: the drift writer,
		// not this transaction, converges the schemas after the deploy.
		const schemasAfter = await sql<{ row: string }>`
			SELECT s::text AS row FROM case_type_schemas AS s ORDER BY app_id, case_type
		`.execute(h.db());
		expect(schemasAfter.rows).toEqual(schemasBefore.rows);
		const casesAfter = await sql<{ row: string }>`
			SELECT c::text AS row FROM cases AS c ORDER BY app_id, case_id
		`.execute(h.db());
		expect(casesAfter.rows).toEqual(casesBefore.rows);

		// Every app loads under the head schema, and folds from its new
		// baseline to its planned target.
		await h.withTransaction(async (tx) => {
			for (const row of after.rows) {
				expect(await loadAppInTransaction(tx, row.id)).not.toBeNull();
				const loaded = await loadCanonicalBlueprintAtSequence(tx, {
					appId: row.id,
					seq: Number(row.mutation_seq),
					expectedDigest: null,
				});
				expect(loaded.doc).toBeDefined();
			}
		});

		// The mutation events are archived, byte for byte inside `archived`.
		const events = await sql<{ kind: string; archived: string }>`
			SELECT kind, (event -> 'archived')::text AS archived FROM events ORDER BY id
		`.execute(h.db());
		expect(events.rows.map((row) => row.kind)).toEqual([
			"archived-mutation",
			"archived-mutation",
		]);
		expect(JSON.parse(events.rows[0]?.archived ?? "null")).toMatchObject({
			kind: "mutation",
			mutation: { kind: "retired-vocabulary" },
		});

		// Each fixture's app holds a notice with every document reason its
		// fixture witnesses, and an app with no entry holds none.
		const notices = await sql<{
			app_id: string;
			cutover: string;
			entries: { kind: string; reason: string }[];
		}>`SELECT app_id, cutover, entries FROM app_migration_notices`.execute(
			h.db(),
		);
		expect(
			notices.rows.every((row) => row.cutover === "hq-round-trip-expressions"),
		).toBe(true);
		const manifest = readFixtureManifest();
		for (const [index, id] of writableFixtureIds().entries()) {
			const appId = fleet.appIds[index];
			const written = notices.rows
				.filter((row) => row.app_id === appId)
				.flatMap((row) => row.entries)
				.map((entry) => entry.reason);
			const witnessed =
				manifest.find((fixture) => fixture.id === id)?.reasons ?? [];
			expect(written, id).toEqual(expect.arrayContaining([...witnessed]));
		}
		expect(
			new Set(notices.rows.map((row) => row.app_id)).size,
			"one notice row per app at most",
		).toBe(notices.rows.length);

		const role = await sql<{ role: string }>`
			SELECT current_user AS role
		`.execute(h.db());
		const probe = await runCanonicalRuntimeDatabaseProbe(
			h.db() as unknown as Kysely<unknown>,
			role.rows[0]?.role ?? "",
		);
		expect(probe.findingCount).toBe(0);

		for (const mode of ["dry-run", "rehearse", "settle-holders"] as const) {
			const again = await runMigrate(h.db(), { mode });
			expect(again.outcome).toEqual({ outcome: "already-applied" });
		}
		const again = await runMigrate(h.db(), {
			mode: "execute",
			expectPlanDigest: digest,
		});
		expect(again.outcome).toEqual({ outcome: "already-applied" });
	}, 120_000);

	it("refuses a digest the rebuilt plan does not hold, with nothing written", async () => {
		await seedFleet();
		const image = await databaseImage(h.db());
		const refused = await runMigrate(h.db(), {
			mode: "execute",
			expectPlanDigest: "0".repeat(64),
		});
		expect(refused.outcome).toEqual({
			outcome: "stopped",
			stoppedBy: ["digest"],
		});
		expect(refused.exitCode).toBe(1);
		expect(await databaseImage(h.db())).toBe(image);
	}, 120_000);

	it("stops within the cutover's lock timeout while another run holds Kysely's migration lock, with nothing written", async () => {
		await seedFleet();
		const input = writerInputOf(await readPlannedFleet(h.db()));
		const image = await databaseImage(h.db());
		/* Kysely's own adapter takes its own lock on one connection, as a
		 * migrate Job or the auth migrator would. */
		const holder = new Kysely<unknown>({
			dialect: new PostgresDialect({
				pool: new Pool({
					connectionString: h.uri(),
					max: 1,
				}) as unknown as PostgresPool,
			}),
		});
		const adapter = new PostgresAdapter();
		const lockOptions = {
			lockTable: "kysely_migration_lock",
			lockRowId: "migration_lock",
		};
		try {
			await holder.connection().execute(async (connection) => {
				await adapter.acquireMigrationLock(connection, lockOptions);
				try {
					const started = performance.now();
					const error = await rejectionOf(
						runFleetTransaction(h.db(), { mode: "execute", input }),
					);
					const elapsed = performance.now() - started;
					expect(error).toBeInstanceOf(CutoverLockTimeoutError);
					expect(errorClassOf(error)).toBe("lock-timeout");
					expect(elapsed).toBeGreaterThanOrEqual(14_000);
					expect(elapsed).toBeLessThan(60_000);
				} finally {
					await adapter.releaseMigrationLock(connection, lockOptions);
				}
			});
		} finally {
			await holder.destroy();
		}
		expect(await appliedMigrations(h.db())).not.toContain(
			FIRST_STACK_MIGRATION,
		);
		expect(await databaseImage(h.db())).toBe(image);
	}, 120_000);

	it("stops with nothing written and no migration applied when the ledger lacks more than the fold horizon", async () => {
		await seedFleet();
		const input = writerInputOf(await readPlannedFleet(h.db()));
		const [lastOfMain] = Object.keys(caseStoreMigrations)
			.filter((name) => name < FIRST_STACK_MIGRATION)
			.sort()
			.reverse();
		if (lastOfMain === undefined) throw new Error("main has no migration.");
		await sql`DELETE FROM kysely_migration WHERE name = ${lastOfMain}`.execute(
			h.db(),
		);
		const ledger = await appliedMigrations(h.db());
		const image = await databaseImage(h.db());
		const error = await rejectionOf(
			runFleetTransaction(h.db(), { mode: "execute", input }),
		);
		expect(error).toBeInstanceOf(CutoverLedgerError);
		expect(errorClassOf(error)).toBe("ledger");
		expect((error as Error).message).toContain(
			`found ${lastOfMain}, ${FIRST_STACK_MIGRATION}`,
		);
		expect(await appliedMigrations(h.db())).toEqual(ledger);
		expect(await databaseImage(h.db())).toBe(image);
	}, 120_000);

	it("names a failed migration and its error class, rolls it back and releases Kysely's lock", async () => {
		await seedFleet();
		const input = writerInputOf(await readPlannedFleet(h.db()));
		/* The fold-horizon migration replaces two functions; the second
		 * cannot replace one that returns another type (42P13), so it fails
		 * after the first has run. */
		await sql`
			ALTER FUNCTION nova_require_app_change_fold_baseline()
				RENAME TO nova_require_app_change_fold_baseline_kept
		`.execute(h.db());
		await sql`
			CREATE FUNCTION nova_require_app_change_fold_baseline() RETURNS integer
				LANGUAGE sql AS 'SELECT 1'
		`.execute(h.db());
		const definition = () =>
			sql<{ body: string }>`
				SELECT pg_get_functiondef('nova_admit_app_change_fold_baseline_insert()'::regprocedure) AS body
			`.execute(h.db());
		const before = (await definition()).rows[0]?.body;
		const ledger = await appliedMigrations(h.db());
		const image = await databaseImage(h.db());

		const error = await rejectionOf(
			runFleetTransaction(h.db(), { mode: "execute", input }),
		);
		expect(error).toBeInstanceOf(CutoverLedgerError);
		expect((error as CutoverLedgerError).failure).toEqual({
			migrationName: FIRST_STACK_MIGRATION,
			failureClass: "DatabaseError",
			sqlState: "42P13",
		});
		expect((error as Error).message).toContain(
			`The ledgered migration ${FIRST_STACK_MIGRATION} failed`,
		);
		expect(errorClassOf(error)).toBe("ledger");

		// No session keeps Kysely's lock past the rollback.
		expect(await advisoryLockCount()).toBe(0);
		expect((await definition()).rows[0]?.body).toBe(before);
		expect(await appliedMigrations(h.db())).toEqual(ledger);
		expect(await databaseImage(h.db())).toBe(image);
	}, 120_000);

	it("stops a second run within the lock timeout, with nothing written", async () => {
		await seedFleet();
		const input = writerInputOf(await readPlannedFleet(h.db()));
		const image = await databaseImage(h.db());
		const firstRun = new Client({ connectionString: h.uri() });
		await firstRun.connect();
		try {
			await firstRun.query("BEGIN");
			await firstRun.query(
				"SELECT pg_advisory_xact_lock(hashtextextended('cutover:hq-round-trip-expressions', 0))",
			);
			await expect(
				runFleetTransaction(h.db(), { mode: "execute", input }),
			).rejects.toThrow(/Another run of this cutover held its lock/);
		} finally {
			await firstRun.query("ROLLBACK");
			await firstRun.end();
		}
		expect(await databaseImage(h.db())).toBe(image);
	}, 120_000);

	it("stops with nothing written when an app changed after the plan was built", async () => {
		const fleet = await seedFleet();
		const input = writerInputOf(await readPlannedFleet(h.db()));
		const [changed] = fleet.appIds;
		await h.withTransaction(async (tx) => {
			await sql`SET LOCAL session_replication_role = replica`.execute(tx);
			await sql`
				UPDATE apps SET app_name = 'Renamed after the plan' WHERE id = ${changed ?? ""}
			`.execute(tx);
		});
		const image = await databaseImage(h.db());
		await expect(
			runFleetTransaction(h.db(), { mode: "execute", input }),
		).rejects.toMatchObject({
			code: "app-changed",
		} satisfies Partial<CutoverStoppedError>);
		expect(await databaseImage(h.db())).toBe(image);
	}, 120_000);

	it("stops with nothing written when an app's sequence moved after the plan was built", async () => {
		const fleet = await seedFleet();
		const input = writerInputOf(await readPlannedFleet(h.db()));
		const [changed] = fleet.appIds;
		await h.withTransaction(async (tx) => {
			await sql`SET LOCAL session_replication_role = replica`.execute(tx);
			await sql`
				UPDATE apps SET mutation_seq = mutation_seq + 1 WHERE id = ${changed ?? ""}
			`.execute(tx);
		});
		const image = await databaseImage(h.db());
		await expect(
			runFleetTransaction(h.db(), { mode: "execute", input }),
		).rejects.toMatchObject({
			code: "app-changed",
		} satisfies Partial<CutoverStoppedError>);
		expect(await databaseImage(h.db())).toBe(image);
	}, 120_000);

	it("stops on a live holder, with nothing written", async () => {
		const fleet = await seedFleet();
		await h
			.db()
			.updateTable("apps")
			.set({
				run_id: "run-live",
				run_holder_nonce: "6a0a35a4-1111-4222-8333-944445555777",
				lock_run_id: "run-live",
				lock_actor_user_id: OWNER,
				lock_expire_at: new Date(Date.now() + 600_000),
			})
			.where("id", "=", fleet.appIds[0] ?? "")
			.execute();
		const image = await databaseImage(h.db());
		const rehearsal = await runMigrate(h.db(), { mode: "rehearse" });
		expect(rehearsal.outcome).toMatchObject({
			outcome: "stopped",
			stoppedBy: expect.arrayContaining(["holder"]),
		});
		expect(await databaseImage(h.db())).toBe(image);
	}, 120_000);

	it("refuses a database where some apps carry the marker and some do not", async () => {
		await h.seedProjectMember(OWNER, PROJECT, "owner");
		await seedApp("choices", "app-00-marked");
		await runFleetTransaction(h.db(), {
			mode: "execute",
			input: writerInputOf(await readPlannedFleet(h.db())),
		});
		await seedPreStepApp(h.db(), {
			...fixtureApp("choices", {
				appId: "app-01-unmarked",
				projectId: PROJECT,
				owner: OWNER,
			}),
		});
		const image = await databaseImage(h.db());
		for (const mode of ["dry-run", "rehearse", "settle-holders"] as const) {
			await expect(runMigrate(h.db(), { mode })).rejects.toThrow(
				"1 of 2 apps carry the hq-round-trip-expressions horizon",
			);
		}
		expect(await databaseImage(h.db())).toBe(image);
	}, 60_000);

	it.each(WRITER_STEPS)(
		"leaves the database byte-identical when it fails after %s",
		async (step) => {
			const fleet = await seedFleet();
			await seedMutationEvents(fleet.appIds[0] ?? "");
			const input = writerInputOf(await readPlannedFleet(h.db()));
			const image = await databaseImage(h.db());
			await expect(
				runFleetTransaction(h.db(), {
					mode: "execute",
					input,
					failAfter: step,
				}),
			).rejects.toThrow(`injected failure after ${step}`);
			expect(await databaseImage(h.db())).toBe(image);
		},
		120_000,
	);
});

describe("the fold-horizon migration's admission", () => {
	useHarness("hq_expr_admission_");

	it("admits the new horizon identity and refuses an invented one", async () => {
		await h.seedProjectMember(OWNER, PROJECT, "owner");
		await seedApp("choices", "app-00-admitted");
		await seedApp("choices", "app-01-invented");
		/* A horizon written the way the writer writes one: the root and entity
		 * rows rewritten in the transaction, the empty marker at `+1`, then the
		 * baseline as the database's own snapshot of them. */
		const establish = (appId: string, batchId: string, actorId: string) =>
			h.withTransaction(async (tx) => {
				await sql`
					UPDATE apps SET mutation_seq = mutation_seq + 1 WHERE id = ${appId}
				`.execute(tx);
				await sql`
					UPDATE blueprint_entities SET ordinal = ordinal WHERE app_id = ${appId}
				`.execute(tx);
				await sql`
					INSERT INTO app_changes (app_id, seq, batch_id, run_id, actor_id, kind, mutations,
						from_project_id, to_project_id)
					SELECT id, mutation_seq, ${batchId}, NULL, ${actorId}, 'fold-baseline',
						'[]'::jsonb, NULL, NULL
					FROM apps WHERE id = ${appId}
				`.execute(tx);
				await sql`
					INSERT INTO app_change_fold_baselines (app_id, seq, project_id, snapshot, snapshot_digest)
					SELECT app.id, app.mutation_seq, app.project_id, current.snapshot,
						nova_app_change_fold_snapshot_digest(current.snapshot)
					FROM apps AS app,
						LATERAL (SELECT nova_current_app_change_fold_snapshot(app.id) AS snapshot) AS current
					WHERE app.id = ${appId}
				`.execute(tx);
			});
		await establish("app-00-admitted", MARKER_BATCH_ID, MARKER_ACTOR_ID);
		await expect(
			establish(
				"app-01-invented",
				"fold-baseline:invented-cutover",
				"system:invented-cutover",
			),
		).rejects.toThrow(/exact (fold marker|horizon)/);
		const markers = await sql<{ app_id: string; batch_id: string }>`
			SELECT app_id, batch_id FROM app_changes ORDER BY app_id, seq
		`.execute(h.db());
		expect(markers.rows).toEqual([
			{ app_id: "app-00-admitted", batch_id: "genesis:app-00-admitted" },
			{ app_id: "app-00-admitted", batch_id: MARKER_BATCH_ID },
			{ app_id: "app-01-invented", batch_id: "genesis:app-01-invented" },
		]);
	}, 60_000);
});
