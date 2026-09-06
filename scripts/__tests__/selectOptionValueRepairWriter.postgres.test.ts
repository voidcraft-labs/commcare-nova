import { sql } from "kysely";
import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { loadSchemaAdmittedAppForInspection } from "@/lib/db/apps";
import { opaqueXPathExpression } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { runSelectOptionValueRepair } from "../lib/selectOptionValueRepair";

const h = setupAppStateTestDb();

function fixture(dataType: "single_select" | "multi_select" = "single_select") {
	return buildDoc({
		appName: "Clients",
		caseTypes: [
			{
				name: "client",
				properties: [
					{
						name: "stage",
						label: "Stage",
						data_type: dataType,
						options: [
							{ value: "in progress", label: "In progress" },
							{ value: "done", label: "Done" },
						],
					},
				],
			},
		],
		modules: [
			{
				name: "Clients",
				caseType: "client",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Register",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "name",
								caseWrite: { caseType: "client", property: "case_name" },
							}),
						],
					},
					{
						name: "Update",
						type: "followup",
						fields: [
							f({
								kind: dataType,
								id: "stage",
								caseWrite: { caseType: "client", property: "stage" },
								optionsSource: {
									kind: "inline",
									options: [
										{
											uuid: testUuid("stage-progress"),
											value: "in progress",
											label: proseText("In progress"),
										},
										{
											uuid: testUuid("stage-done"),
											value: "done",
											label: proseText("Done"),
										},
									],
								},
							}),
						],
					},
				],
			},
		],
	});
}

async function seedCase(appId: string) {
	await sql`INSERT INTO cases (app_id, project_id, case_id, case_type, owner_id, case_name, properties)
		VALUES (${appId}, 'project-test', 'case-one', 'client', 'owner-test', 'Client', '{"stage":"in progress"}'::jsonb)`.execute(
		h.db(),
	);
}

it("rolls back document, history and case values together when a case-row write fails, then retries completely", async () => {
	const id = await h.seedAppWithBlueprint(fixture(), { id: "repair" });
	await seedCase(id);
	const before = await loadSchemaAdmittedAppForInspection(id);
	await sql`CREATE FUNCTION reject_case_repair() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'case-write-refused'; END $$`.execute(
		h.db(),
	);
	await sql`CREATE TRIGGER reject_case_repair BEFORE UPDATE ON cases FOR EACH ROW EXECUTE FUNCTION reject_case_repair()`.execute(
		h.db(),
	);
	const failed = await runSelectOptionValueRepair([id]);
	expect(failed).toMatchObject({
		repairedApps: 0,
		rewrittenCaseRows: 0,
		blockedApps: [
			{ appId: id, reason: expect.stringContaining("case-write-refused") },
		],
	});
	expect((await loadSchemaAdmittedAppForInspection(id))?.blueprint).toEqual(
		before?.blueprint,
	);
	expect(await h.db().selectFrom("app_changes").selectAll().execute()).toEqual(
		[],
	);
	await sql`DROP TRIGGER reject_case_repair ON cases`.execute(h.db());
	const repaired = await runSelectOptionValueRepair([id]);
	expect(repaired).toMatchObject({
		repairedApps: 1,
		rewrittenValues: 2,
		rewrittenCaseRows: 1,
		blockedApps: [],
	});
	const rows = await sql<{
		properties: unknown;
	}>`SELECT properties FROM cases WHERE app_id = ${id}`.execute(h.db());
	expect(rows.rows).toEqual([{ properties: { stage: "in_progress" } }]);
	expect(await runSelectOptionValueRepair([id])).toMatchObject({
		repairedApps: 0,
		rewrittenValues: 0,
		rewrittenCaseRows: 0,
	});
});

