// Concrete source projections from structurally admitted fields/forms. Registry
// completeness is a separate schema audit; these witnesses do not use registry
// paths to manufacture their own expected reads.
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { expectAdmittedDoc } from "@/lib/agent/__tests__/admittedFixture";
import {
	expressionInspectionSource,
	expressionSource,
	expressionSourceEntries,
	expressionSurfaceReads,
	fieldProseTemplate,
	formExpressionSource,
	formExpressionSourceEntries,
	formExpressionValue,
	isScalarFieldExpressionSlotId,
} from "../expressionSource";
import { fieldSchema } from "../fields";
import { formSchema } from "../forms";
import { proseText } from "../prose";
import { opaqueXPathExpression as xp } from "../xpath";

const FIELD = testUuid("expression-field");
const FORM = testUuid("expression-form");
const EMPTY_DOC = { forms: {}, fields: {}, fieldOrder: {} };
const base = {
	uuid: FIELD,
	id: "answer",
	kind: "text",
	label: proseText("Answer"),
};

describe("field expression source", () => {
	it("reads each authored input expression and prose slot with its original value", () => {
		const field = fieldSchema.parse({
			...base,
			relevant: xp("true()"),
			validate: xp(". != ''"),
			default_value: xp("'Ada'"),
			required: xp("false()"),
			hint: proseText("A hint"),
			help: proseText("More help"),
			validate_msg: proseText("Try again"),
		});
		expect(expressionSurfaceReads(field, "xpath", EMPTY_DOC)).toEqual([
			{ slot: "relevant", indices: [], text: "true()", expr: xp("true()") },
			{ slot: "validate", indices: [], text: ". != ''", expr: xp(". != ''") },
			{ slot: "default_value", indices: [], text: "'Ada'", expr: xp("'Ada'") },
			{ slot: "required", indices: [], text: "false()", expr: xp("false()") },
		]);
		expect(
			expressionSurfaceReads(field, "prose", EMPTY_DOC).map(
				({ slot, text }) => ({ slot, text }),
			),
		).toEqual([
			{ slot: "label", text: "Answer" },
			{ slot: "hint", text: "A hint" },
			{ slot: "help", text: "More help" },
			{ slot: "validate_msg", text: "Try again" },
		]);
		expect(expressionSource(field, "default_value", EMPTY_DOC)).toBe("'Ada'");
		expect(fieldProseTemplate(field, "hint")).toEqual(proseText("A hint"));
	});

	it("preserves option positions including an empty label", () => {
		const field = fieldSchema.parse({
			...base,
			kind: "single_select",
			optionsSource: {
				kind: "inline",
				options: [
					{
						uuid: testUuid("expression-option-1"),
						value: "a",
						label: proseText("First"),
					},
					{
						uuid: testUuid("expression-option-2"),
						value: "b",
						label: proseText(""),
					},
					{
						uuid: testUuid("expression-option-3"),
						value: "c",
						label: proseText("Third"),
					},
				],
			},
		});
		expect(expressionSourceEntries(field, "option_label", EMPTY_DOC)).toEqual([
			{ indices: [0], text: "First" },
			{ indices: [1], text: "" },
			{ indices: [2], text: "Third" },
		]);
	});

	it.each([
		{ raw: { repeat_mode: "user_controlled" }, expected: [] },
		{
			raw: { repeat_mode: "count_bound", repeat_count: xp("3") },
			expected: [{ slot: "repeat_count", text: "3" }],
		},
		{
			raw: {
				repeat_mode: "query_bound",
				data_source: { ids_query: xp("'case-id'") },
			},
			expected: [{ slot: "ids_query", text: "'case-id'" }],
		},
	])(
		"reads the active $raw.repeat_mode repeat carrier",
		({ raw, expected }) => {
			const field = fieldSchema.parse({
				uuid: FIELD,
				id: "visits",
				kind: "repeat",
				...raw,
			});
			expect(
				expressionSurfaceReads(field, "xpath", EMPTY_DOC).map(
					({ slot, text }) => ({ slot, text }),
				),
			).toEqual(expected);
		},
	);

	it("distinguishes an absent slot from a stored empty expression", () => {
		const absent = fieldSchema.parse(base);
		const empty = fieldSchema.parse({ ...base, relevant: xp("") });
		expect(expressionSource(absent, "relevant", EMPTY_DOC)).toBeUndefined();
		expect(expressionSourceEntries(absent, "relevant", EMPTY_DOC)).toEqual([]);
		expect(expressionSource(empty, "relevant", EMPTY_DOC)).toBe("");
		expect(expressionSourceEntries(empty, "relevant", EMPTY_DOC)).toEqual([
			{ indices: [], text: "" },
		]);
	});

	it("does not interpret raw strings as stored AST or prose", () => {
		const field = fieldSchema.parse(base);
		Object.assign(field, { relevant: "true()", label: "Raw label" });
		expect(fieldSchema.safeParse(field).success).toBe(false);
		expect(expressionSource(field, "relevant", EMPTY_DOC)).toBeUndefined();
		expect(expressionSurfaceReads(field, "xpath", EMPTY_DOC)).toEqual([]);
		expect(expressionSurfaceReads(field, "prose", EMPTY_DOC)).toEqual([]);
	});

	it("gates an otherwise readable AST by field kind in the surface walk", () => {
		const field = fieldSchema.parse(base);
		Object.assign(field, { calculate: xp("1 + 1") });
		expect(fieldSchema.safeParse(field).success).toBe(false);
		// The scalar accessor reads a named carrier; the surface walk decides
		// which carriers this kind may execute. An AST isolates applicability
		// from the unrelated raw-string shape refusal.
		expect(expressionSource(field, "calculate", EMPTY_DOC)).toBe("1 + 1");
		expect(expressionSurfaceReads(field, "xpath", EMPTY_DOC)).toEqual([]);
	});

	it("prints field identities against the current name without altering the stored reference", () => {
		const doc = buildDoc({
			modules: [
				{
					name: "Survey",
					forms: [
						{
							name: "Intake",
							type: "survey",
							fields: [
								f({ uuid: FIELD, id: "answer", kind: "text", label: "Answer" }),
								f({ id: "copy", kind: "hidden", calculate: "#form/answer" }),
							],
						},
					],
				},
			],
		});
		expectAdmittedDoc(doc);
		const copy = Object.values(doc.fields).find((field) => field.id === "copy");
		if (!copy) throw new Error("Missing copy fixture");
		const stored = structuredClone(copy);
		expect(expressionSource(copy, "calculate", doc)).toBe("#form/answer");
		const renamed = {
			...doc,
			fields: {
				...doc.fields,
				[FIELD]: { ...doc.fields[FIELD], id: "renamed" },
			},
		};
		expectAdmittedDoc(renamed);
		expect(expressionSource(copy, "calculate", renamed)).toBe("#form/renamed");
		expect(copy).toEqual(stored);
	});

	it("keeps unresolved identities as inspection state and refuses strict execution text", () => {
		const expr = {
			parts: [{ kind: "field-ref", uuid: testUuid("missing-source-field") }],
		};
		const field = fieldSchema.parse({ ...base, relevant: expr });
		expect(() => expressionSource(field, "relevant", EMPTY_DOC)).toThrow();
		expect(expressionInspectionSource(field, "relevant", EMPTY_DOC)).toContain(
			"reference needs repair",
		);
		expect(expressionSurfaceReads(field, "xpath", EMPTY_DOC)).toEqual([
			{
				slot: "relevant",
				indices: [],
				text: expect.stringContaining("reference needs repair"),
				expr,
			},
		]);
	});

	it("keeps hashtag-looking prose literal", () => {
		const field = fieldSchema.parse({
			...base,
			label: proseText("Ask #form/answer"),
		});
		expect(expressionSource(field, "label", EMPTY_DOC)).toBe(
			"Ask #form/answer",
		);
	});
});

