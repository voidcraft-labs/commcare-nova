import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import type { CaseIndexRow, CaseRow } from "@/lib/case-store";
import { eq, literal, prop, sessionContext } from "@/lib/domain/predicate";
import { prepareEntryPointLaunch } from "../entryPointLaunch";
import { assertAdmittedPreviewDoc } from "./fixtures/admittedDoc";

function launch(args: Parameters<typeof prepareEntryPointLaunch>[0]) {
	assertAdmittedPreviewDoc(args.doc);
	return prepareEntryPointLaunch(args);
}

const M = testUuid("module"),
	F = testUuid("form"),
	E = testUuid("entry");
function fixture(multiple = false) {
	const doc = buildDoc({
		appName: "Links",
		caseTypes: [{ name: "patient", properties: [] }],
		modules: [
			{
				uuid: "module",
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: "form",
						name: "Visit",
						type: "followup",
						fields: [f({ kind: "text", id: "notes" })],
					},
				],
			},
		],
	});
	if (multiple && doc.modules[M].caseListConfig)
		doc.modules[M].caseListConfig.selection = { kind: "multiple", maximum: 3 };
	doc.forms[F].entryPoint = { uuid: E, id: "visit" };
	return doc;
}
const row = (id: string, caseType = "patient"): CaseRow => ({
	case_id: id,
	case_type: caseType,
	case_name: id,
	properties: {},
	parent_case_id: null,
	external_id: null,
	status: "open",
	opened_on: null,
	modified_on: null,
	closed_on: null,
	owner_id: "worker",
	app_id: "app",
});
function args(doc = fixture()) {
	return {
		doc,
		entryPointUuid: E,
		expectedSeq: 4,
		selections: [{ moduleUuid: M, caseIds: ["b"] }],
		database: { rows: [row("a"), row("b")], indices: [] as CaseIndexRow[] },
		session: { context: { userid: "worker" }, user: {}, userPropertySlugs: {} },
		lookup: { kind: "idle" as const },
	};
}
describe("entry point Preview admission", () => {
	it("binds the exact selected case without a first-case fallback or search launch", () => {
		const result = launch(args());
		expect(result.kind).toBe("ready");
		if (result.kind === "ready") {
			// Server Actions reject null-prototype dictionaries even though JSON accepts them.
			expect(Object.getPrototypeOf(result.launch.menuSelections)).toBe(
				Object.prototype,
			);
			expect(result.launch.formTarget).toEqual({
				formUuid: F,
				cases: [expect.objectContaining({ caseId: "b" })],
			});
			expect(result.launch.location).toEqual({
				kind: "form",
				moduleUuid: M,
				formUuid: F,
			});
			expect(result.launch.formTarget?.searchLaunch).toBeUndefined();
		}
	});
	it("preserves ordered multiple selections", () => {
		const input = args(fixture(true));
		input.selections[0].caseIds = ["b", "a"];
		const result = launch(input);
		expect(
			result.kind === "ready" &&
				result.launch.formTarget?.cases?.map((c) => c.caseId),
		).toEqual(["b", "a"]);
	});
	for (const ids of [[], ["a", "b"], ["a", "a"], ["missing"]])
		it(`refuses invalid scalar selection ${JSON.stringify(ids)}`, () => {
			const input = args();
			input.selections[0].caseIds = ids;
			expect(launch(input).kind).toBe("refused");
		});
	it("refuses missing or extra selection bindings", () => {
		expect(launch({ ...args(), selections: [] }).kind).toBe("refused");
		const input = args();
		input.selections.push({ moduleUuid: testUuid("foreign"), caseIds: ["a"] });
		expect(launch(input).kind).toBe("refused");
	});
	it("refuses foreign case types even with an existing device case ID", () => {
		const input = args();
		input.database.rows = [row("b", "other")];
		expect(launch(input).kind).toBe("refused");
	});
	it("enforces display conditions unless the form explicitly bypasses them", () => {
		const input = args();
		input.doc.modules[M].displayCondition = eq(
			sessionContext("userid"),
			literal("different-worker"),
		);
		expect(launch(input).kind).toBe("refused");
		input.doc.forms[F].entryPoint = {
			uuid: E,
			id: "visit",
			ignoreDisplayConditions: true,
		};
		expect(launch(input)).toMatchObject({
			kind: "ready",
			launch: { ignoreDisplayConditions: true },
		});
	});
	it("evaluates form visibility against the prospective case", () => {
		const input = args();
		input.doc.forms[F].displayCondition = eq(
			prop("patient", "case_name"),
			literal("b"),
		);
		expect(launch(input).kind).toBe("ready");
		input.selections[0].caseIds = ["a"];
		expect(launch(input).kind).toBe("refused");
	});
	it("does not let a visibility bypass open an unavailable case", () => {
		const input = args();
		input.doc.forms[F].entryPoint = {
			uuid: E,
			id: "visit",
			ignoreDisplayConditions: true,
		};
		input.database.rows = [];
		expect(launch(input)).toMatchObject({
			kind: "refused",
			message: expect.stringContaining("does not claim"),
		});
	});
	it("preserves a bare module menu destination", () => {
		const input = args();
		for (const uuid of input.doc.fieldOrder[F]) {
			delete input.doc.fields[uuid];
			delete input.doc.fieldParent[uuid];
		}
		delete input.doc.fieldOrder[F];
		delete input.doc.forms[F];
		input.doc.formOrder[M] = [];
		input.doc.modules[M].caseListOnly = true;
		input.doc.modules[M].entryPoint = { uuid: E, id: "patients" };
		input.selections = [];
		expect(launch(input)).toMatchObject({
			kind: "ready",
			launch: {
				location: { kind: "module", moduleUuid: M },
				menuSelections: {},
			},
		});
	});
});

describe("entry point parent selection", () => {
	it("requires the direct child index to match the selected parent", () => {
		const doc = buildDoc({
			appName: "Families",
			caseTypes: [
				{ name: "household", properties: [] },
				{ name: "patient", parent_type: "household", properties: [] },
			],
			modules: [
				{
					uuid: "households",
					name: "Households",
					caseType: "household",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							uuid: "household-visit",
							name: "Visit",
							type: "followup",
							fields: [f({ kind: "text", id: "notes" })],
						},
					],
				},
				{
					uuid: "module",
					name: "Patients",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							uuid: "form",
							name: "Visit",
							type: "followup",
							fields: [f({ kind: "text", id: "notes" })],
						},
					],
				},
			],
		});
		doc.forms[F].entryPoint = { uuid: E, id: "visit" };
		const input = args(doc);
		input.selections = [
			{ moduleUuid: testUuid("households"), caseIds: ["house"] },
			{ moduleUuid: M, caseIds: ["b"] },
		];
		input.database.rows = [row("house", "household"), row("b")];
		input.database.indices = [
			{
				case_id: "b",
				ancestor_id: "house",
				target_case_type: "household",
				identifier: "parent",
				relationship: "child",
				depth: 1,
			},
		];
		expect(launch(input).kind).toBe("ready");
		input.database.indices[0].relationship = "extension";
		expect(launch(input).kind).toBe("refused");
		input.database.indices[0].relationship = "child";
		input.database.indices[0].ancestor_id = "other-house";
		expect(launch(input).kind).toBe("refused");
	});
});
