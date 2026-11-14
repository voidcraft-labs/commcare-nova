/**
 * The field kind table (9.1), held at two boundaries. Every row is reached by
 * a source written for it and is the first row its facts match, so a row an
 * earlier one shadows fails here; the source is read through the reader's own
 * stages and gives the row's kind, or its refusal at the question. Every
 * field kind Nova's emitter writes alone reads back as that kind, so a kind
 * Nova gains with no row fails here. A question named `registration` is the
 * reserved-name finding, never the grammar one, and never held.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { proseText } from "@/lib/domain";
import { buildXForm } from "../../../xform/builder";
import { FIELD_KIND_ROWS, type FieldKindFacts, fieldKindOf } from "../kinds";
import {
	codesAt,
	readFields,
	readForm,
	XMLNS,
	xformSource,
} from "./formReading";

const Q = (id: string) => `questions/${id}`;

interface RowCase {
	/** The row's entry: the one row these facts must reach first. */
	readonly entry: string;
	readonly facts: FieldKindFacts;
}

const BASE: FieldKindFacts = {
	control: "input",
	bindType: "string",
	mediaType: undefined,
	appearance: undefined,
	hasCalculate: false,
	hasDefault: false,
};

const facts = (patch: Partial<FieldKindFacts>): FieldKindFacts => ({
	...BASE,
	...patch,
});

