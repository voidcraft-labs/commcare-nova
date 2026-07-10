/**
 * The planning-schema surface is built so a wrong input can't parse:
 * optional means omit (no ""/[] sentinels), present strings are
 * non-empty, and cross-field contradictions are rejected with a message
 * that says what to do instead. These tests pin the rejection shapes a
 * blank-filling model actually produced on a live build (empty-string
 * parent links, relationship without a parent, padded connect blocks)
 * alongside the valid shapes that must keep parsing.
 */

import { describe, expect, it } from "vitest";
import {
	caseTypeRecordSchema,
	connectFormConfigSchema,
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

	it('rejects parent_type: "" — absence is omission, not a blank', () => {
		const result = caseTypeRecordSchema.safeParse({
			...validRecord,
			parent_type: "",
		});
		expect(result.success).toBe(false);
	});

	it("rejects relationship without parent_type, naming the fix", () => {
		const result = caseTypeRecordSchema.safeParse({
			...validRecord,
			relationship: "child",
		});
		expect(result.success).toBe(false);
		expect(result.error?.issues[0]?.message).toContain("parent_type");
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

	it("rejects options on a non-select property", () => {
		const result = caseTypeRecordSchema.safeParse({
			...validRecord,
			properties: [
				{
					name: "age",
					label: "Age",
					data_type: "int",
					options: [{ value: "1", label: "One" }],
				},
			],
		});
		expect(result.success).toBe(false);
		expect(result.error?.issues[0]?.message).toContain("single_select");
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

	it("rejects an empty block — participation with nothing in it", () => {
		const result = connectFormConfigSchema.safeParse({});
		expect(result.success).toBe(false);
		expect(result.error?.issues[0]?.message).toContain("omit");
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
