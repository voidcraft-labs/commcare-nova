// Tests for the in-tree creation scaffolds. The contract is valid-by-
// construction: each scaffold's batch, committed against a valid doc, must
// pass the SAME gate the builder UI uses (`mutationCommitVerdict`) — an empty
// shell would be rejected, so these prove the atomic defaults are load-bearing.

import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { planCaseTypeRetirementOnRetype } from "@/lib/doc/caseTypeRetirement";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { applyMutation } from "@/lib/doc/mutations";
import {
	caseListModuleMutations,
	caseTypeCatalogMutations,
	caseTypeClearPatch,
	caseTypeSetPatch,
	declareCaseTypeMutations,
	formScaffoldMutations,
	surveyModuleMutations,
} from "@/lib/doc/scaffolds";
import type { BlueprintDoc } from "@/lib/doc/types";
import { asUuid } from "@/lib/doc/types";
import { type Field, type Form, type Module, plainColumn } from "@/lib/domain";

const M = (s: string) => asUuid(`mod${s}-0000-0000-0000-000000000000`);
const F = (s: string) => asUuid(`frm${s}-0000-0000-0000-000000000000`);
const Q = (s: string) => asUuid(`qst${s}-0000-0000-0000-000000000000`);

function emptyDoc(): BlueprintDoc {
	return {
		appId: "test",
		appName: "App",
		connectType: null,
		caseTypes: null,
		modules: {},
		forms: {},
		fields: {},
		moduleOrder: [],
		formOrder: {},
		fieldOrder: {},
		fieldParent: {},
	};
}

/**
 * A valid one-module starting doc (a survey module with one form + field).
 * Built via the reducer; we don't gate it — `mutationCommitVerdict` is
 * delta-based, and a finding on a brand-new entity is a different location
 * than anything here, so it can't be masked.
 */
function baseDoc(): BlueprintDoc {
	return produce(emptyDoc(), (d) => {
		applyMutation(d, {
			kind: "addModule",
			module: { uuid: M("base"), id: "base", name: "Base" } as Module,
		});
		applyMutation(d, {
			kind: "addForm",
			moduleUuid: M("base"),
			form: {
				uuid: F("base"),
				id: "base_form",
				name: "Base form",
				type: "survey",
			} as Form,
		});
		applyMutation(d, {
			kind: "addField",
			parentUuid: F("base"),
			field: {
				uuid: Q("base"),
				id: "note",
				kind: "text",
				label: "Note",
			} as never as Field,
		});
	});
}

describe("caseListModuleMutations", () => {
	it("commits a born-valid case-list viewer (caseListOnly, no forms)", () => {
		const base = baseDoc();
		const scaffold = caseListModuleMutations(base, { caseType: "patient" });
		const verdict = mutationCommitVerdict(base, scaffold.mutations);

		expect(verdict.ok).toBe(true);

		const mod = verdict.nextDoc.modules[scaffold.moduleUuid];
		expect(mod?.caseType).toBe("patient");
		expect(mod?.caseListOnly).toBe(true);
		expect(mod?.caseListConfig?.columns[0]).toMatchObject({
			field: "case_name",
			header: "Name",
		});

		// A viewer is born with no forms — the user adds one later.
		expect(verdict.nextDoc.formOrder[scaffold.moduleUuid]).toEqual([]);

		// The case type is declared in the catalog so the Name column's
		// standard `case_name` property resolves with no writer yet.
		expect(verdict.nextDoc.caseTypes?.some((ct) => ct.name === "patient")).toBe(
			true,
		);
	});

	it("derives a default module name from the case type", () => {
		const base = baseDoc();
		const scaffold = caseListModuleMutations(base, { caseType: "home_visit" });
		const verdict = mutationCommitVerdict(base, scaffold.mutations);
		expect(verdict.ok).toBe(true);
		expect(verdict.nextDoc.modules[scaffold.moduleUuid]?.name).toBe(
			"Home visit",
		);
	});
});

describe("surveyModuleMutations", () => {
	it("commits a bare survey module (no case type, no forms)", () => {
		const base = baseDoc();
		const scaffold = surveyModuleMutations(base);
		const verdict = mutationCommitVerdict(base, scaffold.mutations);

		expect(verdict.ok).toBe(true);
		const mod = verdict.nextDoc.modules[scaffold.moduleUuid];
		expect(mod?.caseType).toBeUndefined();
		expect(verdict.nextDoc.formOrder[scaffold.moduleUuid]).toEqual([]);
	});
});