const CASES: readonly RowCase[] = [
	{ entry: Q("text-input-xsd-string"), facts: facts({}) },
	{
		entry: Q("phone-number-xsd-string-appearance-numeric"),
		facts: facts({ appearance: "numeric" }),
	},
	{
		entry: Q("an-input-whose-bind-has-no-type-any-appearance-but-numeric-or"),
		facts: facts({ bindType: undefined }),
	},
	{
		entry: Q(
			"an-input-whose-bind-has-no-type-with-numeric-or-numbers-ignoring",
		),
		facts: facts({ bindType: undefined, appearance: "Numbers" }),
	},
	{
		entry: Q("integer-xsd-int-xsd-integer-read-as-the-same"),
		facts: facts({ bindType: "integer" }),
	},
	{ entry: Q("decimal-xsd-double"), facts: facts({ bindType: "double" }) },
	{ entry: Q("date-xsd-date"), facts: facts({ bindType: "date" }) },
	{ entry: Q("time-xsd-time"), facts: facts({ bindType: "time" }) },
	{
		entry: Q("date-and-time-xsd-datetime"),
		facts: facts({ bindType: "dateTime" }),
	},
	{ entry: Q("gps-geopoint"), facts: facts({ bindType: "geopoint" }) },
	{ entry: Q("barcode-barcode"), facts: facts({ bindType: "barcode" }) },
	{ entry: Q("long-xsd-long"), facts: facts({ bindType: "long" }) },
	{
		entry: Q("android-app-callout-input-appearance-intent-id-bind-type-intent"),
		facts: facts({ bindType: "intent" }),
	},
	{
		entry: Q("input-whose-bind-type-vellum-does-not-write-xsd-decimal-xsd"),
		facts: facts({ bindType: "decimal" }),
	},
	{
		entry: Q("password-secret-xsd-string"),
		facts: facts({ control: "secret" }),
	},
	{
		entry: Q("a-secret-whose-bind-has-no-type-any-appearance-but-numeric-or"),
		facts: facts({ control: "secret", bindType: undefined }),
	},
	{
		entry: Q(
			"a-secret-whose-bind-has-no-type-with-numeric-or-numbers-ignoring",
		),
		facts: facts({
			control: "secret",
			bindType: undefined,
			appearance: "numeric",
		}),
	},
	{
		entry: Q("secret-with-a-numeric-bind-type"),
		facts: facts({ control: "secret", bindType: "int" }),
	},
	{
		entry: Q("multiple-choice-select1-item"),
		facts: facts({ control: "select1", bindType: "select1" }),
	},
	{
		entry: Q("checkbox-select-item"),
		facts: facts({ control: "select", bindType: undefined }),
	},
	{
		entry: Q(
			"a-choice-bind-type-contradicting-the-control-listitem-select1-on",
		),
		facts: facts({ control: "select1", bindType: "listItems" }),
	},
	{
		entry: Q("a-select-whose-bind-type-is-neither-a-choice-type-nor-a-string"),
		facts: facts({ control: "select", bindType: "int" }),
	},
	{
		entry: Q("label-trigger-whose-appearance-is-exactly-minimal"),
		facts: facts({
			control: "trigger",
			bindType: undefined,
			appearance: "minimal",
		}),
	},
	{
		entry: Q("acknowledge-label-a-trigger-whose-appearance-is-neither-exactly"),
		facts: facts({ control: "trigger", bindType: undefined }),
	},
	{
		entry: Q("image-capture-upload-image"),
		facts: facts({
			control: "upload",
			bindType: "binary",
			mediaType: "image/*",
		}),
	},
	{
		entry: Q("signature-image-signature"),
		facts: facts({
			control: "upload",
			bindType: "binary",
			mediaType: "image/*",
			appearance: "signature",
		}),
	},
	{
		entry: Q("face-capture-image-face"),
		facts: facts({
			control: "upload",
			bindType: "binary",
			mediaType: "image/*",
			appearance: "face",
		}),
	},
	{
		entry: Q("audio-capture-audio"),
		facts: facts({
			control: "upload",
			bindType: "binary",
			mediaType: "audio/*",
		}),
	},
	{
		entry: Q("video-capture-video"),
		facts: facts({
			control: "upload",
			bindType: "binary",
			mediaType: "video/*",
		}),
	},
	{
		entry: Q("document-upload-application-text"),
		facts: facts({
			control: "upload",
			bindType: "binary",
			mediaType: "application/*,text/*",
		}),
	},
	{
		entry: Q("upload-with-any-other-mediatype-or-none"),
		facts: facts({
			control: "upload",
			bindType: "binary",
			mediaType: "Image/*",
		}),
	},
	{
		entry: Q(
			"hidden-value-data-node-bind-no-control-with-calculate-or-default",
		),
		facts: facts({ control: "none", hasCalculate: true }),
	},
	{
		entry: Q("hidden-value-with-neither"),
		facts: facts({ control: "none", bindType: undefined }),
	},
	{
		entry: Q(
			"hidden-value-with-both-calculate-and-a-default-by-any-expression",
		),
		facts: facts({ control: "none", hasCalculate: true, hasDefault: true }),
	},
	{
		entry: Q(
			"hidden-value-data-node-bind-no-control-with-calculate-or-default",
		),
		facts: facts({ control: "none", bindType: "dateTime", hasDefault: true }),
	},
	{
		entry: Q("hidden-value-with-neither"),
		facts: facts({ control: "none", bindType: "dateTime" }),
	},
	{
		entry: Q(
			"hidden-value-with-both-calculate-and-a-default-by-any-expression",
		),
		facts: facts({
			control: "none",
			bindType: "dateTime",
			hasCalculate: true,
			hasDefault: true,
		}),
	},
	{
		entry: Q("hidden-value-bound-a-type-nova-would-not-write"),
		facts: facts({ control: "none", bindType: "int" }),
	},
];

describe("FIELD_KIND_ROWS", () => {
	it("reaches every row first from facts written for it", () => {
		const reached = new Set(CASES.map(({ facts: one }) => fieldKindOf(one)));
		for (const { entry, facts: one } of CASES)
			expect(fieldKindOf(one)?.claim.entry, JSON.stringify(one)).toBe(entry);
		const unreached = FIELD_KIND_ROWS.filter((row) => !reached.has(row)).map(
			(row) => row.claim.entry,
		);
		expect(unreached).toEqual([]);
	});

	it("leaves an upload of one of the four media types with no binary type unclaimed", () => {
		expect(
			fieldKindOf(
				facts({ control: "upload", bindType: "string", mediaType: "image/*" }),
			),
		).toBeUndefined();
	});
});

