// Stored trees are read through their real registry address. Display text and
// prose projections have separate contracts; neither is an executable reader.
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	formField,
	literal,
	matchAll,
	matchNone,
	neq,
	term,
} from "../expression";
import { printFormExpression } from "../expression/print";
import type { ExpressionSlotRef } from "../expression/types";
import {
	expressionAt,
	expressionDisplayText,
	fieldProseTemplate,
	proseSource,
	proseSourceEntries,
	proseSurfaceReads,
} from "../expressionSource";
import { type Field, fieldSchema } from "../fields";
import { proseText } from "../prose";
import { referenceNames } from "../referenceNames";
import { expressionSlotValues } from "../referenceSlots";

const FIELD = testUuid("expression-field");
const FORM = testUuid("expression-form");
const base = {
	uuid: FIELD,
	id: "answer",
	kind: "text" as const,
	label: proseText("Answer"),
};
function docWith(field: Field) {
	return buildDoc({
		modules: [
			{
				name: "Survey",
				forms: [
					{
						uuid: FORM,
						name: "Intake",
						type: "survey",
						fields: [field],
					},
				],
			},
		],
	});
}
const fieldRef = (
	slot:
		| "relevant"
		| "validate"
		| "default_value"
		| "required"
		| "calculate"
		| "repeat_count"
		| "ids_query",
): ExpressionSlotRef => ({ entity: "field", uuid: FIELD, slot });

describe("stored field expressions and prose", () => {
	it("reads each executable tree by address and projects prose independently", () => {
		const field = fieldSchema.parse({
			...base,
			relevant: matchAll(),
			validate: neq(formField(FIELD), literal("")),
			default_value: term(literal("Ada")),
			required: matchNone(),
			hint: proseText("A hint"),
			help: proseText("More help"),
			validate_msg: proseText("Try again"),
		});
		const doc = docWith(field);
		if (field.kind !== "text") throw new Error("Expected a text fixture");
		expect(
			expressionSlotValues(doc, { entity: "field", uuid: FIELD }).map(
				({ ref, expression }) => ({ slot: ref.slot, expression }),
			),
		).toEqual([
			{ slot: "relevant", expression: field.relevant },
			{ slot: "validate", expression: field.validate },
			{ slot: "default_value", expression: field.default_value },
			{ slot: "required", expression: field.required },
		]);
		const stored = doc.fields[FIELD];
		if (stored.kind !== "text") throw new Error("Expected a stored text field");
		expect(expressionAt(doc, fieldRef("default_value"))).toBe(
			stored.default_value,
		);
		expect(
			proseSurfaceReads(field, doc).map(({ slot, text }) => ({ slot, text })),
		).toEqual([
			{ slot: "label", text: "Answer" },
			{ slot: "hint", text: "A hint" },
			{ slot: "help", text: "More help" },
			{ slot: "validate_msg", text: "Try again" },
		]);
		expect(fieldProseTemplate(field, "hint")).toEqual(proseText("A hint"));
	});

	it("preserves option positions including an empty label", () => {
		const field = fieldSchema.parse({
			...base,
			kind: "single_select",
			optionsSource: {
				kind: "inline",
				options: ["First", "", "Third"].map((label, i) => ({
					uuid: testUuid(`expression-option-${i}`),
					value: String(i),
					label: proseText(label),
				})),
			},
		});
		expect(proseSourceEntries(field, "option_label", docWith(field))).toEqual([
			{ indices: [0], text: "First" },
			{ indices: [1], text: "" },
			{ indices: [2], text: "Third" },
		]);
	});

	it.each([
		{ raw: { repeat_mode: "user_controlled" }, expected: [] },
		{
			raw: { repeat_mode: "count_bound", repeat_count: term(literal(3)) },
			expected: ["repeat_count"],
		},
		{
			raw: {
				repeat_mode: "query_bound",
				data_source: { ids_query: term(literal("case-id")) },
			},
			expected: ["ids_query"],
		},
	])(
		"reads only the active $raw.repeat_mode repeat carrier",
		({ raw, expected }) => {
			const field = fieldSchema.parse({
				uuid: FIELD,
				id: "visits",
				kind: "repeat",
				...raw,
			});
			expect(
				expressionSlotValues(docWith(field), {
					entity: "field",
					uuid: FIELD,
				}).map(({ ref }) => ref.slot),
			).toEqual(expected);
		},
	);

	it("keeps absence distinct from a stored false condition and refuses empty text", () => {
		const absent = docWith(fieldSchema.parse(base));
		const falseCondition = docWith(
			fieldSchema.parse({ ...base, relevant: matchNone() }),
		);
		expect(expressionAt(absent, fieldRef("relevant"))).toBeUndefined();
		expect(expressionAt(falseCondition, fieldRef("relevant"))).toEqual(
			matchNone(),
		);
		expect(fieldSchema.safeParse({ ...base, relevant: "" }).success).toBe(
			false,
		);
	});

	it("does not read raw strings as stored expressions or prose", () => {
		const doc = docWith(fieldSchema.parse(base));
		Object.assign(doc.fields[FIELD], {
			relevant: "true()",
			label: "Raw label",
		});
		expect(fieldSchema.safeParse(doc.fields[FIELD]).success).toBe(false);
		expect(expressionAt(doc, fieldRef("relevant"))).toBeUndefined();
		expect(expressionSlotValues(doc, { entity: "field", uuid: FIELD })).toEqual(
			[],
		);
		expect(proseSurfaceReads(doc.fields[FIELD], doc)).toEqual([]);
	});

	it("ignores a carrier the owning field kind does not execute", () => {
		const doc = docWith(fieldSchema.parse(base));
		Object.assign(doc.fields[FIELD], { calculate: term(literal(2)) });
		expect(fieldSchema.safeParse(doc.fields[FIELD]).success).toBe(false);
		expect(expressionAt(doc, fieldRef("calculate"))).toBeUndefined();
		expect(expressionSlotValues(doc, { entity: "field", uuid: FIELD })).toEqual(
			[],
		);
	});

	it("projects the current field name without rewriting the stored identity", () => {
		const doc = buildDoc({
			modules: [
				{
					name: "Survey",
					forms: [
						{
							name: "Intake",
							type: "survey",
							fields: [
								f({ ...base }),
								f({ id: "copy", kind: "hidden", calculate: "#form/answer" }),
							],
						},
					],
				},
			],
		});
		const copy = Object.values(doc.fields).find(
			(field) => field.kind === "hidden",
		);
		if (copy?.kind !== "hidden") throw new Error("Missing copy fixture");
		const stored = structuredClone(copy.calculate);
		expect(expressionDisplayText(copy.calculate, referenceNames(doc))).toBe(
			"#form/answer",
		);
		const renamed = {
			...doc,
			fields: {
				...doc.fields,
				[FIELD]: { ...doc.fields[FIELD], id: "renamed" },
			},
		};
		expect(expressionDisplayText(copy.calculate, referenceNames(renamed))).toBe(
			"#form/renamed",
		);
		expect(copy.calculate).toEqual(stored);
	});

	it("retains unresolved identity as a tree and reports it in display projection", () => {
		const expression = term(formField(testUuid("missing-source-field")));
		const doc = docWith(fieldSchema.parse({ ...base, relevant: expression }));
		expect(expressionAt(doc, fieldRef("relevant"))).toEqual(expression);
		const projected = printFormExpression(expression, referenceNames(doc));
		expect(projected.text).toContain("reference needs repair");
		expect(projected.unresolved).toEqual([{ path: [], reason: "identity" }]);
	});

	it("keeps hashtag-looking prose literal", () => {
		const field = fieldSchema.parse({
			...base,
			label: proseText("Ask #form/answer"),
		});
		expect(proseSource(field, "label", docWith(field))).toBe(
			"Ask #form/answer",
		);
	});
});

