/**
 * Contract: each top-level conjunct of each `_xpath_query` row Nova's emission writes
 * (`composeXPathQueryEmission`, through `expandDoc`) is placed by `classifySearchRows` where that
 * emission writes it back from: Nova's zero-input row (A), a restated clause of the case list
 * filter (B), a simple Search field's derivation (C), a condition that reads Search fields, on an
 * excluded field or as a list filter clause that waits for a field (D), a filter of the search's
 * own on a menu whose forms read the search (F), or a finding (E). A row that holds two conjuncts
 * gives each its own place. On a menu whose forms do not read the search, a list filter clause
 * the search does not restate raises, and so does a conjunct with no field; on one whose forms
 * read it, the first is held with `search-restates-list-filter` and the second joins the list
 * filter with `search-filter-joined-to-list`, unless an advanced load names the menu. A conjunct
 * that reads a bare prompt outside its guard raises. Rows in another order read equal and record
 * the reorder.
 *
 * The failure it catches: a derivation read as an authored condition; a filter that starts
 * narrowing a search; Nova's own filter read back as a field's condition, which breaks the fixed
 * point.
 */
import { produce } from "immer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type {
	BlueprintDoc,
	CasePropertyDataType,
	SearchInputDef,
	Uuid,
} from "@/lib/domain";
import { effectiveCaseTypes } from "@/lib/domain/effectiveCaseTypes";
import {
	and,
	dateLiteral,
	eq,
	gt,
	input,
	literal,
	multiSelectAll,
	neq,
	now,
	prop,
	whenInput,
} from "@/lib/domain/expression/builders";
import type { Expression } from "@/lib/domain/expression/types";
import {
	type CaseListConfig,
	plainColumn,
	type SimpleSearchInputDef,
} from "@/lib/domain/modules";
import { proseText } from "@/lib/domain/prose";
import { emitCsql } from "../../../csql/emitter";
import { moduleExpressionContexts } from "../../../expressionContext";
import { deriveSimpleArmPredicate } from "../../../suite/case-search/simpleArmDerivation";
import { serializeWire } from "../../../xpath/wire/serialize";
import { patients, uuid } from "../../caseList/__tests__/fixtures";
import {
	type AppJson,
	codes,
	emittedApp,
	listOf,
	readLists,
} from "../../caseList/__tests__/listReading";
import {
	type ConjunctPlacement,
	derivedConditionsAreSimpleFields,
	type RowClassification,
} from "../rows";

/** Every classification the reading's settle made, in the order it made them. */
const recorded = vi.hoisted(() => ({ classifications: [] as unknown[] }));

vi.mock(import("../rows"), async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...actual,
		classifySearchRows: (
			...args: Parameters<typeof actual.classifySearchRows>
		) => {
			const out = actual.classifySearchRows(...args);
			recorded.classifications.push(out);
			return out;
		},
	};
});

beforeEach(() => {
	recorded.classifications.length = 0;
});

/** The last classification the settle made: the rows of the last searching menu. */
function classified(): RowClassification {
	const last = recorded.classifications.at(-1);
	if (last === undefined) throw new Error("The settle classified no rows.");
	return last as RowClassification;
}

/** Each conjunct's placement, by row and its place in the row. */
function placements(): ConjunctPlacement[] {
	return classified().conjuncts.map((one) => one.placement);
}

const notesIs = (value: string) => eq(prop("patient", "notes"), literal(value));

/** `doc` with a catalog that types each named property of `patient`. */
function typed(
	doc: BlueprintDoc,
	types: Record<string, CasePropertyDataType>,
): BlueprintDoc {
	return produce(doc, (draft) => {
		draft.caseTypes = [
			{
				name: "patient",
				properties: Object.entries(types).map(([name, data_type]) => ({
					name,
					label: proseText(name),
					data_type,
				})),
			},
		];
	});
}

function rowsOf(app: AppJson, module = 0): Record<string, unknown>[] {
	return app.modules[module]?.search_config.default_properties as Record<
		string,
		unknown
	>[];
}

