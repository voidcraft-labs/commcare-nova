/**
 * The case-writes cutover's fleet transaction over real Postgres (step 5's
 * part 09, sections 4, 13 and 14, and the Tests row for this file), from
 * `main`'s migration prefix: every migration before the publish-placement
 * one, so the run applies the window's three itself, inside the transaction.
 *
 * Contract: nothing is written and no DDL applied before every check that
 * can stop has passed, and any stop or failure leaves the database
 * byte-identical (`postgresSeed.ts::databaseImage`, which reads every
 * constraint and routine through `catalog.ts`, with the app-test namespace
 * decoy of section 15.2 present). A committed run leaves every app, deleted
 * ones included, loading and folding from its new baseline to its planned
 * target, the runtime probe clean, the case schemas byte-identical with only
 * each app's claim row left for the drift writer, exactly the planned
 * notices, and a second run already applied.
 *
 * The plausible failures it separates: a write before a stop (an app, a
 * ledger row or a function body left behind), a check that reads a moved
 * app, baseline or holder as unchanged, a target that does not survive its
 * own storage, history that does not fold to it, a schema row or case row
 * touched, a notice missed or invented.
 */

import { type Kysely, sql } from "kysely";
import { Client } from "pg";
import { beforeEach, describe, expect, it } from "vitest";
import { loadCanonicalBlueprintAtSequence } from "@/lib/agent/change-set/baseLoader";
import { caseStoreMigrations } from "@/lib/case-store/migrations";
import { buildCaseTypeMap } from "@/lib/case-store/store";
import {
	type AppStateTestDb,
	setupAppStateTestDb,
} from "@/lib/db/__tests__/appStateTestDb";
import { loadAppInTransaction } from "@/lib/db/canonicalCommitKernel";
import type { AppDatabase } from "@/lib/db/pg";
import { runCanonicalRuntimeDatabaseProbe } from "@/lib/db/runtimeDatabaseProbe";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
import { CASE_CLAIM_CASE_TYPE } from "@/lib/domain";
import { caseTypeToJsonSchema } from "@/lib/domain/expression/jsonSchema";
import { migrationNoticeEntriesSchema } from "@/lib/notices/migrationNotice";
import {
	canonicalJsonDigest,
	canonicalJsonText,
} from "@/lib/utils/canonicalJson";
import { computeSchemaDrift } from "../../schemaDrift";
import {
	CutoverLedgerError,
	CutoverLockTimeoutError,
	classifyApplied,
	readMarkerCount,
	readMigrationLedger,
} from "../ledger";
import { readRawDocument } from "../oldShape";
import { type PlannedFleet, planFleet } from "../plan";
import { readFleetSourceSnapshot } from "../source";
import { writesIntoOperations } from "../steps/writesIntoOperations";
import { parseHead, structurePhase } from "../structure";
import {
	ACTOR_ID,
	CUTOVER,
	MARKER_BATCH_ID,
	PENDING_MIGRATIONS,
	PUBLISH_PLACEMENT_MIGRATION,
	WRITER_STEPS,
} from "../types";
import {
	CutoverAlreadyAppliedError,
	CutoverStoppedError,
	runFleetTransaction,
} from "../writer";
import {
	databaseImage,
	PUBLISHED_DEPLOYMENTS,
	PUBLISHED_FIXTURE,
	preStepDocument,
	seedDecoyNamespace,
	seedMutationEvents,
	seedPreStepFleet,
	seedPrivateWork,
	seedPublishedDeployments,
} from "./postgresSeed";
import { carriersOfPersistedDoc, PRE_STEP_FIXTURE_IDS } from "./rawFixture";

const OWNER = "owner-case-writes-cutover";
const PROJECT = "project-case-writes-cutover";
/** The one fixture a blocker stops (part 09 §7.4's C9 arm under `forEach`),
 *  which the transform tests hold; every other fixture is an app here. */
