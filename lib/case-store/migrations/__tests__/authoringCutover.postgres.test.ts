import { randomUUID } from "node:crypto";
import { type Kysely, sql } from "kysely";
import { Migrator } from "kysely/migration";
import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { makeCanonicalGenesisDoc } from "@/lib/agent/__tests__/fixtures";
import { loadCanonicalBlueprintAtSequence } from "@/lib/agent/change-set/baseLoader";
import { decomposeBlueprint } from "@/lib/db/blueprintRows";
import type { AppDatabase } from "@/lib/db/pg";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { setFormSections } from "@/lib/doc/formSectionMutations";
import { applyMutations } from "@/lib/doc/mutations";
import { blueprintDocSchema, type PersistableDoc } from "@/lib/domain";
import {
	inspectAuthoringBaseline,
	repairAuthoringBaselineInTransaction,
} from "@/scripts/lib/repairAuthoringBaselines";
import { setupPerTestDatabase } from "../../sql/__tests__/perTestDatabase";
import { caseStoreMigrations } from "..";

const first = "20260914000000_authoring_plans";
const database = setupPerTestDatabase({
	databaseNamePrefix: "authoring_cutover_",
	establishLocalMigrationAuthority: true,
	prepareTemplate: async (db) => {
		const result = await new Migrator({
			db,
			provider: {
				getMigrations: async () =>
					Object.fromEntries(
						Object.entries(caseStoreMigrations).filter(
							([name]) => name < first,
						),
					),
			},
		}).migrateToLatest();
		if (result.error) throw result.error;
	},
});

function authoredApp(id: string): PersistableDoc {
	const doc = structuredClone(makeCanonicalGenesisDoc("Visits", id));
	const property = testUuid("cutover-user-property");
	const userType = testUuid("cutover-user-type");
	const persona = testUuid("cutover-persona");
	const level = testUuid("cutover-level");
	const placeProperty = testUuid("cutover-place-property");
	const automation = testUuid("cutover-automation");
	const formUuid = Object.values(doc.forms)[0]?.uuid;
	if (!formUuid) throw new Error("The canonical starter needs a form.");
	const group = testUuid("cutover-group");
	const repeat = testUuid("cutover-repeat");
	const question = testUuid("cutover-question");
	applyMutations(doc, [
		{
			kind: "addField",
			parentUuid: formUuid,
			field: { uuid: group, id: "details", kind: "group" },
		},
		{
			kind: "addField",
			parentUuid: group,
			field: {
				uuid: repeat,
				id: "visits",
				kind: "repeat",
				repeat_mode: "count_bound",
				repeat_count: { parts: [{ kind: "text", text: "2" }] },
			},
		},
		{
			kind: "addField",
			parentUuid: repeat,
			field: {
				uuid: question,
				id: "name",
				kind: "text",
				label: { parts: [{ kind: "text", text: "Name" }] },
			},
		},
	]);
	const sections = setFormSections(doc, formUuid, [
		{ fields: [...(doc.fieldOrder[formUuid] ?? [])] },
	]);
	if (!sections.ok) throw new Error(sections.reason);
	applyMutations(doc, sections.mutations);
	doc.caseTypes = [
		{
			name: "visit",
			properties: [
				{
					name: "state",
					label: { parts: [{ kind: "text", text: "State" }] },
					data_type: "text",
				},
			],
		},
	];
	applyMutations(doc, [
		{
			kind: "addUserProperty",
			property: {
				uuid: property,
				slug: "region",
				label: "Region",
				choices: ["north", "south"],
			},
		},
		{
			kind: "addUserType",
			userType: {
				uuid: userType,
				name: "Worker",
				values: { [property]: "north" },
			},
		},
		{
			kind: "addPersona",
			persona: {
				uuid: persona,
				name: "Asha",
				userTypeUuid: userType,
				values: { [property]: "south" },
			},
		},
		{ kind: "addLanguage", language: { language: "fra" } },
	]);
	doc.organizationLevels = {
		[level]: {
			uuid: level,
			code: "region",
			name: "Region",
			caseFlow: { workers: "none", ownsCases: false },
			addressBook: { reach: "own-branch" },
		},
	};
	doc.organizationLevelOrder = [level];
	doc.locationProperties = {
		[placeProperty]: {
			uuid: placeProperty,
			slug: "code",
			label: "Region code",
		},
	};
	doc.locationPropertyOrder = [placeProperty];
	doc.automations = {
		[automation]: {
			uuid: automation,
			kind: "case-update",
			name: "Resolve visits",
			caseType: "visit",
			criteriaOperator: "all",
			criteria: [],
			setupOnlyCriteria: [],
			closeCase: false,
			updates: [
				{
					uuid: testUuid("cutover-update"),
					target: { scope: "case", property: "state" },
					value: { kind: "literal", value: "resolved" },
				},
			],
		},
	};
	doc.automationOrder = [automation];
	return blueprintDocSchema.parse(toPersistableDoc(doc));
}

