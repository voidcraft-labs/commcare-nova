/**
 * `editField` conversion consent — the needs-confirmation round for a
 * kind conversion whose per-row cast can fail (`plan.dataLossRisk`).
 *
 * The contract these tests pin:
 *
 *   - a failable flip with a non-empty counted impact returns
 *     `{ needsConfirmation, message }` and persists NOTHING;
 *   - the SAME call with `confirmConversion: true` proceeds without
 *     re-counting (consent was given against the relayed numbers);
 *   - a failable flip whose count comes back empty proceeds directly —
 *     nothing to consent to;
 *   - a total flip, and any conversion of a non-case-bound field,
 *     never consults the impact lookup at all.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { backfillOrderKeys } from "@/lib/doc/order/backfill";
import type { BlueprintDoc } from "@/lib/domain";
import { makeStubToolContext } from "../../__tests__/fixtures";
import { editFieldTool } from "../editField";

vi.mock("@/lib/db/apps", () => ({
	completeApp: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/lib/db/applyBlueprintChange", () => ({
	applyBlueprintChange: vi.fn(() => Promise.resolve({ seq: 0 })),
}));

/** A patient module whose followup form writes `score` (a decimal case
 *  property) — the decimal → int flip is the canonical failable edge. */
function makeCaseBoundDoc(): BlueprintDoc {
	const doc = buildDoc({
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: "Name" },
					{ name: "score", label: "Score" },
					{ name: "visit_on", label: "Visited" },
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
								id: "score",
								kind: "decimal",
								label: "Score",
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
				],
			},
		],
	});
	backfillOrderKeys(doc);
	return doc;
}

function soleField(doc: BlueprintDoc, id: string) {
	const field = Object.values(doc.fields).find((fld) => fld.id === id);
	if (!field) throw new Error(`fixture field "${id}" missing`);
	return field;
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("editField — conversion consent", () => {
	it("a failable flip with saved data at stake returns needsConfirmation and persists nothing", async () => {
		const doc = makeCaseBoundDoc();
		const { ctx, recordMutationStages, conversionImpact } = makeStubToolContext(
			{
				conversionImpact: async () => ({
					totalWithValue: 12,
					uncastable: 3,
					alreadyHeld: 1,
					samples: ["17.5", "n/a", "3.25"],
				}),
			},
		);
		const result = await editFieldTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fieldId: "score",
				updates: { kind: "int" },
			},
			ctx,
			doc,
		);
		if (!("needsConfirmation" in result.result)) {
			throw new Error(
				`expected needsConfirmation, got ${JSON.stringify(result.result)}`,
			);
		}
		expect(result.result.needsConfirmation).toEqual({
			property: "score",
			fromType: "decimal",
			toType: "int",
			totalWithValue: 12,
			uncastable: 3,
			alreadyHeld: 1,
			samples: ["17.5", "n/a", "3.25"],
		});
		// The prose carries the counts, the hold consequence, and the
		// expressible next state.
		expect(result.result.message).toContain("3 of 12");
		expect(result.result.message).toContain("held out of the running app");
		expect(result.result.message).toContain("confirmConversion: true");

		expect(conversionImpact).toHaveBeenCalledExactlyOnceWith({
			caseType: "patient",
			property: "score",
			toType: "int",
		});
		expect(recordMutationStages).not.toHaveBeenCalled();
		expect(result.mutations).toEqual([]);
		expect(result.newDoc).toBe(doc);
	});

	it("the same call with confirmConversion: true converts without re-counting", async () => {
		const doc = makeCaseBoundDoc();
		const { ctx, recordMutationStages, conversionImpact } = makeStubToolContext(
			{
				conversionImpact: async () => ({
					totalWithValue: 12,
					uncastable: 3,
					alreadyHeld: 0,
					samples: ["17.5"],
				}),
			},
		);
		const result = await editFieldTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fieldId: "score",
				updates: { kind: "int" },
				confirmConversion: true,
			},
			ctx,
			doc,
		);
		if ("error" in result.result || "needsConfirmation" in result.result) {
			throw new Error(`expected success, got ${JSON.stringify(result.result)}`);
		}
		expect(conversionImpact).not.toHaveBeenCalled();
		expect(recordMutationStages).toHaveBeenCalledTimes(1);
		const after = result.newDoc.fields[soleField(doc, "score").uuid];
		expect(after?.kind).toBe("int");
	});

	it("a failable flip whose counted impact is empty proceeds without a confirmation round", async () => {
		const doc = makeCaseBoundDoc();
		const { ctx, recordMutationStages, conversionImpact } =
			makeStubToolContext();
		const result = await editFieldTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fieldId: "score",
				updates: { kind: "int" },
			},
			ctx,
			doc,
		);
		if ("error" in result.result || "needsConfirmation" in result.result) {
			throw new Error(`expected success, got ${JSON.stringify(result.result)}`);
		}
		expect(conversionImpact).toHaveBeenCalledTimes(1);
		expect(recordMutationStages).toHaveBeenCalledTimes(1);
		const after = result.newDoc.fields[soleField(doc, "score").uuid];
		expect(after?.kind).toBe("int");
	});

	it("a total flip never consults the impact lookup", async () => {
		const doc = makeCaseBoundDoc();
		const { ctx, conversionImpact } = makeStubToolContext({
			conversionImpact: async () => {
				throw new Error("a total flip must not count impact");
			},
		});
		// date → datetime extends to midnight — total, no consent.
		const result = await editFieldTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fieldId: "visit_on",
				updates: { kind: "datetime" },
			},
			ctx,
			doc,
		);
		if ("error" in result.result || "needsConfirmation" in result.result) {
			throw new Error(`expected success, got ${JSON.stringify(result.result)}`);
		}
		expect(conversionImpact).not.toHaveBeenCalled();
	});

	it("a non-case-bound conversion never consults the impact lookup", async () => {
		const doc = buildDoc({
			modules: [
				{
					name: "Survey",
					forms: [
						{
							name: "Feedback",
							type: "survey",
							fields: [f({ id: "score", kind: "decimal", label: "Score" })],
						},
					],
				},
			],
		});
		backfillOrderKeys(doc);
		const { ctx, conversionImpact } = makeStubToolContext();
		const result = await editFieldTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				fieldId: "score",
				updates: { kind: "int" },
			},
			ctx,
			doc,
		);
		if ("error" in result.result || "needsConfirmation" in result.result) {
			throw new Error(`expected success, got ${JSON.stringify(result.result)}`);
		}
		expect(conversionImpact).not.toHaveBeenCalled();
	});
});
