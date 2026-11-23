/**
 * Contract: a named link edit (`caseRelationEdit.ts::editCaseRelation`) changes exactly one
 * edge of a case type's relation catalog through the commit gate, a lone `parent` link lands in
 * the default parent slot every `parent_type` reader sees, a second destination keeps the first,
 * and a link to a type the app lacks is refused. The plausible failures: a first `parent` link
 * stored only under `relations`, so parent selection and exports read no parent; an added
 * alternative replacing the default; a removal that leaves a duplicate behind; and a dangling
 * destination committing.
 */
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { editCaseRelation } from "@/lib/doc/caseRelationEdit";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc } from "@/lib/domain";
import type { CaseRelation } from "@/lib/domain/caseRelations";
import { declaredCaseRelations } from "@/lib/domain/caseRelations";
import { proseText } from "@/lib/domain/prose";

function base(): BlueprintDoc {
	return buildDoc({
		caseTypes: [
			{ name: "visit", properties: [] },
			{ name: "clinic", properties: [] },
			{ name: "home", properties: [] },
		],
		modules: [
			{
				name: "Visits",
				forms: [
					{
						name: "Note",
						type: "survey",
						fields: [f({ kind: "text", id: "note", label: proseText("Note") })],
					},
				],
			},
		],
	});
}

function edit(
	doc: BlueprintDoc,
	action: "add" | "remove",
	edge: CaseRelation,
): ReturnType<typeof mutationCommitVerdict> {
	const visit = doc.caseTypes?.find((type) => type.name === "visit");
	if (visit === undefined) throw new Error("The fixture holds visit.");
	return mutationCommitVerdict(
		doc,
		editCaseRelation(visit, action, edge),
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
}

function committed(verdict: ReturnType<typeof mutationCommitVerdict>) {
	if (!verdict.ok) throw new Error(JSON.stringify(verdict));
	return verdict.nextDoc;
}

const visitOf = (doc: BlueprintDoc) =>
	doc.caseTypes?.find((type) => type.name === "visit");

const toClinic = {
	identifier: "parent",
	targetType: "clinic",
	relationship: "child",
} as const;
const toHome = {
	identifier: "parent",
	targetType: "home",
	relationship: "extension",
} as const;

describe("a named link edit", () => {
	it("puts a lone parent link in the default parent slot", () => {
		const next = committed(edit(base(), "add", toClinic));
		expect(visitOf(next)).toMatchObject({
			parent_type: "clinic",
			relationship: "child",
		});
		expect(visitOf(next)?.relations).toBeUndefined();
	});

	it("keeps the default when a second destination joins it, and removes each edge alone", () => {
		const one = committed(edit(base(), "add", toClinic));
		const two = committed(edit(one, "add", toHome));
		expect(declaredCaseRelations(visitOf(two) ?? never())).toEqual([
			toClinic,
			toHome,
		]);
		expect(visitOf(two)?.parent_type).toBe("clinic");
		const back = committed(edit(two, "remove", toClinic));
		expect(declaredCaseRelations(visitOf(back) ?? never())).toEqual([toHome]);
		expect(edit(back, "remove", toClinic)).toMatchObject({ ok: true });
	});

	it("stores a link under another index beside the default", () => {
		const site = {
			identifier: "site-link",
			targetType: "home",
			relationship: "child",
		} as const;
		const next = committed(edit(base(), "add", site));
		expect(visitOf(next)?.parent_type).toBeUndefined();
		expect(visitOf(next)?.relations).toEqual([site]);
	});

	it("refuses a link to a case type the app does not have", () => {
		expect(
			edit(base(), "add", {
				identifier: "site",
				targetType: "nowhere",
				relationship: "child",
			}),
		).toMatchObject({
			ok: false,
			findings: [{ code: "CASE_RELATION_INVALID" }],
		});
	});
});

function never(): never {
	throw new Error("The fixture holds visit.");
}
