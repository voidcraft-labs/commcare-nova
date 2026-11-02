/** The rail's case-write subscriptions re-render only when what they show
 *  changes: each compares the derived view of two committed documents. */

import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { formCasePlacementView } from "@/lib/doc/casePlacements";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { planFieldCaseWrite } from "@/lib/doc/fieldCaseWriteMutations";
import { casePlacementViewKey } from "@/lib/doc/hooks/useCasePlacements";
import { sameFieldCaseWriteViews } from "@/lib/doc/hooks/useFieldCaseWrites";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";
import { fieldCaseWriteViews, type Uuid } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";

function fixture(): { doc: BlueprintDoc; formUuid: Uuid; noteUuid: Uuid } {
	const doc = buildDoc({
		appName: "Subscriptions",
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "note", label: proseText("Note") },
					{ name: "remark", label: proseText("Remark") },
				],
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [
							f({
								kind: "text",
								id: "note",
								label: proseText("Note"),
								caseWrite: { caseType: "patient", property: "note" },
							}),
						],
					},
				],
			},
		],
	});
	const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
	return { doc, formUuid, noteUuid: doc.fieldOrder[formUuid][0] };
}

function commit(doc: BlueprintDoc, mutations: readonly Mutation[]) {
	const verdict = mutationCommitVerdict(
		doc,
		mutations,
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	if (!verdict.ok) throw new Error(JSON.stringify(verdict.findings));
	return verdict.nextDoc;
}

describe("case-write subscriptions", () => {
	it("hold a question's Saves to across an unrelated edit, and see its retarget", () => {
		const { doc, noteUuid } = fixture();
		const renamed = commit(doc, [{ kind: "setAppName", name: "Renamed" }]);
		const before = fieldCaseWriteViews(doc, noteUuid);
		const after = fieldCaseWriteViews(renamed, noteUuid);
		expect(after).not.toBe(before);
		expect(sameFieldCaseWriteViews(before, after)).toBe(true);

		const plan = planFieldCaseWrite(renamed, noteUuid, {
			caseType: "patient",
			property: "remark",
		});
		if (!plan.ok) throw new Error(plan.message);
		const retargeted = commit(renamed, plan.mutations);
		expect(
			sameFieldCaseWriteViews(after, fieldCaseWriteViews(retargeted, noteUuid)),
		).toBe(false);
	});

	it("hold a form's placement view across an unrelated edit", () => {
		const { doc, formUuid } = fixture();
		const renamed = commit(doc, [{ kind: "setAppName", name: "Renamed" }]);
		const before = formCasePlacementView(doc, formUuid);
		const after = formCasePlacementView(renamed, formUuid);
		expect(after).not.toBe(before);
		expect(after.own).toBeDefined();
		expect(casePlacementViewKey(after)).toBe(casePlacementViewKey(before));
	});
});
