import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { makeToolWorkspaceHarness } from "@/lib/agent/__tests__/fixtures";
import { evaluateFormTool } from "@/lib/agent/tools/evaluateForm";
import { getAuthDb } from "@/lib/auth/db";
import {
	buildCaseTypeMap,
	withProjectContext,
	withSchemaContext,
} from "@/lib/case-store";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { plainColumn, proseText, simpleSearchInputDef } from "@/lib/domain";
import { count } from "@/lib/domain/expression";
import { SEARCH_READING } from "@/lib/domain/expression/temporalType";
import { createEvaluationApp } from "@/lib/preview/engine/__tests__/evaluationFixture";
import { loadFormEvaluationContext } from "../evaluationContext";

const h = setupAppStateTestDb("authoring_evaluation_", {
	authSchema: "migrated",
});
const actor = "evaluator";
const projectId = "evaluation-project";

it("uses the authorized worker's records and makes no case or blueprint writes", async () => {
	const source = await createEvaluationApp(
		[
			{
				name: "Loans",
				caseType: "loan",
				forms: [{ name: "Return", type: "close" }],
			},
		],
		[
			{
				toolName: "addFields",
				input: {
					moduleUuid: "Loans",
					formUuid: "Return",
					fields: [
						{
							kind: "text",
							id: "condition",
							label: "Condition",
							required: true,
							validate: {
								expr: "count(instance('casedb')/casedb/case[@case_type = 'loan'][@case_id != #loan/case_id][condition = #form/condition]) = 0",
								msg: "Another loan already has this condition.",
							},
							caseWrite: { caseType: "loan", property: "condition" },
						},
					],
				},
			},
			{
				toolName: "removeField",
				input: {
					moduleUuid: "Loans",
					formUuid: "Return",
					fieldUuid: "fixture_placeholder",
				},
			},
		],
	);
	const appId = await h.seedAppWithBlueprint(source, {
		owner: actor,
		projectId,
	});
	const doc = { ...source, appId };
	const schema = await withSchemaContext();
	await schema.applySchemaChange({
		appId,
		caseType: "loan",
		caseTypeSchemas: buildCaseTypeMap(doc),
	});
	await h.seedProjectMember("other-worker", projectId, "editor");
	const row = {
		case_type: "loan",
		case_name: "Drill",
		properties: { condition: "Good" },
		status: "open" as const,
		opened_on: new Date(),
		modified_on: new Date(),
		closed_on: null,
		external_id: null,
		parent_case_id: null,
	};
	const own = await withProjectContext(projectId, actor, actor);
	const ownCase = await own.insert({ appId, row });
	const other = await withProjectContext(
		projectId,
		"other-worker",
		"other-worker",
	);
	const otherCase = await other.insert({
		appId,
		row: { ...row, case_name: "Saw" },
	});
	const workspace = makeToolWorkspaceHarness(doc, {
		appId,
		userId: actor,
		projectId,
	}).workspace;
	const beforeRows = await own.query({
		reading: SEARCH_READING,
		appId,
		caseType: "loan",
	});
	const beforeApp = await h
		.db()
		.selectFrom("apps")
		.selectAll()
		.where("id", "=", appId)
		.executeTakeFirstOrThrow();
	const formUuid = Object.values(doc.forms).find(
		(form) => form.name === "Return",
	)?.uuid;
	const moduleUuid = doc.moduleOrder.find(
		(id) => doc.modules[id].name === "Loans",
	);
	if (!formUuid || !moduleUuid)
		throw new Error("Evaluation fixture is incomplete.");
	const outcome = await workspace.invoke({
		toolName: "evaluateForm",
		execute: (ctx) =>
			evaluateFormTool.execute(
				{
					moduleUuid,
					formUuid,
					answers: [{ path: "condition", value: "Worn" }],
					caseIds: [ownCase.caseId],
				},
				ctx,
			),
	});
	expect(outcome.data).toMatchObject({
		valid: true,
		proposedValues: {
			kind: "close",
			caseIds: [ownCase.caseId],
			patch: { properties: { condition: "Worn" } },
		},
	});
	expect(outcome.data).not.toHaveProperty("submission");
	expect(outcome.data).toHaveProperty("proposedValues", {
		kind: "close",
		caseIds: [ownCase.caseId],
		patch: { properties: { condition: "Worn" } },
	});
	const scenario = {
		records: [
			{ id: "example", caseType: "loan", properties: { condition: "Good" } },
			{
				id: "counterexample",
				caseType: "loan",
				properties: { condition: "Worn" },
			},
		],
	};
	const evaluateScenario = (caseId: string) =>
		workspace.invoke({
			toolName: "evaluateForm",
			execute: (ctx) =>
				evaluateFormTool.execute(
					{
						moduleUuid,
						formUuid,
						answers: [{ path: "condition", value: "Worn" }],
						caseIds: [caseId],
						scenario,
					},
					ctx,
				),
		});
	expect((await evaluateScenario("example")).data).toMatchObject({
		mode: "scenario",
		valid: false,
	});
	// Actual rows cannot satisfy a selection in the supplied population.
	expect((await evaluateScenario(ownCase.caseId)).data).toHaveProperty("error");
	scenario.records.pop();
	expect((await evaluateScenario("example")).data).toMatchObject({
		mode: "scenario",
		valid: true,
		proposedValues: {
			caseIds: ["example"],
			patch: { properties: { condition: "Worn" } },
		},
	});
	expect(
		await own.query({ reading: SEARCH_READING, appId, caseType: "loan" }),
	).toEqual(beforeRows);
	expect(
		await own.count({
			reading: SEARCH_READING,
			appId,
			caseType: "commcare-user",
		}),
	).toBe(0);
	expect(
		await h
			.db()
			.selectFrom("apps")
			.selectAll()
			.where("id", "=", appId)
			.executeTakeFirstOrThrow(),
	).toEqual(beforeApp);
	const refused = await workspace.invoke({
		toolName: "evaluateForm",
		execute: (ctx) =>
			evaluateFormTool.execute(
				{ moduleUuid, formUuid, answers: [], caseIds: [otherCase.caseId] },
				ctx,
			),
	});
	expect(refused.data).toHaveProperty("error");
	const foreign = makeToolWorkspaceHarness(doc, {
		appId,
		userId: actor,
		projectId: "different-project",
	}).workspace;
	await expect(
		foreign.invoke({
			toolName: "evaluateForm",
			execute: (ctx) => loadFormEvaluationContext(ctx),
		}),
	).rejects.toThrow();
	const auth = await getAuthDb();
	await auth
		.deleteFrom("auth_member")
		.where("userId", "=", actor)
		.where("organizationId", "=", projectId)
		.execute();
	await expect(
		workspace.invoke({
			toolName: "evaluateForm",
			execute: (ctx) => loadFormEvaluationContext(ctx, undefined, scenario),
		}),
	).rejects.toThrow();
});

