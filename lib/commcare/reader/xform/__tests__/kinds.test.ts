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
import {
	buildDoc,
	caseListConfig,
	type FieldSpec,
	f,
} from "@/lib/__tests__/docHelpers";
import { proseText } from "@/lib/domain";
import { type FieldKind, fieldKinds } from "@/lib/domain/fields";
import { buildXForm } from "../../../xform/builder";
import { exportedBody, inputFor } from "../../__tests__/novaExport";
import { readHqApp } from "../../index";
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
			? `<item><label>A</label><value>a</value></item>`
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

describe("jr:imageDimensionScaledMax", () => {
	/** The codes at an upload of `mediatype` carrying the attribute as `value`. */
	async function codesFor(
		value: string,
		mediatype = "image/*",
		appearance = "",
	): Promise<string[]> {
		const reading = await readForm(
			xformSource({
				data: "<q/>",
				model: '<bind nodeset="/data/q" type="binary"/>',
				body: `<upload ref="/data/q" mediatype="${mediatype}"${appearance} jr:imageDimensionScaledMax="${value}"/>`,
			}),
		);
		return codesAt(reading, "q");
	}

	it("reads the value as Core's Integer.parseInt does, and -1 on an image as none", async () => {
		const held = Q(
			"jr-imagedimensionscaledmax-250-500-1000px-or-another-positive",
		);
		const invalid = Q(
			"jr-imagedimensionscaledmax-that-is-not-an-integer-or-is-greater",
		);
		expect(await codesFor("500px")).toEqual([held]);
		expect(await codesFor("+500")).toEqual([held]);
		expect(await codesFor("-1")).toEqual([]);
		expect(await codesFor("0")).toEqual([invalid]);
		expect(await codesFor("-2px")).toEqual([invalid]);
		expect(await codesFor("12.5px")).toEqual([invalid]);
		expect(await codesFor("2147483648")).toEqual([invalid]);
		expect(await codesFor("300", "audio/*")).toEqual([]);
		expect(await codesFor("-2147483649", "audio/*")).toEqual([invalid]);
		expect(await codesFor("big", "audio/*")).toEqual([invalid]);
		expect(await codesFor("300", "image/*", ' appearance="signature"')).toEqual(
			[],
		);
	});
});

describe("a data node with element children and no control", () => {
	it("is refused whole, and what it holds stands under it at its own path", async () => {
		const reading = await readForm(
			xformSource({
				data: "<g><a/><h><b/></h></g><c/>",
				model:
					'<bind nodeset="/data/g/a"/><bind nodeset="/data/c" type="xsd:string"/>',
				body: '<input ref="/data/c"/>',
			}),
		);
		const fields = readFields(reading.xform ?? ({} as never));
		expect(
			fields.map((field) => [
				field.node.path.join("/"),
				field.kind,
				field.parent?.id ?? null,
				field.standIn,
			]),
		).toEqual([
			["g", "group", null, true],
			["g/a", "hidden", "g", false],
			["g/h", "group", "g", true],
			["g/h/b", "hidden", "h", false],
			["c", "text", null, false],
		]);
		expect(codesAt(reading, "g")).toEqual([Q("hidden-value-with-children")]);
		expect(codesAt(reading, "g/h")).toEqual([]);
		expect(codesAt(reading, "g/a")).toEqual([]);
	});
});

describe("a select whose choices are the worker's cases, read whole", () => {
	/** The findings a whole reading of a document of one such select leaves at its question. */
	async function questionFindings(filter: string | undefined) {
		const doc = buildDoc({
			caseTypes: [
				{
					name: "clinic",
					properties: [
						{ name: "case_name", label: proseText("Name") },
						{ name: "region", label: proseText("Region") },
					],
				},
			],
			modules: [
				{
					name: "Clinics",
					caseType: "clinic",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							name: "Refer",
							type: "survey",
							fields: [
								f({
									kind: "single_select",
									id: "clinic",
									optionsSource: {
										kind: "cases",
										caseType: "clinic",
										labelProperty: "case_name",
										...(filter === undefined ? {} : { filter }),
									},
								} as FieldSpec),
							],
						},
					],
				},
			],
		});
		const outcome = readHqApp(await inputFor(exportedBody(doc)));
		return {
			outcome,
			atQuestion: (outcome.kind === "account" ? outcome.findings : [])
				.filter((finding) => finding.place.kind === "question")
				.map((finding) => `${finding.code} ${finding.detail.name ?? ""}`),
		};
	}

	it("holds the itemset Nova writes with no filter, its nodeset claimed", async () => {
		const { atQuestion, outcome } = await questionFindings(undefined);
		expect(atQuestion).toEqual([]);
		expect(
			outcome.claims.counts[
				Q("itemset-over-casedb-in-nova-s-case-choices-shape")
			],
		).toBeGreaterThan(0);
	});

	it("holds the itemset Nova writes with a filter", async () => {
		const { atQuestion, outcome } = await questionFindings("region = 'north'");
		expect(atQuestion).toEqual([]);
		expect(
			outcome.claims.counts[
				Q("itemset-over-casedb-in-nova-s-case-choices-shape")
			],
		).toBeGreaterThan(0);
	});
});

