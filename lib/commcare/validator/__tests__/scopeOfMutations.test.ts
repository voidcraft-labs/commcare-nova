import { describe, expect, it } from "vitest";
import type { Mutation } from "@/lib/doc/types";
import {
	asUuid,
	type BlueprintDoc,
	calculatedColumn,
	type Field,
} from "@/lib/domain";
import { literal, term } from "@/lib/domain/predicate";
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

	it("a case-property-touching rename maps to full — cascades and readers reach app-wide", () => {
		// The rename cascade renames peers by (id, case_property_on)
		// regardless of their module's caseType, and relation-walk readers
		// (search inputs / predicate ASTs walking to the written type) can
		// live in modules of ANY type — no widening bounds that reach.
		const doc = twoTypeDoc();
		const caseName = fieldByid(doc, "case_name");
		expect(
			scopeOfMutations(doc, [
				{ kind: "renameField", uuid: caseName.uuid, newId: "full_name" },
			]),
		).toBe("full");
	});

	it("a rename of a NON-case-bound field stays scoped to its form", () => {
		const doc = twoTypeDoc();
		const notes = fieldByid(doc, "notes");
		const scope = scopeOfMutations(doc, [
			{ kind: "renameField", uuid: notes.uuid, newId: "remarks" },
		]);
		expectScope(scope);
		expect([...(scope.formUuids ?? [])]).toEqual([
			doc.formOrder[doc.moduleOrder[0]][0],
		]);
	});

	it("a patch GAINING case_property_on maps to full", () => {
		const doc = twoTypeDoc();
		const notes = fieldByid(doc, "notes");
		expect(
			scopeOfMutations(doc, [
				{
					kind: "updateField",
					uuid: notes.uuid,
					targetKind: "text",
					patch: { case_property_on: "patient" },
				} as Mutation,
			]),
		).toBe("full");
	});

	it("a patch on a case-bound field that leaves the writer pair alone stays scoped", () => {
		const doc = twoTypeDoc();
		const caseName = fieldByid(doc, "case_name");
		const scope = scopeOfMutations(doc, [
			{
				kind: "updateField",
				uuid: caseName.uuid,
				targetKind: "text",
				patch: { label: "Full name" },
			} as Mutation,
		]);
		expectScope(scope);
		expect([...(scope.formUuids ?? [])]).toEqual([
			doc.formOrder[doc.moduleOrder[0]][0],
		]);
	});

	it("a patch renaming a case-bound field's id maps to full (writer pair changes)", () => {
		const doc = twoTypeDoc();
		const caseName = fieldByid(doc, "case_name");
		expect(
			scopeOfMutations(doc, [
				{
					kind: "updateField",
					uuid: caseName.uuid,
					targetKind: "text",
					patch: { id: "full_name" },
				} as Mutation,
			]),
		).toBe("full");
	});

	it("a kind-bearing patch stays form-scoped — the reducer strips the immutable discriminant", () => {
		// `kind` never changes through a patch: the wire schema strips the
		// key (the per-kind partial schemas omit it) and the reducer ignores
		// it for replay-equivalence — `convertField` is the single
		// kind-change path and keeps its full mapping. A kind-bearing patch
		// can therefore only flip form-local findings via its remaining
		// keys, even on a case-bound field.
		const doc = twoTypeDoc();
		const caseName = fieldByid(doc, "case_name");
		const scope = scopeOfMutations(doc, [
			{
				kind: "updateField",
				uuid: caseName.uuid,
				targetKind: "text",
				patch: { kind: "int" },
			} as Mutation,
		]);
		expectScope(scope);
		expect([...(scope.formUuids ?? [])]).toEqual([
			doc.formOrder[doc.moduleOrder[0]][0],
		]);
	});

	it("removing a container whose subtree writes a case property maps to full", () => {
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
		expect(
			scopeOfMutations(withWriter, [{ kind: "removeField", uuid: grp.uuid }]),
		).toBe("full");
	});

	it("renaming a case-bound field maps to full even when its peers live in OTHER-type modules", () => {
		// Finding-1 repro shape: two HOUSEHOLD modules whose forms write the
		// PATIENT type (the child-case authoring pattern). The cascade
		// renames the form-2 peer (`age` → `weight`, colliding with its
		// sibling) — a form no caseType-keyed widening would ever cover, so
		// the only sound scope is full.
		const doc = buildDoc({
			appName: "Peers",
			modules: [
				{
					name: "Households A",
					caseType: "household",
					forms: [
						{
							name: "F1",
							type: "followup",
							fields: [
								f({
									kind: "int",
									id: "age",
									label: "Age",
									case_property_on: "patient",
								}),
							],
						},
					],
				},
				{
					name: "Households B",
					caseType: "household",
					forms: [
						{
							name: "F2",
							type: "followup",
							fields: [
								f({
									kind: "int",
									id: "age",
									label: "Age",
									case_property_on: "patient",
								}),
								f({ kind: "int", id: "weight", label: "Weight" }),
							],
						},
					],
				},
			],
		});
		const age = fieldByid(doc, "age");
		expect(
			scopeOfMutations(doc, [
				{ kind: "renameField", uuid: age.uuid, newId: "weight" },
			]),
		).toBe("full");
	});

	it("adding a case-property writer maps to full (relation-walk readers live anywhere)", () => {
		// Finding-7 repro shape: a module of a DIFFERENT caseType holds a
		// search input whose `via` walks to the written type — its findings
		// flip when the writer-augmented property set changes.
		const doc = twoTypeDoc();
		const form = doc.formOrder[doc.moduleOrder[0]][0];
		expect(
			scopeOfMutations(doc, [
				{
					kind: "addField",
					parentUuid: form,
					field: {
						uuid: asUuid("fld-age"),
						kind: "date",
						id: "age",
						label: "Age",
						case_property_on: "patient",
					} as Field,
				},
			]),
		).toBe("full");
	});

	it("convertField on a case-bound field maps to full; on a plain field it stays scoped", () => {
		const doc = twoTypeDoc();
		const caseName = fieldByid(doc, "case_name");
		expect(
			scopeOfMutations(doc, [
				{ kind: "convertField", uuid: caseName.uuid, toKind: "int" },
			]),
		).toBe("full");

		const notes = fieldByid(doc, "notes");
		const scope = scopeOfMutations(doc, [
			{ kind: "convertField", uuid: notes.uuid, toKind: "int" },
		]);
		expectScope(scope);
		expect([...(scope.formUuids ?? [])]).toEqual([
			doc.formOrder[doc.moduleOrder[0]][0],
		]);
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
			{ kind: "setConnectType", connectType: "learn" },
			{ kind: "setCaseTypes", caseTypes: null },
		];
		for (const mutation of fullKinds) {
			expect(scopeOfMutations(doc, [mutation]), mutation.kind).toBe("full");
		}
	});

	it("a calculated-column visibility patch keeps full validation scope", () => {
		const doc = twoTypeDoc();
		const moduleUuid = doc.moduleOrder[0];
		const existing = doc.modules[moduleUuid].caseListConfig?.columns[0];
		if (!existing) throw new Error("fixture column missing");
		const calculated = calculatedColumn(
			existing.uuid,
			"Computed",
			term(literal("value")),
			{ visibleInList: false },
		);
		doc.modules[moduleUuid].caseListConfig?.columns.splice(0, 1, calculated);
		const { visibleInList: _hidden, ...shown } = calculated;

		expect(
			scopeOfMutations(doc, [
				{
					kind: "updateColumn",
					moduleUuid,
					uuid: calculated.uuid,
					column: shown,
					visibilityPatch: { surface: "list", visible: true },
				},
			]),
		).toBe("full");
	});

	it("setAppName / setAppLogo are app-rules-only (empty) scopes, not full", () => {
		// `appName` feeds only EMPTY_APP_NAME (an always-run app rule) and
		// `logo` only the boundary-time media surfaces — an app rename /
		// logo edit must not pay two full deep-validation runs.
		const doc = twoTypeDoc();
		const appLevel: Mutation[] = [
			{ kind: "setAppName", name: "X" },
			{ kind: "setAppLogo", logo: null },
		];
		for (const mutation of appLevel) {
			const scope = scopeOfMutations(doc, [mutation]);
			expectScope(scope);
			expect(scope.moduleUuids?.size, mutation.kind).toBe(0);
			expect(scope.formUuids?.size, mutation.kind).toBe(0);
		}
	});

	it("a SAME-parent moveField of a case-bound field stays form-scoped (no full escalation)", () => {
		// Drag-reorder within one parent can't dedup-rename (the reducer
		// only dedups on a parent change), so the writer set is untouched
		// and the containing form covers every order-sensitive finding.
		const doc = twoTypeDoc();
		const writer = fieldByid(doc, "case_name");
		const formUuid = doc.fieldParent[writer.uuid];
		const scope = scopeOfMutations(doc, [
			{
				kind: "moveField",
				uuid: writer.uuid,
				toParentUuid: formUuid as never,
				toIndex: 1,
			},
		]);
		expectScope(scope);
		expect(scope.formUuids?.has(formUuid as never)).toBe(true);
	});

	it("a CROSS-parent moveField of a case-bound field still degrades to full", () => {
		const doc = twoTypeDoc();
		const writer = fieldByid(doc, "case_name");
		const targetForm = doc.formOrder[doc.moduleOrder[2]][0];
		expect(
			scopeOfMutations(doc, [
				{
					kind: "moveField",
					uuid: writer.uuid,
					toParentUuid: targetForm,
					toIndex: 0,
				},
			]),
		).toBe("full");
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