const BLOCKED = "pre-step-own-close-operation";
const FIXTURES = PRE_STEP_FIXTURE_IDS.filter((id) => id !== BLOCKED);
/** The app whose open private work and mutation events the writer ends. */
const WORK_FIXTURE = "targeted-migration-attachment";

let h: AppStateTestDb;
const harness = setupAppStateTestDb("case_writes_writer_", {
	authSchema: "migrated",
	caseStoreMigrationsBefore: PUBLISH_PLACEMENT_MIGRATION,
});
beforeEach(() => {
	h = harness;
});

// ─── Seeding ──────────────────────────────────────────────────────────────

/**
 * The case schemas `main`'s deploy stored for a fixture: what its writes
 * derive once made operations, but for the claim type's row, which no
 * stored app holds.
 */
async function seedStoredSchemas(
	db: Kysely<AppDatabase>,
	appId: string,
	fixtureId: string,
): Promise<void> {
	const raw = readRawDocument(
		appId,
		carriersOfPersistedDoc(preStepDocument(fixtureId)),
	);
	const structure = structurePhase(raw);
	const head = parseHead(appId, structure.persisted);
	if (!head.ok)
		throw new Error(`The fixture ${fixtureId} does not parse at the head.`);
	const doc = writesIntoOperations(head.doc, structure.facts).doc;
	await db.transaction().execute(async (tx) => {
		await sql`SET LOCAL session_replication_role = replica`.execute(tx);
		for (const caseType of buildCaseTypeMap(toPersistableDoc(doc)).values()) {
			if (caseType.name === CASE_CLAIM_CASE_TYPE) continue;
			await sql`
				INSERT INTO case_type_schemas (app_id, case_type, schema, synced_seq)
				VALUES (${appId}, ${caseType.name},
					${JSON.stringify(caseTypeToJsonSchema(caseType))}::jsonb, 1)
			`.execute(tx);
		}
	});
}

interface Seeded {
	readonly appIds: readonly string[];
	readonly publishedAppId: string;
	readonly workAppId: string;
	readonly deletedAppId: string;
}

/**
 * Every fixture the transform admits as an app, one more deleted; the
 * published fixture's app with an entry point and its `push`, `create` and
 * `unread` deployments; open private work and two mutation events on
 * another app; the stored schemas of each; and section 15.2's decoy under
 * production's heap order.
 */
async function seedFleet(
	options: { readonly digestFails?: boolean } = {},
): Promise<Seeded> {
	const db = h.db();
	await h.seedProjectMember(OWNER, PROJECT, "owner");
	await sql`VACUUM FULL pg_catalog.pg_constraint`.execute(db);
	await sql`VACUUM FULL pg_catalog.pg_proc`.execute(db);
	await seedDecoyNamespace(db);
	await sql`
		DO $$ BEGIN
			EXECUTE format('ALTER DATABASE %I SET enable_indexscan = off', current_database());
		END $$
	`.execute(db);
	const fleet = await seedPreStepFleet(db, {
		fixtureIds: FIXTURES,
		projectId: PROJECT,
		owner: OWNER,
	});
	for (const [fixtureId, appId] of fleet.byFixture) {
		await seedStoredSchemas(db, appId, fixtureId);
	}
	const [first] = FIXTURES;
	if (first === undefined) throw new Error("No fixture to seed.");
	await seedStoredSchemas(db, fleet.deletedAppId, first);
	const publishedAppId = fleet.byFixture.get(PUBLISHED_FIXTURE);
	const workAppId = fleet.byFixture.get(WORK_FIXTURE);
	if (publishedAppId === undefined || workAppId === undefined)
		throw new Error("The fleet lacks the published or the work fixture.");
	await seedPublishedDeployments(db, {
		appId: publishedAppId,
		projectId: PROJECT,
		...(options.digestFails === true && { digestFails: true }),
	});
	await seedPrivateWork(h, {
		appId: workAppId,
		projectId: PROJECT,
		owner: OWNER,
	});
	await seedMutationEvents(db, workAppId);
	return {
		appIds: fleet.appIds,
		publishedAppId,
		workAppId,
		deletedAppId: fleet.deletedAppId,
	};
}