it("reports a real commit-gate refusal and still repairs the next selected app", async () => {
	const invalid = fixture();
	const field = Object.values(invalid.fields).find(
		(candidate) => candidate.kind === "text",
	);
	if (field === undefined) throw new Error("Missing text field");
	field.required = opaqueXPathExpression("here()");
	const blocked = await h.seedAppWithBlueprint(invalid, { id: "blocked" });
	const good = await h.seedAppWithBlueprint(fixture(), { id: "good" });
	const report = await runSelectOptionValueRepair([blocked, good]);
	expect(report).toMatchObject({
		scannedApps: 2,
		repairedApps: 1,
		rewrittenValues: 2,
		blockedApps: [{ appId: blocked, reason: expect.stringContaining("here") }],
	});
	expect(
		await h.db().selectFrom("app_changes").select("app_id").execute(),
	).toEqual([{ app_id: good }]);
});

it("rolls back a database write refusal and continues to the next app", async () => {
	const blocked = await h.seedAppWithBlueprint(fixture(), { id: "blocked" });
	const good = await h.seedAppWithBlueprint(fixture(), { id: "good" });
	await sql`CREATE FUNCTION reject_one_repair() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.app_id = 'blocked' THEN RAISE EXCEPTION 'history-write-refused'; END IF; RETURN NEW; END $$`.execute(
		h.db(),
	);
	await sql`CREATE TRIGGER reject_one_repair BEFORE INSERT ON app_changes FOR EACH ROW EXECUTE FUNCTION reject_one_repair()`.execute(
		h.db(),
	);
	const before = (await loadSchemaAdmittedAppForInspection(blocked))?.blueprint;
	const report = await runSelectOptionValueRepair([blocked, good]);
	expect(report).toMatchObject({
		scannedApps: 2,
		repairedApps: 1,
		blockedApps: [
			{
				appId: blocked,
				reason: expect.stringContaining("history-write-refused"),
			},
		],
	});
	expect(
		(await loadSchemaAdmittedAppForInspection(blocked))?.blueprint,
	).toEqual(before);
	expect(
		await h.db().selectFrom("app_changes").select("app_id").execute(),
	).toEqual([{ app_id: good }]);
});

it("fails on an unreadable snapshot before recording misleading per-app repair results", async () => {
	const id = await h.seedAppWithBlueprint(fixture());
	await h
		.db()
		.updateTable("blueprint_entities")
		.set({ data: JSON.stringify({ kind: "not-a-field" }) })
		.where("app_id", "=", id)
		.where("kind", "=", "field")
		.execute();
	await expect(runSelectOptionValueRepair([id])).rejects.toThrow();
	expect(await h.db().selectFrom("app_changes").selectAll().execute()).toEqual(
		[],
	);
});

it("preserves ordered multi-select members and limits row changes to the repaired app", async () => {
	const id = await h.seedAppWithBlueprint(fixture("multi_select"), {
		id: "selected",
	});
	const other = await h.seedAppWithBlueprint(fixture("multi_select"), {
		id: "other",
	});
	for (const appId of [id, other]) {
		await sql`INSERT INTO cases (app_id, project_id, case_id, case_type, owner_id, case_name, properties)
			VALUES (${appId}, 'project-test', ${`case-${appId}`}, 'client', 'owner-test', 'Client', '{"stage":["done","in progress","done"],"other":"untouched"}'::jsonb)`.execute(
			h.db(),
		);
	}
	const before = await sql<{
		app_id: string;
		modified_on: Date;
	}>`SELECT app_id, modified_on FROM cases ORDER BY app_id`.execute(h.db());
	expect(await runSelectOptionValueRepair([id])).toMatchObject({
		repairedApps: 1,
		rewrittenCaseRows: 1,
		blockedApps: [],
	});
	const rows = await sql<{
		app_id: string;
		properties: unknown;
	}>`SELECT app_id, properties FROM cases ORDER BY app_id`.execute(h.db());
	expect(rows.rows).toEqual([
		{
			app_id: "other",
			properties: {
				stage: ["done", "in progress", "done"],
				other: "untouched",
			},
		},
		{
			app_id: "selected",
			properties: {
				stage: ["done", "in_progress", "done"],
				other: "untouched",
			},
		},
	]);
	expect(
		(
			await sql`SELECT app_id, modified_on FROM cases ORDER BY app_id`.execute(
				h.db(),
			)
		).rows,
	).toEqual(before.rows);
});
