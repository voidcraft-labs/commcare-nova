/**
 * The planning-schema surface is built so a wrong input can't parse,
 * under the shared input contract: the model omits what doesn't apply
 * (SA tools run `strict: false`), and every optional slot is ALSO
 * nullable with null as absence, so arbitrary MCP callers and stray
 * nulls stay harmless. These tests pin that contract from both sides:
 * null is accepted as absence on every optional slot, while blanks and
 * cross-field contradictions (filler shapes a live build actually
 * produced under strict-normalized decoding) still reject with messages
 * that teach passing null. `cleanCaseTypeRecord` then collapses the
 * nulls before a record leaves the boundary.
 */

import { describe, expect, it } from "vitest";
import {
	caseTypeRecordSchema,
	cleanCaseTypeRecord,
	connectFormConfigSchema,
	connectFormPatchSchema,
} from "../planningSchemas";

const validRecord = {
	name: "patient",
	properties: [{ name: "case_name", label: "Full name" }],
};

describe("caseTypeRecordSchema", () => {
	it("accepts a standalone record and a real parent link", () => {
		expect(caseTypeRecordSchema.safeParse(validRecord).success).toBe(true);
		expect(
			caseTypeRecordSchema.safeParse({
				...validRecord,
				name: "pregnancy",
				parent_type: "mother",
				relationship: "extension",
			}).success,
		).toBe(true);
	});

	it("accepts null as absence on every optional slot", () => {
		const result = caseTypeRecordSchema.safeParse({
			name: "client",
			parent_type: null,
			relationship: null,
			properties: [
				{
					name: "case_name",
					label: "Client name",
					data_type: null,
					hint: null,
					required: null,
					validation: null,
					validation_msg: null,
					options: null,
				},
			],
		});
		expect(result.success).toBe(true);
	});

	it('rejects parent_type: "" — absence is null, not a blank', () => {
		const result = caseTypeRecordSchema.safeParse({
			...validRecord,
			parent_type: "",
		});
		expect(result.success).toBe(false);
	});

	it("rejects relationship without parent_type, teaching null", () => {
		const result = caseTypeRecordSchema.safeParse({
			...validRecord,
			parent_type: null,
			relationship: "child",
		});
		expect(result.success).toBe(false);
		expect(result.error?.issues[0]?.message).toContain("null");
	});

	it("rejects an empty properties array", () => {
		expect(
			caseTypeRecordSchema.safeParse({ ...validRecord, properties: [] })
				.success,
		).toBe(false);
	});

	it("rejects blank-string property slots (label, hint, validation)", () => {
		for (const overrides of [
			{ label: "" },
			{ hint: "" },
			{ validation: "" },
		] as const) {
			const result = caseTypeRecordSchema.safeParse({
				...validRecord,
				properties: [{ name: "age", label: "Age", ...overrides }],
			});
			expect(result.success).toBe(false);
		}
	});

	it("rejects a validation_msg with no validation to accompany", () => {
		const result = caseTypeRecordSchema.safeParse({
			...validRecord,
			properties: [
				{ name: "age", label: "Age", validation_msg: "Must be 0-150" },
			],
		});
		expect(result.success).toBe(false);
		expect(result.error?.issues[0]?.message).toContain("validation");
	});

	it("rejects options on a non-select property — the live build's filler shape", () => {
		const result = caseTypeRecordSchema.safeParse({
			...validRecord,
			properties: [
				{
					name: "age",
					label: "Age",
					data_type: "int",
					options: [{ value: "unused", label: "unused" }],
				},
			],
		});
		expect(result.success).toBe(false);
		expect(result.error?.issues[0]?.message).toContain("null");
	});

	it("accepts options on a select property", () => {
		const result = caseTypeRecordSchema.safeParse({
			...validRecord,
			properties: [
				{
					name: "status",
					label: "Status",
					data_type: "single_select",
					options: [
						{ value: "open", label: "Open" },
						{ value: "closed", label: "Closed" },
					],
				},
			],
		});
		expect(result.success).toBe(true);
	});
});

