import { modelMessageSchema } from "ai";
import { sql } from "kysely";
import { expect, it } from "vitest";
import { z } from "zod";
import { makeAuthoringHarness } from "@/lib/agent/__tests__/authoringHarness";
import { makeDurableAuthoringHarness } from "@/lib/agent/__tests__/durableAuthoringHarness";
import { namedFormFixture } from "@/lib/agent/__tests__/namedFormFixture";
import { authoringFingerprint } from "@/lib/agent/authoring/fingerprints";
import { runSharedToolCall } from "@/lib/agent/authoring/sharedToolCall";
import { authoringToolSchema } from "@/lib/agent/authoring/toolSchema";
import { SHARED_TOOL_REGISTRY } from "@/lib/agent/sharedToolRegistry";
import { CanonicalMutationWorkspace } from "@/lib/agent/workspace/canonicalWorkspace";
import { appTestNamespace } from "@/lib/case-store/appTestNamespace";
import {
	HOST_MODULE,
	noMatchesDoc,
	REGISTER_FORM,
} from "@/lib/commcare/__tests__/noMatchesWireFixture";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { readAppTestSteps } from "@/lib/db/appTests";
import { collectTranslationUnits, makeTranslationUnitId } from "@/lib/domain";
import { createEvaluationApp } from "../../engine/__tests__/evaluationFixture";
import { sectionEntryDoc } from "../../engine/__tests__/fixtures/sectionEntry";
import { continueAppTest, startAppTest } from "../service";
import type { AppTestAction } from "../types";

const h = setupAppStateTestDb("app_test_journey_", { authSchema: "migrated" });
const scope = {
	appId: "equipment-app",
	projectId: "equipment-project",
	actorUserId: "author",
};

const stepSchema = z.object({
	testId: z.string(),
	step: z.number(),
	observation: z.record(z.string(), z.unknown()),
});

it("commits a registration and finishes in one batch with replayable evidence and no retained test records", async () => {
	const doc = await createEvaluationApp(
		[
			{
				name: "Clients",
				caseType: "client",
				forms: [{ name: "Register", type: "registration" }],
			},
		],
		[
			{
				toolName: "addFields",
				input: {
					moduleUuid: "Clients",
					formUuid: "Register",
					fields: [{ id: "name", kind: "text", label: "Name", required: true }],
				},
			},
			{
				toolName: "updateForm",
				input: {
					moduleUuid: "Clients",
					formUuid: "Register",
					recordName: "#form/name",
				},
			},
			{
				toolName: "removeField",
				input: {
					moduleUuid: "Clients",
					formUuid: "Register",
					fieldUuid: "fixture_placeholder",
				},
			},
		],
	);
	await h.seedProjectMember(scope.actorUserId, scope.projectId, "viewer");
	await h.seedAppWithBlueprint(doc, {
		id: scope.appId,
		owner: scope.actorUserId,
		projectId: scope.projectId,
	});
	const call = sharedJourneyCalls(doc);
	const started = stepSchema.parse(
		await call("startAppTest", { purpose: "Register and finish atomically" }),
	);
	await call("continueAppTest", {
		testId: started.testId,
		expectedStep: 0,
		actions: [
			{ action: { kind: "menu", moduleUuid: "Clients" } },
			{ action: { kind: "form", formUuid: "Register" } },
		],
	});
	const input = {
		testId: started.testId,
		expectedStep: 2,
		actions: [
			{
				action: { kind: "answer", answers: [{ path: "name", value: "Maya" }] },
			},
			{ action: { kind: "submit" }, expect: { submitted: true } },
			{ action: { kind: "finish" } },
		],
	};
	const beforeCases = (
		await sql`SELECT * FROM ${sql.id(appTestNamespace(started.testId), "cases")}`.execute(
			h.db(),
		)
	).rows;
	// Fail after the namespace has been dropped but before its response receipt
	// persists: the entire answer/submit/finish call must still roll back.
	await sql`CREATE FUNCTION reject_disposal_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'receipt persistence failed'; END $$`.execute(
		h.db(),
	);
	await sql`CREATE TRIGGER reject_disposal_receipt BEFORE INSERT ON app_test_requests
  FOR EACH ROW WHEN (NEW.request_id = 'register-and-finish') EXECUTE FUNCTION reject_disposal_receipt()`.execute(
		h.db(),
	);
	await expect(
		call("continueAppTest", input, "register-and-finish"),
	).rejects.toThrow("receipt persistence failed");
	const rolledBack = await readAppTestSteps({
		...scope,
		testId: started.testId,
	});
	expect(rolledBack).toMatchObject({ step: 2, disposed_at: null });
	expect(rolledBack.steps.map((step) => step.step)).toEqual([0, 1, 2]);
	expect(
		(
			await sql`SELECT * FROM ${sql.id(appTestNamespace(started.testId), "cases")}`.execute(
				h.db(),
			)
		).rows,
	).toEqual(beforeCases);
	expect(
		(
			await sql`SELECT 1 FROM ${sql.id(appTestNamespace(started.testId), "form_submission_intents")}`.execute(
				h.db(),
			)
		).rows,
	).toEqual([]);
	expect(
		await h
			.db()
			.selectFrom("app_test_requests")
			.select("request_id")
			.where("test_id", "=", started.testId)
			.where("request_id", "=", "register-and-finish")
			.execute(),
	).toEqual([]);
	await sql`DROP TRIGGER reject_disposal_receipt ON app_test_requests`.execute(
		h.db(),
	);
	const response = await call("continueAppTest", input, "register-and-finish");
	expect(response).toMatchObject({
		step: 5,
		observation: { ended: true },
		results: [
			{ step: 3 },
			{
				step: 4,
				observation: {
					savedInTest: true,
					evidence: { caseTransaction: "committed" },
				},
			},
			{ step: 5, observation: { ended: true } },
		],
	});
	expect(await call("continueAppTest", input, "register-and-finish")).toEqual(
		response,
	);
	const history = await readAppTestSteps({ ...scope, testId: started.testId });
	expect(history.disposed_at).not.toBeNull();
	expect(history.steps.map((step) => step.step)).toEqual([0, 1, 2, 3, 4, 5]);
	expect(history.steps[4].observation).toMatchObject({ savedInTest: true });
	expect(
		(
			await sql`SELECT 1 FROM pg_namespace WHERE nspname = ${appTestNamespace(started.testId)}`.execute(
				h.db(),
			)
		).rows,
	).toEqual([]);
	expect(
		(
			await sql`SELECT 1 FROM public.cases WHERE app_id = ${scope.appId}`.execute(
				h.db(),
			)
		).rows,
	).toEqual([]);
});

function sharedJourneyCalls(doc: import("@/lib/domain").BlueprintDoc) {
	const author = makeAuthoringHarness(
		{
			appId: scope.appId,
			projectId: scope.projectId,
			userId: scope.actorUserId,
		},
		doc,
	);
	const workspace = new CanonicalMutationWorkspace({
		host: author.host,
		initialDoc: doc,
		baseSeq: 0,
	});
	return async (name: string, input: unknown, requestId?: string) => {
		const entry = SHARED_TOOL_REGISTRY.find((entry) => entry.saName === name);
		if (!entry) throw new Error("Missing shared tool");
		return workspace.invoke({
			toolName: name,
			requestId,
			execute: async (ctx) => {
				const result = await runSharedToolCall(
					entry,
					authoringToolSchema(name, entry.tool.inputSchema).authored.parse(
						input,
					),
					ctx,
				);
				if (result.kind !== "read")
					throw new Error("Expected a journey observation");
				return result.data;
			},
		});
	};
}

it.each([false, true])(
	"admits registration only after an empty search, preserving its return behavior (app home: %s)",
	async (home) => {
		const doc = noMatchesDoc();
		if (home) doc.forms[REGISTER_FORM].postSubmit = "app_home";
		await h.seedProjectMember(scope.actorUserId, scope.projectId, "viewer");
		await h.seedAppWithBlueprint(doc, {
			id: scope.appId,
			owner: scope.actorUserId,
			projectId: scope.projectId,
		});
		let current = await startAppTest(scope, {
			requestId: "start",
			expectedBlueprintSeq: 0,
			input: { purpose: "Search before registering" },
		});
		let request = 0;
		const step = async (action: AppTestAction) => {
			current = await continueAppTest(scope, {
				testId: current.testId,
				requestId: `step-${++request}`,
				expectedStep: current.step,
				action,
			});
			return current.observation;
		};
		expect(await step({ kind: "menu", moduleUuid: HOST_MODULE })).toMatchObject(
			{ screen: "search" },
		);
		expect(await step({ kind: "form", formUuid: REGISTER_FORM })).toMatchObject(
			{ completed: false },
		);
		expect(
			await step({
				kind: "search",
				answers: [{ name: "patient_name", value: "Maya" }],
			}),
		).toMatchObject({
			results: { kind: "empty" },
			registration: { uuid: REGISTER_FORM },
		});
		expect(await step({ kind: "form", formUuid: REGISTER_FORM })).toMatchObject(
			{
				questions: expect.arrayContaining([
					expect.objectContaining({ value: "Maya" }),
				]),
			},
		);
		await step({
			kind: "answer",
			answers: [{ path: "case_name", value: "Corrected name" }],
		});
		const saved = await step({ kind: "submit" });
		expect(saved.savedInTest).toBe(true);
		if (home) expect(saved.screen).toBe("home");
		else {
			expect(saved).toMatchObject({
				screen: "results",
				results: {
					kind: "rows",
					rows: [expect.objectContaining({ case_name: "Corrected name" })],
				},
			});
			expect(saved.registration).toBeUndefined();
		}
	},
);

