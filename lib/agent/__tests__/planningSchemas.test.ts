/** Pure SA/MCP input parsing and normalization. These checks establish the
 * boundary shape, not full document validity or Connect wire acceptance; the
 * guarded-tool and native consumer suites own those stronger contracts. */

import { describe, expect, it } from "vitest";
import { caseTypeSchema } from "@/lib/domain/blueprint";
import { matchAll } from "@/lib/domain/expression";
import { proseText } from "@/lib/domain/prose";
import { caseTypeRecordSchema, cleanCaseTypeRecord } from "../planningSchemas";

const validRecord = {
	name: "patient",
	properties: [{ name: "display_name", label: proseText("Full name") }],
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
					name: "display_name",
					label: proseText("Client name"),
					data_type: null,
					hint: null,
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

	it("accepts a record with no custom properties", () => {
		expect(
			caseTypeRecordSchema.safeParse({ ...validRecord, properties: [] })
				.success,
		).toBe(true);
	});

	it("rejects raw strings in typed prose slots", () => {
		for (const overrides of [{ label: "" }, { hint: "" }] as const) {
			const result = caseTypeRecordSchema.safeParse({
				...validRecord,
				properties: [{ name: "age", label: proseText("Age"), ...overrides }],
			});
			expect(result.success).toBe(false);
		}
	});

	it.each(["required", "validation", "validation_msg"])(
		"rejects the retired catalog rule input %s, including explicit null",
		(key) => {
			for (const value of [
				null,
				key === "validation_msg" ? proseText("Enter an age.") : matchAll(),
			]) {
				expect(
					caseTypeRecordSchema.safeParse({
						...validRecord,
						properties: [
							{ name: "age", label: proseText("Age"), [key]: value },
						],
					}).success,
				).toBe(false);
			}
		},
	);

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

	it("refuses a select option value containing a space", () => {
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
					options: null,
				},
			],
		});
		const before = structuredClone(parsed);
		const clean = cleanCaseTypeRecord(parsed);
		expect(caseTypeSchema.parse(clean)).toEqual(clean);
		expect(parsed).toEqual(before);
		expect(clean).toEqual({
			name: "client",
			properties: [
				{
					name: "age",
					label: proseText("Age"),
					data_type: "int",
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
				{ name: "display_name", label: proseText("Case name") },
				{ name: "display_name", label: proseText("Name") },
			],
		});
		expect(result.success).toBe(false);
		if (result.success) throw new Error("expected duplicate rejection");
		expect(result.error.issues[0]?.message).toContain(
			'property "display_name" more than once',
		);
	});
});
