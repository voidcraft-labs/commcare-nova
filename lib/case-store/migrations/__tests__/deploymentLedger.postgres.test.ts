import { sql } from "kysely";
import { Migrator } from "kysely/migration";
import { describe, expect, it } from "vitest";
import { canonicalTestBlueprint } from "@/lib/db/__tests__/appStateTestDb";
import { decomposeBlueprint } from "@/lib/db/blueprintRows";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { setupPerTestDatabase } from "../../sql/__tests__/perTestDatabase";
import { caseStoreMigrations } from "..";
import { up } from "../20261015020000_hq_round_trip_deployment_ledger";

const database = setupPerTestDatabase({
	databaseNamePrefix: "deployment_ledger_migration_",
	prepareTemplate: async (db) => {
		const result = await new Migrator({
			db,
			provider: {
				getMigrations: async () =>
					Object.fromEntries(
						Object.entries(caseStoreMigrations).filter(
							([name]) =>
								name < "20261015020000_hq_round_trip_deployment_ledger",
						),
					),
			},
		}).migrateToLatest();
		if (result.error !== undefined) throw result.error;
	},
});

const FAILED_UPLOAD = "01992000-0000-7000-8000-000000000001";
const REACHED = "01992000-0000-7000-8000-000000000002";
const NEVER_MAPPED = "01992000-0000-7000-8000-000000000003";
const DIGEST = "a".repeat(64);

async function seedApp() {
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
}

async function seedDeployment(
	id: string,
	domain: string,
	upload: "failed" | "succeeded",
) {
	const phases =
		upload === "failed"
			? {
					upload: {
						status: "failed",
						at: "2026-09-06T00:00:00Z",
						failure: {
							code: "remote_app_missing",
							message: "The app is gone.",
							details: [],
						},
					},
				}
			: { upload: { status: "succeeded", at: "2026-09-06T00:00:00Z" } };
	await sql`INSERT INTO app_deployments
		(id, app_id, project_id, server, domain, state, resume_phase, phases, created_by)
		VALUES (${id}::uuid, 'app', 'project', 'production', ${domain},
			${upload === "failed" ? "incomplete" : "uploaded"},
			${upload === "failed" ? "upload" : null},
			${JSON.stringify(phases)}::jsonb, 'owner')`.execute(database.db);
}

async function seedMapping(
	deploymentId: string,
	kind: "app" | "lookup-table",
	remoteId: string,
	superseded: boolean,
) {
	await sql`INSERT INTO app_deployment_resources
		(deployment_id, kind, nova_resource_id, remote_id, ownership,
			pushed_identity, pushed_at, pushed_revision, superseded_at)
		VALUES (${deploymentId}::uuid, ${kind}, ${kind === "app" ? "app" : "table"},
			${remoteId}, 'nova-created', ${kind === "app" ? null : "districts"},
			'2026-09-06T00:00:00Z', 1, ${superseded ? "2026-09-06T00:00:00Z" : null})`.execute(
		database.db,
	);
}

async function missingByRemoteId() {
	return (
		await sql<{ remote_id: string; missing: boolean }>`
			SELECT remote_id, remote_missing_at IS NOT NULL AS missing
			FROM app_deployment_resources ORDER BY remote_id`.execute(database.db)
	).rows;
}

async function seedPublishedShapes() {
	await seedApp();
	await seedDeployment(FAILED_UPLOAD, "failed", "failed");
	await seedMapping(FAILED_UPLOAD, "app", "hq-live", false);
	await seedMapping(FAILED_UPLOAD, "app", "hq-old", true);
	await seedMapping(FAILED_UPLOAD, "lookup-table", "hq-table", false);
	await seedDeployment(REACHED, "reached", "succeeded");
	await seedMapping(REACHED, "app", "hq-reached", false);
	await seedDeployment(NEVER_MAPPED, "never-mapped", "failed");
}

async function refusal(statement: Promise<unknown>) {
	return expect(statement).rejects.toMatchObject({
		code: expect.stringMatching(/^23/),
	});
}

