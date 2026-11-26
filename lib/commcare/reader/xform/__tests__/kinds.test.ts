/**
 * The field kind table, held at two boundaries. Every row is reached by
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
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import {
	type BlueprintDoc,
	blueprintDocSchema,
	type LookupColumnId,
	type LookupTableId,
	proseText,
} from "@/lib/domain";
import { type FieldKind, fieldKinds } from "@/lib/domain/fields";
import { lookupMemberIdSchema } from "@/lib/domain/lookupIds";
import type { LookupRead } from "@/lib/domain/lookupRead";
import { positionedCaseCreate } from "@/proof/targeted/documents/positionedCaseCreate";
import { lookupWireNaming } from "../../../lookup/naming";
import { buildXForm } from "../../../xform/builder";
import { exportedBody, inputFor } from "../../__tests__/novaExport";
import { readHqApp } from "../../index";
import { FIELD_KIND_ROWS, type FieldKindFacts, fieldKindOf } from "../kinds";
import {
	codesAt,
	formFindings,
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
	inRepeat: false,
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
		facts: facts({ bindType: "intent", appearance: "intent:q" }),
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
		entry: Q("hidden-value-with-both-calculate-and-a-default-no-runtime-reads"),
		facts: facts({ control: "none", hasCalculate: true, hasDefault: true }),
	},
	{
		entry: Q(
			"hidden-value-with-both-calculate-and-a-default-by-any-expression",
		),
		facts: facts({
			control: "none",
			hasCalculate: true,
			hasDefault: true,
			inRepeat: true,
		}),
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
		entry: Q("hidden-value-with-both-calculate-and-a-default-no-runtime-reads"),
		facts: facts({
			control: "none",
			bindType: "dateTime",
			hasCalculate: true,
			hasDefault: true,
		}),
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
			inRepeat: true,
		}),
	},
	{
		entry: Q(
			"hidden-value-data-node-bind-no-control-with-calculate-or-default",
		),
		facts: facts({ control: "none", bindType: "int", hasDefault: true }),
	},
	{
		entry: Q("hidden-value-with-neither"),
		facts: facts({ control: "none", bindType: "int" }),
	},
	{
		entry: Q("hidden-value-with-both-calculate-and-a-default-no-runtime-reads"),
		facts: facts({
			control: "none",
			bindType: "int",
			hasCalculate: true,
			hasDefault: true,
		}),
	},
	{
		entry: Q(
			"hidden-value-with-both-calculate-and-a-default-by-any-expression",
		),
		facts: facts({
			control: "none",
			bindType: "int",
			hasCalculate: true,
			hasDefault: true,
			inRepeat: true,
		}),
	},
	{
		entry: Q("hidden-value-with-neither"),
		facts: facts({ control: "none", bindType: "unknown" }),
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

/** The source of one question from a row's facts: its node, its bind and its control, in a
 *  repeat `r` where the facts say so. */
function sourceOf(one: FieldKindFacts): string {
	const at = one.inRepeat ? "/data/r/q" : "/data/q";
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
	const control =
		one.control === "none"
			? ""
			: `<${one.control} ref="${at}"${appearance}${mediatype}>${choices}</${one.control}>`;
	return xformSource({
		...(one.bindType === "intent" && {
			head: '<odkx:intent id="q" class="org.example.MEASURE"/>',
		}),
		data: one.inRepeat ? `<r jr:template=""><q/></r>` : "<q/>",
		model: `${one.inRepeat ? `<bind nodeset="/data/r"/>` : ""}<bind nodeset="${at}"${type}${calculate}/>${
			one.hasDefault
				? `<setvalue event="${one.inRepeat ? "jr-insert" : "xforms-ready"}" ref="${at}" value="'d'"/>`
				: ""
		}`,
		body: one.inRepeat
			? `<group><repeat nodeset="/data/r">${control}</repeat></group>`
			: control,
	});
}

