import { modelMessageSchema } from "ai";
import { sql } from "kysely";
import { expect, it } from "vitest";
import { z } from "zod";
import { makeAuthoringHarness } from "@/lib/agent/__tests__/authoringHarness";
import { runSharedToolCall } from "@/lib/agent/authoring/sharedToolCall";
import { authoringToolSchema } from "@/lib/agent/authoring/toolSchema";
import { SHARED_TOOL_REGISTRY } from "@/lib/agent/sharedToolRegistry";
import { CanonicalMutationWorkspace } from "@/lib/agent/workspace/canonicalWorkspace";
import {
	HOST_MODULE,
	noMatchesDoc,
	REGISTER_FORM,
} from "@/lib/commcare/__tests__/noMatchesWireFixture";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { readAppTestSteps } from "@/lib/db/appTests";
import { createEvaluationApp } from "../../engine/__tests__/evaluationFixture";
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
	const doc = await createEvaluationApp({
		name: "Equipment",
		case_type: "equipment",
		forms: [
			{
				name: "Register",
				type: "registration",
				recordName: "#form/name",
				fields: [
					{ kind: "text", id: "name", label: "Equipment name", required: true },
				],
			},
			{
				name: "Retire",
				type: "close",
				fields: [
					{
						kind: "text",
						id: "reason",
						label: "Reason for retirement",
						required: true,
						caseWrite: { caseType: "equipment", property: "retirement_reason" },
					},
				],
			},
		],
	});
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
	const selected = await step({ kind: "select", caseIds: [id] });
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
	const evidence = await readAppTestSteps({ ...scope, testId });
	expect(evidence.steps).toHaveLength(current.step + 1);
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
	const author = makeAuthoringHarness();
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
	await write("createModule", {
		name: "Households",
		case_type: "household",
		forms: [
			{
				name: "Visit",
				type: "followup",
				fields: [
					{ kind: "label", id: "intro", label: "Select this household" },
				],
			},
		],
	});
	await write("createModule", {
		name: "Equipment",
		case_type: "equipment",
		forms: [
			{
				name: "Inspect",
				type: "followup",
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
	await write("createForm", {
		moduleUuid: "Equipment",
		name: "Receipt",
		type: "survey",
		post_submit: "previous",
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
	expect(await call("startAppTest", inputs, "start")).toEqual(current);
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
	const author = makeAuthoringHarness();
	expect(
		await author.call("createModule", {
			name: "People",
			case_type: "person",
			forms: [
				{
					name: "Visit",
					type: "followup",
					fields: [
						{
							kind: "text",
							id: "region",
							label: "Region",
							caseWrite: { caseType: "person", property: "region" },
						},
					],
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
	const doc = author.currentDoc();
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
	const author = makeAuthoringHarness();
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
	await write("createModule", {
		name: "Groups",
		case_type: "group",
		forms: [
			{
				name: "Register group",
				type: "survey",
				fields: [
					{ kind: "text", id: "name", label: "Group name", required: true },
				],
			},
			{
				name: "Review group",
				type: "followup",
				fields: [{ kind: "label", id: "intro", label: "Review this group" }],
			},
		],
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
	const doc = author.currentDoc();
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