it("starts at visible entry, preserves answers between calls and persists a close only in disposable records", async () => {
	const doc = await createEvaluationApp(
		[
			{
				name: "Equipment",
				caseType: "equipment",
				forms: [
					{ name: "Register", type: "registration" },
					{ name: "Retire", type: "close" },
				],
			},
		],
		[
			{
				toolName: "addFields",
				input: {
					moduleUuid: "Equipment",
					formUuid: "Register",
					fields: [
						{
							kind: "text",
							id: "name",
							label: "Equipment name",
							required: true,
						},
					],
				},
			},
			{
				toolName: "updateForm",
				input: {
					moduleUuid: "Equipment",
					formUuid: "Register",
					recordName: "#form/name",
				},
			},
			{
				toolName: "removeField",
				input: {
					moduleUuid: "Equipment",
					formUuid: "Register",
					fieldUuid: "fixture_placeholder",
				},
			},
			{
				toolName: "addFields",
				input: {
					moduleUuid: "Equipment",
					formUuid: "Retire",
					fields: [
						{
							kind: "text",
							id: "reason",
							label: "Reason for retirement",
							required: true,
							caseWrite: {
								caseType: "equipment",
								property: "retirement_reason",
							},
						},
					],
				},
			},
			{
				toolName: "removeField",
				input: {
					moduleUuid: "Equipment",
					formUuid: "Retire",
					fieldUuid: "fixture_placeholder",
				},
			},
		],
	);
	await h.seedProjectMember(scope.actorUserId, scope.projectId, "viewer");
	await h.seedAppWithBlueprint(doc, {
		id: scope.appId,
		owner: scope.actorUserId,
		projectId: scope.projectId,
	});
	const call = sharedJourneyCalls(doc);
	let current = stepSchema.parse(
		await call("startAppTest", {
			purpose: "Register equipment, retire it, and check the next task.",
		}),
	);
	expect(current.observation.suppliedRecords).toEqual([]);
	const testId = current.testId;
	const step = async (action: AppTestAction) => {
		const args = {
			testId,
			expectedStep: current.step,
			action,
		};
		current = stepSchema.parse(await call("continueAppTest", args));
		expect(current.observation.error).toBeUndefined();
		return current.observation;
	};
	expect(current.observation).toMatchObject({
		screen: "home",
		worker: { personaUuid: null },
	});
	const moduleUuid = doc.moduleOrder.find(
		(uuid) => doc.modules[uuid].name === "Equipment",
	);
	const register = Object.values(doc.forms).find(
		(form) => form.name === "Register",
	);
	const retire = Object.values(doc.forms).find(
		(form) => form.name === "Retire",
	);
	if (!moduleUuid || !register || !retire)
		throw new Error("Fixture is incomplete.");
	await step({ kind: "menu", moduleUuid });
	const opened = await step({ kind: "form", formUuid: register.uuid });
	expect(opened).toMatchObject({ screen: "form", valid: false });
	expect(opened.questions).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				label: "Equipment name",
				required: true,
				visible: true,
			}),
		]),
	);
	await step({
		kind: "answer",
		answers: [{ path: "name", value: "Clinic pump" }],
	});
	const registration = await step({ kind: "submit" });
	expect(registration.savedInTest).toBe(true);
	const effects = registration.effects as { primaryCaseIds: string[] };
	const id = effects.primaryCaseIds[0];
	expect(id).toBeTruthy();
	await step({ kind: "home" });
	await step({ kind: "menu", moduleUuid });
	await step({ kind: "form", formUuid: retire.uuid });
	expect(await step({ kind: "select", caseIds: [id] })).toMatchObject({
		screen: "details",
		canContinue: true,
	});
	const selected = await step({ kind: "continue" });
	expect(selected).toMatchObject({ screen: "form", name: "Retire" });
	await step({
		kind: "answer",
		answers: [{ path: "reason", value: "Broken seal" }],
	});
	const closed = await step({ kind: "submit" });
	expect(closed).toMatchObject({
		savedInTest: true,
		effects: {
			caseDatabasePatch: {
				rows: expect.arrayContaining([
					expect.objectContaining({
						case_id: id,
						status: "closed",
						properties: expect.objectContaining({
							retirement_reason: "Broken seal",
						}),
					}),
				]),
			},
		},
	});
	const synced = await step({ kind: "sync" });
	expect(synced.availableRecords).not.toEqual(
		expect.arrayContaining([expect.objectContaining({ id })]),
	);
	const live = await sql<{
		count: string;
	}>`SELECT count(*)::text AS count FROM cases WHERE app_id = ${scope.appId}`.execute(
		h.db(),
	);
	expect(live.rows[0].count).toBe("0");
	await step({ kind: "finish" });
	const evidence = await readAppTestSteps({ ...scope, testId, limit: 20 });
	expect(evidence.steps).toHaveLength(current.step + 1);
	expect(evidence.steps[0].observation?.suppliedRecords).toEqual([]);
	// A recorded journey must be usable by the next real model step, including
	// database timestamps after disposal. SDK JSON output rejects Date objects.
	const listed = await call("readAppTest", {});
	expect(listed).toMatchObject({
		tests: [
			expect.objectContaining({
				id: testId,
				purpose: "Register equipment, retire it, and check the next task.",
				step: current.step,
			}),
		],
	});
	const toolEvidence = await call("readAppTest", { testId });
	for (const evidence of [listed, toolEvidence]) {
		expect(() =>
			modelMessageSchema.parse({
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolName: "readAppTest",
						toolCallId: "history",
						output: { type: "json", value: evidence },
					},
				],
			}),
		).not.toThrow();
	}
});

it("requires a saved role and parent selection, then executes additional operations before opening the next form", async () => {
	// This fixture exercises the saved journey, not private authoring persistence.
	const author = makeAuthoringHarness(
		{},
		namedFormFixture([
			{
				name: "Households",
				caseType: "household",
				forms: [{ name: "Visit", type: "followup" }],
			},
			{
				name: "Equipment",
				caseType: "equipment",
				forms: [
					{ name: "Inspect", type: "followup" },
					{ name: "Receipt", type: "survey" },
				],
			},
		]),
	);
	const write = async (name: string, input: unknown) =>
		expect(await author.call(name, input)).toMatchObject({ ok: true });
	await write("addUserProperties", {
		properties: [
			{ slug: "role_code", label: "Role", required: true },
			{ slug: "last_inspection", label: "Last inspection" },
		],
	});
	await write("addUserTypes", {
		userTypes: [
			{
				name: "Inspector",
				values: [{ userPropertyUuid: "role_code", value: "inspector" }],
			},
		],
	});
	await write("addPersonas", {
		personas: [{ name: "Inspection worker", userTypeUuid: "Inspector" }],
	});
	await write("addFields", {
		formUuid: "Visit",
		moduleUuid: "Households",
		fields: [{ kind: "label", id: "intro", label: "Select this household" }],
	});
	await write("addFields", {
		formUuid: "Inspect",
		moduleUuid: "Equipment",
		fields: [
			{
				kind: "text",
				id: "condition",
				label: "Condition",
				required: true,
				caseWrite: { caseType: "equipment", property: "condition" },
			},
			{ kind: "text", id: "note", label: "Temporary note" },
			{
				kind: "text",
				id: "worker_note",
				label: "Worker note",
				caseWrite: {
					caseType: "commcare-user",
					property: "last_inspection",
				},
			},
		],
	});
	await write("setCaseTypeParent", {
		caseType: "equipment",
		parentType: "household",
	});
	await write("updateModule", {
		moduleUuid: "Equipment",
		parentCaseModuleUuid: "Households",
		displayCondition: "#user/role_code = 'inspector'",
	});
	await write("updateModule", {
		moduleUuid: "Households",
		displayCondition: "#user/role_code = 'inspector'",
	});
	await write("updateForm", {
		moduleUuid: "Equipment",
		formUuid: "Receipt",
		post_submit: "previous",
	});
	await write("addFields", {
		formUuid: "Receipt",
		moduleUuid: "Equipment",
		fields: [
			{
				kind: "hidden",
				id: "inspection_count",
				calculate:
					"count(instance('casedb')/casedb/case[@case_type = 'inspection'])",
			},
			{
				kind: "text",
				id: "saved_worker_note",
				label: "Saved worker note",
				default_value: "#user/last_inspection",
			},
		],
	});
	await write("addCaseOperations", {
		moduleUuid: "Equipment",
		formUuid: "Inspect",
		operations: [
			{
				operation: {
					id: "inspection",
					action: "create",
					caseType: "inspection",
					target: { kind: "new" },
					name: "'Inspection receipt'",
					writes: [{ property: "condition", value: "#form/condition" }],
					links: [
						{
							identifier: "parent",
							targetType: "equipment",
							target: { kind: "session" },
							relationship: "child",
						},
					],
				},
			},
			{
				operation: {
					id: "record_household_inspection",
					action: "update",
					caseType: "household",
					target: {
						kind: "expression",
						expr: "via(ancestor('parent'), #case/case_id)",
					},
					writes: [{ property: "last_equipment_id", value: "#case/case_id" }],
				},
			},
		],
	});
	await write("addFormLinks", {
		moduleUuid: "Equipment",
		formUuid: "Inspect",
		links: [
			{
				link: {
					condition:
						"#case/condition = 'Working' and #user/last_inspection = 'Checked'",
					target: {
						type: "form",
						moduleUuid: "Equipment",
						formUuid: "Receipt",
					},
				},
			},
		],
	});
	await write("addOrganizationLevels", {
		levels: [
			{
				code: "clinic",
				name: "Clinic",
				caseFlow: {
					workers: "assigned",
					ownsCases: true,
					descendantCases: { kind: "none" },
				},
				addressBook: { reach: "own-branch" },
			},
		],
	});
	for (const [moduleUuid, formUuid] of [
		["Households", "Visit"],
		["Equipment", "Inspect"],
		["Equipment", "Receipt"],
	]) {
		await write("removeField", {
			moduleUuid,
			formUuid,
			fieldUuid: "fixture_placeholder",
		});
	}
	const doc = author.currentDoc();
	const worker = Object.values(doc.personas ?? {})[0];
	const equipment = Object.values(doc.modules).find(
		(module) => module.name === "Equipment",
	);
	if (!equipment) throw new Error("Equipment menu missing.");
	await h.seedProjectMember(scope.actorUserId, scope.projectId, "viewer");
	await h.seedAppWithBlueprint(doc, {
		id: scope.appId,
		owner: scope.actorUserId,
		projectId: scope.projectId,
	});
	const records = [
		{ id: "home-a", caseType: "household", name: "Home A" },
		{ id: "home-b", caseType: "household", name: "Home B" },
		{ id: "pump-a", caseType: "equipment", parentId: "home-a", name: "Pump A" },
		{ id: "pump-b", caseType: "equipment", parentId: "home-b", name: "Pump B" },
		{
			id: "other-clinic",
			caseType: "household",
			name: "Other clinic household",
		},
	];
	const call = sharedJourneyCalls(doc);
	const inputs = {
		purpose:
			"Inspect equipment at an assigned clinic, belonging to one selected household.",
		scenario: { records },
		places: [
			{ name: "Example north", levelUuid: "Clinic" },
			{ name: "Example south", levelUuid: "Clinic" },
		],
		assignments: [
			{ personaUuid: "Inspection worker", locationUuids: ["Example north"] },
		],
		owners: records.map((record) => ({
			recordId: record.id,
			owner: {
				kind: "place",
				locationUuid:
					record.id === "other-clinic" ? "Example south" : "Example north",
			},
		})),
	};
	let current = stepSchema.parse(await call("startAppTest", inputs, "start"));
	expect(current.observation.suppliedRecords).toEqual([
		{ caseType: "household", count: 3 },
		{ caseType: "equipment", count: 2 },
	]);
	expect(await call("startAppTest", inputs, "start")).toEqual(current);
	const retainedStart = await call("readAppTest", { testId: current.testId });
	expect(retainedStart).toMatchObject({
		steps: [
			{ observation: { suppliedRecords: current.observation.suppliedRecords } },
		],
	});
	expect(doc.personas?.[worker.uuid].locations).toBeUndefined();
	expect(
		await h
			.db()
			.selectFrom("app_locations")
			.selectAll()
			.where("app_id", "=", scope.appId)
			.execute(),
	).toEqual([]);
	const step = async (action: AppTestAction) => {
		current = stepSchema.parse(
			await call("continueAppTest", {
				testId: current.testId,
				expectedStep: current.step,
				action,
			}),
		);
		return current.observation;
	};
	expect(current.observation.menus).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ name: "Equipment", visibility: "hidden" }),
		]),
	);
	expect(
		await step({ kind: "menu", moduleUuid: equipment.uuid }),
	).toMatchObject({ completed: false });
	const entry = await step({ kind: "identity", personaUuid: worker.uuid });
	expect(entry.worker).toMatchObject({
		role: "Inspector",
		assignmentTestOnly: true,
		places: [{ name: "Example north", testOnly: true }],
	});
	expect(entry.menus).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ name: "Equipment", visibility: "shown" }),
		]),
	);
	expect(
		await step({ kind: "menu", moduleUuid: equipment.uuid }),
	).toMatchObject({
		name: "Households",
		results: {
			kind: "rows",
			rows: [
				expect.objectContaining({ case_id: "home-a" }),
				expect.objectContaining({ case_id: "home-b" }),
			],
		},
	});
	await step({ kind: "select", caseIds: ["home-a"] });
	await step({ kind: "continue" });
	const inspect = Object.values(doc.forms).find(
		(form) => form.name === "Inspect",
	);
	if (!inspect) throw new Error("Inspection form missing.");
	const children = await step({ kind: "form", formUuid: inspect.uuid });
	expect(children).toMatchObject({
		name: "Equipment",
		results: {
			kind: "rows",
			rows: [expect.objectContaining({ case_id: "pump-a" })],
		},
	});
	expect(await step({ kind: "select", caseIds: ["pump-b"] })).toMatchObject({
		completed: false,
	});
	expect(await step({ kind: "select", caseIds: ["pump-a"] })).toMatchObject({
		screen: "details",
	});
	expect(await step({ kind: "continue" })).toMatchObject({
		screen: "form",
		name: "Inspect",
	});
	await step({
		kind: "answer",
		answers: [
			{ path: "condition", value: "Working" },
			{ path: "note", value: "Unsaved note" },
			{ path: "worker_note", value: "Checked" },
		],
	});
	expect(await step({ kind: "submit" })).toMatchObject({
		savedInTest: true,
		screen: "form",
		name: "Receipt",
		questions: expect.arrayContaining([
			expect.objectContaining({ path: "inspection_count", value: "1" }),
			expect.objectContaining({ path: "saved_worker_note", value: "Checked" }),
		]),
		effects: {
			caseDatabasePatch: {
				rows: expect.arrayContaining([
					expect.objectContaining({
						case_id: "pump-a",
						properties: expect.objectContaining({ condition: "Working" }),
					}),
					expect.objectContaining({
						case_type: "inspection",
						properties: expect.objectContaining({ condition: "Working" }),
					}),
					expect.objectContaining({
						case_id: "home-a",
						properties: expect.objectContaining({
							last_equipment_id: "pump-a",
						}),
					}),
				]),
			},
		},
	});
	expect(await step({ kind: "submit" })).toMatchObject({
		savedInTest: true,
		name: "Inspect",
		questions: expect.arrayContaining([
			expect.objectContaining({ path: "condition", value: "Working" }),
			expect.objectContaining({ path: "note", value: "" }),
		]),
	});
});