/** What a reading holds of one field: the slots the kind table and the containers set. */
interface ReadShape {
	readonly id: string;
	readonly kind: FieldKind;
	readonly keypad?: unknown;
	readonly fieldList?: unknown;
	readonly repeat_mode?: unknown;
	readonly placement?: unknown;
}

/** One document the emitter writes for a kind, and what its reading must hold, in order. */
interface KindFixture {
	readonly fields: readonly FieldSpec[];
	readonly read: readonly ReadShape[];
}

const option = (key: string) => ({
	uuid: testUuid(`${key}-a`),
	value: "a",
	label: proseText("A"),
});

/**
 * Every kind of `fieldKinds`, each with the fields that make the emitter write it, among them
 * the count and query modes of a repeat and both placements of a query repeat. A section is a
 * form's root of sections, so it is read from a form of its own.
 */
const EMITTED: { readonly [K in FieldKind]: readonly KindFixture[] } = {
	text: [
		{
			fields: [f({ kind: "text", id: "text" })],
			read: [{ id: "text", kind: "text" }],
		},
		{
			fields: [f({ kind: "text", id: "phone", keypad: "numbers" })],
			read: [{ id: "phone", kind: "text", keypad: "numbers" }],
		},
	],
	int: [
		{
			fields: [f({ kind: "int", id: "int" })],
			read: [{ id: "int", kind: "int" }],
		},
	],
	decimal: [
		{
			fields: [f({ kind: "decimal", id: "decimal" })],
			read: [{ id: "decimal", kind: "decimal" }],
		},
	],
	date: [
		{
			fields: [f({ kind: "date", id: "date" })],
			read: [{ id: "date", kind: "date" }],
		},
	],
	time: [
		{
			fields: [f({ kind: "time", id: "time" })],
			read: [{ id: "time", kind: "time" }],
		},
	],
	datetime: [
		{
			fields: [f({ kind: "datetime", id: "datetime" })],
			read: [{ id: "datetime", kind: "datetime" }],
		},
	],
	single_select: [
		{
			fields: [
				f({
					kind: "single_select",
					id: "single",
					optionsSource: { kind: "inline", options: [option("single")] },
				}),
			],
			read: [{ id: "single", kind: "single_select" }],
		},
	],
	multi_select: [
		{
			fields: [
				f({
					kind: "multi_select",
					id: "multi",
					optionsSource: { kind: "inline", options: [option("multi")] },
				}),
			],
			read: [{ id: "multi", kind: "multi_select" }],
		},
	],
	geopoint: [
		{
			fields: [f({ kind: "geopoint", id: "geopoint" })],
			read: [{ id: "geopoint", kind: "geopoint" }],
		},
	],
	image: [
		{
			fields: [f({ kind: "image", id: "image" })],
			read: [{ id: "image", kind: "image" }],
		},
	],
	audio: [
		{
			fields: [f({ kind: "audio", id: "audio" })],
			read: [{ id: "audio", kind: "audio" }],
		},
	],
	video: [
		{
			fields: [f({ kind: "video", id: "video" })],
			read: [{ id: "video", kind: "video" }],
		},
	],
	file: [
		{
			fields: [f({ kind: "file", id: "file" })],
			read: [{ id: "file", kind: "file" }],
		},
	],
	barcode: [
		{
			fields: [f({ kind: "barcode", id: "barcode" })],
			read: [{ id: "barcode", kind: "barcode" }],
		},
	],
	signature: [
		{
			fields: [f({ kind: "signature", id: "signature" })],
			read: [{ id: "signature", kind: "signature" }],
		},
	],
	label: [
		{
			fields: [f({ kind: "label", id: "label" })],
			read: [{ id: "label", kind: "label" }],
		},
	],
	hidden: [
		{
			fields: [f({ kind: "hidden", id: "hidden" })],
			read: [{ id: "hidden", kind: "hidden" }],
		},
	],
	secret: [
		{
			fields: [f({ kind: "secret", id: "secret" })],
			read: [{ id: "secret", kind: "secret" }],
		},
	],
	group: [
		{
			fields: [
				f({
					kind: "group",
					id: "group",
					children: [f({ kind: "text", id: "inner" })],
				}),
			],
			read: [
				{ id: "group", kind: "group" },
				{ id: "inner", kind: "text" },
			],
		},
		{
			fields: [
				f({
					kind: "group",
					id: "list",
					fieldList: true,
					children: [f({ kind: "text", id: "listed" })],
				}),
			],
			read: [
				{ id: "list", kind: "group", fieldList: true },
				{ id: "listed", kind: "text" },
			],
		},
	],
	repeat: [
		{
			fields: [
				f({
					kind: "repeat",
					id: "repeat",
					repeat_mode: "user_controlled",
					children: [f({ kind: "text", id: "row" })],
				}),
			],
			read: [
				{ id: "repeat", kind: "repeat", repeat_mode: "user_controlled" },
				{ id: "row", kind: "text" },
			],
		},
		{
			// Counted by the int question above, which `jr:count` names directly.
			fields: [
				f({
					kind: "repeat",
					id: "counted",
					repeat_mode: "count_bound",
					repeat_count: "#form/int",
					children: [f({ kind: "text", id: "counted_row" })],
				} as FieldSpec),
			],
			read: [
				{ id: "counted", kind: "repeat", repeat_mode: "count_bound" },
				{ id: "counted_row", kind: "text" },
			],
		},
		{
			// At the root, reading no answer: model iteration.
			fields: [
				f({
					kind: "repeat",
					id: "iterated",
					repeat_mode: "query_bound",
					data_source: { ids_query: "'a b'" },
					children: [f({ kind: "text", id: "iterated_row" })],
				} as FieldSpec),
			],
			read: [
				{
					id: "iterated",
					kind: "repeat",
					repeat_mode: "query_bound",
					placement: "model-iteration",
				},
				{ id: "iterated_row", kind: "text" },
			],
		},
		{
			// Inside another repeat: the count placement.
			fields: [
				f({
					kind: "repeat",
					id: "outer",
					repeat_mode: "user_controlled",
					children: [
						f({
							kind: "repeat",
							id: "placed",
							repeat_mode: "query_bound",
							data_source: { ids_query: "'a b'" },
							children: [f({ kind: "text", id: "placed_row" })],
						} as FieldSpec),
					],
				}),
			],
			read: [
				{ id: "outer", kind: "repeat", repeat_mode: "user_controlled" },
				{
					id: "placed",
					kind: "repeat",
					repeat_mode: "query_bound",
					placement: "count",
				},
				{ id: "placed_row", kind: "text" },
			],
		},
	],
	section: [
		{
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
			read: [
				{ id: "first", kind: "section" },
				{ id: "a", kind: "text" },
				{ id: "second", kind: "section" },
				{ id: "b", kind: "int" },
			],
		},
	],
};

