/**
 * A search filter row read back through its CSQL. The contract: a row is held
 * only where the production CSQL emitter writes it back, its whole wrapper
 * (exact) or the same CSQL and device values with Nova's guards around them
 * (guards), and every row it cannot hold claims the entry its shape names.
 * The failures this catches: HQ's documented quoted-answer row, in either
 * quote mark, not held at the guards level; HQ's server-side `today()` left
 * unrecognized; Nova's own lists, fixed and calculated, and its presence
 * cascade not read back as the tree that wrote them; a system date compared
 * with a date held, or left unrecognized, where Nova can't evaluate it; a
 * text property ordered claimed as anything but the record rule set's
 * wider vocabulary; a property name built at run time held; an
 * unparenthesized later argument held; a count of subcases bounded by a
 * Search field's answer, whose zero the row writes bare, or a test of the
 * case's own type, not read back as the tree that wrote it; and a related
 * case's id compared through a step other than `parent`, which HQ's
 * flag-free spelling writes with no case type, read back untyped, which the
 * checker refuses on Nova's own export; and a selection of several values,
 * a selection of a Search field's answer (`selected-any`, `selected-all`), a
 * membership and a list of values (`unwrap-list`) in Nova's own export not
 * read back as the canonical tree of the condition that wrote them, or read
 * with a finding.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { lookupTableDefinition } from "@/lib/__tests__/lookupFixtures";
import {
	and,
	datetimeLiteral,
	eq,
	input,
	literal,
	neq,
	or,
	prop,
	term,
	whenInput,
} from "@/lib/domain/expression/builders";
import { slotContext } from "@/lib/domain/expression/context";
import type { Expression } from "@/lib/domain/expression/types";
import {
	lookupColumnIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import {
	advancedSearchInputDef,
	type CaseListConfig,
} from "@/lib/domain/modules";
import { proseText } from "@/lib/domain/prose";
import { readsSearchField } from "@/lib/domain/searchConditions";
import { emitCsql } from "../../../csql/emitter";
import { lookupWireNaming } from "../../../lookup/naming";
import { searchWireShape } from "../../../suite/case-search/searchWireShape";
import { searchInputInstanceId } from "../../../suite/case-search/types";
import { DERIVED_WIRE_IDENTITY } from "../../../wireIdentity";
import { serializeWire } from "../../../xpath/wire/serialize";
import { exportedBody, inputFor } from "../../__tests__/novaExport";
import { matchingResolver } from "../../identity";
import { externalIdentityMap } from "../../identityMap";
import { readHqApp } from "../../index";
import { canonicalExpression } from "../canonical";
import { readSearchFilterRow } from "../csqlRead";
import { searchRowProperties, searchRowRelations } from "../scanReads";
import {
	CSQL_READER_VECTORS,
	csqlRow,
	csqlVectorDoc,
	REGION,
	rowContext,
	rowEnv,
} from "./csqlVectors";

const doc = csqlVectorDoc();
const env = rowEnv(doc);
const filter = rowContext(doc);
const condition = rowContext(doc, "search_input_predicate");
const ANSWER = "instance('search-input:results')/input/field[@name = 'region']";
const village = prop("patient", "village");

/** Nova's own row for a predicate in a context, as the HQ JSON holds it. */
function novaRow(predicate: Expression, context: typeof filter): string {
	const mod = doc.modules[context.slot.uuid];
	const shape = mod?.caseSearchConfig
		? searchWireShape(mod.caseSearchConfig)
		: undefined;
	const wire = emitCsql(predicate, {
		types: context,
		bindings: {
			...(shape === undefined
				? {}
				: { searchInputInstanceId: searchInputInstanceId(shape) }),
		},
	}).wrapper;
	return serializeWire(wire, { target: "hq-json", interpolation: "none" }).text;
}

/** The condition a reading holds for the menu's one Search field: the field's own where it reads a
 *  Search field, else the search condition, the field then holding none. */