it("opens browse-first Results with its hidden Search values already applied", async () => {
	const author = await makeDurableAuthoringHarness(h);
	expect(
		await author.call("createModule", { name: "People", case_type: "person" }),
	).toMatchObject({ ok: true });
	expect(
		await author.call("createForm", {
			moduleUuid: "People",
			name: "Visit",
			type: "followup",
		}),
	).toMatchObject({ ok: true });
	expect(
		await author.call("addFields", {
			formUuid: "Visit",
			moduleUuid: "People",
			fields: [
				{
					kind: "text",
					id: "region",
					label: "Region",
					caseWrite: { caseType: "person", property: "region" },
				},
			],
		}),
	).toMatchObject({ ok: true });
	expect(
		await author.call("addSearchInputs", {
			moduleUuid: "People",
			searchInputs: [
				{ kind: "hidden", name: "region", label: "Region", value: "'north'" },
			],
		}),
	).toMatchObject({ ok: true });
	expect(
		await author.call("setCaseListFilter", {
			moduleUuid: "People",
			filter: "when-provided(#search/region, #case/region = #search/region)",
		}),
	).toMatchObject({ ok: true });
	const doc = await author.currentDoc();
	const people = Object.values(doc.modules).find(
		(module) => module.name === "People",
	);
	if (!people) throw new Error("Missing people menu");

	await h.seedProjectMember(scope.actorUserId, scope.projectId, "viewer");
	await h.seedAppWithBlueprint(doc, {
		id: scope.appId,
		owner: scope.actorUserId,
		projectId: scope.projectId,
	});
	const begun = await startAppTest(scope, {
		requestId: "start",
		expectedBlueprintSeq: 0,
		input: {
			purpose: "Browse only the assigned region",
			scenario: {
				records: [
					{
						id: "north-person",
						caseType: "person",
						name: "North person",
						properties: { region: "north" },
					},
					{
						id: "south-person",
						caseType: "person",
						name: "South person",
						properties: { region: "south" },
					},
				],
			},
		},
	});
	const result = await continueAppTest(scope, {
		testId: begun.testId,
		expectedStep: 0,
		requestId: "open",
		action: { kind: "menu", moduleUuid: people.uuid },
	});
	expect(result.observation).toMatchObject({
		screen: "browse",
		results: {
			kind: "rows",
			rows: [expect.objectContaining({ case_id: "north-person" })],
		},
	});
});

it("creates a place-owned record from empty entry using the worker reading advertised to authors", async () => {
	const author = await makeDurableAuthoringHarness(h);
	const write = async (name: string, input: unknown) =>
		expect(await author.call(name, input)).toMatchObject({ ok: true });
	const readings = z
		.object({
			builtInPlaces: z.object({
				primarySharingGroup: z.object({ recordExpression: z.string() }),
			}),
		})
		.parse(await author.call("getUsers", {}));
	await write("addPersonas", {
		personas: [{ name: "Collecting worker" }, { name: "Reviewing worker" }],
	});
	await write("addOrganizationLevels", {
		levels: [
			{
				code: "branch",
				name: "Branch",
				caseFlow: {
					workers: "assigned",
					ownsCases: true,
					descendantCases: { kind: "none" },
				},
				addressBook: { reach: "own-branch" },
			},
		],
	});
	await write("createModule", { name: "Groups", case_type: "group" });
	await write("createForm", {
		moduleUuid: "Groups",
		name: "Register group",
		type: "survey",
	});
	await write("addFields", {
		formUuid: "Register group",
		moduleUuid: "Groups",
		fields: [{ kind: "text", id: "name", label: "Group name", required: true }],
	});
	await write("createForm", {
		moduleUuid: "Groups",
		name: "Review group",
		type: "followup",
	});
	await write("addFields", {
		formUuid: "Review group",
		moduleUuid: "Groups",
		fields: [{ kind: "label", id: "intro", label: "Review this group" }],
	});
	await write("addCaseOperations", {
		moduleUuid: "Groups",
		formUuid: "Register group",
		operations: [
			{
				operation: {
					id: "create_group",
					action: "create",
					caseType: "group",
					target: { kind: "new" },
					name: "#form/name",
					owner: readings.builtInPlaces.primarySharingGroup.recordExpression,
				},
			},
		],
	});
	const doc = await author.currentDoc();
	const module = Object.values(doc.modules).find((m) => m.name === "Groups");
	const register = Object.values(doc.forms).find(
		(f) => f.name === "Register group",
	);
	const review = Object.values(doc.forms).find(
		(f) => f.name === "Review group",
	);
	const collector = Object.values(doc.personas ?? {}).find(
		(p) => p.name === "Collecting worker",
	);
	const reviewer = Object.values(doc.personas ?? {}).find(
		(p) => p.name === "Reviewing worker",
	);
	if (!module || !register || !review || !collector || !reviewer)
		throw new Error("Authored journey missing");
	await h.seedProjectMember(scope.actorUserId, scope.projectId, "viewer");
	await h.seedAppWithBlueprint(doc, {
		id: scope.appId,
		owner: scope.actorUserId,
		projectId: scope.projectId,
	});
	const call = sharedJourneyCalls(doc);
	let current = stepSchema.parse(
		await call("startAppTest", {
			purpose: "Register first shared group",
			scenario: { records: [] },
			places: [{ name: "Example branch", levelUuid: "Branch" }],
			assignments: [
				{ personaUuid: "Collecting worker", locationUuids: ["Example branch"] },
				{ personaUuid: "Reviewing worker", locationUuids: ["Example branch"] },
			],
		}),
	);
	const step = async (action: AppTestAction) => {
		current = stepSchema.parse(
			await call("continueAppTest", {
				testId: current.testId,
				expectedStep: current.step,
				action,
			}),
		);
		return current.observation;
	};
	await step({ kind: "identity", personaUuid: collector.uuid });
	await step({ kind: "menu", moduleUuid: module.uuid });
	await step({ kind: "form", formUuid: register.uuid });
	await step({
		kind: "answer",
		answers: [{ path: "name", value: "Shared group" }],
	});
	expect(await step({ kind: "submit" })).toMatchObject({ savedInTest: true });
	await step({ kind: "identity", personaUuid: reviewer.uuid });
	await step({ kind: "menu", moduleUuid: module.uuid });
	const selection = await step({ kind: "form", formUuid: review.uuid });
	expect(selection).toMatchObject({
		screen: "browse",
		results: {
			kind: "rows",
			rows: [expect.objectContaining({ case_name: "Shared group" })],
		},
	});
	await step({ kind: "finish" });
});

