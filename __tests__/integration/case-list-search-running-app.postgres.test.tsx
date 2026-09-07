// A real controller sends its final protocol through the production Server Actions.
// Authentication extraction is controlled; Project authorization, committed blueprint,
// receipt derivation, schema healing, SQL, and re-reads all use native PostgreSQL.
// Browser screen wiring is exercised by the native Preview and authenticated journeys.
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { createBlueprintDocStore } from "@/lib/doc/store";
import {
	type BlueprintDoc,
	calculatedColumn,
	plainColumn,
	simpleSearchInputDef,
	type Uuid,
} from "@/lib/domain";
import {
	arith,
	eq,
	literal,
	prop,
	qualifiedLiteral,
	term,
} from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";
import { assertAdmittedPreviewDoc } from "@/lib/preview/__tests__/fixtures/admittedDoc";
import {
	loadCaseDataAction,
	loadCasesAction,
	submitFormAction,
} from "@/lib/preview/engine/caseDataBinding";
import { caseRowsToFormPreloads } from "@/lib/preview/engine/caseDataBindingClient";
import { EngineController } from "@/lib/preview/engine/engineController";
import { previewAsMe } from "@/lib/preview/engine/identity";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth-utils", () => ({ getSession }));
const APP_ID = "case-list-search-int";
const PROJECT = "project-case-list-search-int";
const OWNER_ID = "owner-int";
const MODULE_NAME = "Patients";
const MODULE_UUID = testUuid("00000000-0000-0000-0000-00000000a001");
const REG_FORM_UUID = testUuid("00000000-0000-0000-0000-00000000a002");
const FOLLOWUP_FORM_UUID = testUuid("00000000-0000-0000-0000-00000000a003");
const CLOSE_FORM_UUID = testUuid("00000000-0000-0000-0000-00000000a004");
const COL_NAME_UUID = testUuid("00000000-0000-4000-8000-000000000001");
const COL_AGE_UUID = testUuid("00000000-0000-4000-8000-000000000002");
const COL_CALC_UUID = testUuid("00000000-0000-4000-8000-000000000003");
const SI_NAME_UUID = testUuid("00000000-0000-4000-8000-000000000010");
const MEMBER = {
	id: OWNER_ID,
	name: "Preview Worker",
	email: "worker@dimagi.com",
};
const h = setupAppStateTestDb("running_app_actions_", {
	authSchema: "migrated",
	poolMax: 4,
});
const controllers = new Set<EngineController>();
let doc: BlueprintDoc;
let digest: string;
beforeEach(async () => {
	getSession.mockResolvedValue({ user: MEMBER });
	doc = assertAdmittedPreviewDoc(buildFixtureDoc());
	digest = canonicalJsonDigest(toPersistableDoc(doc));
	await h.seedAppWithBlueprint(doc, {
		id: APP_ID,
		owner: OWNER_ID,
		projectId: PROJECT,
	});
});
afterEach(async () => {
	for (const controller of controllers) controller.dispose();
	await Promise.all(
		[...controllers].map((controller) => controller.awaitSettled()),
	);
	controllers.clear();
	vi.restoreAllMocks();
});
function buildFixtureDoc(): BlueprintDoc {
	return buildDoc({
		appId: APP_ID,
		appName: "Case List Search Integration",
		modules: [
			{
				uuid: MODULE_UUID,
				name: MODULE_NAME,
				caseType: "patient",
				caseListConfig: {
					columns: [
						plainColumn(COL_NAME_UUID, "case_name", "Name"),
						plainColumn(COL_AGE_UUID, "age", "Age", {
							sort: { direction: "desc", priority: 0 },
						}),
						calculatedColumn(
							COL_CALC_UUID,
							"Age next year",
							arith(
								"+",
								term(prop("patient", "age")),
								term(qualifiedLiteral(1, "int")),
							),
						),
					],
					filter: eq(prop("patient", "status"), literal("open")),
					searchInputs: [
						simpleSearchInputDef(
							SI_NAME_UUID,
							"name",
							"Name",
							"text",
							"full_name",
						),
					],
				},
				forms: [
					{
						uuid: REG_FORM_UUID,
						name: "Register",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "case_name",
								label: proseText("Patient name"),
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
							f({
								kind: "text",
								id: "name",
								label: proseText("Full name"),
								caseWrite: { caseType: "patient", property: "full_name" },
							}),
							f({
								kind: "int",
								id: "age",
								label: proseText("Age"),
								caseWrite: { caseType: "patient", property: "age" },
							}),
						],
					},
					{
						uuid: FOLLOWUP_FORM_UUID,
						name: "Visit",
						type: "followup",
						fields: [
							f({
								kind: "int",
								id: "age",
								label: proseText("Age"),
								caseWrite: { caseType: "patient", property: "age" },
							}),
						],
					},
					{
						uuid: CLOSE_FORM_UUID,
						name: "Close visit",
						type: "close",
						fields: [
							f({
								kind: "text",
								id: "notes",
								label: proseText("Closing notes"),
							}),
						],
					},
				],
			},
		],
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "full_name", label: proseText("Name"), data_type: "text" },
					{ name: "age", label: proseText("Age"), data_type: "int" },
				],
			},
		],
	});
}
async function controllerFor(formUuid: Uuid, caseId?: string) {
	const store = createBlueprintDocStore();
	store.getState().load(doc);
	const controller = new EngineController();
	controllers.add(controller);
	controller.setDocStore(store);
	controller.setPreviewIdentity(previewAsMe(MEMBER, doc));
	if (caseId === undefined) controller.activateForm(formUuid);
	else {
		const result = await loadCaseDataAction(APP_ID, "patient", caseId, 0);
		if (result.kind !== "row")
			throw new Error(`Case preload failed: ${JSON.stringify(result)}`);
		controller.activateForm(
			formUuid,
			caseRowsToFormPreloads(result.row, result.ancestors, [
				{ name: "patient", depth: 0 },
			]),
		);
	}
	expect(controller.entryStore.getState().ready).toBe(true);
	return controller;
}
async function submit(
	controller: EngineController,
	caseIds?: readonly string[],
) {
	expect(controller.validateAll()).toBe(true);
	const entryKey = controller.entryKey;
	if (!entryKey) throw new Error("Controller entry missing");
	const snapshot = await controller.computeSubmissionMutationAsync(
		{ caseIds },
		entryKey,
	);
	if (!snapshot) throw new Error("Controller submission missing");
	return submitFormAction(snapshot.mutation, APP_ID, digest);
}
async function register(name: string, age: number) {
	const controller = await controllerFor(REG_FORM_UUID);
	controller.setValueAt("/data/case_name", name);
	controller.setValueAt("/data/name", name);
	controller.setValueAt("/data/age", String(age));
	const result = await submit(controller);
	if (result.kind !== "registration")
		throw new Error(`Registration failed: ${JSON.stringify(result)}`);
	return result.caseId;
}
async function results(name = "") {
	const result = await loadCasesAction({
		appId: APP_ID,
		caseType: "patient",
		caseTypes: doc.caseTypes ?? [],
		caseListConfig: doc.modules[MODULE_UUID].caseListConfig,
		inputValues: { name },
	});
	if (result.kind !== "rows" && result.kind !== "empty")
		throw new Error(`Results failed: ${JSON.stringify(result)}`);
	return result.kind === "rows" ? result.rows : [];
}
function rowValues(rows: Awaited<ReturnType<typeof results>>) {
	return rows.map((row) => ({
		name: row.case_name,
		age: row.properties.age,
		nextAge: Number(row.calculated[COL_CALC_UUID]),
	}));
}

