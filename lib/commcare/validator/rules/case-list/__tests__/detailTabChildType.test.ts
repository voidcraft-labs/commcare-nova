/**
 * Contract: a Details tab's child case type (a children tab's, or the type a records tab asks a
 * search for) is one CommCare HQ's Case Detail page offers that menu: a type a basic form of a
 * menu of the list's case type adds as a child case (`Application.get_subcase_types`). The page
 * lists only those, and its next save clears any other, so the gate refuses one on every editor.
 * The plausible failure: Nova writes `nodeset_case_type` for a type no form adds, and HQ's
 * editors lose it on the first save there.
 */

import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { tileFixture } from "@/lib/commcare/__tests__/tileFixture";
import { runValidation } from "@/lib/commcare/validator/runner";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";

function childTypeFindings(doc: ReturnType<typeof tileFixture>) {
	return runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)
		.filter((error) => error.details?.reason === "child-type-not-added")
		.map((error) => [error.code, error.details?.caseType]);
}

describe("a Details tab's child case type", () => {
	it("is admitted where a form of a menu of the list's case type adds that child", () => {
		expect(
			childTypeFindings(tileFixture("conditional-search-children")),
		).toEqual([]);
	});

	it("is refused where no form adds it, which HQ's Case Detail page would clear", () => {
		const doc = produce(tileFixture("conditional-search-children"), (draft) => {
			const adds = draft.moduleOrder.find(
				(uuid) => draft.modules[uuid]?.name === "Visit contacts",
			);
			if (adds === undefined) throw new Error("Missing the contacts menu.");
			for (const form of draft.formOrder[adds] ?? []) delete draft.forms[form];
			delete draft.formOrder[adds];
			delete draft.modules[adds];
			draft.moduleOrder = draft.moduleOrder.filter((uuid) => uuid !== adds);
		});
		expect(childTypeFindings(doc)).toEqual([
			["CASE_DETAIL_TAB_ROWS_INVALID", "contact"],
		]);
	});

	// Staged work holds a registration before its name field (createForm, then addFields): the
	// rule reads every form of the list's case type, and one whose case wire does not build yet
	// adds no child, while that form's own finding is what the validator reports.
	it("reads past a registration that does not yet name its case", () => {
		const doc = produce(tileFixture("conditional-search-children"), (draft) => {
			const registration = Object.values(draft.forms).find(
				(form) => form.name === "New visit",
			);
			if (registration === undefined)
				throw new Error("Missing the registration form.");
			for (const operation of registration.caseOperations ?? [])
				if (operation.action === "own") delete operation.name;
		});
		const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
		expect(findings.map((error) => error.code)).toContain(
			"CASE_CREATE_NAME_MISSING",
		);
		expect(
			findings.filter(
				(error) => error.details?.reason === "child-type-not-added",
			),
		).toEqual([]);
	});
});