it("reports its local clock and uses the same day in list calculations and forms", async () => {
	const doc = await createEvaluationApp(
		[
			{
				name: "Appointments",
				caseType: "appointment",
				forms: [{ name: "Visit", type: "followup" }],
			},
		],
		[
			{
				toolName: "addFields",
				input: {
					moduleUuid: "Appointments",
					formUuid: "Visit",
					fields: [
						{
							kind: "date",
							id: "visit_date",
							label: "Visit date",
							default_value: "today()",
						},
					],
				},
			},
			{
				toolName: "removeField",
				input: {
					moduleUuid: "Appointments",
					formUuid: "Visit",
					fieldUuid: "fixture_placeholder",
				},
			},
			{
				toolName: "addCaseListColumns",
				input: {
					moduleUuid: "Appointments",
					columns: [
						{
							kind: "calculated",
							header: "Today",
							expression: "format-date(today(), '%Y-%m-%d')",
						},
					],
				},
			},
			{
				toolName: "removeCaseListColumn",
				input: { moduleUuid: "Appointments", columnUuid: "Name" },
			},
		],
	);
	await h.seedProjectMember(scope.actorUserId, scope.projectId, "viewer");
	await h.seedAppWithBlueprint(doc, {
		id: scope.appId,
		owner: scope.actorUserId,
		projectId: scope.projectId,
	});
	let current = await startAppTest(scope, {
		requestId: "calendar-start",
		expectedBlueprintSeq: 0,
		input: {
			purpose: "Compare the list and form day",
			scenario: {
				records: [
					{ id: "appointment-1", caseType: "appointment", name: "Visit" },
				],
			},
		},
	});
	let request = 0;
	const step = async (action: AppTestAction) => {
		current = await continueAppTest(scope, {
			testId: current.testId,
			requestId: `calendar-${++request}`,
			expectedStep: current.step,
			action,
		});
		expect(current.observation.error).toBeUndefined();
		return current.observation;
	};
	const clock = z
		.object({ timeZone: z.string(), today: z.string() })
		.parse(current.observation.clock);
	expect(clock.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
	const mod = Object.values(doc.modules).find(
		(item) => item.name === "Appointments",
	);
	const form = Object.values(doc.forms).find((item) => item.name === "Visit");
	if (!mod || !form) throw new Error("Missing calendar fixture");
	const listed = await step({ kind: "menu", moduleUuid: mod.uuid });
	const column = mod.caseListConfig?.columns[0];
	if (!column) throw new Error("Missing calendar column");
	expect(listed).toMatchObject({
		clock,
		results: {
			kind: "rows",
			rows: [
				expect.objectContaining({
					case_id: "appointment-1",
					calculated: { [column.uuid]: clock.today },
				}),
			],
		},
	});
	expect(
		await step({ kind: "select", caseIds: ["appointment-1"] }),
	).toMatchObject({ screen: "details" });
	const opened = await step({ kind: "continue" });
	expect(opened).toMatchObject({
		clock,
		questions: expect.arrayContaining([
			expect.objectContaining({ label: "Visit date", value: clock.today }),
		]),
	});
	await step({ kind: "finish" });
});

it.each([
	{ chooser: false, destination: "previous" },
	{ chooser: true, destination: "previous" },
	{ chooser: false, destination: "module" },
	{ chooser: true, destination: "module" },
] as const)(
	"keeps leaf selection local (chooser $chooser, return $destination)",
	async ({ chooser, destination }) => {
		const doc = await createEvaluationApp(
			[
				{
					name: "Repairs",
					caseType: "repair",
					forms: [
						{ name: "Update condition", type: "followup" },
						...(chooser
							? [{ name: "Inspect", type: "followup" as const }]
							: []),
					],
				},
			],
			[
				{
					toolName: "addFields",
					input: {
						moduleUuid: "Repairs",
						formUuid: "Update condition",
						fields: [
							{
								kind: "text",
								id: "condition",
								label: "Condition",
								caseWrite: { caseType: "repair", property: "condition" },
							},
						],
					},
				},
				{
					toolName: "updateForm",
					input: {
						moduleUuid: "Repairs",
						formUuid: "Update condition",
						post_submit: destination,
					},
				},
				{
					toolName: "removeField",
					input: {
						moduleUuid: "Repairs",
						formUuid: "Update condition",
						fieldUuid: "fixture_placeholder",
					},
				},
				...(chooser
					? [
							{
								toolName: "addFields",
								input: {
									moduleUuid: "Repairs",
									formUuid: "Inspect",
									fields: [
										{
											kind: "label",
											id: "info",
											label: "Inspect this equipment.",
										},
									],
								},
							},
							{
								toolName: "removeField",
								input: {
									moduleUuid: "Repairs",
									formUuid: "Inspect",
									fieldUuid: "fixture_placeholder",
								},
							},
						]
					: []),
				{
					toolName: "addCaseListColumns",
					input: {
						moduleUuid: "Repairs",
						columns: [
							{ kind: "plain", field: "case_name", header: "Equipment" },
							{ kind: "plain", field: "condition", header: "Condition" },
						],
					},
				},
				{
					toolName: "removeCaseListColumn",
					input: { moduleUuid: "Repairs", columnUuid: "Name" },
				},
			],
		);
		const form = Object.values(doc.forms).find(
			(item) => item.name === "Update condition",
		);
		if (!form) throw new Error("Missing repair form");
		const module = Object.values(doc.modules).find(
			(item) => item.name === "Repairs",
		);
		if (!module) throw new Error("Missing repair menu");
		await h.seedProjectMember(scope.actorUserId, scope.projectId, "viewer");
		await h.seedAppWithBlueprint(doc, {
			id: scope.appId,
			owner: scope.actorUserId,
			projectId: scope.projectId,
		});
		const call = sharedJourneyCalls(doc);
		let current = stepSchema.parse(
			await call("startAppTest", {
				purpose:
					"Confirm a record, change it, inspect the return screen, and start the next task.",
				scenario: {
					records: [
						{
							id: "repair-a",
							caseType: "repair",
							name: "Pump",
							properties: { condition: "Broken" },
						},
					],
				},
			}),
		);
		const step = async (action: AppTestAction) => {
			current = stepSchema.parse(
				await call("continueAppTest", {
					testId: current.testId,
					expectedStep: current.step,
					action,
				}),
			);
			return current.observation;
		};
		await step({ kind: "menu", moduleUuid: module.uuid });
		expect(await step({ kind: "select", caseIds: ["repair-a"] })).toMatchObject(
			{
				screen: "details",
				canContinue: true,
				fields: expect.arrayContaining([
					{
						uuid: expect.any(String),
						label: "Condition",
						format: "plain",
						kind: "value",
						text: "Broken",
					},
				]),
			},
		);
		expect(
			await step({
				kind: "answer",
				answers: [{ path: "condition", value: "Fixed" }],
			}),
		).toMatchObject({ completed: false });
		const openTask = async () => {
			const continued = await step({ kind: "continue" });
			if (chooser) {
				expect(continued).toMatchObject({
					screen: "menu",
					selected: [expect.objectContaining({ caseId: "repair-a" })],
				});
				return step({ kind: "form", formUuid: form.uuid });
			}
			return continued;
		};
		expect(await openTask()).toMatchObject({
			screen: "form",
			questions: expect.arrayContaining([
				expect.objectContaining({ value: "Broken" }),
			]),
		});
		await step({
			kind: "answer",
			answers: [{ path: "condition", value: "Fixed" }],
		});
		const submitted = await step({ kind: "submit" });
		expect(submitted.savedInTest).toBe(true);
		if (destination === "module") {
			expect(submitted).toMatchObject({
				screen: "browse",
				results: {
					rows: [
						expect.objectContaining({
							case_id: "repair-a",
							properties: expect.objectContaining({ condition: "Fixed" }),
						}),
					],
				},
			});
			await step({ kind: "select", caseIds: ["repair-a"] });
		} else {
			expect(submitted).toMatchObject({
				screen: "details",
				fields: expect.arrayContaining([
					expect.objectContaining({ label: "Condition", text: "Fixed" }),
				]),
			});
		}
		expect(await openTask()).toMatchObject({
			screen: "form",
			questions: expect.arrayContaining([
				expect.objectContaining({ value: "Fixed" }),
			]),
		});
		expect(await step({ kind: "back" })).toMatchObject({ screen: "details" });
		expect(await step({ kind: "back" })).toMatchObject({ screen: "browse" });
		await step({ kind: "finish" });
	},
);

it("reads informational Details without inventing a form or Continue action", async () => {
	const doc = await createEvaluationApp(
		[{ name: "Directory", caseType: "entry", forms: [] }],
		[],
	);
	const module = Object.values(doc.modules).find(
		(item) => item.name === "Directory",
	);
	if (!module) throw new Error("Missing directory");
	await h.seedProjectMember(scope.actorUserId, scope.projectId, "viewer");
	await h.seedAppWithBlueprint(doc, {
		id: scope.appId,
		owner: scope.actorUserId,
		projectId: scope.projectId,
	});
	let current = await startAppTest(scope, {
		requestId: "directory-start",
		expectedBlueprintSeq: 0,
		input: {
			purpose: "Read information without a submission task",
			scenario: {
				records: [{ id: "entry-a", caseType: "entry", name: "Clinic" }],
			},
		},
	});
	let request = 0;
	const step = async (action: AppTestAction) => {
		current = await continueAppTest(scope, {
			testId: current.testId,
			requestId: `directory-${++request}`,
			expectedStep: current.step,
			action,
		});
		return current.observation;
	};
	await step({ kind: "menu", moduleUuid: module.uuid });
	expect(await step({ kind: "select", caseIds: ["entry-a"] })).toMatchObject({
		screen: "details",
		canContinue: false,
		record: { case_name: "Clinic" },
	});
	expect(await step({ kind: "continue" })).toMatchObject({ completed: false });
	expect(await step({ kind: "back" })).toMatchObject({ screen: "browse" });
	await step({ kind: "finish" });
});

it("limits a mixed module's inline chooser to case forms and goes back to Results without Details", async () => {
	const doc = await createEvaluationApp(
		[
			{
				name: "Equipment",
				caseType: "equipment",
				forms: [
					{ name: "Register", type: "registration" },
					{ name: "Inspect", type: "followup" },
					{ name: "Retire", type: "close" },
				],
			},
		],
		[
			{
				toolName: "addFields",
				input: {
					moduleUuid: "Equipment",
					formUuid: "Register",
					fields: [{ kind: "text", id: "name", label: "Name", required: true }],
				},
			},
			{
				toolName: "updateForm",
				input: {
					moduleUuid: "Equipment",
					formUuid: "Register",
					recordName: "#form/name",
				},
			},
			{
				toolName: "removeField",
				input: {
					moduleUuid: "Equipment",
					formUuid: "Register",
					fieldUuid: "fixture_placeholder",
				},
			},
			{
				toolName: "addFields",
				input: {
					moduleUuid: "Equipment",
					formUuid: "Inspect",
					fields: [
						{ kind: "label", id: "info", label: "Inspect this equipment." },
					],
				},
			},
			{
				toolName: "removeField",
				input: {
					moduleUuid: "Equipment",
					formUuid: "Inspect",
					fieldUuid: "fixture_placeholder",
				},
			},
			{
				toolName: "addFields",
				input: {
					moduleUuid: "Equipment",
					formUuid: "Retire",
					fields: [
						{ kind: "label", id: "info", label: "Retire this equipment." },
					],
				},
			},
			{
				toolName: "removeField",
				input: {
					moduleUuid: "Equipment",
					formUuid: "Retire",
					fieldUuid: "fixture_placeholder",
				},
			},
			{
				toolName: "addCaseListColumns",
				input: {
					moduleUuid: "Equipment",
					columns: [
						{
							kind: "plain",
							field: "case_name",
							header: "Equipment",
							visibleInDetail: false,
						},
					],
				},
			},
			{
				toolName: "removeCaseListColumn",
				input: { moduleUuid: "Equipment", columnUuid: "Name" },
			},
		],
	);
	const mod = Object.values(doc.modules).find(
		(module) => module.name === "Equipment",
	);
	const register = Object.values(doc.forms).find(
		(form) => form.name === "Register",
	);
	const inspect = Object.values(doc.forms).find(
		(form) => form.name === "Inspect",
	);
	if (!mod || !register || !inspect) throw new Error("Incomplete mixed module");
	await h.seedProjectMember(scope.actorUserId, scope.projectId, "viewer");
	await h.seedAppWithBlueprint(doc, {
		id: scope.appId,
		owner: scope.actorUserId,
		projectId: scope.projectId,
	});
	const call = sharedJourneyCalls(doc);
	let current = stepSchema.parse(
		await call("startAppTest", {
			purpose:
				"Choose a case task without inventing registration in the inline chooser",
			scenario: {
				records: [{ id: "pump", caseType: "equipment", name: "Pump" }],
			},
		}),
	);
	const step = async (action: AppTestAction) => {
		current = stepSchema.parse(
			await call("continueAppTest", {
				testId: current.testId,
				expectedStep: current.step,
				action,
			}),
		);
		return current.observation;
	};
	const menu = await step({ kind: "menu", moduleUuid: mod.uuid });
	expect(menu.forms).toEqual(
		expect.arrayContaining([expect.objectContaining({ name: "Register" })]),
	);
	await step({ kind: "records" });
	const chooser = await step({ kind: "select", caseIds: ["pump"] });
	expect(chooser).toMatchObject({
		screen: "menu",
		forms: [
			expect.objectContaining({ name: "Inspect" }),
			expect.objectContaining({ name: "Retire" }),
		],
	});
	expect(await step({ kind: "form", formUuid: register.uuid })).toMatchObject({
		completed: false,
	});
	expect(await step({ kind: "form", formUuid: inspect.uuid })).toMatchObject({
		screen: "form",
		name: "Inspect",
	});
	expect(await step({ kind: "back" })).toMatchObject({ screen: "browse" });
	await step({ kind: "finish" });
});

// Each action persists a checkpoint in Postgres and uses the production worker.
// Fourteen sequential actions exceeded 5 seconds on the hosted runner.
it("visits form pages using retained entry state before allowing submission", {
	timeout: 15_000,
}, async () => {
	const doc = sectionEntryDoc();
	const moduleUuid = doc.moduleOrder[0];
	const formUuid = doc.formOrder[moduleUuid][0];
	const first = Object.values(doc.fields).find((field) => field.id === "first");
	const second = Object.values(doc.fields).find(
		(field) => field.id === "second",
	);
	if (!first || !second) throw new Error("Missing sections");
	await h.seedProjectMember(scope.actorUserId, scope.projectId, "viewer");
	await h.seedAppWithBlueprint(doc, {
		id: scope.appId,
		owner: scope.actorUserId,
		projectId: scope.projectId,
	});
	let current = await startAppTest(scope, {
		requestId: "start",
		expectedBlueprintSeq: 0,
		input: {
			purpose:
				"Choose an area, inspect its assets, and retain answers on return",
		},
	});
	let request = 0;
	const step = async (action: AppTestAction) => {
		current = await continueAppTest(scope, {
			testId: current.testId,
			requestId: `page-${++request}`,
			expectedStep: current.step,
			action,
		});
		return current.observation;
	};
	await step({ kind: "menu", moduleUuid });
	expect(await step({ kind: "form", formUuid })).toMatchObject({
		canSubmit: false,
		questions: expect.arrayContaining([
			expect.objectContaining({
				path: "first/zone",
				value: "north",
				label: "Area",
			}),
		]),
	});
	expect((await step({ kind: "submit" })).savedInTest).toBe(false);
	await step({ kind: "answer", answers: [{ path: "first/zone", value: "" }] });
	expect(
		(await step({ kind: "section", sectionUuid: second.uuid })).sections,
	).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ uuid: first.uuid, current: true }),
		]),
	);
	await step({
		kind: "answer",
		answers: [{ path: "first/zone", value: "south" }],
	});
	await expect(
		step({
			kind: "answer",
			answers: [{ path: "second/rounds[0]/assets[0]/note", value: "early" }],
		}),
	).resolves.toMatchObject({
		completed: false,
		error: "Open that section before answering its questions.",
	});
	const opened = await step({ kind: "pageNext" });
	expect(opened).toMatchObject({
		canSubmit: true,
		questions: expect.arrayContaining([
			expect.objectContaining({
				path: "second/rounds[0]/assets",
				repeatCount: 1,
			}),
			expect.objectContaining({
				path: "second/rounds[0]/assets[0]/note",
				value: "tank",
			}),
		]),
	});
	await step({
		kind: "answer",
		answers: [{ path: "second/rounds[0]/assets[0]/note", value: "retained" }],
	});
	expect(await step({ kind: "pagePrevious" })).toMatchObject({
		pageNavigation: { canNext: true, canPrevious: false },
		actions: expect.arrayContaining(["pageNext", "routeBack"]),
	});
	await step({
		kind: "answer",
		answers: [{ path: "first/zone", value: "north" }],
	});
	expect(await step({ kind: "pageNext" })).toMatchObject({
		questions: expect.arrayContaining([
			expect.objectContaining({
				path: "second/rounds[0]/assets",
				repeatCount: 1,
			}),
			expect.objectContaining({
				path: "second/rounds[0]/assets[0]/note",
				value: "retained",
			}),
		]),
	});
	expect(await step({ kind: "submit" })).toMatchObject({
		savedInTest: true,
		effects: {
			primaryCaseIds: [],
			operations: [],
			caseDatabasePatch: { rows: [], indices: [] },
		},
		evidence: {
			collectionScope: "disposable-case-store",
			caseTransaction: "committed",
			submissionReceipt: "persisted",
			casePatch: "none",
			answerDocumentArchive: "not-created",
		},
	});
	const receipts = await sql<{
		result: Record<string, unknown>;
	}>`SELECT result FROM ${sql.id(appTestNamespace(current.testId), "form_submission_intents")} WHERE form_uuid = ${formUuid}`.execute(
		h.db(),
	);
	expect(receipts.rows).toHaveLength(1);
	expect(receipts.rows[0].result).toMatchObject({
		primaryCaseIds: [],
		caseDatabasePatch: { rows: [], indices: [] },
	});
	expect(receipts.rows[0].result).not.toHaveProperty("answers");
	expect(JSON.stringify(receipts.rows)).not.toContain("retained");
});