function registers(reading: Awaited<ReturnType<typeof readLists>>): string[] {
	return reading.ctx.facts.sameStateRewrites.map((one) => one.register);
}

/**
 * `value` with each Search field identity the reading minted
 * (`externalKey.searchInput`) replaced by the authored one of the same name,
 * so a reading compares with the document it was emitted from.
 */
function authored<T>(
	value: T,
	reading: Awaited<ReturnType<typeof readLists>>,
	inputs: readonly SearchInputDef[],
	module = 0,
): T {
	let text = JSON.stringify(value);
	for (const read of listOf(reading, module).searchInputs) {
		const own = inputs.find((one) => one.name === read.name);
		if (own !== undefined) text = text.split(read.uuid).join(own.uuid);
	}
	return JSON.parse(text) as T;
}

/** One `_xpath_query` row holding `predicate` whole, printed by Nova's CSQL emitter in the case
 *  list filter's context: the row a person writes where Nova writes one row per conjunct. */
function oneRow(doc: BlueprintDoc, predicate: Expression): string {
	const moduleUuid = doc.moduleOrder[0] as Uuid;
	const context = moduleExpressionContexts(
		doc,
		moduleUuid,
	)({ slot: "case_list_filter" });
	const { wrapper } = emitCsql(predicate, {
		types: context,
		bindings: { searchInputInstanceId: "search-input:results" },
	});
	return serializeWire(wrapper, { target: "hq-json", interpolation: "none" })
		.text;
}

const PHONE = uuid(9);
const BORN = uuid(10);
const NUMBER = uuid(11);

/** A text field HQ's own matcher compares: no `exclude`, no row of its own. */
const bare: SearchInputDef = {
	uuid: PHONE,
	name: "phone",
	label: "Phone",
	kind: "simple",
	type: "text",
	property: "phone",
};

/** A date field, whose whole-day match Nova writes as a row and the prompt excluded. */
const born: SearchInputDef = {
	uuid: BORN,
	name: "dob",
	label: "Born",
	kind: "simple",
	type: "date",
	property: "dob",
};

/** A condition on the field `field`: the notes differ from what the worker typed. */
const notesDiffer = (field: Uuid) =>
	whenInput(input(field), neq(prop("patient", "notes"), input(field)));

/** An advanced field whose condition reads its own answer. */
const number: SearchInputDef = {
	uuid: NUMBER,
	name: "number",
	label: "Number",
	kind: "advanced",
	type: "text",
	predicate: whenInput(
		input(NUMBER),
		neq(prop("patient", "phone"), input(NUMBER)),
	),
};

/** One menu of patients whose registration saves a date of birth from a date question and a
 *  moment it was seen from the clock, searched by `searchInputs`. */
function withSeen(searchInputs: SearchInputDef[]): BlueprintDoc {
	return buildDoc({
		// Declared with no type: the writers type each.
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "dob", label: proseText("dob") },
					{ name: "seen", label: proseText("seen") },
				],
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				forms: [
					{
						name: "Register",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "name",
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
							f({
								kind: "date",
								id: "dob",
								caseWrite: { caseType: "patient", property: "dob" },
							}),
							f({
								kind: "hidden",
								id: "seen",
								calculate: now(),
								caseWrite: { caseType: "patient", property: "seen" },
							}),
						],
					},
				],
				caseListConfig: {
					columns: [plainColumn(uuid(1), "case_name", "Name")],
					searchInputs,
				},
				caseSearchConfig: {},
			},
		],
	});
}

function oneOfEach(): BlueprintDoc {
	return typed(
		patients([plainColumn(uuid(1), "case_name", "Name")], {
			searchInputs: [bare, born, number],
			search: {},
			list: { filter: and(notesIs("open"), notesDiffer(PHONE)) },
		}),
		{ dob: "date" },
	);
}