function heldCondition(
	config: CaseListConfig | undefined,
	ownField: boolean,
): unknown {
	const field = config?.searchInputs[0];
	if (ownField) return field?.kind === "advanced" ? field.predicate : field;
	expect(field?.kind === "advanced" ? field.predicate : field).toEqual({
		kind: "match-all",
	});
	return config?.searchCondition;
}

describe("a search filter row's CSQL", () => {
	it.each(CSQL_READER_VECTORS)("reads $id as its vector says", (vector) => {
		const reading = readSearchFilterRow(csqlRow(vector.csql), filter, env);
		if ("held" in vector.reads) {
			expect(reading).toMatchObject({
				ok: true,
				level: vector.reads.held,
				rewrites: vector.reads.rewrites,
			});
			return;
		}
		expect(reading).toMatchObject({
			ok: false,
			claim: { entryId: vector.reads.entry },
		});
	});

	it("holds HQ's documented quoted answer at the guards level, in either quote mark", () => {
		for (const text of [
			`concat('village = "', ${ANSWER}, '"')`,
			`concat("village = '", ${ANSWER}, "'")`,
		]) {
			const reading = readSearchFilterRow(text, filter, env);
			expect(reading).toEqual({
				ok: true,
				predicate: eq(village, term(input(REGION))),
				level: "guards",
				rewrites: ["search-value-guards"],
			});
		}
	});

	it("reads a row that fails closed under its author's own condition as that choice", () => {
		// The source sends `match-none()` under a condition of its author's,
		// which is no guard of Nova's: the row is read with the condition as a
		// choice its tree holds, never as Nova's guard with the condition
		// dropped. Nova's print guards the answer's read for no rows.
		const text = `if(${ANSWER} = 'x', 'match-none()', "village = 'open'")`;
		expect(readSearchFilterRow(text, filter, env)).toEqual({
			ok: true,
			predicate: {
				kind: "if",
				cond: eq(term(input(REGION)), term(literal("x"))),
				// biome-ignore lint/suspicious/noThenProperty: an expression branch, never awaited.
				then: { kind: "match-none" },
				else: eq(village, term(literal("open"))),
			},
			level: "guards",
			rewrites: ["empty-rows-guard"],
		});
	});

	it("holds no reading that drops its author's own condition for failing closed", () => {
		// Read as a choice, Nova's print puts its own guards of the quoted
		// answer inside the choice, which the guards level compares as one
		// device value, so the row is not held; read as Nova's guard, the
		// condition would be dropped and Nova would search where the source
		// showed no case.
		const text = `if(${ANSWER} = '', 'match-none()', concat("village = '", ${ANSWER}, "'"))`;
		expect(readSearchFilterRow(text, filter, env).ok).toBe(false);
	});

	it("holds a row whose wrapper fails closed under Nova's own quote guard, spelled in either order", () => {
		const text = `if(contains(${ANSWER}, '"') and contains(${ANSWER}, "'"), 'match-none()', concat('village = "', ${ANSWER}, '"'))`;
		expect(readSearchFilterRow(text, filter, env)).toEqual({
			ok: true,
			predicate: eq(village, term(input(REGION))),
			level: "guards",
			rewrites: ["search-value-guards"],
		});
	});

	it("reads no quote cascade whose single-quoted branch searches for something else", () => {
		const text = `if(contains(${ANSWER}, '"'), if(contains(${ANSWER}, "'"), 'match-none()', "village = 'other'"), concat('village = "', ${ANSWER}, '"'))`;
		const reading = readSearchFilterRow(text, filter, env);
		expect(
			reading.ok &&
				JSON.stringify(reading.predicate) ===
					JSON.stringify(eq(village, term(input(REGION)))),
			JSON.stringify(reading),
		).toBe(false);
		// Nova's own cascade of the same row is still one.
		const own = novaRow(eq(village, term(input(REGION))), filter);
		expect(readSearchFilterRow(own, filter, env)).toMatchObject({
			ok: true,
			level: "exact",
		});
	});

	it("reads Nova's own presence cascade back as the tree that wrote it, exactly", () => {
		const predicate = whenInput(
			input(REGION),
			eq(village, term(input(REGION))),
		);
		expect(
			readSearchFilterRow(novaRow(predicate, filter), filter, env),
		).toEqual({ ok: true, predicate, level: "exact", rewrites: [] });
	});

	it("reads a list of fixed values and one with a calculated item", () => {
		const fixed: Expression = eq(village, {
			kind: "value-list",
			items: [term(literal("north")), term(literal("south"))],
		});
		const calculated: Expression = whenInput(
			input(REGION),
			eq(village, {
				kind: "value-list",
				items: [term(literal("north")), term(input(REGION))],
			}),
		);
		for (const predicate of [fixed, calculated])
			expect(
				readSearchFilterRow(novaRow(predicate, condition), condition, env),
			).toEqual({ ok: true, predicate, level: "exact", rewrites: [] });
	});

	it("reads Nova's own selections and membership back as the trees that wrote them, exactly", () => {
		const tags = {
			kind: "prop",
			caseType: "patient",
			property: "tags",
		} as const;
		const selection = (
			values: readonly Expression[],
			quantifier: "any" | "all",
		): Expression =>
			({
				kind: "multi-select-contains",
				property: tags,
				values: values.map((one) =>
					one.kind === "term" && one.term.kind === "literal" ? one.term : one,
				),
				quantifier,
			}) as Expression;
		const fixed = [term(literal("a")), term(literal("b"))];
		const answered = term(input(REGION));
		for (const predicate of [
			selection(fixed, "any"),
			selection(fixed, "all"),
			whenInput(input(REGION), selection([answered], "any")),
			whenInput(input(REGION), selection([answered], "all")),
			whenInput(
				input(REGION),
				selection([fixed[0], answered] as Expression[], "all"),
			),
			{
				kind: "in",
				left: term(village),
				values: [literal("north"), literal("south")],
			} as Expression,
		])
			expect(
				readSearchFilterRow(novaRow(predicate, condition), condition, env),
			).toEqual({ ok: true, predicate, level: "exact", rewrites: [] });
	});

	it("reads HQ's other spellings of a selection as the selection Nova prints, and says the row is respelled", () => {
		// HQ's search names one function `selected` and `selected-any`, and `selected-all` finds what
		// the selection of each of its words finds where each word is one token.
		const tags = {
			kind: "prop",
			caseType: "patient",
			property: "tags",
		} as const;
		const fixed = (values: string[], quantifier: "any" | "all"): Expression =>
			({
				kind: "multi-select-contains",
				property: tags,
				values: values.map((value) => literal(value)),
				quantifier,
			}) as Expression;
		for (const [row, predicate] of [
			[`"selected-any(tags, 'a')"`, fixed(["a"], "any")],
			[`"selected-all(tags, 'a')"`, fixed(["a"], "any")],
			[`"selected-any(tags, 'a b')"`, fixed(["a", "b"], "any")],
			[`"selected-all(tags, 'a b')"`, fixed(["a", "b"], "all")],
		] as const)
			expect(readSearchFilterRow(row, condition, env)).toEqual({
				ok: true,
				predicate,
				level: "guards",
				rewrites: [],
				respelled: true,
			});
		// A word HQ's analyser may split is no one token: `selected-all` then finds what no
		// selection Nova prints finds.
		expect(
			readSearchFilterRow(`"selected-all(tags, 'well-child')"`, condition, env),
		).toMatchObject({ ok: false });
		// A value the device works out: `selected` is Nova's `selected-any`.
		const answered = `if(count(${ANSWER}), concat("selected(tags, '", ${ANSWER}, "')"), 'match-all()')`;
		expect(readSearchFilterRow(answered, condition, env)).toEqual({
			ok: true,
			predicate: whenInput(input(REGION), {
				kind: "multi-select-contains",
				property: tags,
				values: [term(input(REGION))],
				quantifier: "any",
			} as Expression),
			level: "guards",
			rewrites: ["search-value-guards"],
			respelled: true,
		});
	});

	it("reads a count of subcases bounded by a Search field's answer, and a case type test, as the trees that wrote them", () => {
		// The bound's zero is written bare by a choice around the answer.
		const counted: Expression = whenInput(input(REGION), {
			kind: "gt",
			left: {
				kind: "count",
				via: { kind: "subcase", identifier: "parent", ofCaseType: "visit" },
			},
			right: { kind: "double", value: term(input(REGION)) },
		});
		const ownType: Expression = eq(
			term({ kind: "case-row-type" }),
			term({ kind: "case-type", caseType: "patient" }),
		);
		for (const predicate of [counted, ownType])
			expect(
				readSearchFilterRow(novaRow(predicate, condition), condition, env),
			).toMatchObject({ ok: true, predicate });
	});

	it("refuses a property name the device builds as computed at run time", () => {
		const reading = readSearchFilterRow(
			`concat(${ANSWER}, " = 'x'")`,
			filter,
			env,
		);
		expect(reading).toMatchObject({
			ok: false,
			claim: {
				entryId:
					"case-search/property-names-operators-or-function-names-computed-at-runtime",
			},
		});
	});

	describe("a value read from a lookup table's row", () => {
		const districts = lookupTableDefinition({
			id: lookupTableIdSchema.parse("01912d68-783e-7000-8000-00000000d001"),
			name: "Districts",
			tag: "districts",
			columns: [
				{
					id: lookupColumnIdSchema.parse(
						"01912d68-783e-7000-8000-00000000d002",
					),
					wireName: "id",
					label: "Id",
				},
			],
		});
		const lookup = new Map([[districts.id, districts]]);
		const tableEnv = { doc, lookup };
		const tableFilter = slotContext(
			doc,
			{ entity: "module", uuid: filter.slot.uuid, slot: "case_list_filter" },
			new Map([
				[
					districts.id,
					new Map(districts.columns.map((one) => [one.id, one.dataType])),
				],
			]),
		);
		if (tableFilter === undefined) throw new Error("No case list filter slot.");
		const firstDistrict: Expression = {
			kind: "table-lookup",
			tableId: districts.id,
			resultColumnId: districts.columns[0].id,
			where: { kind: "match-all" },
		};

		it("reads Nova's own row back as the tree that wrote it", () => {
			const predicate = eq(village, firstDistrict);
			const wire = emitCsql(predicate, {
				types: tableFilter,
				bindings: {
					lookup: {
						naming: lookupWireNaming([districts]),
						instanceScope: "suite",
					},
				},
			}).wrapper;
			const text = serializeWire(wire, {
				target: "hq-json",
				interpolation: "none",
			}).text;
			expect(readSearchFilterRow(text, tableFilter, tableEnv)).toMatchObject({
				ok: true,
				predicate,
			});
		});

		it("keeps the first lookup cell and adds the empty-table and quote guards", () => {
			const text = `concat("village = '", instance('item-list:districts')/districts_list/districts[1]/id, "'")`;
			expect(readSearchFilterRow(text, tableFilter, tableEnv)).toMatchObject({
				ok: true,
				predicate: eq(village, firstDistrict),
				rewrites: expect.arrayContaining([
					"search-value-guards",
					"empty-rows-guard",
				]),
			});
		});
	});

	it("leaves text no CSQL reading holds unrecognized", () => {
		expect(readSearchFilterRow("'village ='", filter, env)).toEqual({
			ok: false,
			unrecognized: true,
			reason: "differs:string",
		});
	});
});