it("binds ordered public section aliases after navigation, stops at failed forward validation, and replays the whole call", async () => {
	const doc = sectionEntryDoc();
	await h.seedProjectMember(scope.actorUserId, scope.projectId, "viewer");
	await h.seedAppWithBlueprint(doc, {
		id: scope.appId,
		owner: scope.actorUserId,
		projectId: scope.projectId,
	});
	const call = sharedJourneyCalls(doc);
	const started = stepSchema.parse(
		await call("startAppTest", { purpose: "Inspect the chosen area's assets" }),
	);
	const input = {
		testId: started.testId,
		expectedStep: 0,
		actions: [
			{ action: { kind: "menu", moduleUuid: "Visits" } },
			{
				action: { kind: "form", formUuid: "Inspect" },
				expect: { screen: "form" },
			},
			{
				action: {
					kind: "answer",
					answers: [{ path: "first/zone", value: "" }],
				},
			},
			{ action: { kind: "section", sectionUuid: "second" } },
			{ action: { kind: "submit" } },
		],
	};
	const failed = await call("continueAppTest", input, "ordered-failure");
	expect(failed).toMatchObject({
		step: 4,
		stopped: { index: 3 },
		results: [
			{ step: 1 },
			{ step: 2 },
			{ step: 3 },
			{
				step: 4,
				observation: {
					completed: false,
					questions: expect.arrayContaining([
						expect.objectContaining({
							path: "first/zone",
							error: "This field is required",
						}),
					]),
				},
			},
		],
	});
	const recovered = await call(
		"continueAppTest",
		{
			testId: started.testId,
			expectedStep: 4,
			actions: [
				{
					action: {
						kind: "answer",
						answers: [{ path: "first/zone", value: "south" }],
					},
				},
				{ action: { kind: "section", sectionUuid: "#form/second" } },
				{
					action: { kind: "submit" },
					expect: { screen: "details", submitted: true },
				},
				{ action: { kind: "home" } },
			],
		},
		"ordered-submit",
	);
	expect(recovered).toMatchObject({
		step: 7,
		stopped: { index: 2 },
		observation: {
			savedInTest: true,
			expectationMet: false,
			evidence: {
				caseTransaction: "committed",
				serializedSubmission: "not-observed",
				retainedReport: "not-observed",
			},
		},
	});
	// Reauthorize, then return the original bytes before checking the later step
	// or resolving section names against the now-different current screen.
	expect(await call("continueAppTest", input, "ordered-failure")).toEqual(
		failed,
	);
	const page = await readAppTestSteps({ ...scope, testId: started.testId });
	expect(page.steps.map((step) => step.step)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
	await call("continueAppTest", {
		testId: started.testId,
		expectedStep: 7,
		actions: [{ action: { kind: "finish" } }],
	});
});

it("uses selected worker language, preserves authored messages and retains page/repeat answers through language changes", {
	timeout: 15_000,
}, async () => {
	const author = makeAuthoringHarness({}, sectionEntryDoc());
	expect(
		await author.call("addFields", {
			moduleUuid: "Visits",
			formUuid: "Inspect",
			parentUuid: "first",
			fields: [
				{ id: "count", kind: "int", label: "Count", required: true },
				{
					id: "code",
					kind: "text",
					label: "Code",
					validate: {
						expr: "#form/first/code = 'ok'",
						msg: "Enter ok exactly",
					},
				},
			],
		}),
	).not.toHaveProperty("error");
	for (const language of ["spa", "fra"])
		expect(
			await author.call("addLanguage", { language: { language } }),
		).not.toHaveProperty("error");
	let doc = author.currentDoc();
	const moduleUuid = doc.moduleOrder[0];
	const formUuid = doc.formOrder[moduleUuid][0];
	const count = Object.values(doc.fields).find((field) => field.id === "count");
	if (!count) throw new Error("Missing count field");
	const translated = new Map<string, string>([
		[makeTranslationUnitId("module", moduleUuid, "name"), "Visitas"],
		[makeTranslationUnitId("form", formUuid, "name"), "Inspeccionar"],
		[makeTranslationUnitId("field", count.uuid, "label"), "Cantidad"],
	]);
	const updates = collectTranslationUnits(doc).flatMap((unit) => {
		const value = translated.get(unit.id);
		return value === undefined
			? []
			: [
					{
						operation: "set",
						unitId: unit.id,
						expectedSourceFingerprint: authoringFingerprint(
							unit.sourceFingerprint,
						),
						value,
					},
				];
	});
	expect(updates).toHaveLength(3);
	expect(
		await author.call("updateTranslations", {
			language: { language: "spa" },
			updates,
		}),
	).not.toHaveProperty("error");
	expect(
		await author.call("updateLanguage", {
			action: "set-default",
			language: { language: "spa" },
		}),
	).not.toHaveProperty("error");
	doc = author.currentDoc();
	await h.seedProjectMember(scope.actorUserId, scope.projectId, "viewer");
	await h.seedAppWithBlueprint(doc, {
		id: scope.appId,
		owner: scope.actorUserId,
		projectId: scope.projectId,
	});
	const call = sharedJourneyCalls(doc);
	let current = stepSchema.parse(
		await call("startAppTest", {
			purpose: "Fill an inspection in the worker's language",
		}),
	);
	expect(current.observation).toMatchObject({
		language: {
			selected: { language: "spa" },
			runtime: { catalogLanguage: "spa", fallback: false },
		},
		menus: [expect.objectContaining({ name: "Visitas" })],
	});
	const advance = async (actions: unknown[]) => {
		current = stepSchema.parse(
			await call("continueAppTest", {
				testId: current.testId,
				expectedStep: current.step,
				actions,
			}),
		);
		return current.observation;
	};
	const opened = await advance([
		{ action: { kind: "menu", moduleUuid: "Visitas" } },
		{ action: { kind: "form", formUuid: "Inspeccionar" } },
	]);
	expect(opened).toMatchObject({
		name: "Inspeccionar",
		controls: { back: "Atrás" },
		questions: expect.arrayContaining([
			expect.objectContaining({
				path: "first/count",
				label: "Cantidad",
				error: "Este campo es obligatorio",
			}),
		]),
	});
	const invalid = await advance([
		{
			action: {
				kind: "answer",
				answers: [
					{ path: "first/count", value: "1.5" },
					{ path: "first/code", value: "no" },
				],
			},
		},
	]);
	expect(invalid.questions).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				path: "first/count",
				error: "Esta pregunta necesita un número entero.",
			}),
			expect.objectContaining({
				path: "first/code",
				error: "Enter ok exactly",
			}),
		]),
	);
	const english = await advance([
		{ action: { kind: "language", language: { language: "eng" } } },
	]);
	expect(english.questions).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				path: "first/count",
				value: "1.5",
				label: "Count",
				error: "This question needs a whole number.",
			}),
		]),
	);
	const retained = await advance([
		{
			action: {
				kind: "answer",
				answers: [
					{ path: "first/count", value: "2" },
					{ path: "first/code", value: "ok" },
					{ path: "first/zone", value: "south" },
				],
			},
		},
		{ action: { kind: "section", sectionUuid: "second" } },
		{
			action: {
				kind: "answer",
				answers: [
					{ path: "second/rounds[0]/assets[0]/note", value: "Checked tank" },
				],
			},
		},
		{ action: { kind: "language", language: { language: "spa" } } },
	]);
	expect(retained).toMatchObject({
		controls: { submit: "Enviar" },
		questions: expect.arrayContaining([
			expect.objectContaining({
				path: "second/rounds[0]/assets[0]/note",
				value: "Checked tank",
			}),
		]),
	});
	expect(
		await advance([
			{ action: { kind: "language", language: { language: "fra" } } },
		]),
	).toMatchObject({
		language: {
			selected: { language: "fra" },
			runtime: { catalogLanguage: "eng", fallback: true },
		},
	});
	expect(
		await advance([
			{ action: { kind: "language", language: { language: "deu" } } },
		]),
	).toMatchObject({
		completed: false,
		error: "Choose a language configured in this app.",
	});
	await advance([{ action: { kind: "finish" } }]);
});