describe("cleanCaseTypeRecord", () => {
	it("collapses null slots to real absence so no null reaches the catalog", () => {
		const parsed = caseTypeRecordSchema.parse({
			name: "client",
			parent_type: null,
			relationship: null,
			properties: [
				{
					name: "age",
					label: "Age",
					data_type: "int",
					hint: null,
					required: "true()",
					validation: null,
					validation_msg: null,
					options: null,
				},
			],
		});
		const clean = cleanCaseTypeRecord(parsed);
		expect(clean).toEqual({
			name: "client",
			properties: [
				{ name: "age", label: "Age", data_type: "int", required: "true()" },
			],
		});
		expect("parent_type" in clean).toBe(false);
		expect("hint" in clean.properties[0]).toBe(false);
	});
});

describe("connectFormConfigSchema", () => {
	it("accepts a real learn block and a real deliver block", () => {
		expect(
			connectFormConfigSchema.safeParse({
				learn_module: {
					name: "Hygiene basics",
					description: "Handwashing training content",
					time_estimate: 15,
				},
			}).success,
		).toBe(true);
		expect(
			connectFormConfigSchema.safeParse({
				deliver_unit: { name: "Home visit" },
			}).success,
		).toBe(true);
	});

	it("accepts null sub-configs beside a real one", () => {
		expect(
			connectFormConfigSchema.safeParse({
				learn_module: null,
				assessment: null,
				deliver_unit: { name: "Home visit", id: null },
				task: null,
			}).success,
		).toBe(true);
	});

	it("rejects an all-null block — participation with nothing in it", () => {
		const result = connectFormConfigSchema.safeParse({
			learn_module: null,
			assessment: null,
			deliver_unit: null,
			task: null,
		});
		expect(result.success).toBe(false);
		expect(result.error?.issues[0]?.message).toContain("null");
	});

	it("rejects blank strings inside sub-configs", () => {
		expect(
			connectFormConfigSchema.safeParse({
				deliver_unit: { name: "" },
			}).success,
		).toBe(false);
		expect(
			connectFormConfigSchema.safeParse({
				assessment: { user_score: "" },
			}).success,
		).toBe(false);
	});

	it("rejects a zero or fractional time_estimate", () => {
		for (const time_estimate of [0, 1.5, -3]) {
			const result = connectFormConfigSchema.safeParse({
				learn_module: {
					name: "Module",
					description: "Content",
					time_estimate,
				},
			});
			expect(result.success).toBe(false);
		}
	});
});

describe("connectFormPatchSchema", () => {
	it("accepts a partial-null patch — remove one sub-config, keep the rest", () => {
		// The updateForm surface: `{ assessment: null }` means "drop the
		// quiz, keep everything else as it is" — the shape the creation
		// refinement rejects (there, null ≡ omitted, so the block would be
		// empty). This is the drop-the-quiz-keep-the-lesson move.
		expect(connectFormPatchSchema.safeParse({ assessment: null }).success).toBe(
			true,
		);
	});

	it("accepts an all-null patch — equivalent to whole-block removal", () => {
		expect(
			connectFormPatchSchema.safeParse({
				learn_module: null,
				assessment: null,
				deliver_unit: null,
				task: null,
			}).success,
		).toBe(true);
	});

	it("rejects the says-nothing patch (every sub-config omitted)", () => {
		const result = connectFormPatchSchema.safeParse({});
		expect(result.success).toBe(false);
		expect(result.error?.issues[0]?.message).toContain("changes nothing");
	});

	it("shares the creation shape — sub-config contents gate identically", () => {
		expect(
			connectFormPatchSchema.safeParse({
				deliver_unit: { name: "" },
			}).success,
		).toBe(false);
	});
});
