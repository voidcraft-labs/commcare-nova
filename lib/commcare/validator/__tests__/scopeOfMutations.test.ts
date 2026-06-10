import { describe, expect, it } from "vitest";
import type { Mutation } from "@/lib/doc/types";
import { asUuid, type BlueprintDoc, type Field } from "@/lib/domain";
import { buildDoc, caseListConfig, f } from "../../../__tests__/docHelpers";
import type { ValidationScope } from "../index";
import { scopeOfMutations } from "../scopeOfMutations";

/**
 * Two modules sharing the "patient" case type, one unrelated survey
 * module — the smallest doc where "containing form", "all modules of a
 * case type", and "untouched elsewhere" are all distinct sets.
 */
function twoTypeDoc(): BlueprintDoc {
	return buildDoc({
		appName: "Scope",
		modules: [
			{
				name: "Patients",
				caseType: "patient",
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
								id: "case_name",
								label: "Name",
								case_property_on: "patient",
							}),
							f({ kind: "text", id: "notes", label: "Notes" }),
							f({
								kind: "group",
								id: "grp",
								label: "Group",
								children: [f({ kind: "text", id: "inner", label: "Inner" })],
							}),
						],
					},
				],
			},
			{
				name: "Patient Followups",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [f({ kind: "text", id: "visit_notes", label: "Notes" })],
					},
				],
			},
			{
				name: "Survey",
				forms: [
					{
						name: "Feedback",
						type: "survey",
						fields: [f({ kind: "text", id: "answer", label: "Answer" })],
					},
				],
			},
		],
		caseTypes: [
			{ name: "patient", properties: [{ name: "case_name", label: "Name" }] },
		],
	});
}

function fieldByid(doc: BlueprintDoc, id: string): Field {
	const field = Object.values(doc.fields).find((x) => x.id === id);
	if (!field) throw new Error(`fixture is missing field "${id}"`);
	return field;
}

function expectScope(
	result: ValidationScope | "full",
): asserts result is ValidationScope {
	expect(result).not.toBe("full");
}