it("replays a pre-batch named action against its pinned source after a deploy and app rename", async () => {
	const doc = sectionEntryDoc();
	await h.seedProjectMember(scope.actorUserId, scope.projectId, "viewer");
	await h.seedAppWithBlueprint(doc, {
		id: scope.appId,
		owner: scope.actorUserId,
		projectId: scope.projectId,
	});
	const call = sharedJourneyCalls(doc);
	const started = stepSchema.parse(
		await call("startAppTest", { purpose: "Preserve predeploy evidence" }),
	);
	const moduleUuid = doc.moduleOrder[0];
	// This is the old shared boundary's persisted canonical action and digest.
	const first = await call(
		"continueAppTest",
		{
			testId: started.testId,
			expectedStep: 0,
			action: { kind: "menu", moduleUuid },
		},
		"legacy-menu",
	);
	await h
		.db()
		.deleteFrom("app_test_requests")
		.where("test_id", "=", started.testId)
		.where("request_id", "=", "legacy-menu")
		.execute();
	await h
		.db()
		.updateTable("app_test_sessions")
		.set({ runtime_version: 6 })
		.where("id", "=", started.testId)
		.execute();
	await h
		.db()
		.updateTable("apps")
		.set({ mutation_seq: 1 })
		.where("id", "=", scope.appId)
		.execute();
	const renamed = structuredClone(doc);
	renamed.modules[moduleUuid].name = "Renamed visits";
	const retry = sharedJourneyCalls(renamed);
	expect(
		await retry(
			"continueAppTest",
			{
				testId: started.testId,
				expectedStep: 0,
				action: { kind: "menu", moduleUuid: "Visits" },
			},
			"legacy-menu",
		),
	).toEqual(first);
	await expect(
		retry(
			"continueAppTest",
			{
				testId: started.testId,
				expectedStep: 1,
				action: { kind: "menu", moduleUuid: "Visits" },
			},
			"legacy-menu",
		),
	).rejects.toThrow("different inputs");
	await expect(
		retry(
			"continueAppTest",
			{ testId: started.testId, expectedStep: 0, action: { kind: "home" } },
			"legacy-menu",
		),
	).rejects.toThrow("different inputs");
	expect(
		(await readAppTestSteps({ ...scope, testId: started.testId })).steps,
	).toHaveLength(2);
});

it("projects translated choice labels in Results and Details while preserving stored values", async () => {
	const author = makeAuthoringHarness(
		{},
		namedFormFixture([
			{
				name: "Clients",
				caseType: "client",
				forms: [{ name: "Update", type: "followup" }],
			},
		]),
	);
	const ok = async (name: string, input: unknown) =>
		expect(await author.call(name, input)).not.toHaveProperty("error");
	await ok("addFields", {
		moduleUuid: "Clients",
		formUuid: "Update",
		fields: [
			{
				id: "status",
				kind: "single_select",
				label: "Status",
				optionsSource: {
					kind: "inline",
					options: [
						{ value: "open", label: "Open" },
						{ value: "closed", label: "Closed" },
					],
				},
				caseWrite: { caseType: "client", property: "condition" },
			},
			{
				id: "needs",
				kind: "multi_select",
				label: "Needs",
				optionsSource: {
					kind: "inline",
					options: [
						{ value: "food", label: "Food" },
						{ value: "water", label: "Water" },
					],
				},
				caseWrite: { caseType: "client", property: "needs" },
			},
		],
	});
	await ok("updateCaseProperty", {
		caseType: "client",
		property: "condition",
		updates: {
			options: [
				{ value: "open", label: "Open" },
				{ value: "closed", label: "Closed" },
			],
		},
	});
	await ok("updateCaseProperty", {
		caseType: "client",
		property: "needs",
		updates: {
			options: [
				{ value: "food", label: "Food" },
				{ value: "water", label: "Water" },
			],
		},
	});
	await ok("addCaseListColumns", {
		moduleUuid: "Clients",
		columns: [
			{ kind: "plain", field: "condition", header: "Status" },
			{ kind: "plain", field: "needs", header: "Needs" },
		],
	});
	await ok("addLanguage", { language: { language: "spa" } });
	const choices: Record<string, string> = {
		open: "Abierto",
		closed: "Cerrado",
		food: "Comida",
		water: "Agua",
	};
	const updates = collectTranslationUnits(author.currentDoc()).flatMap(
		(unit) => {
			const value =
				unit.owner.kind === "case-property-option"
					? choices[unit.owner.value]
					: unit.role === "case-list-header"
						? unit.source === "Status"
							? "Estado"
							: unit.source === "Needs"
								? "Necesidades"
								: undefined
						: undefined;
			return value === undefined
				? []
				: [
						{
							operation: "set",
							unitId: unit.id,
							expectedSourceFingerprint: authoringFingerprint(
								unit.sourceFingerprint,
							),
							value,
						},
					];
		},
	);
	expect(updates).toHaveLength(6);
	await ok("updateTranslations", { language: { language: "spa" }, updates });
	const doc = author.currentDoc();
	const module = Object.values(doc.modules).find(
		(module) => module.name === "Clients",
	);
	if (!module) throw new Error("Missing clients fixture");
	await h.seedProjectMember(scope.actorUserId, scope.projectId, "viewer");
	await h.seedAppWithBlueprint(doc, {
		id: scope.appId,
		owner: scope.actorUserId,
		projectId: scope.projectId,
	});
	let current = await startAppTest(scope, {
		requestId: "localized-cells",
		expectedBlueprintSeq: 0,
		input: {
			purpose: "Check the worker's translated record choices",
			language: { language: "spa" },
			scenario: {
				records: [
					{
						id: "client-1",
						caseType: "client",
						name: "Maya",
						properties: { condition: "open", needs: ["food", "water"] },
					},
				],
			},
		},
	});
	const step = async (action: AppTestAction) => {
		current = await continueAppTest(scope, {
			testId: current.testId,
			requestId: `localized-cells-${current.step + 1}`,
			expectedStep: current.step,
			action,
		});
		expect(current.observation.error).toBeUndefined();
		return current.observation;
	};
	const spanishCells = [
		expect.objectContaining({ label: "Estado", text: "Abierto" }),
		expect.objectContaining({ label: "Necesidades", text: "Comida Agua" }),
	];
	expect(await step({ kind: "menu", moduleUuid: module.uuid })).toMatchObject({
		renderedResults: {
			rows: [
				{ recordId: "client-1", cells: expect.arrayContaining(spanishCells) },
			],
		},
		results: {
			rows: [
				expect.objectContaining({
					properties: { condition: "open", needs: ["food", "water"] },
				}),
			],
		},
	});
	expect(await step({ kind: "select", caseIds: ["client-1"] })).toMatchObject({
		screen: "details",
		fields: expect.arrayContaining(spanishCells),
	});
	expect(
		await step({ kind: "language", language: { language: "eng" } }),
	).toMatchObject({
		fields: expect.arrayContaining([
			expect.objectContaining({ label: "Status", text: "Open" }),
			expect.objectContaining({ label: "Needs", text: "Food Water" }),
		]),
	});
	await step({ kind: "finish" });
});