async function save(doc: PersistableDoc) {
	const db = database.db as Kysely<AppDatabase>;
	await db.transaction().execute(async (tx) => {
		await sql`INSERT INTO apps (id, owner, project_id, app_name, app_name_lower, case_types, localization, mutation_seq, run_id)
			VALUES (${doc.appId}, 'owner', 'project', ${doc.appName}, ${doc.appName.toLowerCase()},
				${JSON.stringify(doc.caseTypes)}::jsonb, ${JSON.stringify(doc.localization)}::jsonb, 1, 'genesis')`.execute(
			tx,
		);
		await tx
			.insertInto("blueprint_entities")
			.values(
				decomposeBlueprint(doc).map((row) => ({
					...row,
					app_id: doc.appId,
					data: JSON.stringify(row.data),
				})),
			)
			.execute();
		await sql`INSERT INTO app_changes (app_id, seq, batch_id, actor_id, kind, mutations, run_id)
			VALUES (${doc.appId}, 1, ${`genesis:${doc.appId}`}, 'owner', 'fold-baseline', '[]'::jsonb, 'genesis')`.execute(
			tx,
		);
		await sql`SELECT nova_insert_app_change_genesis_fold_baseline(${doc.appId})`.execute(
			tx,
		);
	});
}
async function snapshot(appId: string) {
	const result = await sql<{ snapshot: PersistableDoc }>`
		SELECT nova_current_app_change_fold_snapshot(${appId}) AS snapshot
	`.execute(database.db);
	return result.rows[0]?.snapshot;
}