describe("scopeOfMutations", () => {
	it("a plain field edit scopes to its containing form only", () => {
		const doc = twoTypeDoc();
		const notes = fieldByid(doc, "notes");
		const scope = scopeOfMutations(doc, [
			{
				kind: "updateField",
				uuid: notes.uuid,
				targetKind: "text",
				patch: { label: "Renamed" },
			} as Mutation,
		]);
		expectScope(scope);
		expect([...(scope.formUuids ?? [])]).toEqual([
			doc.formOrder[doc.moduleOrder[0]][0],
		]);
		expect(scope.moduleUuids?.size).toBe(0);
	});

	it("a nested field resolves its containing form through the parent chain", () => {
		const doc = twoTypeDoc();
		const inner = fieldByid(doc, "inner");
		const scope = scopeOfMutations(doc, [
			{ kind: "renameField", uuid: inner.uuid, newId: "inner2" },
		]);
		expectScope(scope);
		expect([...(scope.formUuids ?? [])]).toEqual([
			doc.formOrder[doc.moduleOrder[0]][0],
		]);
	});

	it("a case-property-touching field mutation widens to every module of that case type", () => {
		const doc = twoTypeDoc();
		const caseName = fieldByid(doc, "case_name");
		const scope = scopeOfMutations(doc, [
			{ kind: "renameField", uuid: caseName.uuid, newId: "full_name" },
		]);
		expectScope(scope);
		// Both patient modules — and NOT the survey module.
		expect([...(scope.moduleUuids ?? [])].sort()).toEqual(
			[doc.moduleOrder[0], doc.moduleOrder[1]].sort(),
		);
	});

	it("a patch GAINING case_property_on widens too", () => {
		const doc = twoTypeDoc();
		const notes = fieldByid(doc, "notes");
		const scope = scopeOfMutations(doc, [
			{
				kind: "updateField",
				uuid: notes.uuid,
				targetKind: "text",
				patch: { case_property_on: "patient" },
			} as Mutation,
		]);
		expectScope(scope);
		expect(scope.moduleUuids?.size).toBe(2);
	});

	it("removing a container widens by every case type its subtree writes", () => {
		const doc = twoTypeDoc();
		const grp = fieldByid(doc, "grp");
		// Give the nested field a case write first (fixture-level), then
		// derive the scope for removing the whole group.
		const withWriter = structuredClone(doc) as BlueprintDoc;
		const inner = Object.values(withWriter.fields).find(
			(x) => x.id === "inner",
		);
		if (inner) {
			(inner as unknown as Record<string, unknown>).case_property_on =
				"patient";
		}
		const scope = scopeOfMutations(withWriter, [
			{ kind: "removeField", uuid: grp.uuid },
		]);
		expectScope(scope);
		expect(scope.moduleUuids?.size).toBe(2);
	});

	it("updateModule keeps module scope unless the patch touches caseType", () => {
		const doc = twoTypeDoc();
		const moduleUuid = doc.moduleOrder[0];
		const rename = scopeOfMutations(doc, [
			{ kind: "updateModule", uuid: moduleUuid, patch: { name: "Renamed" } },
		]);
		expectScope(rename);
		expect([...(rename.moduleUuids ?? [])]).toEqual([moduleUuid]);

		expect(
			scopeOfMutations(doc, [
				{
					kind: "updateModule",
					uuid: moduleUuid,
					patch: { caseType: "other" },
				},
			]),
		).toBe("full");

		// Same-value caseType is not "touching" — nothing can change.
		const sameValue = scopeOfMutations(doc, [
			{
				kind: "updateModule",
				uuid: moduleUuid,
				patch: { caseType: "patient" },
			},
		]);
		expectScope(sameValue);
	});

	it("updateForm keeps form scope unless the patch touches type", () => {
		const doc = twoTypeDoc();
		const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
		const links = scopeOfMutations(doc, [
			{ kind: "updateForm", uuid: formUuid, patch: { postSubmit: "app_home" } },
		]);
		expectScope(links);
		expect([...(links.formUuids ?? [])]).toEqual([formUuid]);

		expect(
			scopeOfMutations(doc, [
				{ kind: "updateForm", uuid: formUuid, patch: { type: "survey" } },
			]),
		).toBe("full");
	});

	it("structural cross-entity kinds map to full", () => {
		const doc = twoTypeDoc();
		const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
		const fullKinds: Mutation[] = [
			{ kind: "removeModule", uuid: doc.moduleOrder[0] },
			{ kind: "removeForm", uuid: formUuid },
			{
				kind: "moveForm",
				uuid: formUuid,
				toModuleUuid: doc.moduleOrder[1],
				toIndex: 0,
			},
			{ kind: "setAppName", name: "X" },
			{ kind: "setConnectType", connectType: "learn" },
			{ kind: "setAppLogo", logo: null },
			{ kind: "setCaseTypes", caseTypes: null },
		];
		for (const mutation of fullKinds) {
			expect(scopeOfMutations(doc, [mutation]), mutation.kind).toBe("full");
		}
	});

	it("moveModule is an app-rules-only (empty) scope, not full", () => {
		const doc = twoTypeDoc();
		const scope = scopeOfMutations(doc, [
			{ kind: "moveModule", uuid: doc.moduleOrder[0], toIndex: 2 },
		]);
		expectScope(scope);
		expect(scope.moduleUuids?.size).toBe(0);
		expect(scope.formUuids?.size).toBe(0);
	});

	it("moveField scopes both the source and the target form", () => {
		const doc = twoTypeDoc();
		const notes = fieldByid(doc, "notes");
		const targetForm = doc.formOrder[doc.moduleOrder[2]][0];
		const scope = scopeOfMutations(doc, [
			{
				kind: "moveField",
				uuid: notes.uuid,
				toParentUuid: targetForm,
				toIndex: 0,
			},
		]);
		expectScope(scope);
		expect([...(scope.formUuids ?? [])].sort()).toEqual(
			[doc.formOrder[doc.moduleOrder[0]][0], targetForm].sort(),
		);
	});

	it("intra-batch adds resolve: addModule + addForm + addField stays scoped", () => {
		const doc = twoTypeDoc();
		const scope = scopeOfMutations(doc, [
			{
				kind: "addModule",
				module: { uuid: asUuid("mod-new"), id: "mod-new", name: "New Module" },
			},
			{
				kind: "addForm",
				moduleUuid: asUuid("mod-new"),
				form: {
					uuid: asUuid("form-new"),
					id: "form-new",
					name: "New Form",
					type: "survey",
				},
			},
			{
				kind: "addField",
				parentUuid: asUuid("form-new"),
				field: {
					uuid: asUuid("fld-new"),
					kind: "text",
					id: "q1",
					label: "Q1",
				} as Field,
			},
		]);
		expectScope(scope);
		expect(scope.moduleUuids?.has(asUuid("mod-new"))).toBe(true);
		expect(scope.formUuids?.has(asUuid("form-new"))).toBe(true);
	});

	it("an unresolvable target degrades to full, never to a silent miss", () => {
		const doc = twoTypeDoc();
		expect(
			scopeOfMutations(doc, [
				{
					kind: "addField",
					parentUuid: asUuid("nowhere"),
					field: {
						uuid: asUuid("fld-x"),
						kind: "text",
						id: "q",
						label: "Q",
					} as Field,
				},
			]),
		).toBe("full");
	});

	it("a batch unions the per-mutation scopes; any full wins", () => {
		const doc = twoTypeDoc();
		const notes = fieldByid(doc, "notes");
		const union = scopeOfMutations(doc, [
			{
				kind: "updateField",
				uuid: notes.uuid,
				targetKind: "text",
				patch: { label: "x" },
			} as Mutation,
			{
				kind: "setModuleMedia",
				uuid: doc.moduleOrder[2],
				icon: null,
				audioLabel: null,
			},
		]);
		expectScope(union);
		expect(union.formUuids?.size).toBe(1);
		expect([...(union.moduleUuids ?? [])]).toEqual([doc.moduleOrder[2]]);

		expect(
			scopeOfMutations(doc, [
				{
					kind: "updateField",
					uuid: notes.uuid,
					targetKind: "text",
					patch: { label: "x" },
				} as Mutation,
				{ kind: "setCaseTypes", caseTypes: null },
			]),
		).toBe("full");
	});
});
