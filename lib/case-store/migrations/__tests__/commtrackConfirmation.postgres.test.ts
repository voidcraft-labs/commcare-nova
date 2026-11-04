/**
 * The `commtrack-off` confirmation kind, admitted by the database. The
 * plausible failures: the fifth kind left out of the kind CHECK, or admitted
 * under a subject other than its own name; a row the previous revision wrote
 * refused by the replaced CHECK; and a migration that names the confirmations
 * table or its constraint by a bare name, so a same-named table elsewhere,
 * first on the search path or first in a catalog scan, is the one it changes.
 */

import { type Kysely, sql } from "kysely";
import { Migrator } from "kysely/migration";
import { describe, expect, it } from "vitest";
import { canonicalTestBlueprint } from "@/lib/db/__tests__/appStateTestDb";
import { decomposeBlueprint } from "@/lib/db/blueprintRows";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { setupPerTestDatabase } from "../../sql/__tests__/perTestDatabase";
import { caseStoreMigrations } from "..";
import {
	down,
	up,
} from "../20261110010000_hq_round_trip_case_writes_commtrack_confirmation";
import { checkConstraintVerdicts } from "./checkConstraint";

const MIGRATION =
	"20261110010000_hq_round_trip_case_writes_commtrack_confirmation";
const TABLE = "public.app_deployment_confirmations";
const KIND_CHECK = "app_deployment_confirmations_kind_check";
const SUBJECT_CHECK = "app_deployment_confirmations_commtrack_subject";
const DECOY_SCHEMA = "nova_commtrack_test_decoy";
const DECOY_TABLE = `${DECOY_SCHEMA}.app_deployment_confirmations`;

/* Every migration before this one: the confirmations table with the four
 * kinds step 4 admitted. */
const database = setupPerTestDatabase({
	databaseNamePrefix: "commtrack_confirmation_migration_",
	prepareTemplate: async (db) => {
		const result = await new Migrator({
			db,
			provider: {
				getMigrations: async () =>
					Object.fromEntries(
						Object.entries(caseStoreMigrations).filter(
							([name]) => name < MIGRATION,
						),
					),
			},
		}).migrateToLatest();
		if (result.error !== undefined) throw result.error;
	},
});

const DEPLOYMENT = "01992000-0000-7000-8000-000000000081";

async function seedDeployment(db: Kysely<unknown>): Promise<void> {
	const doc = toPersistableDoc(canonicalTestBlueprint("app", "Published app"));
	await sql`INSERT INTO public.apps (id, owner, project_id, app_name, app_name_lower,
		module_count, form_count, mutation_seq, status, awaiting_input)
		VALUES ('app', 'owner', 'project', ${doc.appName}, ${doc.appName.toLowerCase()},
		${doc.moduleOrder.length}, ${Object.keys(doc.forms).length}, 0, 'complete', false)`.execute(
		db,
	);
	for (const row of decomposeBlueprint(doc)) {
		await sql`INSERT INTO public.blueprint_entities (app_id, uuid, kind, parent_uuid, ordinal, data)
			VALUES ('app', ${row.uuid}, ${row.kind}, ${row.parent_uuid}, ${row.ordinal}, ${JSON.stringify(row.data)}::jsonb)`.execute(
			db,
		);
	}
	const phases = {
		upload: { status: "succeeded", at: "2026-11-01T00:00:00Z" },
	};
	await sql`INSERT INTO public.app_deployments
		(id, app_id, project_id, server, domain, state, resume_phase, phases, created_by)
		VALUES (${DEPLOYMENT}::uuid, 'app', 'project', 'production', 'clinic', 'uploaded',
			NULL, ${JSON.stringify(phases)}::jsonb, 'owner')`.execute(db);
}

function confirm(db: Kysely<unknown>, kind: string, subject: string) {
	return sql`INSERT INTO public.app_deployment_confirmations
		(deployment_id, kind, subject, confirmed_by)
		VALUES (${DEPLOYMENT}::uuid, ${kind}, ${subject}, 'owner')`.execute(db);
}

async function refusal(statement: Promise<unknown>) {
	return expect(statement).rejects.toMatchObject({
		code: expect.stringMatching(/^23/),
	});
}

const KINDS = [
	"plan-feature",
	"flat-location-fixture",
	"connect-forwarder",
	"form-entry-sync-off",
	"commtrack-off",
	"commtrack",
];

function kindVerdicts(db: Kysely<unknown>, table: string) {
	return checkConstraintVerdicts(db, table, KIND_CHECK, "kind", KINDS);
}

/** Every constraint of one table, by name, with its definition. */
async function constraintsOf(db: Kysely<unknown>, table: string) {
	const rows = await sql<{ name: string; definition: string }>`
		SELECT conname AS name, pg_catalog.pg_get_constraintdef(oid) AS definition
		FROM pg_catalog.pg_constraint
		WHERE conrelid = ${table}::regclass
		ORDER BY conname
	`.execute(db);
	return rows.rows;
}

/** The schema of every constraint named like the kind CHECK, in the order a
 *  sequential scan of `pg_constraint` meets them. */
async function byNameScanOrder(db: Kysely<unknown>): Promise<string[]> {
	const rows = await sql<{ schema_name: string }>`
		SELECT connamespace::regnamespace::text AS schema_name
		FROM pg_catalog.pg_constraint
		WHERE conname = ${KIND_CHECK}
	`.execute(db);
	return rows.rows.map((row) => row.schema_name);
}

/**
 * A decoy schema holding a same-named confirmations table with the same
 * named kind CHECK, first on the session's search path, and first in
 * `pg_constraint`'s heap, so a by-name catalog scan or a bare table name
 * meets the decoy before the real table.
 */