describe("stored form expressions", () => {
	it("reads separate Connect carriers by their owning form", () => {
		const doc = buildDoc({
			connectType: "deliver",
			modules: [
				{
					name: "Deliver",
					forms: [
						{
							uuid: FORM,
							name: "Delivery",
							type: "survey",
							fields: [],
							connect: {
								deliver_unit: {
									id: "unit",
									name: "Unit",
									entity_id: term(literal("id")),
									entity_name: term(literal("Name")),
								},
							},
						},
					],
				},
			],
		});
		expect(
			expressionAt(doc, {
				entity: "form",
				uuid: FORM,
				slot: "deliver_entity_id",
			}),
		).toEqual(term(literal("id")));
		expect(
			expressionAt(doc, {
				entity: "form",
				uuid: FORM,
				slot: "deliver_entity_name",
			}),
		).toEqual(term(literal("Name")));
		expect(
			expressionAt(doc, {
				entity: "form",
				uuid: FORM,
				slot: "assessment_user_score",
			}),
		).toBeUndefined();
	});

	it("addresses link members by link and datum identity across reordering", () => {
		const module = testUuid("expression-target-module");
		const link = testUuid("expression-link");
		const datum = { kind: "selected-case" as const, module };
		const doc = buildDoc({
			modules: [
				{
					uuid: module,
					name: "Patients",
					caseType: "patient",
					forms: [
						{
							uuid: FORM,
							name: "Visit",
							type: "followup",
							fields: [],
						},
					],
				},
			],
			caseTypes: [{ name: "patient", properties: [] }],
		});
		doc.forms[FORM].formLinks = [
			{
				uuid: link,
				target: { type: "form", moduleUuid: module, formUuid: FORM },
				condition: matchAll(),
				datums: [{ name: datum, xpath: term(literal("patient-1")) }],
			},
			{
				uuid: testUuid("expression-else"),
				target: { type: "module", moduleUuid: module },
			},
		];
		const slot = {
			entity: "form" as const,
			uuid: FORM,
			slot: "form_link_datum_xpath" as const,
			member: { linkUuid: link, datum },
		};
		const before = expressionAt(doc, slot);
		doc.forms[FORM].formLinks.reverse();
		expect(expressionAt(doc, slot)).toBe(before);
		expect(before).toEqual(term(literal("patient-1")));
		expect(
			expressionSlotValues(doc, { entity: "form", uuid: FORM }).map(
				({ ref }) => ref.slot,
			),
		).toEqual(["form_link_condition", "form_link_datum_xpath"]);
	});
});