describe("deployment ledger migration", () => {
	it("marks exactly a live app mapping beside a failed upload as gone", async () => {
		await seedPublishedShapes();
		await database.db.transaction().execute(up);

		expect(await missingByRemoteId()).toEqual([
			{ remote_id: "hq-live", missing: true },
			{ remote_id: "hq-old", missing: false },
			{ remote_id: "hq-reached", missing: false },
			{ remote_id: "hq-table", missing: false },
		]);
		const neverMapped = await sql<{ count: number }>`
			SELECT count(*)::int AS count FROM app_deployment_resources
			WHERE deployment_id = ${NEVER_MAPPED}::uuid`.execute(database.db);
		expect(neverMapped.rows).toEqual([{ count: 0 }]);
		const columns = await sql<Record<string, unknown>>`
			SELECT offered_logo_content_hash, target_empty_case_list_text,
				target_web_apps_enabled
			FROM app_deployments ORDER BY id`.execute(database.db);
		expect(columns.rows).toEqual(
			Array.from({ length: 3 }, () => ({
				offered_logo_content_hash: null,
				target_empty_case_list_text: null,
				target_web_apps_enabled: null,
			})),
		);
	});

	it("keeps the gone fact to app mappings", async () => {
		await seedPublishedShapes();
		await database.db.transaction().execute(up);
		await sql`UPDATE app_deployment_resources SET remote_missing_at = now()
			WHERE remote_id = 'hq-reached'`.execute(database.db);
		await refusal(
			sql`UPDATE app_deployment_resources SET remote_missing_at = now()
				WHERE remote_id = 'hq-table'`.execute(database.db),
		);
	});

	it("refuses every ledger row its constraints name", async () => {
		await seedPublishedShapes();
		await database.db.transaction().execute(up);

		await refusal(
			sql`INSERT INTO app_deployment_identities
				(deployment_id, entity_kind, nova_entity_uuid)
				VALUES (${REACHED}::uuid, 'form', gen_random_uuid())`.execute(
				database.db,
			),
		);
		await refusal(
			sql`INSERT INTO app_deployment_identities
				(deployment_id, entity_kind, nova_entity_uuid, xmlns)
				VALUES (${REACHED}::uuid, 'module', gen_random_uuid(),
					'http://openrosa.org/formdesigner/a')`.execute(database.db),
		);
		await sql`INSERT INTO app_deployment_identities
			(deployment_id, entity_kind, nova_entity_uuid, unique_id, xmlns)
			VALUES (${REACHED}::uuid, 'form', gen_random_uuid(), 'form-a',
				'http://openrosa.org/formdesigner/a')`.execute(database.db);
		await refusal(
			sql`INSERT INTO app_deployment_identities
				(deployment_id, entity_kind, nova_entity_uuid, xmlns)
				VALUES (${REACHED}::uuid, 'form', gen_random_uuid(),
					'http://openrosa.org/formdesigner/a')`.execute(database.db),
		);

		const confirm = (kind: string, subject: string) =>
			sql`INSERT INTO app_deployment_confirmations
				(deployment_id, kind, subject, confirmed_by)
				VALUES (${REACHED}::uuid, ${kind}, ${subject}, 'owner')`.execute(
				database.db,
			);
		await confirm("connect-forwarder", "connect-forwarder");
		await refusal(confirm("connect-forwarder", "connect-forwarder"));
		await refusal(confirm("connect-forwarder", "data-forwarding"));
		await refusal(confirm("flat-location-fixture", "user-case"));
		await sql`UPDATE app_deployment_confirmations
			SET withdrawn_by = 'owner', withdrawn_at = now()`.execute(database.db);
		await confirm("connect-forwarder", "connect-forwarder");
		await refusal(
			sql`UPDATE app_deployment_confirmations SET withdrawn_at = now()
				WHERE withdrawn_at IS NULL`.execute(database.db),
		);

		await refusal(
			sql`INSERT INTO app_deployment_baselines
				(deployment_id, remote_app_id, origin, source_gzip, source_bytes,
					source_digest, ownership, observed_at, observed_by)
				VALUES (${REACHED}::uuid, 'hq-reached', 'unread', '\\x00'::bytea, 1,
					${DIGEST}, '{}'::jsonb, now(), 'owner')`.execute(database.db),
		);
		await refusal(
			sql`INSERT INTO app_deployment_baselines
				(deployment_id, remote_app_id, origin, observed_at, observed_by,
					discarded_digest)
				VALUES (${REACHED}::uuid, 'hq-reached', 'unread', now(), 'owner',
					${DIGEST})`.execute(database.db),
		);
		await sql`INSERT INTO app_deployment_baselines
			(deployment_id, remote_app_id, origin, observed_at, observed_by)
			VALUES (${REACHED}::uuid, 'hq-reached', 'unread', now(), 'owner')`.execute(
			database.db,
		);

		const resourceBaseline = (origin: string, canonical: string | null) =>
			sql`INSERT INTO project_space_resource_baselines
				(project_id, server, domain, kind, remote_id, origin, canonical,
					digest, observed_at, observed_by, observed_from_app_id)
				VALUES ('project', 'production', 'reached', 'location', 'place-1',
					${origin}, ${canonical}::jsonb,
					${canonical === null ? null : DIGEST}, now(), 'owner', 'app')`.execute(
				database.db,
			);
		await refusal(resourceBaseline("unread", "{}"));
		await refusal(resourceBaseline("push", null));
		await resourceBaseline("push", "{}");
		await refusal(
			sql`UPDATE project_space_resource_baselines
				SET discarded_digest = ${DIGEST}`.execute(database.db),
		);
	});
});
