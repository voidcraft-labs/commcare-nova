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
import { z } from "zod";
import { xp } from "@/lib/__tests__/docHelpers";
import { proseText } from "@/lib/domain/prose";
import {
	caseTypeRecordSchema,
	cleanCaseTypeRecord,
	connectFormConfigSchema,
	connectFormPatchSchema,
} from "../planningSchemas";

const validRecord = {
	name: "patient",
	properties: [{ name: "case_name", label: proseText("Full name") }],
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
					label: proseText("Client name"),
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
		expect(result.error?.issues[0]?.message).toContain("pass null");
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
				properties: [{ name: "age", label: proseText("Age"), ...overrides }],
			});
			expect(result.success).toBe(false);
		}
	});

	it("rejects a validation_msg with no validation to accompany", () => {
		const result = caseTypeRecordSchema.safeParse({
			...validRecord,
			properties: [
				{
					name: "age",
					label: proseText("Age"),
					validation_msg: proseText("Must be 0-150"),
				},
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
					label: proseText("Age"),
					data_type: "int",
					options: [{ value: "unused", label: proseText("unused") }],
				},
			],
		});
		expect(result.success).toBe(false);
		expect(result.error?.issues[0]?.message).toContain("Pass null for options");
	});

	it("accepts options on a select property", () => {
		const result = caseTypeRecordSchema.safeParse({
			...validRecord,
			properties: [
				{
					name: "status",
					label: proseText("Status"),
					data_type: "single_select",
					options: [
						{ value: "open", label: proseText("Open") },
						{ value: "closed", label: proseText("Closed") },
					],
				},
			],
		});
		expect(result.success).toBe(true);
	});

	it("teaches the option value's slug shape in the schema, then refuses a value with a space", () => {
		const describedOptions = z.toJSONSchema(caseTypeRecordSchema);
		const text = JSON.stringify(describedOptions);
		expect(text).toContain("prefer_not_to_say");
		expect(text).toContain("underscores");

		const result = caseTypeRecordSchema.safeParse({
			...validRecord,
			properties: [
				{
					name: "status",
					label: proseText("Status"),
					data_type: "single_select",
					options: [
						{ value: "In progress", label: proseText("In progress") },
						{ value: "closed", label: proseText("Closed") },
					],
				},
			],
		});
		expect(result.success).toBe(false);
		expect(result.error?.issues[0]?.message).toContain("underscores");
		expect(result.error?.issues[0]?.path).toEqual([
			"properties",
			0,
			"options",
			0,
			"value",
		]);
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
					label: proseText("Age"),
					data_type: "int",
					hint: null,
					required: xp("true()"),
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
				{
					name: "age",
					label: proseText("Age"),
					data_type: "int",
					required: xp("true()"),
				},
			],
		});
		expect("parent_type" in clean).toBe(false);
		expect("hint" in clean.properties[0]).toBe(false);
	});

	it.each(["name", "external-id", "date-opened"])(
		"rejects the retired catalog property spelling %s",
		(name) => {
			const parsed = caseTypeRecordSchema.safeParse({
				name: "client",
				properties: [{ name, label: proseText("Value") }],
			});
			expect(parsed.success).toBe(false);
		},
	);

	it("rejects exact duplicate catalog properties", () => {
		const result = caseTypeRecordSchema.safeParse({
			name: "client",
			properties: [
				{ name: "case_name", label: proseText("Case name") },
				{ name: "case_name", label: proseText("Name") },
			],
		});
		expect(result.success).toBe(false);
		if (result.success) throw new Error("expected duplicate rejection");
		expect(result.error.issues[0]?.message).toContain(
			'property "case_name" more than once',
		);
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

	it("publishes time_estimate as whole hours in the tool schema", () => {
		const schema = JSON.stringify(
			z.toJSONSchema(connectFormConfigSchema, {
				target: "draft-7",
				io: "input",
			}),
		);
		expect(schema).toContain(
			"Estimated whole hours to complete the module's content; round up and use at least 1.",
		);
		expect(schema).not.toMatch(/\bminutes?\b/i);
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
		expect(result.error?.issues[0]?.message).toContain(
			"empty Connect participant",
		);
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

	it("rejects a zero or fractional time_estimate in hours", () => {
		const parse = (time_estimate: number) =>
			connectFormConfigSchema.safeParse({
				learn_module: {
					name: "Module",
					description: "Content",
					time_estimate,
				},
			});
		const zero = parse(0);
		const fractional = parse(1.5);
		const negative = parse(-3);
		expect(zero.success).toBe(false);
		expect(fractional.success).toBe(false);
		expect(negative.success).toBe(false);
		if (zero.success || fractional.success) {
			throw new Error("expected invalid hour estimates");
		}
		expect(zero.error.issues[0]?.message).toBe(
			"time_estimate must be at least 1 hour.",
		);
		expect(fractional.error.issues[0]?.message).toBe(
			"time_estimate must be a whole number of hours.",
		);
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
