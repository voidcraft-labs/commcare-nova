// Tests for the in-tree creation scaffolds. The contract is valid-by-
// construction: each scaffold's batch, committed against a valid doc, must
// pass the SAME gate the builder UI uses (`mutationCommitVerdict`) — an empty
// shell would be rejected, so these prove the atomic defaults are load-bearing.

import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { evaluateBoundary } from "@/lib/commcare/validator/gate";
import { planCaseTypeRetirementOnRetype } from "@/lib/doc/caseTypeRetirement";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { applyMutation, applyMutations } from "@/lib/doc/mutations";
import {
	BLANK_APP_NAME,
	blankAppMutations,
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
	it("commits a survey module born with one survey form + question", () => {
		const base = baseDoc();
		const scaffold = surveyModuleMutations(base);
		const verdict = mutationCommitVerdict(base, scaffold.mutations);

		// Valid by construction: a formless module would introduce
		// NO_FORMS_OR_CASE_LIST (a hard CommCare build error), so the module is
		// born with a survey form — no case type, but a form.
		expect(verdict.ok).toBe(true);
		const mod = verdict.nextDoc.modules[scaffold.moduleUuid];
		expect(mod?.caseType).toBeUndefined();
		expect(mod?.caseListOnly).toBeFalsy();
		expect(verdict.nextDoc.formOrder[scaffold.moduleUuid]).toEqual([
			scaffold.formUuid,
		]);
		const form = verdict.nextDoc.forms[scaffold.formUuid];
		expect(form?.type).toBe("survey");
		// The form has its one starter question, so it isn't born EMPTY_FORM.
		expect(verdict.nextDoc.fieldOrder[scaffold.formUuid]).toHaveLength(1);
	});

	it("removing a survey module's only form is rejected, delete-friendly", () => {
		// The user's exact action: a survey module has one form; deleting it would
		// leave the module formless (a survey module can't fall back to a viewer
		// the way a case module can). The message must read sensibly for a DELETE,
		// not tell the user to "add a form" to the thing they're removing.
		const base = baseDoc();
		const scaffold = surveyModuleMutations(base);
		const doc = produce(base, (d) => {
			applyMutations(d, scaffold.mutations);
		});
		const verdict = mutationCommitVerdict(doc, [
			{ kind: "removeForm", uuid: scaffold.formUuid },
		]);
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			const msg =
				verdict.introduced.find((e) => e.code === "NO_FORMS_OR_CASE_LIST")
					?.message ?? "";
			expect(msg).toMatch(/add another form first or delete the whole module/i);
		}
	});

	it("a manually-built formless survey module is rejected", () => {
		// The gap this closes: a lone typeless, formless addModule used to commit
		// clean (the rule was guarded on caseType). CommCare rejects it —
		// "<menu> has no forms or case list" — so the gate must too.
		const base = baseDoc();
		const verdict = mutationCommitVerdict(base, [
			{
				kind: "addModule",
				module: { uuid: M("bare"), id: "bare", name: "Bare" } as Module,
			},
		]);
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			expect(verdict.introduced.map((e) => e.code)).toContain(
				"NO_FORMS_OR_CASE_LIST",
			);
		}
	});
});

/**
 * The blank app (`createBlankApp`, `app/(app)/build/actions.ts`) is exactly
 * `BLANK_APP_NAME` + `blankAppMutations`, and both halves are what make it
 * EXPORT-ready the instant it exists — the bar a hand-built app has to clear
 * with no SA run behind it. These drive the real template, not a hand-rebuilt
 * copy of it, so dropping either half fails here.
 *
 * `mutationCommitVerdict` cannot prove this: it is delta-based, and an empty
 * doc's `NO_MODULES` / `EMPTY_APP_NAME` are pre-existing rather than
 * introduced, so a template that left either standing would still commit.
 * The boundary validator — the zero-tolerance compile/upload/export gate,
 * which `createApp`'s `seedNewApp` also runs at construction — is the only
 * oracle that answers the question actually being asked.
 */
describe("the blank app template", () => {
	const seeded = (appName: string): BlueprintDoc => {
		const base = { ...emptyDoc(), appName };
		return produce(base, (d) => {
			applyMutations(d, blankAppMutations(base));
		});
	};

	it("is export-ready as `createBlankApp` builds it", () => {
		expect(evaluateBoundary(seeded(BLANK_APP_NAME), new Map())).toEqual([]);
	});

	it("names the app for real — BLANK_APP_NAME is not a blank name", () => {
		expect(BLANK_APP_NAME.trim()).not.toBe("");
	});

	it("does not inherit the empty app's findings, which block export", () => {
		const codes = evaluateBoundary(emptyDoc(), new Map()).map((e) => e.code);
		expect(codes).toContain("NO_MODULES");
	});

	it("needs the name too — a nameless blank app cannot export", () => {
		const codes = evaluateBoundary(seeded(""), new Map()).map((e) => e.code);
		expect(codes).toEqual(["EMPTY_APP_NAME"]);
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

	it("clearing a module's type when it has a survey form commits clean", () => {
		// A case module carrying a SURVEY form (no case reference) and a Name
		// column: clearing its type drops the flag + case-list config, leaving a
		// plain survey with the form it already had. (A registration/followup form
		// would block the clear — a case form needs its type — which is a separate,
		// correct rejection.)
		const base = baseDoc();
		const { mutations, moduleUuid } = caseListModuleMutations(base, {
			caseType: "thing",
		});
		const withViewer = produce(base, (d) => {
			for (const m of mutations) applyMutation(d, m);
		});
		const form = formScaffoldMutations(withViewer, moduleUuid, "survey");
		if (!form) throw new Error("form scaffold failed");
		const doc = produce(withViewer, (d) => {
			for (const m of form.mutations) applyMutation(d, m);
		});
		const verdict = mutationCommitVerdict(doc, [
			{ kind: "updateModule", uuid: moduleUuid, patch: caseTypeClearPatch() },
		]);
		expect(verdict.ok).toBe(true);
		expect(verdict.nextDoc.modules[moduleUuid]?.caseListOnly).toBeFalsy();
		expect(verdict.nextDoc.modules[moduleUuid]?.caseType).toBeUndefined();
	});

	it("clearing a FORMLESS viewer's type is rejected (no forms left)", () => {
		// A born viewer has no forms; clearing its type would leave a typeless,
		// formless module — invalid in CommCare ("<menu> has no forms or case
		// list"). The gate refuses it, and the module-settings control surfaces
		// that inline. The user adds a form (making a real survey) or deletes the
		// module; conjuring a form from a case-type toggle would be a surprise.
		const { mutations, moduleUuid } = caseListModuleMutations(emptyDoc(), {
			caseType: "thing",
		});
		const doc = produce(emptyDoc(), (d) => {
			for (const m of mutations) applyMutation(d, m);
		});
		const verdict = mutationCommitVerdict(doc, [
			{ kind: "updateModule", uuid: moduleUuid, patch: caseTypeClearPatch() },
		]);
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			expect(verdict.introduced.map((e) => e.code)).toContain(
				"NO_FORMS_OR_CASE_LIST",
			);
		}
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