describe("the kinds of the conjuncts of `_xpath_query`", () => {
	it("places each conjunct Nova writes where Nova wrote it from, and reads the list back equal", async () => {
		const doc = oneOfEach();
		const inputs = [bare, born, number];
		const reading = await readLists(doc);
		expect(codes(reading)).toEqual([]);
		expect(authored(placements(), reading, inputs)).toEqual([
			{ kind: "B", clause: 0 },
			{ kind: "D", from: "filter" },
			{ kind: "D", from: "field", input: NUMBER },
			{ kind: "C", input: BORN, property: "dob" },
		]);
		expect(classified().unrestated).toEqual([]);
		const read = listOf(reading);
		// The clause that waits for the bare field is back in the filter, never on a field.
		expect(authored(read.filter, reading, inputs)).toEqual(
			and(notesIs("open"), notesDiffer(PHONE)),
		);
		expect(authored(read.searchInputs, reading, inputs)).toEqual(inputs);
		expect(registers(reading)).not.toContain("search-filter-rows-recut");
	});

	it("places Nova's zero-input row as kind A", async () => {
		const reading = await readLists(
			patients([plainColumn(uuid(1), "case_name", "Name")], { search: {} }),
		);
		expect(codes(reading)).toEqual([]);
		expect(placements()).toEqual([{ kind: "A" }]);
		expect(listOf(reading).filter).toBeUndefined();
		expect(listOf(reading).searchInputs).toEqual([]);
	});

	it("reads a condition that waits for a field from the slot Nova wrote it from", async () => {
		// The same condition, once a list filter clause waiting for a bare field and once an
		// excluded field's own condition: each reads back where it was.
		const asFilter = await readLists(
			patients([plainColumn(uuid(1), "case_name", "Name")], {
				searchInputs: [bare],
				search: {},
				list: { filter: notesDiffer(PHONE) },
			}),
		);
		expect(codes(asFilter)).toEqual([]);
		expect(placements()).toEqual([{ kind: "D", from: "filter" }]);
		expect(authored(listOf(asFilter).filter, asFilter, [bare])).toEqual(
			notesDiffer(PHONE),
		);
		expect(authored(listOf(asFilter).searchInputs, asFilter, [bare])).toEqual([
			bare,
		]);

		const onField: SearchInputDef = {
			uuid: PHONE,
			name: "phone",
			label: "Phone",
			kind: "advanced",
			type: "text",
			predicate: notesDiffer(PHONE),
		};
		const asField = await readLists(
			patients([plainColumn(uuid(1), "case_name", "Name")], {
				searchInputs: [onField],
				search: {},
			}),
		);
		expect(codes(asField)).toEqual([]);
		expect(authored(placements(), asField, [onField])).toEqual([
			{ kind: "D", from: "field", input: PHONE },
		]);
		expect(listOf(asField).filter).toBeUndefined();
		expect(authored(listOf(asField).searchInputs, asField, [onField])).toEqual([
			onField,
		]);
	});

	it("reads a list clause that waits for an excluded field with no condition of its own back into the list filter", async () => {
		// The clause is stored before another field's condition, which Nova writes after the list
		// filter's rows: read as the excluded field's condition it would come out behind that row.
		const plainExcluded: SearchInputDef = {
			uuid: PHONE,
			name: "phone",
			label: "Phone",
			kind: "advanced",
			type: "text",
			predicate: { kind: "match-all" },
		};
		const inputs = [number, plainExcluded];
		const reading = await readLists(
			patients([plainColumn(uuid(1), "case_name", "Name")], {
				searchInputs: inputs,
				search: {},
				list: { filter: and(notesIs("open"), notesDiffer(PHONE)) },
			}),
		);
		expect(codes(reading)).toEqual([]);
		expect(authored(placements(), reading, inputs)).toEqual([
			{ kind: "B", clause: 0 },
			{ kind: "D", from: "filter" },
			{ kind: "D", from: "field", input: NUMBER },
		]);
		expect(authored(listOf(reading).filter, reading, inputs)).toEqual(
			and(notesIs("open"), notesDiffer(PHONE)),
		);
		expect(authored(listOf(reading).searchInputs, reading, inputs)).toEqual(
			inputs,
		);
		expect(registers(reading)).not.toContain("search-filter-rows-recut");
	});

	it("reads a list clause shaped as a field's derivation back into the list filter, in its place", async () => {
		// The first clause is what a simple field over `phone` derives; Nova writes a derivation
		// after the list filter's rows and the fields' conditions, so read as one, or as the
		// field's own condition, it would come out behind the second clause and `number`'s row.
		const plainExcluded: SearchInputDef = {
			uuid: PHONE,
			name: "phone",
			label: "Phone",
			kind: "advanced",
			type: "text",
			predicate: { kind: "match-all" },
		};
		const filter = and(
			whenInput(input(PHONE), eq(prop("patient", "phone"), input(PHONE))),
			notesDiffer(PHONE),
		);
		const inputs = [number, plainExcluded];
		const reading = await readLists(
			patients([plainColumn(uuid(1), "case_name", "Name")], {
				searchInputs: inputs,
				search: {},
				list: { filter },
			}),
		);
		expect(codes(reading)).toEqual([]);
		expect(authored(placements(), reading, inputs)).toEqual([
			{ kind: "D", from: "filter" },
			{ kind: "D", from: "filter" },
			{ kind: "D", from: "field", input: NUMBER },
		]);
		expect(authored(listOf(reading).filter, reading, inputs)).toEqual(filter);
		expect(authored(listOf(reading).searchInputs, reading, inputs)).toEqual(
			inputs,
		);
		expect(registers(reading)).not.toContain("search-filter-rows-recut");
	});

	it("declares the type a row compares an untyped property with before it binds", async () => {
		// Only the catalog types `last_seen`, which HQ keeps no type of; the field's condition
		// compares it with a date and time, which Nova prints as the moment's two bounds.
		const SEEN = uuid(12);
		const since: SearchInputDef = {
			uuid: SEEN,
			name: "since",
			label: "Since",
			kind: "advanced",
			type: "date",
			predicate: whenInput(
				input(SEEN),
				eq(prop("patient", "last_seen"), {
					kind: "datetime-coerce",
					value: {
						kind: "term",
						term: { kind: "input", searchInputUuid: SEEN },
					},
				} as Expression),
			),
		};
		const doc = produce(
			patients([plainColumn(uuid(1), "case_name", "Name")], {
				searchInputs: [since],
				search: {},
			}),
			(draft) => {
				draft.caseTypes = [
					{
						name: "patient",
						properties: [
							{
								name: "last_seen",
								label: proseText("last_seen"),
								data_type: "datetime",
							},
						],
					},
				];
			},
		);
		const reading = await readLists(doc);
		expect(codes(reading)).toEqual([]);
		expect(authored(placements(), reading, [since])).toEqual([
			{ kind: "D", from: "field", input: SEEN },
		]);
		expect(
			effectiveCaseTypes(reading.ctx.doc as BlueprintDoc)
				.find((type) => type.name === "patient")
				?.properties.find((one) => one.name === "last_seen")?.data_type,
		).toBe("datetime");
	});

	it("gives each conjunct of a row `c_list and c_field` its own place", async () => {
		// A field Nova matches by its own row: a phone number that starts with what was typed.
		const field: SearchInputDef = {
			...bare,
			mode: { kind: "starts-with" },
		};
		const doc = patients([plainColumn(uuid(1), "case_name", "Name")], {
			searchInputs: [field],
			search: {},
			list: { filter: notesIs("open") },
		});
		// Nova writes the list's clause and the field's match as two rows; the source holds both in
		// one.
		expect(rowsOf(await emittedApp(doc))).toHaveLength(2);
		const filterContext = moduleExpressionContexts(
			doc,
			doc.moduleOrder[0] as Uuid,
		)({ slot: "case_list_filter" });
		const joined = oneRow(
			doc,
			and(
				notesIs("open"),
				deriveSimpleArmPredicate(
					field as SimpleSearchInputDef,
					"patient",
					filterContext,
				),
			),
		);
		const reading = await readLists(doc, {
			edit: (app) => {
				rowsOf(app).splice(0, Number.POSITIVE_INFINITY, {
					property: "_xpath_query",
					defaultValue: joined,
				});
			},
		});
		expect(codes(reading)).toEqual([]);
		expect(authored(placements(), reading, [field])).toEqual([
			{ kind: "B", clause: 0 },
			{
				kind: "C",
				input: PHONE,
				property: "phone",
				mode: { kind: "starts-with" },
			},
		]);
		expect(listOf(reading).filter).toEqual(notesIs("open"));
		expect(authored(listOf(reading).searchInputs, reading, [field])).toEqual([
			field,
		]);
		expect(registers(reading)).toContain("search-filter-rows-recut");
	});

	it("reads an excluded field whose condition is a simple field's derivation as that simple field", async () => {
		const condition = whenInput(
			input(uuid(9)),
			eq(prop("patient", "phone"), input(uuid(9))),
		);
		const field: SearchInputDef = {
			uuid: uuid(9),
			name: "number",
			label: "Number",
			kind: "advanced",
			type: "text",
			predicate: condition,
		};
		const doc = patients([plainColumn(uuid(1), "case_name", "Name")], {
			searchInputs: [field],
			search: {},
		});
		const reading = await readLists(doc);
		expect(codes(reading)).toEqual([]);
		expect(authored(placements(), reading, [field])).toEqual([
			{ kind: "C", input: uuid(9), property: "phone" },
		]);
		// The reading mints its own identities; every other key is the canonical member's.
		const withoutUuid = (inputs: readonly SearchInputDef[] | undefined) =>
			(inputs ?? []).map(({ uuid: _uuid, ...rest }) => rest);
		const canonical = derivedConditionsAreSimpleFields(doc);
		expect(withoutUuid(listOf(reading).searchInputs)).toEqual(
			withoutUuid(
				Object.values(canonical.modules)[0]?.caseListConfig?.searchInputs,
			),
		);
		expect(listOf(reading).searchInputs[0]).toMatchObject({
			kind: "simple",
			property: "phone",
		});
	});

	// A date question types `dob` a date; a Hidden Value calculated from the clock types `seen` a
	// date and time.
	for (const [property, dataType] of [
		["dob", "date"],
		["seen", "datetime"],
	] as const)
		it(`reads a date field over a property typed ${dataType} as the simple field`, async () => {
			const field: SearchInputDef = {
				uuid: BORN,
				name: property,
				label: "When",
				kind: "simple",
				type: "date",
				property,
			};
			const reading = await readLists(withSeen([field]));
			expect(codes(reading)).toEqual([]);
			expect(authored(placements(), reading, [field])).toEqual([
				{ kind: "C", input: BORN, property },
			]);
			expect(authored(listOf(reading).searchInputs, reading, [field])).toEqual([
				field,
			]);
			expect(
				effectiveCaseTypes(reading.ctx.doc as BlueprintDoc)
					.find((type) => type.name === "patient")
					?.properties.find((one) => one.name === property)?.data_type,
			).toBe(dataType);
		});

	// No writer types `seen`: the catalog's own declaration does, and the reading declares it again
	// before the rows bind.
	for (const [type, dataType] of [
		["date", "date"],
		["date", "datetime"],
		["date-range", "date"],
	] as const)
		it(`reads a ${type} field over a property only the catalog declares ${dataType}`, async () => {
			const field = {
				uuid: BORN,
				name: "seen",
				label: "Seen",
				kind: "simple",
				type,
				property: "seen",
				...(type === "date-range" && { mode: { kind: "range" } }),
			} as SearchInputDef;
			// A date range field is HQ's own match and writes no row: a list filter that orders the
			// property against a day reads it instead, restated by the search.
			const filter =
				type === "date-range"
					? gt(prop("patient", "seen"), dateLiteral("2026-01-01"))
					: undefined;
			const reading = await readLists(
				typed(
					patients([plainColumn(uuid(1), "case_name", "Name")], {
						searchInputs: [field],
						search: {},
						...(filter !== undefined && { list: { filter } }),
					}),
					{ seen: dataType },
				),
			);
			expect(codes(reading)).toEqual([]);
			expect(authored(placements(), reading, [field])).toEqual([
				type === "date-range"
					? { kind: "B", clause: 0 }
					: { kind: "C", input: BORN, property: "seen" },
			]);
			expect(authored(listOf(reading).searchInputs, reading, [field])).toEqual([
				field,
			]);
			expect(listOf(reading).filter).toEqual(filter);
			expect(
				effectiveCaseTypes(reading.ctx.doc as BlueprintDoc)
					.find((one) => one.name === "patient")
					?.properties.find((one) => one.name === "seen")?.data_type,
			).toBe(dataType);
		});

	it("raises a conjunct that reads a bare prompt outside its guard", async () => {
		// Nova never writes it (`composeXPathQueryEmission` refuses a read outside its guard); a
		// person can, in a row of their own.
		const doc = patients([plainColumn(uuid(1), "case_name", "Name")], {
			searchInputs: [bare],
			search: {},
		});
		const unguarded = oneRow(doc, neq(prop("patient", "notes"), input(PHONE)));
		const reading = await readLists(doc, {
			edit: (app) => {
				rowsOf(app).push({ property: "_xpath_query", defaultValue: unguarded });
			},
		});
		expect(codes(reading)).toContain(
			"case-search/xpath-query-row-reading-a-field-hq-also-matches",
		);
		expect(placements()).toEqual([
			{
				kind: "E",
				entry: "case-search/xpath-query-row-reading-a-field-hq-also-matches",
			},
		]);
	});

	it("reads rows in another order as the same rows, and records the reorder", async () => {
		const field: SearchInputDef = { ...number, predicate: notesDiffer(NUMBER) };
		const doc = patients([plainColumn(uuid(1), "case_name", "Name")], {
			searchInputs: [field],
			search: {},
			list: { filter: notesIs("open") },
		});
		const reading = await readLists(doc, {
			edit: (app) => {
				rowsOf(app).reverse();
			},
		});
		expect(codes(reading)).toEqual([]);
		expect(listOf(reading).filter).toEqual(notesIs("open"));
		expect(registers(reading)).toContain("search-filter-rows-recut");
	});
});