/** The fields of one emitted form, read back as `ReadShape`s, and whether any stands in. */
async function emittedAndRead(
	fields: readonly FieldSpec[],
): Promise<{ readonly shapes: ReadShape[]; readonly standIns: string[] }> {
	const doc = buildDoc({
		modules: [
			{
				name: "Menu",
				forms: [{ name: "Form", type: "survey", fields: [...fields] }],
			},
		],
	});
	const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
	const reading = await readForm(buildXForm(doc, formUuid, { xmlns: XMLNS }));
	const read = readFields(reading.xform ?? ({} as never));
	return {
		shapes: read.map((field) => ({
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
			...(field.field.placement === undefined
				? {}
				: { placement: field.field.placement }),
		})),
		standIns: read.filter((field) => field.standIn).map((field) => field.id),
	};
}

describe("every kind Nova writes, emitted and read back", () => {
	it("has a document for every kind of fieldKinds, each read as that kind", () => {
		for (const kind of fieldKinds) {
			const fixtures = (
				EMITTED as Partial<Record<string, readonly KindFixture[]>>
			)[kind];
			expect(fixtures?.length ?? 0, kind).toBeGreaterThan(0);
			for (const fixture of fixtures ?? [])
				expect(
					fixture.read.some((shape) => shape.kind === kind),
					kind,
				).toBe(true);
		}
	});

	it("reads each field's kind, id, keypad, container shape, repeat mode and placement", async () => {
		const together = fieldKinds
			.filter((kind) => kind !== "section")
			.flatMap((kind) => EMITTED[kind]);
		const { shapes, standIns } = await emittedAndRead(
			together.flatMap((fixture) => fixture.fields),
		);
		expect(shapes).toEqual(together.flatMap((fixture) => fixture.read));
		expect(standIns).toEqual([]);
	});

	it("reads a form of root Question Lists as sections", async () => {
		for (const fixture of EMITTED.section) {
			const { shapes, standIns } = await emittedAndRead(fixture.fields);
			expect(shapes).toEqual(fixture.read);
			expect(standIns).toEqual([]);
		}
	});
});
