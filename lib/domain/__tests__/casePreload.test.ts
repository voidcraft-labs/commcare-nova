/**
 * A preload is a default value that reads the case the form loaded. These
 * tests hold the three readers of that rule: which default is a preload,
 * when a new write to the form's own case is born with one, and what a
 * Hidden Value with no value is told it saves.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, type FieldSpec, f } from "@/lib/__tests__/docHelpers";
import {
	type BlueprintDoc,
	type CaseOperation,
	caseOperationSchema,
	type Field,
	fieldPreload,
	formOpensWithOneCase,
	hiddenWriterBlankNote,
	proseText,
	saveOffersPreload,
	type Uuid,
	writerOffersPreload,
} from "@/lib/domain";
import type { Expression } from "@/lib/domain/expression/types";

const FORM = testUuid("preload-form");
const OWN = testUuid("preload-own");
const PHONE = testUuid("preload-phone");

const formCase = (caseType: string, property: string): Expression => ({
	kind: "term",
	term: { kind: "form-case", caseType, property },
});
const read = (uuid: Uuid): Expression => ({
	kind: "term",
	term: { kind: "field", uuid },
});

function app(options: {
	readonly type: "registration" | "followup" | "close";
	readonly fields: readonly FieldSpec[];
	readonly severalCases?: true;
	readonly operations?: readonly CaseOperation[];
}): BlueprintDoc {
	const operations = (options.operations ?? []).map((operation) =>
		caseOperationSchema.parse(operation),
	);
	return buildDoc(
		{
			caseTypes: [
				{ name: "household", properties: [] },
				{
					name: "patient",
					parent_type: "household",
					properties: ["phone", "note"].map((name) => ({
						name,
						label: proseText(name),
					})),
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					...(options.severalCases && {
						caseListConfig: {
							columns: [],
							searchInputs: [],
							selection: { kind: "multiple", maximum: 10 },
						},
					}),
					forms: [
						{
							uuid: FORM,
							name: "Visit",
							type: options.type,
							fields: [...options.fields],
						},
					],
				},
			],
		},
		(doc) => {
			const form = doc.forms[FORM];
			if (form === undefined) throw new Error("The fixture form is missing.");
			if (operations.length > 0)
				form.caseOperations = operations as typeof form.caseOperations;
		},
	);
}

const fieldOf = (doc: BlueprintDoc, uuid: Uuid): Field => {
	const field = doc.fields[uuid];
	if (field === undefined) throw new Error("The fixture field is missing.");
	return field;
};

describe("formOpensWithOneCase", () => {
	it("is true only for a followup or close form in a one-case module", () => {
		expect(formOpensWithOneCase("followup", "single")).toBe(true);
		expect(formOpensWithOneCase("close", "single")).toBe(true);
		expect(formOpensWithOneCase("followup", "multiple")).toBe(false);
		expect(formOpensWithOneCase("registration", "single")).toBe(false);
		expect(formOpensWithOneCase("survey", "single")).toBe(false);
	});
});

describe("fieldPreload", () => {
	it("reads a default that is exactly the loaded case's property, of the own type or an ancestor's", () => {
		const OWN_DEFAULT = testUuid("preload-own-default");
		const ANCESTOR_DEFAULT = testUuid("preload-ancestor-default");
		const NESTED = testUuid("preload-nested");
		const doc = app({
			type: "followup",
			fields: [
				f({
					kind: "text",
					id: "phone",
					uuid: OWN_DEFAULT,
					default_value: formCase("patient", "phone"),
				}),
				f({
					kind: "text",
					id: "village",
					uuid: ANCESTOR_DEFAULT,
					default_value: formCase("household", "case_name"),
				}),
				f({
					kind: "text",
					id: "greeting",
					uuid: NESTED,
					default_value: {
						kind: "concat",
						parts: [
							formCase("patient", "phone"),
							{ kind: "term", term: { kind: "literal", value: "!" } },
						],
					},
				}),
			],
		});
		expect(fieldPreload(fieldOf(doc, OWN_DEFAULT))).toEqual({
			caseType: "patient",
			property: "phone",
		});
		expect(fieldPreload(fieldOf(doc, ANCESTOR_DEFAULT))).toEqual({
			caseType: "household",
			property: "case_name",
		});
		// A default that reads the case inside another expression shows
		// something computed from it, not the case's value.
		expect(fieldPreload(fieldOf(doc, NESTED))).toBeUndefined();
	});
});

describe("writerOffersPreload", () => {
	const phone = f({ kind: "text", id: "phone", uuid: PHONE });

	it("offers the preload to a one-case follow-up's own write", () => {
		const doc = app({
			type: "followup",
			fields: [phone],
			operations: [
				{
					uuid: OWN,
					id: "patient",
					action: "own",
					writes: [{ property: "phone", value: read(PHONE) }],
				},
			],
		});
		expect(writerOffersPreload(doc, PHONE, "phone")).toBe(true);
		expect(
			writerOffersPreload(
				app({ type: "close", fields: [phone] }),
				PHONE,
				"phone",
			),
		).toBe(true);
	});

	it("offers none to a write of the case's owner", () => {
		const doc = app({
			type: "followup",
			fields: [phone],
			operations: [
				{
					uuid: OWN,
					id: "patient",
					action: "own",
					writes: [{ property: "owner_id", value: read(PHONE) }],
				},
			],
		});
		expect(writerOffersPreload(doc, PHONE, "owner_id")).toBe(false);
		// The owner slot holds it the same.
		const slotted = app({
			type: "close",
			fields: [phone],
			operations: [
				{ uuid: OWN, id: "patient", action: "own", owner: read(PHONE) },
			],
		});
		expect(writerOffersPreload(slotted, PHONE, "owner_id")).toBe(false);
	});

	it("offers none on a registration, a several-case form or through `via`", () => {
		expect(
			writerOffersPreload(
				app({ type: "registration", fields: [phone] }),
				PHONE,
				"phone",
			),
		).toBe(false);
		expect(
			writerOffersPreload(
				app({ type: "followup", fields: [phone], severalCases: true }),
				PHONE,
				"phone",
			),
		).toBe(false);
		expect(
			writerOffersPreload(
				app({ type: "followup", fields: [phone] }),
				PHONE,
				"phone",
				[{ identifier: "parent" }],
			),
		).toBe(false);
	});

	it("offers none to a capture, nor to a field that already holds a calculation or a default", () => {
		const PHOTO = testUuid("preload-photo");
		const CALCULATED = testUuid("preload-calculated");
		const DEFAULTED = testUuid("preload-defaulted");
		const doc = app({
			type: "followup",
			fields: [
				f({ kind: "image", id: "photo", uuid: PHOTO }),
				f({
					kind: "hidden",
					id: "calculated",
					uuid: CALCULATED,
					calculate: "'x'",
				}),
				f({
					kind: "text",
					id: "defaulted",
					uuid: DEFAULTED,
					default_value: "'x'",
				}),
			],
		});
		expect(writerOffersPreload(doc, PHOTO, "phone")).toBe(false);
		expect(writerOffersPreload(doc, CALCULATED, "phone")).toBe(false);
		expect(writerOffersPreload(doc, DEFAULTED, "phone")).toBe(false);
	});
});

describe("saveOffersPreload", () => {
	// The rule over a field, its form's type and its module, as the builder's
	// "Saves to" row asks it with no document.
	const followup = app({ type: "followup", fields: [] });
	const module = followup.modules[followup.moduleOrder[0]];
	const several = app({ type: "followup", fields: [], severalCases: true });
	const severalModule = several.modules[several.moduleOrder[0]];
	const text = { uuid: PHONE, kind: "text", id: "phone" } as Field;
	const offers = (
		field: Field,
		overrides: Partial<Parameters<typeof saveOffersPreload>[0]> = {},
	) =>
		saveOffersPreload({
			field,
			property: "phone",
			formType: "followup",
			module,
			...overrides,
		});

	it("offers the case's value to a plain write on a one-case loading form", () => {
		expect(offers(text)).toBe(true);
		expect(offers(text, { formType: "close" })).toBe(true);
	});

	it("offers none to the owner, through `via`, on a registration or a several-case form", () => {
		expect(offers(text, { property: "owner_id" })).toBe(false);
		expect(offers(text, { via: [{ identifier: "parent" }] })).toBe(false);
		expect(offers(text, { formType: "registration" })).toBe(false);
		expect(offers(text, { module: severalModule })).toBe(false);
	});

	it("offers none on a module with no case type, nor to a write with no property", () => {
		expect(offers(text, { module: { ...module, caseType: undefined } })).toBe(
			false,
		);
		expect(offers(text, { property: "" })).toBe(false);
	});

	it("offers none to a capture, a kind that holds no starting value, nor a question that holds a calculation or a starting value", () => {
		expect(offers({ ...text, kind: "image" } as Field)).toBe(false);
		expect(offers({ uuid: PHONE, kind: "label", id: "phone" } as Field)).toBe(
			false,
		);
		expect(
			offers({
				...text,
				default_value: { kind: "term", term: { kind: "literal", value: "x" } },
			} as Field),
		).toBe(false);
		expect(
			offers({
				uuid: PHONE,
				kind: "hidden",
				id: "phone",
				calculate: { kind: "term", term: { kind: "literal", value: "x" } },
			} as Field),
		).toBe(false);
	});
});

describe("hiddenWriterBlankNote", () => {
	const NOTE = testUuid("preload-note");
	const CALCULATED = testUuid("preload-note-calculated");
	const UNWRITTEN = testUuid("preload-note-unwritten");
	const doc = app({
		type: "followup",
		fields: [
			f({ kind: "hidden", id: "note", uuid: NOTE }),
			f({
				kind: "hidden",
				id: "calculated",
				uuid: CALCULATED,
				calculate: "'x'",
			}),
			f({ kind: "hidden", id: "unwritten", uuid: UNWRITTEN }),
			f({ kind: "text", id: "phone", uuid: PHONE }),
		],
		operations: [
			{
				uuid: OWN,
				id: "patient",
				action: "own",
				writes: [
					{ property: "note", value: read(NOTE) },
					{ property: "phone", value: read(CALCULATED) },
					{
						property: "phone",
						value: read(PHONE),
						via: [{ identifier: "parent" }],
					},
				],
			},
		],
	});

	it("tells a Hidden Value with no value that its write saves the property blank", () => {
		expect(hiddenWriterBlankNote(doc, NOTE)).toBe(
			"Has no value yet, so each submission saves note blank.",
		);
	});

	it("says nothing of a calculated Hidden Value, an unwritten one or a visible question", () => {
		expect(hiddenWriterBlankNote(doc, CALCULATED)).toBeUndefined();
		expect(hiddenWriterBlankNote(doc, UNWRITTEN)).toBeUndefined();
		expect(hiddenWriterBlankNote(doc, PHONE)).toBeUndefined();
	});
});