// A choice list tested for every value prints on a device as one `selected` per value, joined by
// `and`, which the device's filter splits into as many top-level clauses, while the search's row
// holds the one test. The failure it catches: the clauses read as restated by no row (the finding
// `case-list-filter-clause-the-search-does-not-restate` on Nova's own export), or one clause read
// as restating the row because the unchanged filter writes it.
describe("a list filter clause the device prints as several", () => {
	const tagsAll = (...values: [string, ...string[]]) =>
		multiSelectAll(
			prop("patient", "tags"),
			literal(values[0]),
			...values.slice(1).map((value) => literal(value)),
		);
	const tagged = (filter: Expression) =>
		buildDoc({
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [
						{
							name: "Register",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "name",
									caseWrite: { caseType: "patient", property: "case_name" },
								}),
								f({
									kind: "multi_select",
									id: "tags",
									optionsSource: {
										kind: "inline",
										options: ["a", "b", "c"].map((value, index) => ({
											value,
											label: proseText(value.toUpperCase()),
											uuid: uuid(40 + index),
										})),
									},
									caseWrite: { caseType: "patient", property: "tags" },
								}),
							],
						},
					],
					caseListConfig: {
						columns: [plainColumn(uuid(1), "case_name", "Name")],
						searchInputs: [],
						filter,
					},
					caseSearchConfig: {},
				},
			],
		});

	for (const [name, filter, runs] of [
		["two values", tagsAll("a", "b"), [{ kind: "B", clause: 0 }]],
		["three values", tagsAll("a", "b", "c"), [{ kind: "B", clause: 0 }]],
		[
			"two values after another clause",
			and(eq(prop("patient", "case_name"), literal("x")), tagsAll("a", "b")),
			[
				{ kind: "B", clause: 0 },
				{ kind: "B", clause: 1 },
			],
		],
	] as const)
		it(`restates the run of clauses one row holds: ${name}`, async () => {
			const reading = await readLists(tagged(filter));
			expect(codes(reading)).toEqual([]);
			expect(placements()).toEqual(runs);
			expect(classified().unrestated).toEqual([]);
			expect(listOf(reading).filter).toEqual(filter);
		});
});

