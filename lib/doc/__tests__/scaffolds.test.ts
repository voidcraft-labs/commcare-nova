// Tests for the in-tree creation scaffolds. The contract is valid-by-
// construction: each scaffold's batch, committed against a valid doc, must
// pass the SAME gate the builder UI uses (`mutationCommitVerdict`) — an empty
// shell would be rejected, so these prove the atomic defaults are load-bearing.

import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { applyMutation } from "@/lib/doc/mutations";
import {
	caseListModuleMutations,
	formScaffoldMutations,
	surveyModuleMutations,
} from "@/lib/doc/scaffolds";
import type { BlueprintDoc } from "@/lib/doc/types";
import { asUuid } from "@/lib/doc/types";
import type { Field, Form, Module } from "@/lib/domain";

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
	it("commits a born-valid case-management module", () => {
		const base = baseDoc();
		const scaffold = caseListModuleMutations(base, { caseType: "patient" });
		const verdict = mutationCommitVerdict(base, scaffold.mutations);

		expect(verdict.ok).toBe(true);

		const mod = verdict.nextDoc.modules[scaffold.moduleUuid];
		expect(mod?.caseType).toBe("patient");
		expect(mod?.caseListConfig?.columns[0]).toMatchObject({
			field: "case_name",
			header: "Name",
		});

		const form = verdict.nextDoc.forms[scaffold.formUuid];
		expect(form?.type).toBe("registration");

		// A `case_name` field writing to the module's case type exists.
		const fieldUuids = verdict.nextDoc.fieldOrder[scaffold.formUuid] ?? [];
		const caseName = fieldUuids
			.map((u) => verdict.nextDoc.fields[u])
			.find((f) => f?.id === "case_name");
		expect(caseName).toBeTruthy();
		expect((caseName as { case_property_on?: string }).case_property_on).toBe(
			"patient",
		);

		// The new case type auto-registers in the catalog (ensureCatalogProperty).
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

	it("returns null for an unknown module", () => {
		expect(formScaffoldMutations(baseDoc(), M("nope"), "survey")).toBeNull();
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