it("upgrades the installed schema, preserves old history and records complete multilingual app births", async () => {
	const db = database.db as Kysely<AppDatabase>;
	const old = authoredApp("old-app");
	await save(old);
	const originalBaseline = await db
		.selectFrom("app_change_fold_baselines")
		.selectAll()
		.execute();
	// Reproduce the old SQL projection defect before installing its replacement.
	expect(await snapshot(old.appId)).not.toHaveProperty("localization");
	expect(await snapshot(old.appId)).not.toHaveProperty("automations");
	const sessionId = randomUUID();
	await sql`INSERT INTO design_sessions (id, proposed_app_id, owner_user_id, project_id, state, mode)
		VALUES (${sessionId}::uuid, 'proposed', 'owner', 'project', 'active', 'build')`.execute(
		db,
	);
	const result = await new Migrator({
		db: database.db,
		provider: { getMigrations: async () => caseStoreMigrations },
	}).migrateToLatest();
	if (result.error) throw result.error;
	expect(await snapshot(old.appId)).toEqual(old);
	expect(
		await db.selectFrom("app_change_fold_baselines").selectAll().execute(),
	).toEqual(originalBaseline);
	// The old projection cannot be used as a new authoring base. A read-only
	// scan exposes that fact; the operator advances the baseline atomically.
	expect(
		await db
			.transaction()
			.setIsolationLevel("repeatable read")
			.setAccessMode("read only")
			.execute((tx) => inspectAuthoringBaseline(tx, old.appId)),
	).toMatchObject({ status: "ready" });
	expect(
		await db.selectFrom("app_change_fold_baselines").selectAll().execute(),
	).toEqual(originalBaseline);
	await sql`INSERT INTO authoring_plans (session_id, revision) VALUES (${sessionId}::uuid, 1)`.execute(
		db,
	);
	await sql`INSERT INTO authoring_plan_revisions (session_id, revision, markdown, editor, run_id, request_id, request_digest)
		VALUES (${sessionId}::uuid, 1, 'Track visits.', 'migration', 'migration', 'migration', ${"a".repeat(64)})`.execute(
		db,
	);
	const workspaceId = randomUUID();
	await sql`INSERT INTO authoring_workspaces (id, design_session_id, plan_revision, kind, app_id, base_seq, base_project_id, base_snapshot_digest, owner_user_id, owner_run_id, status)
  VALUES (${workspaceId}::uuid, ${sessionId}::uuid, 1, 'app-edit', ${old.appId}, 1, 'project', ${"a".repeat(64)}, 'owner', 'old-run', 'open')`.execute(
		db,
	);
	await sql`UPDATE apps SET lock_run_id = 'held', lock_actor_user_id = 'owner', lock_expire_at = now() + interval '1 minute', run_holder_nonce = ${randomUUID()}::uuid WHERE id = ${old.appId}`.execute(
		db,
	);
	expect(
		await db
			.transaction()
			.execute((tx) => repairAuthoringBaselineInTransaction(tx, old.appId)),
	).toEqual({ appId: old.appId, status: "busy" });
	await sql`UPDATE apps SET lock_run_id = NULL, lock_actor_user_id = NULL, lock_expire_at = NULL, run_holder_nonce = NULL WHERE id = ${old.appId}`.execute(
		db,
	);
	for (const fault of [
		{
			table: "app_changes",
			declaration: "BEFORE INSERT",
			deferred: false,
			body: "IF NEW.batch_id = 'fold-baseline:unified-authoring' THEN NEW.actor_id := 'owner'; END IF; RETURN NEW;",
		},
		{
			table: "blueprint_entities",
			declaration: "BEFORE UPDATE",
			deferred: false,
			body: "IF OLD.kind = 'field' AND OLD.data ->> 'kind' = 'section' THEN RETURN NULL; END IF; RETURN NEW;",
		},
		{
			table: "app_change_fold_baselines",
			declaration: "AFTER INSERT",
			deferred: true,
			body: "RAISE EXCEPTION 'injected late repair failure';",
		},
	]) {
		await sql
			.raw(
				`CREATE FUNCTION test_authoring_repair_fault() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN ${fault.body} END $fn$`,
			)
			.execute(db);
		await sql
			.raw(
				`CREATE ${fault.deferred ? "CONSTRAINT " : ""}TRIGGER test_authoring_repair_fault ${fault.declaration} ON ${fault.table} ${fault.deferred ? "DEFERRABLE INITIALLY DEFERRED " : ""}FOR EACH ROW EXECUTE FUNCTION test_authoring_repair_fault()`,
			)
			.execute(db);
		try {
			await expect(
				db
					.transaction()
					.execute((tx) => repairAuthoringBaselineInTransaction(tx, old.appId)),
			).rejects.toMatchObject({ code: "P0001" });
			expect(
				Number(
					(
						await db
							.selectFrom("apps")
							.select("mutation_seq")
							.where("id", "=", old.appId)
							.executeTakeFirstOrThrow()
					).mutation_seq,
				),
			).toBe(1);
			expect(
				await db.selectFrom("app_change_fold_baselines").selectAll().execute(),
			).toEqual(originalBaseline);
			expect(
				await db
					.selectFrom("app_changes")
					.select("seq")
					.where("app_id", "=", old.appId)
					.execute(),
			).toHaveLength(1);
			expect(
				(
					await db
						.selectFrom("authoring_workspaces")
						.select("status")
						.where("id", "=", workspaceId)
						.executeTakeFirstOrThrow()
				).status,
			).toBe("open");
		} finally {
			await sql
				.raw(`DROP TRIGGER test_authoring_repair_fault ON ${fault.table}`)
				.execute(db);
			await sql`DROP FUNCTION test_authoring_repair_fault()`.execute(db);
		}
	}
	await db.transaction().execute(async (tx) => {
		expect(await repairAuthoringBaselineInTransaction(tx, old.appId)).toEqual({
			appId: old.appId,
			status: "repaired",
		});
	});
	expect(
		(
			await db
				.selectFrom("authoring_workspaces")
				.select("status")
				.where("id", "=", workspaceId)
				.executeTakeFirstOrThrow()
		).status,
	).toBe("abandoned");
	const repaired = await loadCanonicalBlueprintAtSequence(db, {
		appId: old.appId,
		seq: 2,
		expectedDigest: null,
	});
	expect(repaired.snapshot).toEqual(old);
	expect(
		await db
			.selectFrom("app_change_fold_baselines")
			.selectAll()
			.where("seq", "=", 1)
			.execute(),
	).toEqual(originalBaseline);
	expect(
		await db
			.transaction()
			.execute((tx) => repairAuthoringBaselineInTransaction(tx, old.appId)),
	).toEqual({ appId: old.appId, status: "current" });
	expect(
		await db
			.selectFrom("design_sessions")
			.select("authoring_version")
			.where("id", "=", sessionId)
			.executeTakeFirstOrThrow(),
	).toEqual({ authoring_version: 0 });
	const fresh = authoredApp("new-app");
	await save(fresh);
	expect(await snapshot(fresh.appId)).toEqual(fresh);
	const baseline = await db
		.selectFrom("app_change_fold_baselines")
		.select("snapshot")
		.where("app_id", "=", fresh.appId)
		.executeTakeFirstOrThrow();
	expect(baseline.snapshot).toEqual(fresh);
	// Historical Markdown is a permitted attribution after cutover; its revision remains immutable.

	await expect(
		sql`INSERT INTO authoring_plan_revisions (session_id, revision, markdown, editor, run_id, request_id, request_digest)
		VALUES (${sessionId}::uuid, 1, 'Replacement.', 'architect', 'run', 'duplicate', ${"b".repeat(64)})`.execute(
			db,
		),
	).rejects.toMatchObject({ code: "23505" });
});