describe("a menu whose forms do not read the search", () => {
	const doc = () =>
		patients([plainColumn(uuid(1), "case_name", "Name")], {
			searchInputs: [bare],
			search: {},
			list: { filter: notesIs("open") },
		});

	it("raises a list filter clause the search does not restate", async () => {
		const reading = await readLists(doc(), {
			edit: (app) => {
				rowsOf(app).splice(0);
			},
		});
		expect(codes(reading)).toContain(
			"case-search/case-list-filter-clause-the-search-does-not-restate",
		);
	});

	it("gives each row of fields whose conditions read no field its own field", async () => {
		const rule = (at: number, name: string, value: string): SearchInputDef => ({
			uuid: uuid(at),
			name,
			label: name,
			kind: "advanced",
			type: "text",
			predicate: notesIs(value),
		});
		const inputs = [
			rule(20, "open", "open"),
			rule(21, "held", "held"),
			rule(22, "late", "late"),
		];
		const reading = await readLists(
			patients([plainColumn(uuid(1), "case_name", "Name")], {
				searchInputs: inputs,
				search: {},
			}),
		);
		expect(codes(reading)).toEqual([]);
		expect(authored(placements(), reading, inputs)).toEqual(
			inputs.map((one) => ({ kind: "D", from: "field", input: one.uuid })),
		);
		expect(authored(listOf(reading).searchInputs, reading, inputs)).toEqual(
			inputs,
		);
	});

	it("raises a conjunct that reads no field and restates no list clause", async () => {
		const reading = await readLists(doc(), {
			edit: (app) => {
				const rows = rowsOf(app);
				const first = rows[0];
				// A row's value is an XPath whose value is the CSQL text, as Nova writes `"notes = 'open'"`.
				if (first !== undefined)
					rows.push({ ...first, defaultValue: `"notes = 'other'"` });
			},
		});
		expect(codes(reading)).toContain(
			"case-search/xpath-query-row-that-is-neither-a-list-filter-clause-nor-a-search-field-s",
		);
		expect(placements().at(-1)).toEqual({
			kind: "E",
			entry:
				"case-search/xpath-query-row-that-is-neither-a-list-filter-clause-nor-a-search-field-s",
		});
	});

	it("claims each use a row's CSQL makes, held or refused, under the entry whose value class takes it", async () => {
		const typedRightSide =
			"case-search/p-v-p-v-literal-value-function-or-runtime-value-and-p-v-p-v-p-v";
		const dateOnly =
			"case-search/date-only-comparison-on-date-opened-closed-on-last-modified";
		const reading = await readLists(oneOfEach(), {
			edit: (app) => {
				const rows = rowsOf(app);
				const first = rows[0];
				if (first !== undefined)
					rows.push({
						...first,
						defaultValue: `"date_opened > '2024-01-01'"`,
					});
			},
		});
		expect(codes(reading)).toContain(dateOnly);
		const uses = [...reading.ctx.close().claims.records()].flatMap((record) =>
			record.key?.startsWith("csql-") === true
				? [{ key: record.key, entry: record.entry }]
				: [],
		);
		expect(uses).toEqual(
			expect.arrayContaining([
				// The held rows' `notes = 'open'` and `notes != …`.
				{ key: "csql-op:=", entry: typedRightSide },
				{ key: "csql-op:!=", entry: typedRightSide },
				// The refused row's comparison and the system date it reads.
				{ key: "csql-op:>", entry: typedRightSide },
				{ key: "csql-metadata:date_opened", entry: dateOnly },
			]),
		);
	});
});