describe("a row read from a source written for it", () => {
	for (const { entry, facts: one } of CASES) {
		const row = fieldKindOf(one);
		it(`${entry.slice("questions/".length)} (${JSON.stringify(one)})`, async () => {
			const reading = await readForm(sourceOf(one), { mint: true });
			const xform = reading.xform;
			expect(xform).not.toBeNull();
			const field = readFields(xform ?? ({} as never)).find(
				(one) => one.id === "q",
			);
			expect(field?.id).toBe("q");
			const codes = codesAt(reading, one.inRepeat ? "r/q" : "q");
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
	it("reads a question named registration in any case as an answer only Android keeps, and refuses one named case", async () => {
		for (const name of ["registration", "Registration"]) {
			const reading = await readForm(
				xformSource({
					data: `<${name}/>`,
					model: `<bind nodeset="/data/${name}" type="xsd:string"/>`,
					body: `<input ref="/data/${name}"/>`,
				}),
			);
			const codes = codesAt(reading, name);
			expect(codes).not.toContain(Q("submitted-node-consumed-as-case"));
			expect(codes).not.toContain(
				Q("question-id-failing-the-grammar-or-meta-in-any-case"),
			);
			const [field] = readFields(reading.xform ?? ({} as never));
			expect(field?.standIn).toBe(false);
		}
		for (const name of ["case", "Case"]) {
			const reading = await readForm(
				xformSource({
					data: `<${name}/>`,
					model: `<bind nodeset="/data/${name}" type="xsd:string"/>`,
					body: `<input ref="/data/${name}"/>`,
				}),
			);
			expect(codesAt(reading, name)).toContain(
				Q("submitted-node-consumed-as-case"),
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
		const invalid = Q(
			"jr-imagedimensionscaledmax-that-is-not-an-integer-or-is-greater",
		);
		expect(await codesFor("500px")).toEqual([]);
		expect(await codesFor("+500")).toEqual([]);
		for (const [size, pixels] of [
			["500px", 500],
			["+731", 731],
			["2147483647", 2147483647],
			["-1px", undefined],
		] as const) {
			const reading = await readForm(
				xformSource({
					data: "<photo/>",
					model: '<bind nodeset="/data/photo" type="binary"/>',
					body: `<upload ref="/data/photo" mediatype="image/*" jr:imageDimensionScaledMax="${size}"/>`,
				}),
			);
			expect(reading.xform).toBeTruthy();
			if (reading.xform)
				expect(readFields(reading.xform)[0]?.field.maxDimension).toBe(pixels);
		}
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

describe("text on a question's data node", () => {
	it("is a default data value unless Java's trim empties it, so a no-break space is one", async () => {
		const reading = await readForm(
			xformSource({
				data: "<a>\u00a0</a><b> \t\n </b>",
				model:
					'<bind nodeset="/data/a" type="xsd:string"/><bind nodeset="/data/b" type="xsd:string"/>',
				body: '<input ref="/data/a"/><input ref="/data/b"/>',
			}),
		);
		expect(codesAt(reading, "a")).toContain(
			Q("default-data-value-datavalue-instance-text"),
		);
		expect(codesAt(reading, "b")).not.toContain(
			Q("default-data-value-datavalue-instance-text"),
		);
	});

	it("names an attachment's nonempty data value as a runtime refusal", async () => {
		const reading = await readForm(
			xformSource({
				data: "<photo>carry-forward.jpg</photo><report> \t\n </report>",
				model:
					'<bind nodeset="/data/photo" type="binary"/><bind nodeset="/data/report" type="binary"/>',
				body: '<upload ref="/data/photo" mediatype="image/*"/><upload ref="/data/report" mediatype="application/*,text/*"/>',
			}),
		);
		expect(codesAt(reading, "photo")).toEqual([
			Q("default-other-than-blank-on-a-capture-question"),
		]);
		expect(codesAt(reading, "report")).toEqual([]);
	});
});

describe("a question refused by its bind type", () => {
	it("names a bind type Vellum does not write on an input, and only that", async () => {
		const reading = await readForm(
			xformSource({
				data: "<a/>",
				model: '<bind nodeset="/data/a" type="xsd:gYear"/>',
				body: '<input ref="/data/a"/>',
			}),
		);
		expect(
			formFindings(reading)
				.filter(
					(finding) =>
						finding.code ===
						Q("input-whose-bind-type-vellum-does-not-write-xsd-decimal-xsd"),
				)
				.map((finding) => finding.detail.name),
		).toEqual(["xsd:gYear"]);
	});
});

describe("a select's choices", () => {
	it("refuses a choice's value without quoting it, and keeps one holding both quote marks", async () => {
		const reading = await readForm(
			xformSource({
				data: "<c/>",
				model: '<bind nodeset="/data/c" type="xsd:string"/>',
				body: `<select1 ref="/data/c"><item><label>A</label><value>a b</value></item><item><label>B</label><value>it's"x"</value></item></select1>`,
			}),
		);
		const refused = formFindings(reading).filter((finding) =>
			[
				Q("choice-value-with-whitespace-empty-or-duplicated"),
				Q("choice-value-holding-both-an-apostrophe-and-a-double-quote"),
			].includes(finding.code),
		);
		expect(refused.map((finding) => finding.code)).toEqual([
			Q("choice-value-with-whitespace-empty-or-duplicated"),
		]);
		expect(refused.map((finding) => finding.detail.name)).toEqual([undefined]);
	});

	it.each([
		["value", "name", "code"],
		["label", "title", "name"],
		["label and value", "title", "code"],
	])(
		"refuses an itemset whose %s ref names a column the lookup table lacks, once and with no defect",
		async (_case, labelRef, valueRef) => {
			const reading = await readForm(
				xformSource({
					data: "<city/>",
					model:
						'<instance id="cities" src="jr://fixture/item-list:cities"/><bind nodeset="/data/city" type="xsd:string"/>',
					body: `<select1 ref="/data/city"><itemset nodeset="instance('cities')/cities_list/cities[name != '']"><label ref="${labelRef}"/><value ref="${valueRef}"/></itemset></select1>`,
				}),
				{
					lookup: {
						table: (tag) =>
							tag === "cities"
								? {
										tableId: "table-cities" as LookupTableId,
										column: (name) =>
											name === "name"
												? ("column-name" as LookupColumnId)
												: undefined,
									}
								: undefined,
						definitions: new Map(),
					},
				},
			);
			// A device reads a blank label or value for every choice: the read of what is not there,
			// one finding at the question, the whole itemset (its filter included) behind it. The
			// declaration is the expression stage's to claim, which the whole reading below holds.
			expect(codesAt(reading, "city")).toEqual([
				"expressions-and-data/an-expression-core-cannot-evaluate-as-its-author-meant",
			]);
			expect(reading.closed.defects).toEqual([]);
		},
	);

	describe("a lookup select read whole, its table told", () => {
		const table = "01890000-0000-7000-8000-000000000301" as LookupTableId;
		const name = "01890000-0000-7000-8000-000000000302" as LookupColumnId;
		const column = {
			id: name,
			wireName: "district_name",
			label: "Name",
			dataType: "text" as const,
		};
		const rank = lookupMemberIdSchema.parse(
			"01890000-0000-7000-8000-000000000303",
		);
		const attributes = [{ id: rank, wireName: "rank", label: "Rank" }];
		const naming = lookupWireNaming([
			{ id: table, tag: "hq_districts", columns: [column], attributes },
		]);
		const lookupDoc = (sortColumnId?: LookupRead) =>
			buildDoc({
				modules: [
					{
						name: "Survey",
						forms: [
							{
								name: "Ask",
								type: "survey",
								fields: [
									f({
										kind: "single_select",
										id: "district",
										label: "District",
										optionsSource: {
											kind: "lookup",
											tableId: table,
											valueColumnId: name,
											labelColumnId: name,
											...(sortColumnId === undefined ? {} : { sortColumnId }),
										},
									} as FieldSpec),
								],
							},
						],
					},
				],
			});
		const doc = lookupDoc();
		async function read(
			xml?: (xml: string) => string,
			sourceOrTag: BlueprintDoc | string = doc,
		) {
			const source = typeof sourceOrTag === "string" ? doc : sourceOrTag;
			const tableTag =
				typeof sourceOrTag === "string" ? sourceOrTag : "hq_districts";
			const body = exportedBody(source, {
				expand: { lookupNaming: naming },
				...(xml === undefined ? {} : { xml }),
			});
			return readHqApp(
				await inputFor(body, {
					lookup: {
						table: (tag) =>
							tag === tableTag
								? {
										tableId: table,
										column: (wire) =>
											wire === "district_name" ? name : undefined,
										attribute: (wire) => (wire === "rank" ? rank : undefined),
									}
								: undefined,
						definitions: new Map([
							[
								table,
								{
									id: table,
									name: "Districts",
									tag: tableTag,
									columns: [column],
									attributes,
								},
							],
						]),
					},
				}),
				{ claims: "full" },
			);
		}

		it("reads Nova's own export with no finding", async () => {
			const outcome = await read();
			expect(outcome.kind === "account" ? outcome.findings : []).toEqual([]);
			expect(outcome.defects).toEqual([]);
		});

		it.each([
			[
				"its declared fixture",
				"jr://fixture/item-list:hq_districts",
				"(('hq_districts'))",
				true,
			],
			[
				"a selected-cases source",
				"jr://instance/selected-entities/item-list:hq_districts",
				"(('hq_districts'))",
				false,
			],
			[
				"a second argument",
				"jr://fixture/item-list:hq_districts",
				"('hq_districts'), 'extra'",
				false,
			],
		] as const)(
			"reads a grouped itemset ID with %s",
			async (_label, source, args, holds) => {
				const result = await read((xml) =>
					xml
						.replace(
							'src="jr://fixture/item-list:hq_districts"',
							`src="${source}"`,
						)
						.replace("instance(&apos;hq_districts&apos;)", `instance(${args})`),
				);
				expect(result.kind).toBe(holds ? "read" : "account");
				expect(result.defects).toEqual([]);
			},
		);

		it("reads a choice from the canonical fixture id HQ's build declares implicitly", async () => {
			const outcome = await read((xml) =>
				xml
					.replace(
						/<instance\b[^>]*\bsrc="jr:\/\/fixture\/item-list:hq_districts"[^>]*\/>/,
						"",
					)
					.replace(
						"instance(&apos;hq_districts&apos;)",
						"instance(&apos;item-list:hq_districts&apos;)",
					),
			);
			expect(outcome.kind === "account" ? outcome.findings : []).toEqual([]);
			expect(outcome.defects).toEqual([]);
		});

		it.each([true, false])(
			"keeps the dotted fixture only when the form declares it (%s)",
			async (declares) => {
				const readBack = await read((xml) => {
					const renamed = xml
						.replaceAll("hq_districts", "meeting.1")
						.replace(
							"instance(&apos;meeting.1&apos;)",
							"instance(&apos;item-list:meeting.1&apos;)",
						)
						.replace('id="meeting.1"', 'id="item-list:meeting.1"');
					return declares
						? renamed
						: renamed.replace(
								/<instance\b[^>]*\bsrc="jr:\/\/fixture\/item-list:meeting\.1"[^>]*\/>/,
								"",
							);
				}, "meeting.1");
				expect(readBack.defects).toEqual([]);
				expect(readBack.kind).toBe(declares ? "read" : "account");
				if (!declares && readBack.kind === "account")
					expect(readBack.findings.map((finding) => finding.code)).toContain(
						"questions/itemset-over-casedb-or-another-instance-advanced-data-source",
					);
			},
		);

		// The itemset is a read of the table: the read and the table's declaration stand under
		// Nova's typed lookup carrier, never as a declaration nothing reads.
		it("claims the table the itemset reads, and its declaration, under the typed lookup carrier", async () => {
			const outcome = await read();
			const records = [...outcome.claims.records()].filter((record) =>
				record.artifact.startsWith("form:"),
			);
			const carrier =
				"expressions-and-data/item-list-tag-read-through-nova-s-typed-lookup-carriers";
			expect(
				records
					.filter((record) => record.entry === carrier)
					.map((record) => [record.where, record.key]),
			).toEqual([
				[
					"/h:html/h:body[1]/select1[1]/itemset[1]/@nodeset",
					"instance-scheme:item-list",
				],
				// A declaration's source sits at its `src`, and its id is its own key's.
				[
					"/h:html/h:head[1]/model[1]/instance[2]/@id",
					"xform:model/instance@id",
				],
				[
					"/h:html/h:head[1]/model[1]/instance[2]/@src",
					"instance-source:fixture",
				],
			]);
			expect(
				records.some(
					(record) =>
						record.entry ===
						"expressions-and-data/declared-unreferenced-fixture-instance-item-list-locations-user",
				),
			).toBe(false);
		});

		it.each([
			['<value ref="district_name"/>', '<value ref="district_code"/>'],
			['<label ref="district_name"/>', '<label ref="district_title"/>'],
		])(
			"refuses %s named as a column the table lacks, one finding and no defect",
			async (from, to) => {
				const outcome = await read((xml) => {
					expect(xml).toContain(from);
					return xml.replace(from, to);
				});
				expect(outcome.kind).toBe("account");
				expect(
					(outcome.kind === "account" ? outcome.findings : []).map(
						(finding) => [
							finding.code,
							finding.place.kind,
							finding.detail.reason,
						],
					),
				).toEqual([
					[
						"expressions-and-data/an-expression-core-cannot-evaluate-as-its-author-meant",
						"question",
						// The form parser's reason for a column a table lacks, which tells a read of the
						// Project's data that is not there from Nova's own refusal.
						"parse:unknown-column",
					],
				]);
				expect(outcome.defects).toEqual([]);
			},
		);

		/** The district question's choice source in a reading that holds it. */
		function districtSource(outcome: Awaited<ReturnType<typeof read>>) {
			if (outcome.kind !== "read")
				throw new Error(
					`The reading refused: ${JSON.stringify(outcome.findings)}`,
				);
			const field = Object.values(outcome.draft.doc.fields).find(
				(candidate) => candidate.id === "district",
			);
			return field !== undefined && "optionsSource" in field
				? field.optionsSource
				: undefined;
		}

		// Core orders the choices by the sort ref's text (`ItemsetBinding.sortChoices`), and
		// HQ's form builder writes the element after the value (Vellum `itemset.js`).
		it("writes a sort column as the itemset's sort and reads it back", async () => {
			const sorted = lookupDoc(name);
			let written = "";
			const outcome = await read((xml) => {
				written = xml;
				return xml;
			}, sorted);
			expect(written).toContain(
				'<value ref="district_name"/><sort ref="district_name"/>',
			);
			expect(outcome.defects).toEqual([]);
			expect(districtSource(outcome)).toEqual({
				kind: "lookup",
				tableId: table,
				valueColumnId: name,
				labelColumnId: name,
				sortColumnId: name,
			});
			const claimed = [...outcome.claims.records()]
				.filter((record) => record.entry === "questions/itemset-sort-ref")
				.map((record) => record.where);
			expect(claimed).toEqual([
				"/h:html/h:body[1]/select1[1]/itemset[1]/sort[1]",
				"/h:html/h:body[1]/select1[1]/itemset[1]/sort[1]/@ref",
			]);
		});

		it("reads a row attribute sort through the same relative reference as Core", async () => {
			const sorted = lookupDoc({ attributeId: rank });
			let written = "";
			const outcome = await read((xml) => {
				written = xml;
				return xml;
			}, sorted);
			expect(written).toContain('<sort ref="@rank"/>');
			expect(outcome.defects).toEqual([]);
			expect(districtSource(outcome)).toMatchObject({
				sortColumnId: { attributeId: rank },
			});
		});

		it("reads a sort HQ's form builder wrote, and an unsorted itemset as table order", async () => {
			const from = '<value ref="district_name"/>';
			const outcome = await read((xml) =>
				xml.replace(from, `${from}\n<sort ref="district_name" />`),
			);
			expect(districtSource(outcome)).toMatchObject({ sortColumnId: name });
			expect(districtSource(await read())).not.toHaveProperty("sortColumnId");
		});

		it.each([
			[
				"a column the table lacks",
				'<sort ref="district_code"/>',
				"expressions-and-data/an-expression-core-cannot-evaluate-as-its-author-meant",
			],
			[
				"a path that is no column",
				'<sort ref="../district_name"/>',
				"questions/lookup-choice-reference-the-form-editor-cannot-keep",
			],
			[
				"two sorts",
				'<sort ref="district_name"/><sort ref="district_name"/>',
				"questions/itemset-over-casedb-or-another-instance-advanced-data-source",
			],
		])(
			"refuses a sort naming %s once, the select read whole with no defect",
			async (_case, sort, code) => {
				const from = '<value ref="district_name"/>';
				const outcome = await read((xml) =>
					xml.replace(from, `${from}${sort}`),
				);
				expect(
					(outcome.kind === "account" ? outcome.findings : []).map(
						(finding) => [finding.code, finding.place.kind],
					),
				).toEqual([[code, "question"]]);
				expect(outcome.defects).toEqual([]);
			},
		);
	});
});

describe("a select whose choices are the worker's cases, read whole", () => {
	/** The findings a whole reading of a document of one such select leaves at its question. */
	async function questionFindings(
		filter: string | undefined,
		options: {
			readonly allCases?: true;
			readonly labelProperty?: string;
			readonly sortProperty?: string;
			readonly xml?: (xml: string) => string;
		} = {},
	) {
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
									optionsSource: options.allCases
										? { kind: "available-cases" }
										: {
												kind: "cases",
												caseType: "clinic",
												labelProperty: options.labelProperty ?? "case_name",
												...(options.sortProperty !== undefined && {
													sortProperty: options.sortProperty,
												}),
												...(filter === undefined ? {} : { filter }),
											},
								} as FieldSpec),
							],
						},
					],
				},
			],
		});
		const outcome = readHqApp(
			await inputFor(
				exportedBody(
					doc,
					options.xml === undefined ? {} : { xml: options.xml },
				),
			),
		);
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

	it("keeps all available cases as an unfiltered source with exact name and ID", async () => {
		const { atQuestion, outcome } = await questionFindings(undefined, {
			allCases: true,
			xml: (xml) => {
				expect(xml).toContain(
					`nodeset="instance(&apos;casedb&apos;)/casedb/case"`,
				);
				expect(xml).toContain('<label ref="case_name"/>');
				expect(xml).toContain('<value ref="@case_id"/>');
				return xml;
			},
		});
		expect(atQuestion).toEqual([]);
		expect(outcome.kind).toBe("read");
		if (outcome.kind !== "read") throw new Error("Expected a read form.");
		const field = Object.values(outcome.draft.doc.fields).find(
			(one) => one.id === "clinic",
		);
		expect(field).toMatchObject({ optionsSource: { kind: "available-cases" } });
	});

	it("refuses a custom label over untyped cases", async () => {
		const { atQuestion } = await questionFindings(undefined, {
			allCases: true,
			xml: (xml) =>
				xml.replace('<label ref="case_name"/>', '<label ref="region"/>'),
		});
		expect(atQuestion).toEqual([
			`${Q("itemset-over-casedb-or-another-instance-advanced-data-source")} `,
		]);
	});

	it("refuses the raw unfiltered source when the control saves several values", async () => {
		const { atQuestion } = await questionFindings(undefined, {
			allCases: true,
			xml: (xml) =>
				xml.replace("<select1 ", "<select ").replace("</select1>", "</select>"),
		});
		expect(atQuestion).toEqual([
			`${Q("itemset-over-casedb-or-another-instance-advanced-data-source")} `,
		]);
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

	it("holds a label Nova writes as a child step, and refuses one that reads the attribute of that name", async () => {
		const held = await questionFindings(undefined, { labelProperty: "region" });
		expect(held.atQuestion).toEqual([]);
		const label = '<label ref="region"/>';
		const attribute = await questionFindings(undefined, {
			labelProperty: "region",
			xml: (xml) => {
				expect(xml).toContain(label);
				return xml.replace(label, '<label ref="@region"/>');
			},
		});
		expect(attribute.atQuestion).toEqual([
			`${Q("itemset-over-casedb-or-another-instance-advanced-data-source")} `,
		]);
	});

	// Core keeps the last `label` and the last `value` an itemset holds
	// (`XFormParser.parseItemset`, `ItemSetParsingUtils.setLabel` and `setValue`), so a held
	// itemset claims the two its reading read and no other: the case's `dob` shown and its
	// `external_id` stored would otherwise read as its name shown and its id stored.
	it("holds a typed case sort and refuses a different kind of node with the same name", async () => {
		const sort = '<sort ref="region"/>';
		const held = await questionFindings("region = 'north'", {
			sortProperty: "region",
			xml: (xml) => {
				expect(xml).toContain(sort);
				return xml;
			},
		});
		expect(held.outcome.kind).toBe("read");
		expect(held.outcome.claims.counts[Q("itemset-sort-ref")]).toBeGreaterThan(
			0,
		);
		const refused = await questionFindings(undefined, {
			sortProperty: "region",
			xml: (xml) => xml.replace(sort, '<sort ref="@region"/>'),
		});
		expect(refused.atQuestion).toEqual([
			`${Q("itemset-over-casedb-or-another-instance-advanced-data-source")} `,
		]);
	});

	it("leaves a second label and value of a case choices itemset unclaimed", async () => {
		const value = '<value ref="@case_id"/>';
		const { atQuestion, outcome } = await questionFindings(undefined, {
			xml: (xml) => {
				expect(xml).toContain(value);
				return xml.replace(
					value,
					`${value}<label ref="dob"/><value ref="external_id"/>`,
				);
			},
		});
		expect(outcome.kind).toBe("account");
		expect(atQuestion).toEqual(
			expect.arrayContaining([expect.stringMatching(/^unrecognized /)]),
		);
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
const formReaderKinds = fieldKinds.filter((kind) => kind !== "case_change");
const EMITTED: {
	readonly [K in Exclude<FieldKind, "case_change">]: readonly KindFixture[];
} = {
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
	connect_activity: [
		{
			fields: [
				f({
					kind: "connect_activity",
					id: "call",
					activity: {
						kind: "assigned-task",
						name: "Call",
						description: "Ring the household",
					},
				}),
			],
			read: [{ id: "call", kind: "connect_activity" }],
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
		// The assigned task among the kinds needs its role.
		connectRoles: ["deliver"],
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
	it("exhibits every kind the form reader binds before case management", () => {
		for (const kind of formReaderKinds) {
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
		const together = formReaderKinds
			.filter((kind) => kind !== "section")
			.flatMap((kind) => EMITTED[kind]);
		const { shapes, standIns } = await emittedAndRead(
			together.flatMap((fixture) => fixture.fields),
		);
		expect(shapes).toEqual(together.flatMap((fixture) => fixture.read));
		expect(standIns).toEqual([]);
	});

	it("attaches the positioned case-change field to its own case operation", async () => {
		const doc = hydratePersistedBlueprint(
			blueprintDocSchema.parse(positionedCaseCreate().doc),
		);
		const read = readHqApp(await inputFor(exportedBody(doc)));
		expect(read.defects).toEqual([]);
		if (read.kind !== "read") throw new Error(JSON.stringify(read.findings));
		const { forms, fields, fieldOrder } = read.draft.doc;
		const [form] = Object.values(forms);
		const ordered = fieldOrder[form.uuid].map((uuid) => fields[uuid]);
		expect(ordered.map((field) => field.id)).toEqual([
			"visit_name",
			"save_visit",
			"notes",
		]);
		expect(ordered[1]).toMatchObject({
			kind: "case_change",
			operationUuid: form.caseOperations?.[0].uuid,
		});
		expect(form.caseOperations?.[0].action).toBe("create");
	});

	it("reads a form of root Question Lists as sections", async () => {
		for (const fixture of EMITTED.section) {
			const { shapes, standIns } = await emittedAndRead(fixture.fields);
			expect(shapes).toEqual(fixture.read);
			expect(standIns).toEqual([]);
		}
	});
});