describe("an ancestor's id compared with a chosen case's", () => {
	const PATIENTS = testUuid("csql-ancestor-patients");
	const HOUSEHOLDS = testUuid("csql-ancestor-households");
	const LINKED = testUuid("csql-ancestor-linked");
	/** The ancestor through `identifier`, typed `household`, whose id is the
	 *  household the worker chose before the patients' list. */
	function chosenHousehold(identifier: string): Expression {
		return {
			kind: "exists",
			via: {
				kind: "ancestor",
				via: [{ identifier, throughCaseType: "household" }],
			},
			where: eq(prop("household", "case_id"), {
				kind: "term",
				term: {
					kind: "session-datum",
					datum: { kind: "selected-case", module: HOUSEHOLDS },
				},
			}),
		};
	}
	/** Patients chosen after their household, whose Search field `linked`
	 *  holds `condition`. */
	function app(condition: Expression) {
		const config = caseListConfig([{ field: "case_name", header: "Name" }]);
		config.searchInputs = [
			advancedSearchInputDef(LINKED, "linked", "Linked", "text", condition),
		];
		return buildDoc({
			appName: "Households",
			caseTypes: [
				{ name: "household", properties: [] },
				{
					name: "patient",
					parent_type: "household",
					properties: [
						{ name: "village", label: proseText("Village"), data_type: "text" },
					],
				},
			],
			modules: [
				{
					uuid: "csql-ancestor-households",
					name: "Households",
					caseType: "household",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							name: "Visit household",
							type: "followup",
							fields: [f({ kind: "text", id: "note", label: "Note" })],
						},
					],
				},
				{
					uuid: "csql-ancestor-patients",
					name: "Patients",
					caseType: "patient",
					parentCaseModuleUuid: "csql-ancestor-households",
					caseListConfig: config,
					caseSearchConfig: {},
					forms: [
						{
							name: "Visit",
							type: "followup",
							fields: [f({ kind: "text", id: "seen", label: "Seen" })],
						},
					],
				},
			],
		});
	}

	for (const identifier of ["host", "parent"])
		it(`reads Nova's own row through \`${identifier}\`, which names no case type, back to the typed step that wrote it`, async () => {
			const condition = chosenHousehold(identifier);
			const doc = app(condition);
			const outcome = readHqApp(
				await inputFor(exportedBody(doc), {
					resolver: matchingResolver(
						"app-1",
						externalIdentityMap(doc, DERIVED_WIRE_IDENTITY),
					),
				}),
			);
			expect(outcome.kind === "account" ? outcome.findings : []).toEqual([]);
			if (outcome.kind !== "read") throw new Error("The export did not read.");
			// A condition that reads no Search field is the search's own, never the field's.
			const config = outcome.draft.doc.modules[PATIENTS]?.caseListConfig;
			expect(heldCondition(config, readsSearchField(condition))).toEqual(
				condition,
			);
		});
});