describe("controller and Server Action journey against PostgreSQL", () => {
	it("composes authored status and submitted search predicates and restores the sorted results when cleared", async () => {
		await register("Alice", 25);
		await register("Bob", 40);
		const carol = await register("Carol", 30);
		const close = await controllerFor(CLOSE_FORM_UUID, carol);
		expect(await submit(close, [carol])).toMatchObject({
			kind: "close",
			caseIds: [carol],
		});
		expect(rowValues(await results())).toEqual([
			{ name: "Bob", age: 40, nextAge: 41 },
			{ name: "Alice", age: 25, nextAge: 26 },
		]);
		expect(rowValues(await results("Alice"))).toEqual([
			{ name: "Alice", age: 25, nextAge: 26 },
		]);
		expect(rowValues(await results(""))).toEqual([
			{ name: "Bob", age: 40, nextAge: 41 },
			{ name: "Alice", age: 25, nextAge: 26 },
		]);
	});
	it("registers one owned row and replays the exact entry without duplicating it", async () => {
		const controller = await controllerFor(REG_FORM_UUID);
		controller.setValueAt("/data/case_name", "Dana");
		controller.setValueAt("/data/name", "Dana");
		controller.setValueAt("/data/age", "33");
		const result = await submit(controller);
		expect(result).toMatchObject({
			kind: "registration",
			caseId: expect.any(String),
		});
		expect(await submit(controller)).toEqual(result);
		const rows = await results();
		expect(rowValues(rows)).toEqual([{ name: "Dana", age: 33, nextAge: 34 }]);
		expect(rows[0].owner_id).toBe(OWNER_ID);
	});
	it("preloads and follows up the selected case, preserving unrelated values and recomputing its projection", async () => {
		const caseId = await register("Alice", 40);
		const controller = await controllerFor(FOLLOWUP_FORM_UUID, caseId);
		const ageUuid = doc.fieldOrder[FOLLOWUP_FORM_UUID][0];
		expect(controller.store.getState()[ageUuid].value).toBe("40");
		controller.setValueAt("/data/age", "41");
		expect(await submit(controller, [caseId])).toMatchObject({
			kind: "followup",
			caseIds: [caseId],
		});
		expect(rowValues(await results())).toEqual([
			{ name: "Alice", age: 41, nextAge: 42 },
		]);
		const row = await loadCaseDataAction(APP_ID, "patient", caseId, 0);
		expect(row).toMatchObject({
			kind: "row",
			row: { properties: { full_name: "Alice", age: 41 } },
		});
	});
	it("closes the selected case with a timestamp and removes it from the open Results", async () => {
		const caseId = await register("Alice", 25);
		const controller = await controllerFor(CLOSE_FORM_UUID, caseId);
		expect(await submit(controller, [caseId])).toMatchObject({
			kind: "close",
			caseIds: [caseId],
		});
		const result = await loadCaseDataAction(APP_ID, "patient", caseId, 0);
		expect(result).toMatchObject({
			kind: "row",
			row: { status: "closed", closed_on: expect.any(Date) },
		});
		expect(await results()).toEqual([]);
	});
	it("refuses stale document identity and revoked membership before any registration persists", async () => {
		const controller = await controllerFor(REG_FORM_UUID);
		controller.setValueAt("/data/case_name", "Blocked");
		const mutation = controller.computeSubmissionMutation({});
		expect(
			await submitFormAction(mutation, APP_ID, "0".repeat(64)),
		).toMatchObject({ kind: "blueprint-changed" });
		expect(await results()).toEqual([]);
		await sql`DELETE FROM auth_member WHERE "userId" = ${OWNER_ID} AND "organizationId" = ${PROJECT}`.execute(
			h.db(),
		);
		expect(await submitFormAction(mutation, APP_ID, digest)).toEqual({
			kind: "error",
			message: "App not found.",
		});
		await h.seedProjectMember(OWNER_ID, PROJECT, "editor");
		expect(await results()).toEqual([]);
	});
});