async function planned(): Promise<PlannedFleet> {
	return planFleet(await readFleetSourceSnapshot(h.db()));
}

async function appliedMigrations(): Promise<string[]> {
	const rows = await sql<{ name: string }>`
		SELECT name FROM kysely_migration ORDER BY name
	`.execute(h.db());
	return rows.rows.map((row) => row.name);
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

/** Edit rows with the triggers held, as no runtime writer could. */
async function withTriggersHeld(statement: ReturnType<typeof sql>) {
	await h.withTransaction(async (tx) => {
		await sql`SET LOCAL session_replication_role = replica`.execute(tx);
		await statement.execute(tx);
	});
}

// ─── The tests ────────────────────────────────────────────────────────────

describe("the fleet transaction from main's migration prefix", () => {
	it("writes nothing until it commits, then leaves every app at its planned target with its history starting there", async () => {
		const seeded = await seedFleet();
		const ledger = await appliedMigrations();
		expect((await readMigrationLedger(h.db())).pendingMigrations).toEqual([
			...PENDING_MIGRATIONS,
		]);
		const fleet = await planned();
		const { plan } = fleet;
		expect(plan.apps.map((app) => app.appId)).toEqual(seeded.appIds);
		expect(
			plan.apps.filter((app) => app.deleted).map((app) => app.appId),
		).toEqual([seeded.deletedAppId]);
		expect(plan.apps.flatMap((app) => app.blockers)).toEqual([]);
		const published = plan.apps.find(
			(app) => app.appId === seeded.publishedAppId,
		);
		expect(published?.deployments.map((entry) => entry.baseline)).toEqual([
			"readable",
			"shell",
			"unread",
		]);
		expect(published?.held.length).toBeGreaterThan(0);
		const input = { plan, writes: fleet.writes };
		const image = await databaseImage(h.db());

		// A rehearsal runs whole and leaves nothing, the DDL included.
		const rehearsal = await runFleetTransaction(h.db(), {
			mode: "rehearse",
			input,
		});
		expect(rehearsal.migrationsApplied).toEqual([...PENDING_MIGRATIONS]);
		expect(rehearsal.appsWritten).toBe(seeded.appIds.length);
		expect(rehearsal.eventsArchived).toBe(2);
		expect(rehearsal.sessionsEnded).toBe(1);
		expect(await databaseImage(h.db())).toBe(image);

		// A failure after any step rolls the fleet back whole.
		for (const step of WRITER_STEPS) {
			await expect(
				runFleetTransaction(h.db(), {
					mode: "execute",
					expectPlanDigest: plan.digest,
					input,
					failAfter: step,
				}),
			).rejects.toThrow(`injected failure after ${step}`);
			expect(await databaseImage(h.db()), step).toBe(image);
		}
		expect(await appliedMigrations()).toEqual(ledger);

		const before = await sql<{ id: string; updated_at: Date }>`
			SELECT id, updated_at FROM apps ORDER BY id
		`.execute(h.db());
		const schemasBefore = await sql<{ row: string }>`
			SELECT s::text AS row FROM case_type_schemas AS s ORDER BY s::text COLLATE "C"
		`.execute(h.db());
		const report = await runFleetTransaction(h.db(), {
			mode: "execute",
			expectPlanDigest: plan.digest,
			input,
		});
		expect(report.migrationsApplied).toEqual([...PENDING_MIGRATIONS]);
		expect(await appliedMigrations()).toEqual(
			[...ledger, ...PENDING_MIGRATIONS].sort(),
		);

		// Nobody edited an app: `updated_at` stands, and the horizon is `+1`.
		const after = await sql<{ id: string; updated_at: Date; seq: string }>`
			SELECT id, updated_at, mutation_seq::text AS seq FROM apps ORDER BY id
		`.execute(h.db());
		expect(after.rows.map((row) => row.updated_at.toISOString())).toEqual(
			before.rows.map((row) => row.updated_at.toISOString()),
		);
		const markers = await sql<{ app_id: string; seq: string }>`
			SELECT app_id, seq::text AS seq FROM app_changes
			WHERE batch_id = ${MARKER_BATCH_ID} AND actor_id = ${ACTOR_ID}
				AND run_id IS NULL AND kind = 'fold-baseline' AND mutations = '[]'::jsonb
			ORDER BY app_id
		`.execute(h.db());
		expect(markers.rows).toEqual(
			[...plan.apps]
				.sort((a, b) => (a.appId < b.appId ? -1 : 1))
				.map((app) => ({
					app_id: app.appId,
					seq: String(app.baseSeq + 1),
				})),
		);

		// Every app loads under the head schema and the gate, and folds from
		// its new baseline to its planned target.
		await h.withTransaction(async (tx) => {
			for (const app of plan.apps) {
				const loaded = await loadAppInTransaction(tx, app.appId);
				if (loaded === null) throw new Error(`App ${app.appId} is gone.`);
				expect(
					canonicalJsonDigest(
						toPersistableDoc(hydratePersistedBlueprint(loaded.blueprint)),
					),
				).toBe(app.targetDigest);
				const folded = await loadCanonicalBlueprintAtSequence(tx, {
					appId: app.appId,
					seq: app.baseSeq + 1,
					expectedDigest: app.targetDigest,
				});
				expect(folded.digest).toBe(app.targetDigest);
			}
		});
		const role = await sql<{ role: string }>`
			SELECT current_user AS role
		`.execute(h.db());
		const probe = await runCanonicalRuntimeDatabaseProbe(
			h.db() as unknown as Kysely<unknown>,
			role.rows[0]?.role ?? "",
		);
		expect(probe.findingCount).toBe(0);

		// The stored schemas are byte-identical; the drift writer's own
		// comparison names each app's claim row and nothing else.
		const schemasAfter = await sql<{ row: string }>`
			SELECT s::text AS row FROM case_type_schemas AS s ORDER BY s::text COLLATE "C"
		`.execute(h.db());
		expect(schemasAfter.rows).toEqual(schemasBefore.rows);
		for (const app of plan.apps) {
			const loaded = await h.withTransaction((tx) =>
				loadAppInTransaction(tx, app.appId),
			);
			if (loaded === null) throw new Error(`App ${app.appId} is gone.`);
			const drift = await computeSchemaDrift(
				h.db() as unknown as Parameters<typeof computeSchemaDrift>[0],
				app.appId,
				loaded.blueprint,
			);
			expect(
				drift.map((entry) => [entry.caseType, entry.missingRow]),
				app.appId,
			).toEqual([[CASE_CLAIM_CASE_TYPE, true]]);
			expect(app.schemaChanges, app.appId).toEqual([
				{
					caseType: CASE_CLAIM_CASE_TYPE,
					cause: "claim-type-row",
					properties: 0,
				},
			]);
		}

		// The mutation events are archived, the private work ended, and the
		// streams cleared.
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
		const open = await sql<{ open: string }>`
			SELECT ((SELECT count(*) FROM authoring_workspaces WHERE status = 'open')
				+ (SELECT count(*) FROM design_change_sets WHERE status = 'open')
				+ (SELECT count(*) FROM authoring_sessions WHERE active_candidate_id IS NOT NULL))::text AS open
		`.execute(h.db());
		expect(open.rows[0]?.open).toBe("0");

		// Exactly the planned notice rows, as the plan holds them.
		const notices = await sql<{ app_id: string; entries: string }>`
			SELECT app_id, entries::text AS entries FROM app_migration_notices
			WHERE cutover = ${CUTOVER} ORDER BY app_id
		`.execute(h.db());
		expect(
			notices.rows.map((row) => [
				row.app_id,
				canonicalJsonText(JSON.parse(row.entries) as unknown),
			]),
		).toEqual(
			plan.apps
				.filter((app) => app.notice.length > 0)
				.map((app) => [
					app.appId,
					canonicalJsonText(migrationNoticeEntriesSchema.parse(app.notice)),
				]),
		);
		const reasonsOf = (appId: string) =>
			(plan.apps.find((app) => app.appId === appId)?.notice ?? []).map(
				(entry) => entry.reason,
			);
		expect(reasonsOf(seeded.publishedAppId)).toEqual(
			expect.arrayContaining([
				"deep-links-need-republish",
				"placements-kept-unread",
			]),
		);
		expect(reasonsOf(seeded.workAppId).at(-1)).toBe(
			"unsaved-assistant-work-discarded",
		);

		// A second run finds the cutover already applied and writes nothing.
		const applied = await databaseImage(h.db());
		expect(
			classifyApplied(
				await readMigrationLedger(h.db()),
				await readMarkerCount(h.db()),
			),
		).toBe("already-applied");
		const stale = await rejectionOf(
			runFleetTransaction(h.db(), {
				mode: "execute",
				expectPlanDigest: plan.digest,
				input,
			}),
		);
		expect((stale as CutoverStoppedError).code).toBe("app-changed");
		const again = await planned();
		expect(again.plan.apps.flatMap((app) => app.blockers)).toEqual([]);
		const second = await rejectionOf(
			runFleetTransaction(h.db(), {
				mode: "rehearse",
				input: { plan: again.plan, writes: again.writes },
			}),
		);
		expect(second).toBeInstanceOf(CutoverAlreadyAppliedError);
		expect(await databaseImage(h.db())).toBe(applied);
	}, 600_000);

	it("refuses a plan whose published baseline no longer verifies, with nothing written", async () => {
		const seeded = await seedFleet({ digestFails: true });
		const fleet = await planned();
		const app = fleet.plan.apps.find(
			(candidate) => candidate.appId === seeded.publishedAppId,
		);
		expect(app?.targetDigest).toBeNull();
		expect(app?.blockers).toEqual([
			{
				code: "baseline-unreadable",
				count: 1,
				findingCodes: ["baseline-unreadable:digest"],
			},
		]);
		const image = await databaseImage(h.db());
		for (const mode of ["rehearse", "execute"] as const) {
			const error = await rejectionOf(
				runFleetTransaction(h.db(), {
					...(mode === "execute"
						? { mode, expectPlanDigest: fleet.plan.digest }
						: { mode }),
					input: { plan: fleet.plan, writes: fleet.writes },
				}),
			);
			expect(error).toBeInstanceOf(CutoverStoppedError);
			expect((error as CutoverStoppedError).code).toBe("blocker");
		}
		expect(await databaseImage(h.db())).toBe(image);
	}, 300_000);

	it("refuses any ledger but the window's three pending, with nothing written and no migration applied", async () => {
		await seedFleet();
		const migrated = await new (await import("kysely/migration")).Migrator({
			db: h.db() as unknown as Kysely<unknown>,
			provider: { getMigrations: async () => caseStoreMigrations },
		}).migrateTo(PUBLISH_PLACEMENT_MIGRATION);
		expect(migrated.error).toBeUndefined();
		const fleet = await planned();
		const image = await databaseImage(h.db());
		const error = await rejectionOf(
			runFleetTransaction(h.db(), {
				mode: "rehearse",
				input: { plan: fleet.plan, writes: fleet.writes },
			}),
		);
		expect(error).toBeInstanceOf(CutoverLedgerError);
		expect((error as Error).message).toBe(
			`The migration ledger is not the one this cutover was reviewed against: it expected exactly ${PENDING_MIGRATIONS.join(", ")} to be pending and found ${PENDING_MIGRATIONS.slice(1).join(", ")}. The cutover stopped with nothing written and no migration applied. Compare a dry run's ledger line with main's migrations, and find out how the ledger moved before running again.`,
		);
		expect(await databaseImage(h.db())).toBe(image);
	}, 300_000);

	it("stops on a wrong digest, a live holder, a moved app, a moved baseline and a lock wait, each with nothing written and no DDL", async () => {
		const seeded = await seedFleet();
		const fleet = await planned();
		const input = { plan: fleet.plan, writes: fleet.writes };
		const ledger = await appliedMigrations();
		const execute = () =>
			runFleetTransaction(h.db(), {
				mode: "execute",
				expectPlanDigest: fleet.plan.digest,
				input,
			});

		// A digest the plan does not hold: section 13's sentence.
		let image = await databaseImage(h.db());
		const wrong = "0".repeat(64);
		const digest = (await rejectionOf(
			runFleetTransaction(h.db(), {
				mode: "execute",
				expectPlanDigest: wrong,
				input,
			}),
		)) as CutoverStoppedError;
		expect(digest.code).toBe("digest");
		expect(digest.message).toBe(
			`This run's plan has digest ${fleet.plan.digest}, not the ${wrong} the dry run printed, so it wrote nothing. Something in the database moved after the dry run. Compare the two runs' reports, then run the dry run again and pass its digest.`,
		);
		expect(await databaseImage(h.db())).toBe(image);

		// A live edit holder.
		const [heldApp] = seeded.appIds;
		if (heldApp === undefined) throw new Error("The fleet is empty.");
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
			.where("id", "=", heldApp)
			.execute();
		image = await databaseImage(h.db());
		expect(((await rejectionOf(execute())) as CutoverStoppedError).code).toBe(
			"holder",
		);
		expect(await databaseImage(h.db())).toBe(image);
		await h
			.db()
			.updateTable("apps")
			.set({
				run_id: null,
				run_holder_nonce: null,
				lock_run_id: null,
				lock_actor_user_id: null,
				lock_expire_at: null,
			})
			.where("id", "=", heldApp)
			.execute();

		// An app renamed after the plan.
		const appName = (
			await sql<{ app_name: string }>`
				SELECT app_name FROM apps WHERE id = ${seeded.workAppId}
			`.execute(h.db())
		).rows[0]?.app_name;
		await withTriggersHeld(
			sql`UPDATE apps SET app_name = 'Renamed after the plan' WHERE id = ${seeded.workAppId}`,
		);
		image = await databaseImage(h.db());
		expect(((await rejectionOf(execute())) as CutoverStoppedError).code).toBe(
			"app-changed",
		);
		expect(await databaseImage(h.db())).toBe(image);
		await withTriggersHeld(
			sql`UPDATE apps SET app_name = ${appName ?? ""} WHERE id = ${seeded.workAppId}`,
		);

		// A baseline read again after the plan.
		await withTriggersHeld(
			sql`UPDATE app_deployment_baselines SET observed_at = observed_at + interval '1 day'
				WHERE deployment_id = ${PUBLISHED_DEPLOYMENTS.push}::uuid`,
		);
		image = await databaseImage(h.db());
		expect(((await rejectionOf(execute())) as CutoverStoppedError).code).toBe(
			"baseline-changed",
		);
		expect(await databaseImage(h.db())).toBe(image);
		await withTriggersHeld(
			sql`UPDATE app_deployment_baselines SET observed_at = observed_at - interval '1 day'
				WHERE deployment_id = ${PUBLISHED_DEPLOYMENTS.push}::uuid`,
		);

		// Another session holding an app row past the lock timeout.
		image = await databaseImage(h.db());
		const other = new Client({ connectionString: h.uri() });
		await other.connect();
		try {
			await other.query("BEGIN");
			await other.query("SELECT 1 FROM apps WHERE id = $1 FOR UPDATE", [
				seeded.publishedAppId,
			]);
			const started = performance.now();
			const error = await rejectionOf(execute());
			const elapsed = performance.now() - started;
			expect(error).toBeInstanceOf(CutoverLockTimeoutError);
			expect(elapsed).toBeGreaterThanOrEqual(14_000);
			expect(elapsed).toBeLessThan(60_000);
		} finally {
			await other.query("ROLLBACK");
			await other.end();
		}
		expect(await databaseImage(h.db())).toBe(image);
		expect(await appliedMigrations()).toEqual(ledger);
	}, 600_000);
});