it.each([false, true])(
	"retains two open worker forms across a competing submission and explicit sync (current-store guard: %s)",
	{
		timeout: 20_000,
	},
	async (guarded) => {
		const doc = await createEvaluationApp(
			[
				{
					name: "Jobs",
					caseType: "job",
					forms: [
						{ name: "Complete", type: "followup" },
						{ name: "Cancel", type: "followup" },
					],
				},
			],
			[
				{
					toolName: "addFields",
					input: {
						moduleUuid: "Jobs",
						formUuid: "Complete",
						fields: [
							{
								id: "job_state",
								kind: "hidden",
								calculate: "'completed'",
								caseWrite: { caseType: "job", property: "job_state" },
							},
							{
								id: "note",
								kind: "text",
								label: "Completion note",
								required: true,
								caseWrite: { caseType: "job", property: "completion_note" },
							},
						],
					},
				},
				{
					toolName: "addFields",
					input: {
						moduleUuid: "Jobs",
						formUuid: "Cancel",
						fields: [
							{
								id: "status_at_entry",
								kind: "text",
								label: "Status at entry",
								default_value: "#case/job_state",
							},
							{
								id: "note",
								kind: "text",
								label: "Cancellation note",
								required: true,
								caseWrite: { caseType: "job", property: "cancellation_note" },
							},
							{
								id: "pending_jobs",
								kind: "repeat",
								label: "Pending jobs",
								repeat: {
									mode: "query_bound",
									ids_query:
										"instance('casedb')/casedb/case[@case_type = 'job'][job_state = 'pending']/@case_id",
								},
							},
							{
								id: "job_id",
								parentUuid: "pending_jobs",
								kind: "text",
								label: "Pending job",
								default_value: "current()/../@id",
							},
						],
					},
				},
				{
					toolName: "addCaseOperations",
					input: {
						moduleUuid: "Jobs",
						formUuid: "Cancel",
						operations: [
							{
								operation: {
									id: "cancel",
									action: "update",
									caseType: "job",
									target: { kind: "session" },
									...(guarded
										? { condition: "#case/job_state = 'pending'" }
										: {}),
									writes: [{ property: "job_state", value: "'cancelled'" }],
								},
							},
						],
					},
				},
				...(["Complete", "Cancel"] as const).flatMap((formUuid) => [
					{
						toolName: "removeField",
						input: {
							moduleUuid: "Jobs",
							formUuid,
							fieldUuid: "fixture_placeholder",
						},
					},
					{
						toolName: "updateForm",
						input: { moduleUuid: "Jobs", formUuid, post_submit: "app_home" },
					},
				]),
			],
		);
		await h.seedProjectMember(scope.actorUserId, scope.projectId, "viewer");
		await h.seedAppWithBlueprint(doc, {
			id: scope.appId,
			owner: scope.actorUserId,
			projectId: scope.projectId,
		});
		const call = sharedJourneyCalls(doc);
		const startInput = {
			purpose:
				"Hold a cancellation open while another worker completes the same job",
			sessions: [{ id: "coordinator" }, { id: "worker" }],
			scenario: {
				records: [
					{
						id: "job-1",
						caseType: "job",
						name: "Inspect pump",
						properties: { job_state: "pending" },
					},
				],
			},
		};
		const started = stepSchema.parse(await call("startAppTest", startInput));
		expect(started.observation).toMatchObject({
			sessionId: "coordinator",
			sessions: [
				{ id: "coordinator", screen: "home" },
				{ id: "worker", screen: "home" },
			],
			recordSources: { submission: "Preview/Postgres-current-isolated-store" },
		});
		let current = started;
		let request = 0;
		const advance = async (actions: unknown[]) => {
			const result = await call(
				"continueAppTest",
				{ testId: current.testId, expectedStep: current.step, actions },
				`interleave-${++request}`,
			);
			current = stepSchema.parse(result);
			return result;
		};
		const open = (sessionId: string, formUuid: string) => [
			{ sessionId, action: { kind: "menu", moduleUuid: "Jobs" } },
			{ sessionId, action: { kind: "select", caseIds: ["job-1"] } },
			{ sessionId, action: { kind: "routeContinue" } },
			{
				sessionId,
				action: { kind: "form", formUuid },
				expect: { screen: "form" },
			},
		];
		// Case-first entry offers record selection, not a search prerequisite or
		// a direct followup launch. The same saved form opens after selection.
		expect(
			await advance([
				{ action: { kind: "menu", moduleUuid: "Jobs" } },
				{ action: { kind: "form", formUuid: "Cancel" } },
			]),
		).toMatchObject({
			stopped: { index: 1 },
			observation: {
				completed: false,
				error: "This form is not offered by the current record list.",
			},
		});
		const held = await advance([
			...open("coordinator", "Cancel").slice(1),
			{
				action: {
					kind: "answer",
					answers: [{ path: "note", value: "Retained coordinator answer" }],
				},
			},
		]);
		expect(held).toMatchObject({
			observation: {
				sessionId: "coordinator",
				recordSources: { openForm: "retained-entry-snapshot" },
				questions: expect.arrayContaining([
					expect.objectContaining({
						path: "status_at_entry",
						value: "pending",
					}),
				]),
			},
		});
		const refused = await advance([
			{ sessionId: "missing", action: { kind: "submit" } },
			{ sessionId: "worker", action: { kind: "home" } },
		]);
		expect(refused).toMatchObject({
			stopped: { index: 0 },
			observation: { sessionId: "missing", completed: false },
		});
		const competed = await advance([
			...open("worker", "Complete"),
			{
				sessionId: "worker",
				action: {
					kind: "answer",
					answers: [
						{ path: "note", value: "Completed while cancellation was open" },
					],
				},
			},
			{
				sessionId: "worker",
				action: { kind: "submit" },
				expect: { submitted: true, screen: "home" },
			},
		]);
		expect(competed).toMatchObject({
			observation: {
				sessionId: "worker",
				sessions: [
					{ id: "coordinator", screen: "form" },
					{ id: "worker", screen: "home" },
				],
			},
		});
		const caseRows = async () =>
			(
				await sql<{
					properties: Record<string, unknown>;
				}>`SELECT properties FROM ${sql.id(appTestNamespace(started.testId), "cases")} WHERE case_id = 'job-1'`.execute(
					h.db(),
				)
			).rows;
		expect(await caseRows()).toEqual([
			{
				properties: {
					job_state: "completed",
					completion_note: "Completed while cancellation was open",
				},
			},
		]);
		const synced = await advance([{ action: { kind: "sync" } }]);
		expect(synced).toMatchObject({
			observation: {
				sessionId: "coordinator",
				synced: true,
				screen: "form",
				recordSources: { openForm: "retained-entry-snapshot" },
				questions: expect.arrayContaining([
					expect.objectContaining({
						path: "status_at_entry",
						value: "pending",
					}),
					expect.objectContaining({
						path: "note",
						value: "Retained coordinator answer",
					}),
					expect.objectContaining({ path: "pending_jobs", repeatCount: 1 }),
					expect.objectContaining({
						path: "pending_jobs[0]/job_id",
						value: "job-1",
					}),
				]),
			},
		});
		const submitInput = {
			testId: current.testId,
			expectedStep: current.step,
			actions: [{ action: { kind: "submit" }, expect: { submitted: true } }],
		};
		const submitted = await call(
			"continueAppTest",
			submitInput,
			"held-form-submission",
		);
		current = stepSchema.parse(submitted);
		expect(submitted).toMatchObject({
			observation: {
				sessionId: "coordinator",
				savedInTest: true,
				evidence: {
					caseTransaction: "committed",
					serializedSubmission: "not-observed",
				},
			},
		});
		expect(await caseRows()).toEqual([
			{
				properties: {
					job_state: guarded ? "completed" : "cancelled",
					completion_note: "Completed while cancellation was open",
					cancellation_note: "Retained coordinator answer",
				},
			},
		]);
		expect(
			await call("continueAppTest", submitInput, "held-form-submission"),
		).toEqual(submitted);
		const badFinish = await advance([
			{ sessionId: "missing", action: { kind: "finish" } },
		]);
		expect(badFinish).toMatchObject({
			observation: { completed: false, sessionId: "missing" },
			stopped: { index: 0 },
		});
		expect(await caseRows()).toHaveLength(1);
		await advance([{ action: { kind: "finish" } }]);
		expect(
			(
				await sql`SELECT 1 FROM pg_namespace WHERE nspname = ${appTestNamespace(started.testId)}`.execute(
					h.db(),
				)
			).rows,
		).toEqual([]);
		expect(
			(
				await sql`SELECT 1 FROM public.cases WHERE app_id = ${scope.appId}`.execute(
					h.db(),
				)
			).rows,
		).toEqual([]);
		const evidence = await readAppTestSteps({
			...scope,
			testId: started.testId,
			limit: 20,
		});
		expect(
			evidence.steps.filter((step) => step.action?.sessionId === "worker"),
		).toHaveLength(6);
	},
);

