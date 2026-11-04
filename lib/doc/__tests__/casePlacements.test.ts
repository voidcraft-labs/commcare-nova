// Where CommCare HQ keeps each case change, as the builder's placement lines
// and the case-operations tool read it. Catches a line that names a home the
// export does not write, and a view that loses an operation or the own case.

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { formCasePlacementView } from "@/lib/doc/casePlacements";
import { type BlueprintDoc, placementLine } from "@/lib/domain";

const VISIT = testUuid("placements-visit");
const RECALC = testUuid("placements-recalc");
const DISCHARGE = testUuid("placements-discharge");

function fixture(): BlueprintDoc {
	return buildDoc(
		{
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "note", label: "Note" },
						{ name: "summary", label: "Summary" },
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
							uuid: VISIT,
							name: "Visit",
							type: "followup",
							fields: [
								f({
									kind: "text",
									id: "note",
									caseWrite: { caseType: "patient", property: "note" },
								}),
							],
						},
						{
							uuid: RECALC,
							name: "Summarize",
							type: "followup",
							fields: [f({ kind: "text", id: "first" })],
						},
						{
							uuid: DISCHARGE,
							name: "Discharge",
							type: "close",
							fields: [f({ kind: "text", id: "reason" })],
						},
					],
				},
			],
		},
		(draft) => {
			// A write whose value is no question's answer, which Case Management
			// can't save.
			draft.forms[RECALC].caseOperations = [
				{
					uuid: testUuid("placements-recalc-own"),
					id: "patient",
					action: "own",
					writes: [
						{
							property: "summary",
							value: { kind: "term", term: { kind: "literal", value: "seen" } },
						},
					],
				},
			];
		},
	);
}

describe("formCasePlacementView", () => {
	it("reads a form whose own case Case Management keeps", () => {
		const doc = fixture();
		const view = formCasePlacementView(doc, VISIT);
		const own = doc.forms[VISIT]?.caseOperations?.[0];
		expect(view.own).toEqual({
			placement: { kind: "basic", slot: "own" },
			home: "case-management",
			held: false,
			line: "CommCare HQ keeps this in the form's Case Management settings.",
		});
		expect(view.operations).toEqual([
			{ operationUuid: own?.uuid, entry: view.own },
		]);
		expect(view.ownClose).toBeUndefined();
		// One answer per document object.
		expect(formCasePlacementView(doc, VISIT)).toBe(view);
	});

	it("reads a form whose own case takes a Save to Case block", () => {
		const doc = fixture();
		const view = formCasePlacementView(doc, RECALC);
		expect(view.own).toMatchObject({
			placement: { kind: "save-to-case" },
			home: "save-to-case",
			held: false,
		});
		expect(view.own?.line).toBe(placementLine(view.own?.placement as never));
		expect(view.own?.line).toBe(
			"CommCare HQ keeps this in a Save to Case block in the form, which needs Save to Case in the project space's plan.",
		);
	});

	it("reads a close form's close with the own case when they share a place", () => {
		const view = formCasePlacementView(fixture(), DISCHARGE);
		expect(view.own?.home).toBe("case-management");
		expect(view.ownClose).toBeUndefined();
	});
});