describe("a selection and a membership read back from Nova's own Search field", () => {
	const PATIENTS = testUuid("csql-selection-patients");
	const PICKED = testUuid("csql-selection-picked");
	const answer = term(input(PICKED));
	const selects = (
		values: readonly (ReturnType<typeof literal> | Expression)[],
		quantifier: "any" | "all",
		caseType = "patient",
	): Expression =>
		({
			kind: "multi-select-contains",
			property: { kind: "prop", caseType, property: "tags" },
			values,
			quantifier,
		}) as Expression;
	const visits = (where: Expression): Expression => ({
		kind: "exists",
		via: { kind: "subcase", identifier: "parent", ofCaseType: "visit" },
		where,
	});
	const a = literal("a");
	const b = literal("b");
	const whenPicked = (clause: Expression) => whenInput(input(PICKED), clause);
	const among = (...values: string[]): Expression => ({
		kind: "in",
		left: term(village),
		values: values.map((one) => literal(one)) as [
			ReturnType<typeof literal>,
			...ReturnType<typeof literal>[],
		],
	});
	/** Patients searched by an advanced field `picked` whose condition is `condition`. */
	function app(condition: Expression) {
		const config = caseListConfig([{ field: "case_name", header: "Name" }]);
		config.searchInputs = [
			advancedSearchInputDef(PICKED, "picked", "Picked", "text", condition),
		];
		return buildDoc({
			appName: "Selections",
			caseTypes: [
				{
					name: "patient",
					properties: [
						{
							name: "tags",
							label: proseText("Tags"),
							data_type: "multi_select",
						},
						{ name: "village", label: proseText("Village"), data_type: "text" },
					],
				},
				{
					name: "visit",
					parent_type: "patient",
					properties: [
						{
							name: "tags",
							label: proseText("Tags"),
							data_type: "multi_select",
						},
					],
				},
			],
			modules: [
				{
					uuid: "csql-selection-patients",
					name: "Patients",
					caseType: "patient",
					caseListConfig: config,
					caseSearchConfig: {},
					forms: [
						{
							name: "Visit",
							type: "followup",
							fields: [f({ kind: "text", id: "seen", label: "Seen" })],
						},
					],
				},
			],
		});
	}
	// Each condition, and the tree its export reads back as: the canonical
	// tree of the condition (`canonical.ts`, `selection-per-value` and
	// `csql-parenthesized-join`).
	const conditions: readonly {
		readonly name: string;
		readonly condition: Expression;
		readonly reads: Expression;
	}[] = [
		{
			name: "several fixed values, any of them (`selected` joined by or)",
			condition: selects([a, b], "any"),
			reads: selects([a, b], "any"),
		},
		{
			name: "several fixed values, all of them (`selected` joined by and)",
			condition: whenPicked(selects([a, b], "all")),
			reads: whenPicked(selects([a, b], "all")),
		},
		{
			name: "one fixed value, all of it (`selected`, which tests any)",
			condition: whenPicked(selects([a], "all")),
			reads: whenPicked(selects([a], "any")),
		},
		{
			name: "the answer's values, any of them (`selected-any`)",
			condition: whenPicked(selects([answer], "any")),
			reads: whenPicked(selects([answer], "any")),
		},
		{
			name: "the answer's values, all of them (`selected-all`)",
			condition: whenPicked(selects([answer], "all")),
			reads: whenPicked(selects([answer], "all")),
		},
		{
			name: "a fixed value and the answer's values, all of them",
			condition: whenPicked(selects([a, answer], "all")),
			reads: whenPicked(selects([a, answer], "all")),
		},
		{
			name: "a selection of several values in an `and`",
			condition: whenPicked(
				and(eq(village, term(literal("north"))), selects([a, b], "any")),
			),
			reads: whenPicked(
				and(eq(village, term(literal("north"))), selects([a, b], "any")),
			),
		},
		{
			name: "an `or` of one-value tests in an `and`, which prints the selection",
			condition: whenPicked(
				and(
					eq(village, term(literal("north"))),
					or(selects([a], "any"), selects([b], "any")),
				),
			),
			reads: whenPicked(
				and(eq(village, term(literal("north"))), selects([a, b], "any")),
			),
		},
		{
			name: "a related case's selection of several values",
			condition: visits(selects([a, b], "any", "visit")),
			reads: visits(selects([a, b], "any", "visit")),
		},
		{
			name: "a related case's `or` of one-value tests",
			condition: visits(
				or(selects([a], "any", "visit"), selects([b], "any", "visit")),
			),
			reads: visits(
				or(selects([a], "any", "visit"), selects([b], "any", "visit")),
			),
		},
		{
			// HQ's comparison of a date and time is the range from the value to
			// itself, so Nova prints the inequality as the not of that range.
			name: "a related case's inequality of a date and time with its last change",
			condition: visits(
				neq(
					term(datetimeLiteral("2025-12-31T23:59:59.5Z")),
					term(prop("visit", "last_modified")),
				),
			),
			reads: visits(
				neq(
					term(prop("visit", "last_modified")),
					term(datetimeLiteral("2025-12-31T23:59:59.5Z")),
				),
			),
		},
		{
			name: "a membership, alone and in an `or`",
			condition: or(among("north", "south"), selects([a], "any")),
			reads: or(among("north", "south"), selects([a], "any")),
		},
		{
			name: "a list of values (`unwrap-list`)",
			condition: whenPicked(
				eq(village, {
					kind: "value-list",
					items: [term(literal("north")), answer],
				}),
			),
			reads: whenPicked(
				eq(village, {
					kind: "value-list",
					items: [term(literal("north")), answer],
				}),
			),
		},
	];
	for (const one of conditions)
		it(`reads ${one.name} back as its canonical tree, with no finding`, async () => {
			const doc = app(one.condition);
			const outcome = readHqApp(
				await inputFor(exportedBody(doc), {
					resolver: matchingResolver(
						"app-1",
						externalIdentityMap(doc, DERIVED_WIRE_IDENTITY),
					),
				}),
			);
			expect(outcome.kind === "account" ? outcome.findings : []).toEqual([]);
			if (outcome.kind !== "read") throw new Error("The export did not read.");
			// A condition that reads no Search field is the search's own, never the field's.
			const ownField = readsSearchField(one.condition);
			const read = heldCondition(
				outcome.draft.doc.modules[PATIENTS]?.caseListConfig,
				ownField,
			);
			expect(read).toEqual(one.reads);
			const context = slotContext(
				outcome.draft.doc,
				ownField
					? {
							entity: "module",
							uuid: PATIENTS,
							slot: "search_input_predicate",
							member: { searchInputUuid: PICKED },
						}
					: { entity: "module", uuid: PATIENTS, slot: "case_search_filter" },
				new Map(),
			);
			if (context === undefined) throw new Error("The condition has no slot.");
			expect(canonicalExpression(one.condition, context)).toEqual(one.reads);
		});
});