describe("formScaffoldMutations", () => {
	it("adds a survey form to a typeless module", () => {
		const base = baseDoc();
		const scaffold = formScaffoldMutations(base, M("base"), "survey");
		if (!scaffold) throw new Error("expected a survey-form scaffold");
		const verdict = mutationCommitVerdict(base, scaffold.mutations);
		expect(verdict.ok).toBe(true);
		// Born with a default question, never empty.
		expect(verdict.nextDoc.fieldOrder[scaffold.formUuid]?.length).toBe(1);
	});

	it("adds each case-managing form type to a case module", () => {
		const base = baseDoc();
		const cl = caseListModuleMutations(base, { caseType: "patient" });
		const withCase = mutationCommitVerdict(base, cl.mutations);
		expect(withCase.ok).toBe(true);
		const doc = withCase.nextDoc;

		for (const type of ["registration", "followup", "close"] as const) {
			const scaffold = formScaffoldMutations(doc, cl.moduleUuid, type);
			if (!scaffold) throw new Error(`expected a ${type}-form scaffold`);
			const verdict = mutationCommitVerdict(doc, scaffold.mutations);
			expect(verdict.ok, type).toBe(true);
		}
	});

	it("a registration form is born with just a Name field (no Notes)", () => {
		// A name-only case create is wire-valid (REGISTRATION_NO_CASE_PROPS was
		// removed), so the registration scaffold carries exactly one field.
		const base = baseDoc();
		const cl = caseListModuleMutations(base, { caseType: "patient" });
		const doc = mutationCommitVerdict(base, cl.mutations).nextDoc;
		const scaffold = formScaffoldMutations(doc, cl.moduleUuid, "registration");
		if (!scaffold) throw new Error("expected a registration-form scaffold");
		const verdict = mutationCommitVerdict(doc, scaffold.mutations);
		expect(verdict.ok).toBe(true);
		const fieldUuids = verdict.nextDoc.fieldOrder[scaffold.formUuid] ?? [];
		expect(fieldUuids).toHaveLength(1);
		expect(verdict.nextDoc.fields[fieldUuids[0]]?.id).toBe("case_name");
	});

	it("returns null for an unknown module", () => {
		expect(formScaffoldMutations(baseDoc(), M("nope"), "survey")).toBeNull();
	});
});

