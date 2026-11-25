/** Each emitted search conjunct is read at its own execution site. Shared conditions,
 * field-owned comparisons, and independent request clauses round-trip without
 * transferring a restriction between the server search and the device detail. */
import { produce } from "immer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { recordDialectRoundTrip } from "@/lib/agent/authoring/recordRoundTrip";
import type {
	BlueprintDoc,
	CasePropertyDataType,
	SearchInputDef,
	Uuid,
} from "@/lib/domain";
import { effectiveCaseTypes } from "@/lib/domain/effectiveCaseTypes";
import {
	ancestorPath,
	and,
	dateLiteral,
	eq,
	gt,
	ifExpr,
	input,
	literal,
	multiSelectAll,
	neq,
	now,
	prop,
	relationStep,
	sessionContext,
	term,
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
import { readerInput, sourceFromBody } from "../../__tests__/readerInput";
import { canonDocument } from "../../canon";
import { patients, uuid } from "../../caseList/__tests__/fixtures";
import {
	type AppJson,
	closedCodes,
	codes,
	emittedApp,
	listOf,
	readLists,
} from "../../caseList/__tests__/listReading";
import { knownCaseTypesOf, readHqApp } from "../../index";
import type { PromptReading } from "../prompts";
import {
	type ConjunctPlacement,
	derivedConditionsAreSimpleFields,
	filterConditionsOfAFieldAreItsOwn,
	type RowClassification,
	simpleDerivation,
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

	it("types a date field's property over the case above on that case's type, and no property of the menu's own", () => {
		// The household's date is untyped, and the patient holds an untyped property of the same name:
		// the row's derivation reads the household's as a date, and the patient's stays untyped.
		const field: SimpleSearchInputDef = {
			uuid: uuid(9),
			name: "visited",
			label: "Household visited",
			kind: "simple",
			type: "date",
			property: "visited",
			via: ancestorPath(relationStep("parent", "household")),
		};
		const base = patients([plainColumn(uuid(1), "case_name", "Name")], {
			searchInputs: [field],
			search: {},
		});
		const withVisited = (dataType: CasePropertyDataType | undefined) =>
			produce(base, (draft) => {
				draft.caseTypes = [
					{
						name: "patient",
						parent_type: "household",
						properties: [{ name: "visited", label: proseText("visited") }],
					},
					{
						name: "household",
						properties: [
							{
								name: "visited",
								label: proseText("visited"),
								...(dataType !== undefined && { data_type: dataType }),
							},
						],
					},
				];
			});
		const typedDoc = withVisited("date");
		const menu = typedDoc.moduleOrder[0] as Uuid;
		const conjunct = deriveSimpleArmPredicate(
			field,
			"patient",
			moduleExpressionContexts(typedDoc, menu)({ slot: "case_list_filter" }),
		);
		const found = simpleDerivation(
			withVisited(undefined),
			menu,
			"patient",
			{ type: "date", input: field } as PromptReading,
			conjunct,
		);
		expect(found?.property).toBe("visited");
		const typeOf = (caseType: string) =>
			found?.doc.caseTypes
				?.find((one) => one.name === caseType)
				?.properties.find((one) => one.name === "visited")?.data_type;
		expect(typeOf("household")).toBe("date");
		expect(typeOf("patient")).toBeUndefined();
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

	it("reads an unguarded condition without losing the field’s automatic match", async () => {
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
		expect(codes(reading)).toEqual([]);
		expect(authored(listOf(reading).searchCondition, reading, [bare])).toEqual(
			neq(prop("patient", "notes"), input(PHONE)),
		);
		expect(authored(listOf(reading).searchInputs, reading, [bare])).toEqual([
			bare,
		]);
	});

	it("keeps an unguarded answer read on the request and preserves the excluded prompt", async () => {
		// Nova never writes it (`composeXPathQueryEmission` refuses a read outside its guard), and
		// no candidate proposes it: the field's condition would print a read the gate refuses. A
		// device builds the search's input list from the answered fields alone, so the row
		// compares a blank while the field is unanswered.
		const doc = patients([plainColumn(uuid(1), "case_name", "Name")], {
			searchInputs: [number],
			search: {},
		});
		const app = await emittedApp(doc);
		rowsOf(app).push({
			property: "_xpath_query",
			defaultValue: oneRow(doc, neq(prop("patient", "notes"), input(NUMBER))),
		});
		const outcome = readHqApp({
			...readerInput(await sourceFromBody(app)),
			recordDialect: recordDialectRoundTrip,
			knownCaseTypes: knownCaseTypesOf(doc),
		});
		expect(outcome.defects).toEqual([]);
		expect(outcome.kind).toBe("read");
		expect(placements()).toContainEqual({ kind: "F" });
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

	it("keeps a list-only restriction beside an unrestricted online search", async () => {
		const reading = await readLists(doc(), {
			edit: (app) => {
				rowsOf(app).splice(0);
			},
		});
		expect(closedCodes(reading)).toEqual([]);
		expect(listOf(reading).filter).toEqual(notesIs("open"));
		expect(listOf(reading).searchCondition).toEqual({ kind: "match-all" });
	});

	// The search holds its own rows, and the list gains a clause none of them restates: Nova would
	// restate it as a row of its own, which the clause's one finding stands for.
	it("retains the full detail and the narrower set of request clauses", async () => {
		const reading = await readLists(doc(), {
			edit: (app) => {
				const short = app.modules[0]?.case_details.short;
				if (short === undefined) throw new Error("The menu lists patients.");
				short.filter = `${String(short.filter)} and notes != 'closed'`;
			},
		});
		expect(closedCodes(reading)).toEqual([]);
		expect(listOf(reading).searchCondition).toEqual(notesIs("open"));
		expect(listOf(reading).filter).toEqual(
			and(notesIs("open"), neq(prop("patient", "notes"), literal("closed"))),
		);
	});

	// HQ's search compares a system date by its own date rule alone and refuses any value that is no
	// date (`comparison.py::_create_system_datetime_query`): that is the row's one cause, whatever
	// else the row would have been refused for or wherever a conjunct of it could have stood.
	it.each([
		`"date_opened = 'abc'"`,
		`"date_opened > 'abc'"`,
		`"closed_on = 3"`,
	])(
		"raises a system date compared with no date, %s, as that one finding",
		async (defaultValue) => {
			const reading = await readLists(doc(), {
				edit: (app) => {
					rowsOf(app).push({ property: "_xpath_query", defaultValue });
				},
			});
			const closed = reading.ctx.close();
			expect(closed.findings.map((finding) => finding.code)).toEqual([
				"case-search/date-opened-closed-on-or-last-modified-compared-with-any",
			]);
			// The ordering is no range of a property's, so its right side is the system date's class.
			const orderings = [...closed.claims.records()].filter(
				(record) => record.key === "csql-op:>",
			);
			for (const record of orderings)
				expect(record.entry).toBe(
					"case-search/p-v-p-v-literal-value-function-or-runtime-value-and-p-v-p-v-p-v",
				);
		},
	);

	// HQ keeps no stored `None` for a default filter's value: a filter with none, or with a blank,
	// is one finding at the search, and the search's other rows stand under it.
	it.each([
		["left out", {}],
		["blank", { defaultValue: "" }],
	])(
		"raises a default filter whose value is %s as one finding",
		async (_title, value) => {
			const reading = await readLists(doc(), {
				edit: (app) => {
					rowsOf(app).push({
						property: "_xpath_query",
						doc_type: "DefaultCaseSearchProperty",
						...value,
					});
				},
			});
			expect(closedCodes(reading)).toEqual([
				"case-search/default-properties-entry-with-no-defaultvalue-hq-stores-an-empty",
			]);
		},
	);

	it("reads the rows of fields whose conditions read no field as the search condition, as the canonical document holds them", async () => {
		// A condition that reads no Search field is a condition on the whole search: an author sees
		// it as the search condition, never on a field it does not read.
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
		const doc = patients([plainColumn(uuid(1), "case_name", "Name")], {
			searchInputs: inputs,
			search: {},
		});
		const reading = await readLists(doc);
		expect(codes(reading)).toEqual([]);
		expect(placements()).toEqual(inputs.map(() => ({ kind: "F" })));
		const read = listOf(reading);
		expect(read.filter).toBeUndefined();
		expect(read.searchCondition).toEqual(
			and(notesIs("open"), notesIs("held"), notesIs("late")),
		);
		expect(authored(read.searchInputs, reading, inputs)).toEqual(
			inputs.map((one) => ({ ...one, predicate: { kind: "match-all" } })),
		);
		const canonical =
			canonDocument(doc).modules[doc.moduleOrder[0] as Uuid]?.caseListConfig;
		expect(authored(read.searchInputs, reading, inputs)).toEqual(
			canonical?.searchInputs,
		);
		expect(read.searchCondition).toEqual(canonical?.searchCondition);
	});

	it("reads a row that reads no field, held after a field's row, as the search condition, and writes it ahead of the field's", async () => {
		// HQ's Referrals shape: an excluded field whose own row reads its answer, then a row on the
		// whole search. The field takes no condition it does not read; Nova writes the search's own
		// row first, which HQ's search runs as the same filters.
		const OWN = uuid(20);
		const own: SearchInputDef = {
			uuid: OWN,
			name: "own",
			label: "Own",
			kind: "advanced",
			type: "text",
			predicate: notesDiffer(OWN),
		};
		const doc = patients([plainColumn(uuid(1), "case_name", "Name")], {
			searchInputs: [own],
			search: {},
		});
		const reading = await readLists(doc, {
			edit: (app) => {
				rowsOf(app).push({
					property: "_xpath_query",
					doc_type: "DefaultCaseSearchProperty",
					defaultValue: `"notes = 'other'"`,
				});
			},
		});
		expect(codes(reading)).toEqual([]);
		expect(authored(placements(), reading, [own])).toEqual([
			{ kind: "D", from: "field", input: OWN },
			{ kind: "F" },
		]);
		const read = listOf(reading);
		expect(read.searchCondition).toEqual(notesIs("other"));
		expect(authored(read.searchInputs, reading, [own])).toEqual([own]);
		expect(registers(reading)).toContain("search-filter-rows-recut");
	});

	it("claims a text property ordered against a date or a number as a comparison HQ's search converts, and an equality of text as none", async () => {
		const claimedAt = (reading: Awaited<ReturnType<typeof readLists>>) =>
			new Set(
				[...reading.ctx.close().claims.records()].flatMap((record) =>
					record.key === "schema:DefaultCaseSearchProperty.defaultValue"
						? [`${record.where} ${record.entry}`]
						: [],
				),
			);
		const converted =
			"case-search/xpath-query-condition-outside-what-nova-types";
		for (const [row, holds] of [
			[`"notes > '2020-01-01'"`, true],
			[`"notes > 5"`, true],
			[`"notes = 'other'"`, false],
		] as const) {
			const reading = await readLists(typed(doc(), { notes: "text" }), {
				edit: (app) => {
					rowsOf(app).push({
						property: "_xpath_query",
						doc_type: "DefaultCaseSearchProperty",
						defaultValue: row,
					});
				},
			});
			expect(closedCodes(reading), row).toEqual([]);
			expect(
				[...claimedAt(reading)].some((one) => one.endsWith(converted)),
				row,
			).toBe(holds);
		}
	});

	it("keeps a comparison only HQ's search converts on the search condition, never on the list a device runs", async () => {
		// The answered phone orders the notes as HQ's search alone does (`searchIndexedComparison`);
		// a device's list filter would refuse it, so the list keeps its own filter.
		const SI = "instance('search-input:results')/input/field[@name = 'phone']";
		const reading = await readLists(typed(doc(), { notes: "text" }), {
			edit: (app) => {
				rowsOf(app).push({
					property: "_xpath_query",
					doc_type: "DefaultCaseSearchProperty",
					defaultValue: `if(count(${SI}), concat("notes > '", ${SI}, "'"), 'match-all()')`,
				});
			},
		});
		expect(closedCodes(reading)).toEqual([]);
		const read = listOf(reading);
		expect(read.filter).toEqual(notesIs("open"));
		expect(authored(read.searchCondition, reading, [bare])).toEqual(
			and(
				notesIs("open"),
				whenInput(input(PHONE), gt(prop("patient", "notes"), input(PHONE))),
			),
		);
	});

	it("reads an independent request condition beside existing shared clauses", async () => {
		const reading = await readLists(doc(), {
			edit: (app) => {
				const rows = rowsOf(app);
				const first = rows[0];
				// A row's value is an XPath whose value is the CSQL text, as Nova writes `"notes = 'open'"`.
				if (first !== undefined)
					rows.push({ ...first, defaultValue: `"notes = 'other'"` });
			},
		});
		expect(closedCodes(reading)).toEqual([]);
		expect(listOf(reading).filter).toEqual(notesIs("open"));
		expect(listOf(reading).searchCondition).toEqual(
			and(notesIs("open"), notesIs("other")),
		);
		expect(placements().at(-1)).toEqual({ kind: "F" });
	});

	it("claims each class of what a held row works out on the device beside the row's own claim", async () => {
		const visits = prop("patient", "visits");
		const doc = typed(
			patients([plainColumn(uuid(1), "case_name", "Name")], {
				searchInputs: [bare],
				search: {},
				list: {
					filter: and(
						ifExpr(
							eq(term(sessionContext("username")), literal("demo")),
							notesIs("a"),
							notesIs("b"),
						),
						eq(prop("patient", "notes"), term(sessionContext("applanguage"))),
						eq(visits, term(sessionContext("drift"))),
						eq(visits, term(sessionContext("window_width"))),
					),
				},
			}),
			{ notes: "text", visits: "int" },
		);
		const reading = await readLists(doc);
		expect(closedCodes(reading)).toEqual([]);
		const entries = new Set(
			[...reading.ctx.close().claims.records()].flatMap((record) =>
				record.key === "schema:DefaultCaseSearchProperty.defaultValue" &&
				record.where.startsWith("/modules/0/search_config/default_properties/")
					? [record.entry]
					: [],
			),
		);
		for (const entry of [
			"case-search/several-xpath-query-rows",
			"case-search/clause-chosen-at-runtime-by-a-condition-over-session-worker",
			"case-search/runtime-values-read-from-casedb-or-session-datums",
			"case-search/runtime-values-read-from-the-session-context-drift",
			"case-search/runtime-values-read-from-the-session-context-window-width",
			"case-search/runtime-values-read-from-the-session-context-applanguage",
		])
			expect(entries).toContain(entry);
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
		expect(closedCodes(reading)).toEqual([]);
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
				// The independent server condition and the system date it reads.
				{ key: "csql-op:>", entry: typedRightSide },
				{ key: "csql-metadata:date_opened", entry: dateOnly },
				// What a presence test sends with no answer and a row sends where it fails closed,
				// which HQ's search parses as any other text the row can send.
				{ key: "csql-fn:match-all", entry: "case-search/match-all-match-none" },
				{
					key: "csql-fn:match-none",
					entry: "case-search/match-all-match-none",
				},
			]),
		);
	});

	it("records a row's key where its value sits, and a presence test's class at the row's value", async () => {
		let rows = 0;
		const reading = await readLists(oneOfEach(), {
			edit: (app) => {
				rows = rowsOf(app).length;
			},
		});
		expect(codes(reading)).toEqual([]);
		const records = [...reading.ctx.close().claims.records()].filter((record) =>
			record.where.startsWith("/modules/0/search_config/default_properties/"),
		);
		const at = (key: string) =>
			records
				.filter((record) => record.key === key)
				.map((record) => record.where.replace(/^.*default_properties\//, ""));
		// Each `_xpath_query` row's key is the `csql-key` item at `property`, never at its value.
		expect(at("csql-key:_xpath_query")).toEqual(
			Array.from({ length: rows }, (_, index) => `${index}/property`),
		);
		// A row chosen by a Search field's presence test is that class of its value.
		expect(
			records.some(
				(record) =>
					record.entry ===
						"case-search/clause-chosen-at-runtime-by-input-presence" &&
					record.key === "schema:DefaultCaseSearchProperty.defaultValue" &&
					record.where.endsWith("/defaultValue"),
			),
		).toBe(true);
	});

	// HQ's Case List page saves a filter keyed `owner_id`, which HQ's search reads as the case's
	// owner: the key is that `csql-key` item where it sits, as the lane's manifest check reads it.
	it("records a filter keyed owner_id as the search key HQ reads as the case's owner", async () => {
		let index = 0;
		const reading = await readLists(oneOfEach(), {
			edit: (app) => {
				const rows = rowsOf(app);
				index = rows.length;
				rows.push({
					doc_type: "DefaultCaseSearchProperty",
					property: "owner_id",
					defaultValue: "instance('commcaresession')/session/context/userid",
				});
			},
		});
		const records = [...reading.ctx.close().claims.records()].filter(
			(record) =>
				record.where ===
				`/modules/0/search_config/default_properties/${index}/property`,
		);
		expect(records.map((record) => [record.key, record.entry])).toContainEqual([
			"csql-key:owner_id",
			"case-search/a-search-key-named-owner-id",
		]);
	});
});

describe("a menu whose forms read the search", () => {
	const PATIENTS = 1;

	/** An intake menu that registers patients, a menu of patients whose forms read its search, with
	 *  `list` over its case list, and, where asked, a menu held advanced whose follow-up loads a
	 *  patient. */
	function readingForms(
		advanced = false,
		list: Partial<CaseListConfig> = {},
	): BlueprintDoc {
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
		const config: CaseListConfig = {
			columns: [plainColumn(uuid(1), "case_name", "Name")],
			listColumnOrder: [uuid(1)],
			detailColumnOrder: [uuid(1)],
			searchInputs: [bare],
			filter: notesIs("open"),
			...list,
		};
		const doc = buildDoc({
			modules: [
				{ name: "Intake", caseType: "patient", forms: [register] },
				{
					name: "Patients",
					caseType: "patient",
					forms: [visit("Visit")],
					caseListConfig: config,
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

	it("retains a list-only clause when forms read the results", async () => {
		const reading = await readLists(readingForms(), {
			edit: (app) => {
				rowsOf(app, PATIENTS).splice(0);
			},
		});
		expect(codes(reading)).toEqual([]);
		expect(classified().unrestated).toEqual([0]);
		expect(listOf(reading, PATIENTS).filter).toEqual(notesIs("open"));
		expect(listOf(reading, PATIENTS).searchCondition).toEqual({
			kind: "match-all",
		});
		expect(registers(reading)).not.toContain("search-restates-list-filter");
	});

	it("keeps a search-only clause off the device list", async () => {
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
		expect(listOf(reading, PATIENTS).filter).toEqual(notesIs("open"));
		expect(listOf(reading, PATIENTS).searchCondition).toEqual(
			and(notesIs("open"), notesIs("other")),
		);
		expect(registers(reading)).not.toContain("search-filter-joined-to-list");
	});

	it("holds server-only matching on the search", async () => {
		for (const row of [
			`"fuzzy-match(notes, 'nrth')"`,
			`"phonetic-match(notes, 'nrth')"`,
		]) {
			const reading = await readLists(readingForms(), {
				edit: (app) => {
					rowsOf(app, PATIENTS).push({
						property: "_xpath_query",
						defaultValue: row,
					});
				},
			});
			expect(closedCodes(reading)).toEqual([]);
			expect(placements().at(-1)).toEqual({ kind: "F" });
			expect(listOf(reading, PATIENTS).searchCondition?.kind).toBe("and");
			expect(listOf(reading, PATIENTS).filter).toEqual(notesIs("open"));
		}
	});

	it("keeps metadata, whitespace and missing-property matching on the server", async () => {
		// A standard property, which HQ reads from its own metadata; a negation of a property's text,
		// true in HQ of a stored `'other '` or `' '` the device reads trimmed (`'other'`, `''`); and a
		// literal with a space at an end, which HQ matches as stored and the device trimmed.
		for (const row of [
			`"case_name = 'Ana'"`,
			`"notes != 'other'"`,
			`"notes != ''"`,
			`"not(notes = 'other')"`,
			`"notes = 'other '"`,
			`"starts-with(notes, ' ot')"`,
		]) {
			const reading = await readLists(readingForms(), {
				edit: (app) => {
					rowsOf(app, PATIENTS).push({
						property: "_xpath_query",
						defaultValue: row,
					});
				},
			});
			expect(closedCodes(reading)).toEqual([]);
			expect(placements().at(-1)).toEqual({ kind: "F" });
			expect(listOf(reading, PATIENTS).searchCondition?.kind).toBe("and");
			expect(listOf(reading, PATIENTS).filter).toEqual(notesIs("open"));
			expect(registers(reading)).not.toContain("search-filter-joined-to-list");
		}
	});

	it("reads a conjunct with no field beside a field's derivation as the search condition and the field as simple, as the canonical document holds it", async () => {
		// Nova writes the field's condition as two rows, the conjunct with no field with the search
		// condition's rows, then the derivation. The conjunct is a condition on the whole search, the
		// field the simple field its derivation is, and the list a device runs keeps its own filter.
		const ADV = uuid(20);
		const advanced: SearchInputDef = {
			uuid: ADV,
			name: "adv",
			label: "Adv",
			kind: "advanced",
			type: "text",
			predicate: and(
				notesIs("other"),
				whenInput(input(ADV), eq(prop("patient", "phone"), input(ADV))),
			),
		};
		const doc = readingForms(false, { searchInputs: [advanced] });
		const reading = await readLists(doc);
		expect(codes(reading)).toEqual([]);
		const canonical =
			canonDocument(doc).modules[doc.moduleOrder[PATIENTS] as Uuid]
				?.caseListConfig;
		const read = listOf(reading, PATIENTS);
		expect(authored(read.filter, reading, [advanced], PATIENTS)).toEqual(
			canonical?.filter,
		);
		expect(authored(read.searchInputs, reading, [advanced], PATIENTS)).toEqual(
			canonical?.searchInputs,
		);
		expect(read.searchCondition).toEqual(canonical?.searchCondition);
		expect(read.searchInputs[0]?.kind).toBe("simple");
		expect(authored(placements(), reading, [advanced], PATIENTS)).toEqual([
			{ kind: "B", clause: 0 },
			{ kind: "F" },
			{ kind: "C", input: ADV, property: "phone" },
		]);
		expect(registers(reading)).not.toContain("search-filter-joined-to-list");
	});

	it("keeps an additional conjunct before a field-dependent server clause", async () => {
		// The conjunct is first an excluded field's condition; the clause after it waits for a field
		// HQ's matcher compares, and Nova writes the list filter's rows before the field's, so only the
		// conjunct in the list filter writes the rows in order. The list a device runs gains it.
		const ADV = uuid(20);
		const advanced: SearchInputDef = {
			uuid: ADV,
			name: "adv",
			label: "Adv",
			kind: "advanced",
			type: "text",
			predicate: { kind: "match-all" },
		};
		const inputs = [bare, advanced];
		const reading = await readLists(
			readingForms(false, {
				searchInputs: inputs,
				filter: and(notesIs("open"), notesDiffer(PHONE)),
			}),
			{
				edit: (app) => {
					rowsOf(app, PATIENTS).splice(1, 0, {
						property: "_xpath_query",
						defaultValue: `"notes = 'other'"`,
					});
				},
			},
		);
		expect(codes(reading)).toEqual([]);
		expect(placements()).toEqual([
			{ kind: "B", clause: 0 },
			{ kind: "F" },
			{ kind: "D", from: "filter" },
		]);
		expect(
			authored(
				listOf(reading, PATIENTS).searchCondition,
				reading,
				inputs,
				PATIENTS,
			),
		).toEqual(and(notesIs("open"), notesIs("other"), notesDiffer(PHONE)));
		expect(registers(reading)).not.toContain("search-filter-joined-to-list");
	});

	it("preserves the detail selected by an advanced form beside a different server condition", async () => {
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
		expect(closedCodes(reading)).toEqual([]);
		expect(listOf(reading, PATIENTS).filter).toEqual(notesIs("open"));
		expect(listOf(reading, PATIENTS).searchCondition).toEqual(
			and(notesIs("open"), notesIs("other")),
		);
	});
});

describe("an advanced field's guarded conditions, the first of which a simple field derives", () => {
	it("reads every condition back on the field, as the canonical document holds them", async () => {
		// The rows of the field's condition follow the list filter's, so reading the second as a
		// list filter clause would write it ahead of the first: the first is the field's condition
		// again, with the second joined (fuzz-expression-20260930-3).
		const ADV = uuid(20);
		const advanced: SearchInputDef = {
			uuid: ADV,
			name: "adv",
			label: "Adv",
			kind: "advanced",
			type: "text",
			predicate: and(
				whenInput(input(ADV), eq(prop("patient", "notes"), input(ADV))),
				whenInput(input(ADV), neq(prop("patient", "phone"), input(ADV))),
			),
		};
		const doc = patients([plainColumn(uuid(1), "case_name", "Name")], {
			searchInputs: [advanced],
			search: {},
			list: { filter: notesIs("open") },
		});
		const reading = await readLists(doc);
		expect(codes(reading)).toEqual([]);
		const canonical =
			canonDocument(doc).modules[doc.moduleOrder[0] as Uuid]?.caseListConfig;
		const read = listOf(reading);
		expect(authored(read.filter, reading, [advanced])).toEqual(
			canonical?.filter,
		);
		expect(authored(read.searchInputs, reading, [advanced])).toEqual(
			canonical?.searchInputs,
		);
		expect(authored(placements(), reading, [advanced])).toEqual([
			{ kind: "B", clause: 0 },
			{ kind: "D", from: "field", input: ADV },
			{ kind: "D", from: "field", input: ADV },
		]);
	});

	it("reads the same conditions held by the list filter back on the field, as the canonical document holds them", async () => {
		// The list filter's rows are written before every field's, so the two clauses print the rows
		// the field's condition prints, and with no search settings stored the canonical document
		// moves both onto the field as the reading places them (csqlQuoteFixture).
		const ADV = uuid(20);
		const advanced: SearchInputDef = {
			uuid: ADV,
			name: "adv",
			label: "Adv",
			kind: "advanced",
			type: "text",
			predicate: { kind: "match-all" },
		};
		const doc = patients([plainColumn(uuid(1), "case_name", "Name")], {
			searchInputs: [advanced],
			list: {
				filter: and(
					notesIs("open"),
					whenInput(input(ADV), eq(prop("patient", "notes"), input(ADV))),
					whenInput(input(ADV), neq(prop("patient", "phone"), input(ADV))),
				),
			},
		});
		const reading = await readLists(doc);
		expect(codes(reading)).toEqual([]);
		const canonical =
			canonDocument(doc).modules[doc.moduleOrder[0] as Uuid]?.caseListConfig;
		expect(canonical?.filter).toEqual(notesIs("open"));
		// The row moves both clauses in one application: it is a fixed point on its own result.
		const once =
			filterConditionsOfAFieldAreItsOwn(doc).modules[doc.moduleOrder[0] as Uuid]
				?.caseListConfig;
		expect(once?.filter).toEqual(canonical?.filter);
		expect(once?.searchInputs).toEqual(canonical?.searchInputs);
		const read = listOf(reading);
		expect(authored(read.filter, reading, [advanced])).toEqual(
			canonical?.filter,
		);
		expect(authored(read.searchInputs, reading, [advanced])).toEqual(
			canonical?.searchInputs,
		);
	});
});