describe("form expression source", () => {
	const formBase = { uuid: FORM, id: "intake", name: "Intake", type: "survey" };
	it("reads the separate Connect expression carriers", () => {
		const assessment = formSchema.parse({
			...formBase,
			connect: { assessment: { id: "assessment", user_score: xp("7") } },
		});
		const deliver = formSchema.parse({
			...formBase,
			connect: {
				deliver_unit: {
					id: "unit",
					name: "Unit",
					entity_id: xp("'id'"),
					entity_name: xp("'Name'"),
				},
			},
		});
		expect(
			formExpressionSource(assessment, "assessment_user_score", EMPTY_DOC),
		).toBe("7");
		expect(formExpressionValue(assessment, "assessment_user_score")).toEqual(
			xp("7"),
		);
		expect(formExpressionSource(deliver, "deliver_entity_id", EMPTY_DOC)).toBe(
			"'id'",
		);
		expect(
			formExpressionSource(deliver, "deliver_entity_name", EMPTY_DOC),
		).toBe("'Name'");
		const absent = formSchema.parse(formBase);
		expect(
			formExpressionSource(absent, "assessment_user_score", EMPTY_DOC),
		).toBeUndefined();
		expect(formExpressionValue(absent, "deliver_entity_name")).toBeUndefined();
	});

	it("preserves both link and datum indices while skipping absent carriers", () => {
		const target = {
			type: "module",
			moduleUuid: testUuid("expression-target-module"),
		};
		const form = formSchema.parse({
			...formBase,
			formLinks: [
				{
					uuid: testUuid("expression-link-1"),
					target,
					condition: xp("true()"),
					datums: [
						{ name: "a", xpath: xp("'first'") },
						{ name: "b", xpath: xp("'second'") },
					],
				},
				{ uuid: testUuid("expression-link-2"), target },
				{
					uuid: testUuid("expression-link-3"),
					target,
					condition: xp("false()"),
					datums: [{ name: "c", xpath: xp("'third'") }],
				},
			],
		});
		expect(
			formExpressionSourceEntries(form, "form_link_condition", EMPTY_DOC),
		).toEqual([
			{
				slot: "form_link_condition",
				indices: [0],
				text: "true()",
				expr: xp("true()"),
			},
			{
				slot: "form_link_condition",
				indices: [2],
				text: "false()",
				expr: xp("false()"),
			},
		]);
		expect(
			formExpressionSourceEntries(form, "form_link_datum_xpath", EMPTY_DOC),
		).toEqual([
			{
				slot: "form_link_datum_xpath",
				indices: [0, 0],
				text: "'first'",
				expr: xp("'first'"),
			},
			{
				slot: "form_link_datum_xpath",
				indices: [0, 1],
				text: "'second'",
				expr: xp("'second'"),
			},
			{
				slot: "form_link_datum_xpath",
				indices: [2, 0],
				text: "'third'",
				expr: xp("'third'"),
			},
		]);
	});
});

it.each([
	["relevant", true],
	["ids_query", true],
	["calculate", true],
	["label", true],
	["option_label", false],
	["caseWrite", false],
	["id", false],
	["options", false],
])("classifies scalar source key %s", (key, expected) => {
	expect(isScalarFieldExpressionSlotId(String(key))).toBe(expected);
});