describe("caseTypeSetPatch", () => {
	const moduleWith = (caseListConfig?: Module["caseListConfig"]): Module =>
		({
			uuid: M("x"),
			id: "x",
			name: "X",
			...(caseListConfig && { caseListConfig }),
		}) as Module;

	it("seeds a Name column when the module has forms but no columns", () => {
		// MISSING_CASE_LIST_COLUMNS obliges a column once a case module has forms.
		const patch = caseTypeSetPatch(moduleWith(), true, "thing");
		expect(patch.caseType).toBe("thing");
		expect(patch.caseListConfig?.columns).toHaveLength(1);
		expect(patch.caseListConfig?.columns[0]).toMatchObject({
			field: "case_name",
			header: "Name",
		});
	});

	it("does not seed a column when the module already has one", () => {
		const existing = {
			columns: [plainColumn(M("c"), "age", "Age")],
			searchInputs: [],
		};
		expect(
			caseTypeSetPatch(moduleWith(existing), true, "thing").caseListConfig,
		).toBeUndefined();
	});

	it("makes a formless module a case-list-only viewer with a Name column", () => {
		// A formless case module is invalid (NO_FORMS_OR_CASE_LIST); the viewer is
		// the only valid formless+typed shape, and it seeds a Name column like a
		// born viewer. The caller (updateModule) declares the new type so the
		// column resolves — see the gate round-trip below.
		const patch = caseTypeSetPatch(moduleWith(), false, "thing");
		expect(patch.caseType).toBe("thing");
		expect(patch.caseListOnly).toBe(true);
		expect(patch.caseListConfig?.columns[0]).toMatchObject({
			field: "case_name",
			header: "Name",
		});
	});

	it("set-on-formless commits clean through the gate (new type declared)", () => {
		// Mirror the hook: updateModule declares a brand-new type BEFORE the patch,
		// so the seeded Name column resolves. Without the declaration this rejects
		// (CASE_LIST_COLUMN_UNKNOWN_FIELD).
		const doc = produce(emptyDoc(), (d) => {
			applyMutation(d, {
				kind: "addModule",
				module: { uuid: M("s"), id: "s", name: "S" } as Module,
			});
		});
		const mod = doc.modules[M("s")];
		if (!mod) throw new Error("expected module");
		const verdict = mutationCommitVerdict(doc, [
			...declareCaseTypeMutations(doc, "thing"),
			{
				kind: "updateModule",
				uuid: M("s"),
				patch: caseTypeSetPatch(mod, false, "thing"),
			},
		]);
		expect(verdict.ok).toBe(true);
		expect(verdict.nextDoc.modules[M("s")]?.caseListOnly).toBe(true);
	});

	it("re-typing a viewer to a brand-new type commits clean (one catalog write)", () => {
		// The born viewer owns type "a" alone; re-typing to a brand-new "b" must
		// retire "a" AND declare "b" in ONE setCaseTypes. Two separate wholesale
		// writes (declare [a,b] then retire-of-a [] ) would clobber "b" back out,
		// failing the seeded Name column (CASE_LIST_COLUMN_UNKNOWN_FIELD) — the
		// re-type dead-end caseTypeCatalogMutations exists to prevent.
		const { mutations, moduleUuid } = caseListModuleMutations(emptyDoc(), {
			caseType: "a",
		});
		const doc = produce(emptyDoc(), (d) => {
			for (const m of mutations) applyMutation(d, m);
		});
		const mod = doc.modules[moduleUuid];
		if (!mod) throw new Error("expected module");
		const retirement = planCaseTypeRetirementOnRetype(doc, moduleUuid, "b");
		const verdict = mutationCommitVerdict(doc, [
			...caseTypeCatalogMutations(doc, retirement, "b"),
			{
				kind: "updateModule",
				uuid: moduleUuid,
				patch: caseTypeSetPatch(mod, false, "b"),
			},
		]);
		expect(verdict.ok).toBe(true);
		const names = (verdict.nextDoc.caseTypes ?? []).map((ct) => ct.name);
		expect(names).toContain("b");
		expect(names).not.toContain("a");
		expect(verdict.nextDoc.modules[moduleUuid]?.caseType).toBe("b");
	});
});

describe("caseTypeClearPatch", () => {
	it("clears the type, the caseListOnly flag, and the case-list + search config", () => {
		// Dropping caseSearchConfig is load-bearing (a typeless module keeping it
		// trips caseSearchConfigRequiresCaseType); dropping caseListOnly is too (a
		// typeless viewer trips CASE_LIST_ONLY_NO_CASE_TYPE).
		expect(caseTypeClearPatch()).toEqual({
			caseType: undefined,
			caseListOnly: undefined,
			caseListConfig: undefined,
			caseSearchConfig: undefined,
		});
	});

	it("clearing a born viewer's type commits clean (becomes a survey)", () => {
		// The born case-list module is caseListOnly:true; clearing its type must
		// also drop the flag or it leaves an invalid typeless viewer
		// (CASE_LIST_ONLY_NO_CASE_TYPE).
		const { mutations, moduleUuid } = caseListModuleMutations(emptyDoc(), {
			caseType: "thing",
		});
		const doc = produce(emptyDoc(), (d) => {
			for (const m of mutations) applyMutation(d, m);
		});
		const verdict = mutationCommitVerdict(doc, [
			{ kind: "updateModule", uuid: moduleUuid, patch: caseTypeClearPatch() },
		]);
		expect(verdict.ok).toBe(true);
		expect(verdict.nextDoc.modules[moduleUuid]?.caseListOnly).toBeFalsy();
		expect(verdict.nextDoc.modules[moduleUuid]?.caseType).toBeUndefined();
	});
});

describe("atomic creation is load-bearing", () => {
	it("rejects a bare case-managing module with no forms", () => {
		const base = baseDoc();
		const verdict = mutationCommitVerdict(base, [
			{
				kind: "addModule",
				module: {
					uuid: M("bad"),
					id: "bad",
					name: "Bad",
					caseType: "patient",
				} as Module,
			},
		]);
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			expect(
				verdict.introduced.some((e) => e.code === "NO_FORMS_OR_CASE_LIST"),
			).toBe(true);
		}
	});
});