it("preserves synced records for fresh entries while linked forms keep the submitting entry world", {
	timeout: 20_000,
}, async () => {
	const doc = await createEvaluationApp(
		[
			{
				name: "Equipment",
				caseType: "equipment",
				forms: [
					{ name: "Register", type: "registration" },
					{ name: "Review", type: "followup" },
				],
			},
		],
		[
			{
				toolName: "addFields",
				input: {
					moduleUuid: "Equipment",
					formUuid: "Register",
					fields: [
						{ id: "name", kind: "text", label: "Name", required: true },
						{
							id: "entry_count",
							kind: "text",
							label: "Known equipment",
							default_value:
								"count(instance('casedb')/casedb/case[@case_type = 'equipment'])",
						},
					],
				},
			},
			{
				toolName: "updateForm",
				input: {
					moduleUuid: "Equipment",
					formUuid: "Register",
					recordName: "#form/name",
				},
			},
			{
				toolName: "addFields",
				input: {
					moduleUuid: "Equipment",
					formUuid: "Review",
					fields: [
						{
							id: "name",
							kind: "text",
							label: "Equipment name",
							default_value: "#case/case_name",
						},
						{
							id: "entry_count",
							kind: "text",
							label: "Known equipment",
							default_value:
								"count(instance('casedb')/casedb/case[@case_type = 'equipment'])",
						},
					],
				},
			},
			...(["Register", "Review"] as const).map((formUuid) => ({
				toolName: "removeField",
				input: {
					moduleUuid: "Equipment",
					formUuid,
					fieldUuid: "fixture_placeholder",
				},
			})),
			{
				toolName: "addFormLinks",
				input: {
					moduleUuid: "Equipment",
					formUuid: "Register",
					links: [
						{
							link: {
								target: {
									type: "form",
									moduleUuid: "Equipment",
									formUuid: "Review",
								},
							},
						},
					],
				},
			},
		],
	);
	await h.seedProjectMember(scope.actorUserId, scope.projectId, "viewer");
	await h.seedAppWithBlueprint(doc, {
		id: scope.appId,
		owner: scope.actorUserId,
		projectId: scope.projectId,
	});
	const call = sharedJourneyCalls(doc);
	let current = stepSchema.parse(
		await call("startAppTest", {
			purpose: "Sync another registration while an unrelated form stays open",
			sessions: [{ id: "held" }, { id: "other" }],
		}),
	);
	const advance = async (sessionId: string, action: unknown) => {
		current = stepSchema.parse(
			await call("continueAppTest", {
				testId: current.testId,
				expectedStep: current.step,
				actions: [{ sessionId, action }],
			}),
		);
		expect(current.observation.error).toBeUndefined();
		return current.observation;
	};
	try {
		for (const [sessionId, name] of [
			["held", "Held registration"],
			["other", "Learned by Sync"],
		]) {
			await advance(sessionId, { kind: "menu", moduleUuid: "Equipment" });
			await advance(sessionId, { kind: "form", formUuid: "Register" });
			await advance(sessionId, {
				kind: "answer",
				answers: [{ path: "name", value: name }],
			});
		}
		const created = z
			.object({
				savedInTest: z.literal(true),
				effects: z.object({ primaryCaseIds: z.array(z.string()).length(1) }),
			})
			.parse(await advance("other", { kind: "submit" }));
		const learnedId = created.effects.primaryCaseIds[0];
		expect(await advance("held", { kind: "sync" })).toMatchObject({
			availableRecords: expect.arrayContaining([
				expect.objectContaining({ id: learnedId, type: "equipment" }),
			]),
			questions: expect.arrayContaining([
				expect.objectContaining({ path: "entry_count", value: "0" }),
				expect.objectContaining({ path: "name", value: "Held registration" }),
			]),
		});
		// A direct link uses the submitting entry plus its own exact patch. It
		// must not borrow the unrelated row learned after this entry opened.
		expect(await advance("held", { kind: "submit" })).toMatchObject({
			savedInTest: true,
			screen: "form",
			name: "Review",
			questions: expect.arrayContaining([
				expect.objectContaining({ path: "entry_count", value: "1" }),
				expect.objectContaining({ path: "name", value: "Held registration" }),
			]),
		});
		const stored = await sql<{
			case_name: string;
		}>`SELECT case_name FROM ${sql.id(appTestNamespace(current.testId), "cases")} WHERE case_type = 'equipment' ORDER BY case_name`.execute(
			h.db(),
		);
		expect(stored.rows).toEqual([
			{ case_name: "Held registration" },
			{ case_name: "Learned by Sync" },
		]);
		await advance("held", { kind: "home" });
		await advance("held", { kind: "menu", moduleUuid: "Equipment" });
		await advance("held", { kind: "form", formUuid: "Review" });
		expect(
			await advance("held", { kind: "select", caseIds: [learnedId] }),
		).toMatchObject({ screen: "details", canContinue: true });
		// An ordinary new entry uses the catalog's Sync plus both commits. No
		// additional Sync may be needed to recover the already learned identity.
		expect(await advance("held", { kind: "routeContinue" })).toMatchObject({
			screen: "form",
			name: "Review",
			questions: expect.arrayContaining([
				expect.objectContaining({ path: "name", value: "Learned by Sync" }),
				expect.objectContaining({ path: "entry_count", value: "2" }),
			]),
		});
	} finally {
		await call("continueAppTest", {
			testId: current.testId,
			expectedStep: current.step,
			action: { kind: "finish" },
		});
	}
	expect(
		(
			await sql`SELECT 1 FROM public.cases WHERE app_id = ${scope.appId}`.execute(
				h.db(),
			)
		).rows,
	).toEqual([]);
});

it("refuses duplicate session IDs and invented Preview identities before retaining a test namespace", async () => {
	const doc = sectionEntryDoc();
	await h.seedProjectMember(scope.actorUserId, scope.projectId, "viewer");
	await h.seedAppWithBlueprint(doc, {
		id: scope.appId,
		owner: scope.actorUserId,
		projectId: scope.projectId,
	});
	for (const sessions of [
		[{ id: "same" }, { id: "same" }],
		[{ id: "worker", personaUuid: "Invented worker" }],
	]) {
		await expect(
			startAppTest(scope, {
				requestId: "invalid-start",
				expectedBlueprintSeq: 0,
				input: { purpose: "Refuse unavailable sessions", sessions },
			}),
		).rejects.toThrow();
	}
	expect(
		await h.db().selectFrom("app_test_sessions").select("id").execute(),
	).toEqual([]);
	expect(
		(
			await sql`SELECT 1 FROM pg_namespace WHERE nspname LIKE 'nova_app_test_%'`.execute(
				h.db(),
			)
		).rows,
	).toEqual([]);
});

it("keeps saved identities, language, pages and answers local to four retained sessions", {
	timeout: 15_000,
}, async () => {
	const author = makeAuthoringHarness({}, sectionEntryDoc());
	expect(
		await author.call("addLanguage", { language: { language: "spa" } }),
	).not.toHaveProperty("error");
	expect(
		await author.call("addPersonas", {
			personas: [{ name: "Alice" }, { name: "Bob" }],
		}),
	).not.toHaveProperty("error");
	const doc = author.currentDoc();
	const alice = Object.values(doc.personas ?? {}).find(
		(persona) => persona.name === "Alice",
	);
	const bob = Object.values(doc.personas ?? {}).find(
		(persona) => persona.name === "Bob",
	);
	if (!alice || !bob) throw new Error("Missing saved workers.");
	await h.seedProjectMember(scope.actorUserId, scope.projectId, "viewer");
	await h.seedAppWithBlueprint(doc, {
		id: scope.appId,
		owner: scope.actorUserId,
		projectId: scope.projectId,
	});
	const call = sharedJourneyCalls(doc);
	let current = stepSchema.parse(
		await call("startAppTest", {
			purpose: "Retain separate worker forms and settings",
			sessions: [
				{ id: "first", personaUuid: "Alice" },
				{ id: "second", personaUuid: "Bob", language: { language: "spa" } },
				{ id: "third" },
				{ id: "fourth", personaUuid: alice.uuid },
			],
		}),
	);
	expect(current.observation).toMatchObject({
		worker: { personaUuid: alice.uuid, name: "Alice" },
		sessions: [
			{ id: "first", personaUuid: alice.uuid },
			{ id: "second", personaUuid: bob.uuid },
			{ id: "third", personaUuid: null },
			{ id: "fourth", personaUuid: alice.uuid },
		],
	});
	let request = 0;
	const advance = async (actions: unknown[]) => {
		current = stepSchema.parse(
			await call(
				"continueAppTest",
				{ testId: current.testId, expectedStep: current.step, actions },
				`workers-${++request}`,
			),
		);
		return current.observation;
	};
	await advance([
		{ action: { kind: "menu", moduleUuid: "Visits" } },
		{ action: { kind: "form", formUuid: "Inspect" } },
		{
			action: {
				kind: "answer",
				answers: [{ path: "first/zone", value: "north" }],
			},
		},
		{ sessionId: "second", action: { kind: "menu", moduleUuid: "Visits" } },
		{ sessionId: "second", action: { kind: "form", formUuid: "Inspect" } },
		{
			sessionId: "second",
			action: {
				kind: "answer",
				answers: [{ path: "first/zone", value: "south" }],
			},
		},
		{ sessionId: "second", action: { kind: "pageNext" } },
	]);
	expect(current.observation).toMatchObject({
		sessionId: "second",
		worker: { personaUuid: bob.uuid },
		language: { selected: { language: "spa" } },
		pageNavigation: { canNext: false, canPrevious: true },
		questions: expect.arrayContaining([
			expect.objectContaining({
				path: "second/rounds[0]/assets[0]/note",
				value: "tank",
			}),
		]),
	});
	expect(await advance([{ action: { kind: "observe" } }])).toMatchObject({
		sessionId: "first",
		worker: { personaUuid: alice.uuid },
		language: { selected: { language: "eng" } },
		pageNavigation: { canNext: true, canPrevious: false },
		questions: expect.arrayContaining([
			expect.objectContaining({ path: "first/zone", value: "north" }),
		]),
	});
	await advance([
		{
			sessionId: "second",
			action: { kind: "language", language: { language: "eng" } },
		},
		{ sessionId: "second", action: { kind: "identity", personaUuid: null } },
		{ sessionId: "third", action: { kind: "menu", moduleUuid: "Visits" } },
		{ action: { kind: "observe" } },
	]);
	expect(current.observation).toMatchObject({
		sessionId: "first",
		worker: { personaUuid: alice.uuid },
		screen: "form",
		sessions: [
			{ id: "first", personaUuid: alice.uuid, screen: "form" },
			{ id: "second", personaUuid: null, screen: "home" },
			{ id: "third", screen: "menu" },
			{ id: "fourth", personaUuid: alice.uuid, screen: "home" },
		],
		questions: expect.arrayContaining([
			expect.objectContaining({ path: "first/zone", value: "north" }),
		]),
	});
	await advance([{ sessionId: "fourth", action: { kind: "finish" } }]);
	expect(current.observation).toEqual({ ended: true, sessionId: "fourth" });
	expect(
		(
			await sql`SELECT 1 FROM pg_namespace WHERE nspname = ${appTestNamespace(current.testId)}`.execute(
				h.db(),
			)
		).rows,
	).toEqual([]);
});
