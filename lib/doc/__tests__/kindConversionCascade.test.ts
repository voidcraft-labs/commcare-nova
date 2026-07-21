/**
 * `planKindConversion` — the property-centric plan, post-generalization:
 * EVERY data-type flip gets the escort (peer carry + re-declare), and a
 * flip whose per-row cast can fail carries the `dataLossRisk` verdict
 * the consent surfaces gate on.
 *
 * The string-scalar escort and the blocked-peer arm are pinned through
 * the SA tool in `lib/agent/tools/__tests__/kindConversion.test.ts`;
 * this file pins the PLAN-level contract for the edges the
 * generalization opened — temporal flips, numeric flips, and the
 * select↔text reshapes — plus the risk verdict's exact boundary.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { backfillOrderKeys } from "@/lib/doc/order/backfill";
import type { BlueprintDoc, FieldKind } from "@/lib/domain";
import { planKindConversion } from "../kindConversionCascade";

/** Two forms writing the same `visit_on` date property (declared), so a
 *  temporal flip must carry the peer and re-declare. */
function temporalDoc(): BlueprintDoc {
	const doc = buildDoc({
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: "Name" },
					{ name: "visit_on", label: "Visited", data_type: "date" },
				],
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				forms: [
					{
						name: "Register",
						type: "registration",
						fields: [
							f({
								id: "case_name",
								kind: "text",
								label: "Name",
								case_property_on: "patient",
							}),
							f({
								id: "visit_on",
								kind: "date",
								label: "Visited",
								case_property_on: "patient",
							}),
						],
					},
					{
						name: "Follow up",
						type: "followup",
						fields: [
							f({
								id: "visit_on",
								kind: "date",
								label: "Visited",
								case_property_on: "patient",
							}),
						],
					},
				],
			},
		],
	});
	backfillOrderKeys(doc);
	return doc;
}

function fieldIn(doc: BlueprintDoc, id: string, index = 0) {
	const matches = Object.values(doc.fields).filter((fld) => fld.id === id);
	const field = matches[index];
	if (!field) throw new Error(`fixture field "${id}"[${index}] missing`);
	return field;
}

function plan(doc: BlueprintDoc, fieldId: string, toKind: FieldKind) {
	const result = planKindConversion({
		doc,
		field: fieldIn(doc, fieldId),
		toKind,
	});
	if (!result.ok) throw new Error(`plan blocked by ${result.blocker.id}`);
	return result;
}

describe("planKindConversion — generalized escort", () => {
	it("a temporal flip carries the peer writer and re-declares the property", () => {
		const doc = temporalDoc();
		const result = plan(doc, "visit_on", "datetime");

		const converts = result.mutations.filter(
			(m) => m.kind === "convertField" && m.toKind === "datetime",
		);
		expect(converts).toHaveLength(2);
		expect(result.peers).toHaveLength(1);

		const redeclare = result.mutations.find(
			(m) => m.kind === "setCaseProperty",
		);
		expect(redeclare && "property" in redeclare && redeclare.property).toEqual(
			expect.objectContaining({ name: "visit_on", data_type: "datetime" }),
		);
		expect(result.redeclaredTo).toBe("datetime");
	});

	it("multi_select → text converts every selection writer and re-declares without options", () => {
		const doc = buildDoc({
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "case_name", label: "Name" },
						{
							name: "symptoms",
							label: "Symptoms",
							data_type: "multi_select",
							options: [
								{ value: "fever", label: "Fever" },
								{ value: "cough", label: "Cough" },
							],
						},
					],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [
						{
							name: "Register",
							type: "registration",
							fields: [
								f({
									id: "case_name",
									kind: "text",
									label: "Name",
									case_property_on: "patient",
								}),
								f({
									id: "symptoms",
									kind: "multi_select",
									label: "Symptoms",
									case_property_on: "patient",
									options: [
										{ value: "fever", label: "Fever" },
										{ value: "cough", label: "Cough" },
									],
								}),
							],
						},
						{
							name: "Follow up",
							type: "followup",
							fields: [
								f({
									id: "symptoms",
									kind: "multi_select",
									label: "Symptoms",
									case_property_on: "patient",
									options: [
										{ value: "fever", label: "Fever" },
										{ value: "cough", label: "Cough" },
									],
								}),
							],
						},
					],
				},
			],
		});
		backfillOrderKeys(doc);
		const result = plan(doc, "symptoms", "text");

		const converts = result.mutations.filter(
			(m) => m.kind === "convertField" && m.toKind === "text",
		);
		expect(converts).toHaveLength(2);
		expect(result.peers).toHaveLength(1);

		// The declaration follows the writers; a text declaration carries
		// no option list.
		const redeclare = result.mutations.find(
			(m) => m.kind === "setCaseProperty",
		);
		if (!redeclare || !("property" in redeclare)) {
			throw new Error("expected a setCaseProperty re-declare");
		}
		expect(redeclare.property.data_type).toBe("text");
		expect("options" in redeclare.property).toBe(false);
		// The space-join reshape is total — no consent verdict.
		expect(result.dataLossRisk).toBeUndefined();
	});
});

describe("planKindConversion — dataLossRisk verdict", () => {
	it("names the failable edge with the property's addressing", () => {
		const doc = temporalDoc();
		const result = plan(doc, "visit_on", "time");
		expect(result.dataLossRisk).toEqual({
			caseType: "patient",
			property: "visit_on",
			fromType: "date",
			toType: "time",
		});
	});

	it("stays absent on a total flip and on a hidden conversion", () => {
		const doc = temporalDoc();
		expect(plan(doc, "visit_on", "datetime").dataLossRisk).toBeUndefined();
		// Hidden derives no data type — nothing retypes, nothing parks.
		// (The Follow up writer converts; the Register peer keeps the
		// property's type, so no pin fires either.)
		const hiddenPlan = planKindConversion({
			doc,
			field: fieldIn(doc, "visit_on", 1),
			toKind: "hidden",
		});
		if (!hiddenPlan.ok) throw new Error("hidden plan unexpectedly blocked");
		expect(hiddenPlan.dataLossRisk).toBeUndefined();
	});

	it("stays absent when the field is not case-bound", () => {
		const doc = buildDoc({
			modules: [
				{
					name: "Survey",
					forms: [
						{
							name: "Feedback",
							type: "survey",
							fields: [f({ id: "when", kind: "date", label: "When" })],
						},
					],
				},
			],
		});
		backfillOrderKeys(doc);
		const result = plan(doc, "when", "time");
		expect(result.dataLossRisk).toBeUndefined();
		expect(result.mutations).toHaveLength(1);
	});
});