describe("a menu whose forms read the search", () => {
	const PATIENTS = 1;

	/** An intake menu that registers patients, a menu of patients whose forms read its search, and,
	 *  where asked, a menu held advanced whose follow-up loads a patient. */
	function readingForms(advanced = false): BlueprintDoc {
		const register = {
			name: "Register",
			type: "registration" as const,
			fields: [
				f({
					kind: "text",
					id: "name",
					caseWrite: { caseType: "patient", property: "case_name" },
				}),
				f({
					kind: "text",
					id: "notes",
					caseWrite: { caseType: "patient", property: "notes" },
				}),
				f({
					kind: "text",
					id: "phone",
					caseWrite: { caseType: "patient", property: "phone" },
				}),
			],
		};
		const visit = (name: string) => ({
			name,
			type: "followup" as const,
			fields: [
				f({
					kind: "text",
					id: "visit_notes",
					caseWrite: { caseType: "patient", property: "notes" },
				}),
			],
		});
		const list: CaseListConfig = {
			columns: [plainColumn(uuid(1), "case_name", "Name")],
			listColumnOrder: [uuid(1)],
			detailColumnOrder: [uuid(1)],
			searchInputs: [bare],
			filter: notesIs("open"),
		};
		const doc = buildDoc({
			modules: [
				{ name: "Intake", caseType: "patient", forms: [register] },
				{
					name: "Patients",
					caseType: "patient",
					forms: [visit("Visit")],
					caseListConfig: list,
					caseSearchConfig: { formsReadSearch: true },
				},
				...(advanced
					? [{ name: "Review", caseType: "patient", forms: [visit("Review")] }]
					: []),
			],
		});
		if (!advanced) return doc;
		return produce(doc, (draft) => {
			const review = draft.moduleOrder[2];
			const module = review === undefined ? undefined : draft.modules[review];
			if (module !== undefined) module.heldKind = "advanced";
		});
	}

	it("holds a list filter clause the search does not restate, and records it", async () => {
		const reading = await readLists(readingForms(), {
			edit: (app) => {
				rowsOf(app, PATIENTS).splice(0);
			},
		});
		expect(codes(reading)).toEqual([]);
		expect(classified().unrestated).toEqual([0]);
		expect(listOf(reading, PATIENTS).filter).toEqual(notesIs("open"));
		expect(registers(reading)).toContain("search-restates-list-filter");
	});

	it("joins a conjunct with no field to the list filter, and records it", async () => {
		const reading = await readLists(readingForms(), {
			edit: (app) => {
				rowsOf(app, PATIENTS).push({
					property: "_xpath_query",
					defaultValue: `"notes = 'other'"`,
				});
			},
		});
		expect(codes(reading)).toEqual([]);
		expect(placements()).toEqual([{ kind: "B", clause: 0 }, { kind: "F" }]);
		expect(listOf(reading, PATIENTS).filter).toEqual(
			and(notesIs("open"), notesIs("other")),
		);
		expect(registers(reading)).toContain("search-filter-joined-to-list");
	});

	it("raises a conjunct with no field where an advanced form's load names the menu", async () => {
		const reading = await readLists(readingForms(true), {
			edit: (app) => {
				rowsOf(app, PATIENTS).push({
					property: "_xpath_query",
					defaultValue: `"notes = 'other'"`,
				});
				const patients = app.modules[PATIENTS];
				const review = app.modules[2]?.forms as
					| Record<string, unknown>[]
					| undefined;
				const actions = review?.[0]?.actions as
					| { load_update_cases?: Record<string, unknown>[] }
					| undefined;
				const load = actions?.load_update_cases?.[0];
				if (load === undefined)
					throw new Error("The advanced menu's form loads its case.");
				load.details_module = patients?.unique_id;
			},
		});
		const entry =
			"case-search/xpath-query-row-that-is-neither-a-list-filter-clause-nor-a-search-field-s";
		expect(codes(reading)).toContain(entry);
		expect(
			recorded.classifications
				.map((one) => (one as RowClassification).conjuncts.at(-1)?.placement)
				.filter((placement) => placement?.kind === "E"),
		).toEqual([{ kind: "E", entry }]);
	});
});