/** The source of one question from a row's facts: its node, its bind and its control. */
function sourceOf(one: FieldKindFacts): string {
	const type =
		one.bindType === undefined
			? ""
			: ` type="${one.bindType === "string" ? "xsd:string" : one.bindType}"`;
	const calculate = one.hasCalculate ? ` calculate="'x'"` : "";
	const appearance =
		one.appearance === undefined ? "" : ` appearance="${one.appearance}"`;
	const mediatype =
		one.mediaType === undefined ? "" : ` mediatype="${one.mediaType}"`;
	const choices =
		one.control === "select1" || one.control === "select"
			? `<item><value>a</value></item>`
			: "";
	return xformSource({
		data: "<q/>",
		model: `<bind nodeset="/data/q"${type}${calculate}/>${
			one.hasDefault
				? `<setvalue event="xforms-ready" ref="/data/q" value="'d'"/>`
				: ""
		}`,
		body:
			one.control === "none"
				? ""
				: `<${one.control} ref="/data/q"${appearance}${mediatype}>${choices}</${one.control}>`,
	});
}

describe("a row read from a source written for it", () => {
	for (const { entry, facts: one } of CASES) {
		const row = fieldKindOf(one);
		it(`${entry.slice("questions/".length)} (${JSON.stringify(one)})`, async () => {
			const reading = await readForm(sourceOf(one));
			const xform = reading.xform;
			expect(xform).not.toBeNull();
			const [field] = readFields(xform ?? ({} as never));
			expect(field?.id).toBe("q");
			const codes = codesAt(reading, "q");
			if (row?.kind === undefined) {
				expect(field?.standIn).toBe(true);
				expect(codes).toContain(entry);
				return;
			}
			expect(field?.kind).toBe(row.kind);
			expect(field?.standIn).toBe(false);
			expect(codes.filter((code) => code !== "unrecognized")).toEqual([]);
			if (!one.hasCalculate && !one.hasDefault) expect(codes).toEqual([]);
			if (row.slots !== undefined)
				expect(field?.field).toMatchObject(row.slots);
		});
	}
});

describe("a question's id", () => {
	it("refuses a question named registration in any case under the reserved-name entry", async () => {
		for (const name of ["registration", "Registration"]) {
			const reading = await readForm(
				xformSource({
					data: `<${name}/>`,
					model: `<bind nodeset="/data/${name}" type="xsd:string"/>`,
					body: `<input ref="/data/${name}"/>`,
				}),
			);
			const codes = codesAt(reading, name);
			expect(codes).toContain(Q("question-id-case-registration-script"));
			expect(codes).not.toContain(
				Q("question-id-failing-the-grammar-or-meta-in-any-case"),
			);
			const [field] = readFields(reading.xform ?? ({} as never));
			expect(field?.standIn).toBe(true);
		}
	});

	it("refuses meta below the root and a name HQ's form builder cannot open under the grammar entry", async () => {
		const reading = await readForm(
			xformSource({
				data: "<g><meta/></g><bind/>",
				model:
					'<bind nodeset="/data/g/meta" type="xsd:string"/><bind nodeset="/data/bind" type="xsd:string"/>',
				body: '<group ref="/data/g"><input ref="/data/g/meta"/></group><input ref="/data/bind"/>',
			}),
		);
		expect(codesAt(reading, "g/meta")).toContain(
			Q("question-id-failing-the-grammar-or-meta-in-any-case"),
		);
		expect(codesAt(reading, "bind")).toContain(
			Q("question-id-failing-the-grammar-or-meta-in-any-case"),
		);
	});
});