async function installDecoy(db: Kysely<unknown>): Promise<void> {
	await sql`CREATE SCHEMA nova_commtrack_test_decoy`.execute(db);
	await sql`
		CREATE TABLE nova_commtrack_test_decoy.app_deployment_confirmations
			(LIKE public.app_deployment_confirmations INCLUDING DEFAULTS INCLUDING CONSTRAINTS)
	`.execute(db);
	// The rewrite packs the heap, so the next version of a tuple lands after
	// every tuple it holds. Renaming the public CHECK away and back rewrites
	// its catalog tuple twice, so its live version follows the decoy's.
	await sql`VACUUM FULL pg_catalog.pg_constraint`.execute(db);
	await sql`ALTER TABLE public.app_deployment_confirmations
		RENAME CONSTRAINT app_deployment_confirmations_kind_check
		TO app_deployment_confirmations_kind_check_moving`.execute(db);
	await sql`ALTER TABLE public.app_deployment_confirmations
		RENAME CONSTRAINT app_deployment_confirmations_kind_check_moving
		TO app_deployment_confirmations_kind_check`.execute(db);
	await sql`SET enable_indexscan = off`.execute(db);
	await sql`SET enable_indexonlyscan = off`.execute(db);
	await sql`SET enable_bitmapscan = off`.execute(db);
	await sql`SET search_path = nova_commtrack_test_decoy, public`.execute(db);
}

/** The harness's precondition, which no assertion below may assume. */
async function assertDecoyMetFirst(db: Kysely<unknown>): Promise<void> {
	const order = await byNameScanOrder(db);
	if (order.length !== 2 || order[0] !== DECOY_SCHEMA) {
		throw new Error(
			`Harness defect: a by-name scan of pg_constraint must meet the decoy's kind CHECK before the public one, and it met ${JSON.stringify(order)}. Change the decoy's seeding order until it does.`,
		);
	}
}

describe(MIGRATION, () => {
	it("admits the fifth kind beside the four the ledger had, and refuses any other", async () => {
		const db = database.db;
		expect(await kindVerdicts(db, TABLE)).toEqual([
			{ value: "plan-feature", admitted: true },
			{ value: "flat-location-fixture", admitted: true },
			{ value: "connect-forwarder", admitted: true },
			{ value: "form-entry-sync-off", admitted: true },
			{ value: "commtrack-off", admitted: false },
			{ value: "commtrack", admitted: false },
		]);

		await up(db);

		expect(await kindVerdicts(db, TABLE)).toEqual([
			{ value: "plan-feature", admitted: true },
			{ value: "flat-location-fixture", admitted: true },
			{ value: "connect-forwarder", admitted: true },
			{ value: "form-entry-sync-off", admitted: true },
			{ value: "commtrack-off", admitted: true },
			{ value: "commtrack", admitted: false },
		]);
	});

	it("stores the new kind only under its own name, and keeps every row the previous revision wrote", async () => {
		const db = database.db;
		await seedDeployment(db);
		await confirm(db, "plan-feature", "lookup-tables");
		await confirm(db, "flat-location-fixture", "flat-location-fixture");
		await confirm(db, "connect-forwarder", "connect-forwarder");
		await confirm(db, "form-entry-sync-off", "form-entry-sync-off");

		await up(db);

		await refusal(confirm(db, "commtrack-off", "form-entry-sync-off"));
		await refusal(confirm(db, "commtrack-off", "lookup-tables"));
		await refusal(confirm(db, "form-entry-sync-off", "commtrack-off"));
		await confirm(db, "commtrack-off", "commtrack-off");
		const rows = await sql<{ kind: string; subject: string }>`
			SELECT kind, subject FROM public.app_deployment_confirmations
			ORDER BY kind, subject
		`.execute(db);
		expect(rows.rows).toEqual([
			{ kind: "commtrack-off", subject: "commtrack-off" },
			{ kind: "connect-forwarder", subject: "connect-forwarder" },
			{ kind: "flat-location-fixture", subject: "flat-location-fixture" },
			{ kind: "form-entry-sync-off", subject: "form-entry-sync-off" },
			{ kind: "plan-feature", subject: "lookup-tables" },
		]);
		const installed = (await constraintsOf(db, TABLE)).filter(
			({ name }) => name === SUBJECT_CHECK,
		);
		expect(installed.map(({ name }) => name)).toEqual([SUBJECT_CHECK]);
	});

	it("changes the public table and leaves a same-named decoy untouched", async () => {
		const db = database.db;
		await installDecoy(db);
		await assertDecoyMetFirst(db);
		const decoyBefore = await constraintsOf(db, DECOY_TABLE);
		expect(decoyBefore.map(({ name }) => name)).toContain(KIND_CHECK);
		expect(await kindVerdicts(db, DECOY_TABLE)).toEqual(
			await kindVerdicts(db, TABLE),
		);

		await up(db);

		await assertDecoyMetFirst(db);
		expect(await constraintsOf(db, DECOY_TABLE)).toEqual(decoyBefore);
		expect(
			(await kindVerdicts(db, DECOY_TABLE)).find(
				({ value }) => value === "commtrack-off",
			),
		).toEqual({ value: "commtrack-off", admitted: false });
		expect(
			(await kindVerdicts(db, TABLE)).find(
				({ value }) => value === "commtrack-off",
			),
		).toEqual({ value: "commtrack-off", admitted: true });
		expect((await constraintsOf(db, TABLE)).map(({ name }) => name)).toContain(
			SUBJECT_CHECK,
		);
	});

	it("refuses to run down, since that would delete what people confirmed", async () => {
		await expect(down()).rejects.toThrow(/forward-only/);
	});
});