it("runs the module's search for a form that reads what it found", async () => {
	const moduleUuid = testUuid("evaluation-search-module");
	const formUuid = testUuid("evaluation-search-form");
	const source = buildDoc({
		appName: "Search evaluation",
		caseTypes: [
			{
				name: "patient",
				properties: [{ name: "note", label: proseText("Note") }],
			},
		],
		modules: [
			{
				uuid: moduleUuid,
				name: "Patients",
				caseType: "patient",
				caseListConfig: {
					columns: [
						plainColumn(
							testUuid("evaluation-search-name"),
							"case_name",
							"Name",
						),
					],
					searchInputs: [
						simpleSearchInputDef(
							testUuid("evaluation-search-input"),
							"patient_name",
							"Patient name",
							"text",
							"case_name",
						),
					],
				},
				caseSearchConfig: { searchFirst: true },
				forms: [
					{
						uuid: formUuid,
						name: "Check in",
						type: "followup",
						fields: [
							f({
								kind: "hidden",
								id: "found",
								calculate: count({
									kind: "cases",
									source: "search-results",
									where: [],
								}),
							}),
						],
					},
				],
			},
		],
	});
	const appId = await h.seedAppWithBlueprint(source, {
		owner: actor,
		projectId,
	});
	const doc = { ...source, appId };
	const schema = await withSchemaContext();
	await schema.applySchemaChange({
		appId,
		caseType: "patient",
		caseTypeSchemas: buildCaseTypeMap(doc),
	});
	const own = await withProjectContext(projectId, actor, actor);
	const patient = (caseName: string) =>
		own.insert({
			appId,
			row: {
				case_type: "patient",
				case_name: caseName,
				status: "open",
				properties: {},
			},
		});
	const kofi = await patient("Kofi");
	await patient("Ama");
	const workspace = makeToolWorkspaceHarness(doc, {
		appId,
		userId: actor,
		projectId,
	}).workspace;
	const evaluate = (
		extra: Partial<Parameters<typeof evaluateFormTool.execute>[0]>,
	) =>
		workspace.invoke({
			toolName: "evaluateForm",
			execute: (ctx) =>
				evaluateFormTool.execute(
					{
						moduleUuid,
						formUuid,
						answers: [],
						caseIds: [kofi.caseId],
						...extra,
					},
					ctx,
				),
		});
	const found = (data: unknown) =>
		(data as { fields: { path: string; value?: string }[] }).fields.find(
			(field) => field.path === "found",
		)?.value;

	// With no answers the check presses Search with its defaults.
	const everyone = await evaluate({});
	expect(everyone.data).toMatchObject({
		searchResults: { matched: 2, held: 2 },
	});
	expect(found(everyone.data)).toBe("2");

	const searched = await evaluate({
		searchAnswers: [{ name: "patient_name", value: "Kofi" }],
	});
	expect(searched.data).toMatchObject({
		searchResults: { matched: 1, held: 1 },
	});
	expect(found(searched.data)).toBe("1");

	// Test records give a search nothing to run over.
	const scenario = await evaluate({
		caseIds: ["example"],
		scenario: { records: [{ id: "example", caseType: "patient" }] },
	});
	expect(scenario.data).toHaveProperty(
		"error",
		expect.stringContaining("Leave out the scenario"),
	);
});
