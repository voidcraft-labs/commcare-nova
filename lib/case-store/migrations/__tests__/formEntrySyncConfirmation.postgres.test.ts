import { sql } from "kysely";
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
} from "../20261101010000_hq_round_trip_platforms_form_entry_sync";
import { checkConstraintVerdicts } from "./checkConstraint";

const MIGRATION = "20261101010000_hq_round_trip_platforms_form_entry_sync";
const KIND_CHECK = "app_deployment_confirmations_kind_check";
const SUBJECT_CHECK = "app_deployment_confirmations_form_entry_sync_subject";

/* Every migration before this one: the deployment ledger's confirmations
 * table with its unnamed kind CHECK, as the previous revision runs it. */
const database = setupPerTestDatabase({
	databaseNamePrefix: "form_entry_sync_migration_",
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

const DEPLOYMENT = "01992000-0000-7000-8000-000000000021";

async function seedDeployment(): Promise<void> {
	const doc = toPersistableDoc(canonicalTestBlueprint("app", "Published app"));
	await sql`INSERT INTO apps (id, owner, project_id, app_name, app_name_lower,
		module_count, form_count, mutation_seq, status, awaiting_input)
		VALUES ('app', 'owner', 'project', ${doc.appName}, ${doc.appName.toLowerCase()},
		${doc.moduleOrder.length}, ${Object.keys(doc.forms).length}, 0, 'complete', false)`.execute(
		database.db,
	);
	for (const row of decomposeBlueprint(doc)) {
		await sql`INSERT INTO blueprint_entities (app_id, uuid, kind, parent_uuid, ordinal, data)
			VALUES ('app', ${row.uuid}, ${row.kind}, ${row.parent_uuid}, ${row.ordinal}, ${JSON.stringify(row.data)}::jsonb)`.execute(
			database.db,
		);
	}
	const phases = {
		upload: { status: "succeeded", at: "2026-10-01T00:00:00Z" },
	};
	await sql`INSERT INTO app_deployments
		(id, app_id, project_id, server, domain, state, resume_phase, phases, created_by)
		VALUES (${DEPLOYMENT}::uuid, 'app', 'project', 'production', 'clinic', 'uploaded',
			NULL, ${JSON.stringify(phases)}::jsonb, 'owner')`.execute(database.db);
}

function confirm(kind: string, subject: string) {
	return sql`INSERT INTO app_deployment_confirmations
		(deployment_id, kind, subject, confirmed_by)
		VALUES (${DEPLOYMENT}::uuid, ${kind}, ${subject}, 'owner')`.execute(
		database.db,
	);
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
];

describe(MIGRATION, () => {
	it("admits the fourth kind beside the three the ledger had, and refuses any other", async () => {
		expect(
			await checkConstraintVerdicts(
				database.db,
				"app_deployment_confirmations",
				KIND_CHECK,
				"kind",
				KINDS,
			),
		).toEqual([
			{ value: "plan-feature", admitted: true },
			{ value: "flat-location-fixture", admitted: true },
			{ value: "connect-forwarder", admitted: true },
			{ value: "form-entry-sync-off", admitted: false },
			{ value: "commtrack-off", admitted: false },
		]);

		await up(database.db);

		expect(
			await checkConstraintVerdicts(
				database.db,
				"app_deployment_confirmations",
				KIND_CHECK,
				"kind",
				KINDS,
			),
		).toEqual([
			{ value: "plan-feature", admitted: true },
			{ value: "flat-location-fixture", admitted: true },
			{ value: "connect-forwarder", admitted: true },
			{ value: "form-entry-sync-off", admitted: true },
			{ value: "commtrack-off", admitted: false },
		]);
	});

	it("stores the new kind only under its own name, and keeps every row the previous revision wrote", async () => {
		await seedDeployment();
		await confirm("plan-feature", "lookup-tables");
		await confirm("flat-location-fixture", "flat-location-fixture");
		await confirm("connect-forwarder", "connect-forwarder");

		await up(database.db);

		await refusal(confirm("form-entry-sync-off", "connect-forwarder"));
		await refusal(confirm("form-entry-sync-off", "web-apps"));
		await confirm("form-entry-sync-off", "form-entry-sync-off");
		const rows = await sql<{ kind: string; subject: string }>`
			SELECT kind, subject FROM app_deployment_confirmations ORDER BY kind, subject
		`.execute(database.db);
		expect(rows.rows).toEqual([
			{ kind: "connect-forwarder", subject: "connect-forwarder" },
			{ kind: "flat-location-fixture", subject: "flat-location-fixture" },
			{ kind: "form-entry-sync-off", subject: "form-entry-sync-off" },
			{ kind: "plan-feature", subject: "lookup-tables" },
		]);
		const installed = await sql<{ name: string }>`
			SELECT conname AS name FROM pg_constraint
			WHERE conrelid = 'app_deployment_confirmations'::regclass AND conname = ${SUBJECT_CHECK}
		`.execute(database.db);
		expect(installed.rows).toEqual([{ name: SUBJECT_CHECK }]);
	});

	it("refuses to run down, since that would delete what people confirmed", async () => {
		await expect(down()).rejects.toThrow(/forward-only/);
	});
});