describe("a device's choice among a row's clauses", () => {
	const statusIs = (value: string): Expression =>
		eq(village, term(literal(value)));
	const choice: Expression = {
		kind: "switch",
		on: term(village),
		cases: [
			// biome-ignore lint/suspicious/noThenProperty: a case's value, never awaited.
			{ when: { kind: "literal", value: "a" }, then: statusIs("x") },
			// biome-ignore lint/suspicious/noThenProperty: a case's value, never awaited.
			{ when: { kind: "literal", value: "b" }, then: { kind: "match-none" } },
		],
		fallback: { kind: "match-all" },
	};
	it("reads HQ's own choice of each case of a switch whose subject reads the case as that switch", () => {
		expect(readSearchFilterRow(novaRow(choice, filter), filter, env)).toEqual({
			ok: true,
			predicate: choice,
			level: "exact",
			rewrites: [],
		});
	});

	it("names a property a choice's run reads where its marker stands: of the related case inside a relation's filter", () => {
		const outcome = term(prop("visit", "outcome"));
		const related: Expression = {
			kind: "exists",
			via: { kind: "subcase", identifier: "parent", ofCaseType: "visit" },
			where: {
				kind: "if",
				cond: eq(
					{
						kind: "coalesce",
						values: [term(literal("b")), term(literal("a"))],
					},
					term(literal("a")),
				),
				// biome-ignore lint/suspicious/noThenProperty: an expression branch, never awaited.
				then: { kind: "match-none" },
				else: eq(outcome, term(literal("x"))),
			},
		};
		const row = novaRow(related, filter);
		expect(searchRowProperties(row)).toEqual([]);
		expect(searchRowRelations(row, "patient").properties).toEqual([
			{ caseType: "visit", property: "outcome" },
		]);
	});
});