describe("every kind Nova writes, emitted alone and read back", () => {
	const kinds = [
		f({ kind: "text", id: "text" }),
		f({ kind: "text", id: "phone", keypad: "numbers" }),
		f({ kind: "int", id: "int" }),
		f({ kind: "decimal", id: "decimal" }),
		f({ kind: "date", id: "date" }),
		f({ kind: "time", id: "time" }),
		f({ kind: "datetime", id: "datetime" }),
		f({
			kind: "single_select",
			id: "single",
			optionsSource: {
				kind: "inline",
				options: [
					{ uuid: testUuid("single-a"), value: "a", label: proseText("A") },
				],
			},
		}),
		f({
			kind: "multi_select",
			id: "multi",
			optionsSource: {
				kind: "inline",
				options: [
					{ uuid: testUuid("multi-a"), value: "a", label: proseText("A") },
				],
			},
		}),
		f({ kind: "geopoint", id: "geopoint" }),
		f({ kind: "barcode", id: "barcode" }),
		f({ kind: "image", id: "image" }),
		f({ kind: "audio", id: "audio" }),
		f({ kind: "video", id: "video" }),
		f({ kind: "file", id: "file" }),
		f({ kind: "signature", id: "signature" }),
		f({ kind: "label", id: "label" }),
		f({ kind: "secret", id: "secret" }),
		f({ kind: "hidden", id: "hidden" }),
		f({
			kind: "group",
			id: "group",
			children: [f({ kind: "text", id: "inner" })],
		}),
		f({
			kind: "group",
			id: "list",
			fieldList: true,
			children: [f({ kind: "text", id: "listed" })],
		}),
		f({
			kind: "repeat",
			id: "repeat",
			repeat_mode: "user_controlled",
			children: [f({ kind: "text", id: "row" })],
		}),
	];

	it("reads each field's kind, id, keypad and container shape", async () => {
		const doc = buildDoc({
			modules: [
				{
					name: "Menu",
					forms: [{ name: "Form", type: "survey", fields: kinds }],
				},
			],
		});
		const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
		const reading = await readForm(buildXForm(doc, formUuid, { xmlns: XMLNS }));
		const fields = readFields(reading.xform ?? ({} as never));
		expect(
			fields.map((field) => ({
				id: field.id,
				kind: field.kind,
				...(field.field.keypad === undefined
					? {}
					: { keypad: field.field.keypad }),
				...(field.field.fieldList === undefined
					? {}
					: { fieldList: field.field.fieldList }),
				...(field.field.repeat_mode === undefined
					? {}
					: { repeat_mode: field.field.repeat_mode }),
			})),
		).toEqual([
			{ id: "text", kind: "text" },
			{ id: "phone", kind: "text", keypad: "numbers" },
			{ id: "int", kind: "int" },
			{ id: "decimal", kind: "decimal" },
			{ id: "date", kind: "date" },
			{ id: "time", kind: "time" },
			{ id: "datetime", kind: "datetime" },
			{ id: "single", kind: "single_select" },
			{ id: "multi", kind: "multi_select" },
			{ id: "geopoint", kind: "geopoint" },
			{ id: "barcode", kind: "barcode" },
			{ id: "image", kind: "image" },
			{ id: "audio", kind: "audio" },
			{ id: "video", kind: "video" },
			{ id: "file", kind: "file" },
			{ id: "signature", kind: "signature" },
			{ id: "label", kind: "label" },
			{ id: "secret", kind: "secret" },
			{ id: "hidden", kind: "hidden" },
			{ id: "group", kind: "group" },
			{ id: "inner", kind: "text" },
			{ id: "list", kind: "group", fieldList: true },
			{ id: "listed", kind: "text" },
			{ id: "repeat", kind: "repeat", repeat_mode: "user_controlled" },
			{ id: "row", kind: "text" },
		]);
		for (const field of fields) expect(field.standIn).toBe(false);
	});

	it("reads a form of root Question Lists as sections", async () => {
		const doc = buildDoc({
			modules: [
				{
					name: "Menu",
					forms: [
						{
							name: "Form",
							type: "survey",
							fields: [
								f({
									kind: "section",
									id: "first",
									children: [f({ kind: "text", id: "a" })],
								}),
								f({
									kind: "section",
									id: "second",
									children: [f({ kind: "int", id: "b" })],
								}),
							],
						},
					],
				},
			],
		});
		const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
		const reading = await readForm(buildXForm(doc, formUuid, { xmlns: XMLNS }));
		expect(
			readFields(reading.xform ?? ({} as never)).map((field) => [
				field.id,
				field.kind,
			]),
		).toEqual([
			["first", "section"],
			["a", "text"],
			["second", "section"],
			["b", "int"],
		]);
	});
});
