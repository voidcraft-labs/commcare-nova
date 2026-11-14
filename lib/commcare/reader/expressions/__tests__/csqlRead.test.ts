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
import {
	and,
	eq,
	input,
	literal,
	or,
	prop,
	term,
	whenInput,
} from "@/lib/domain/expression/builders";
import { slotContext } from "@/lib/domain/expression/context";
import type { Expression } from "@/lib/domain/expression/types";
import { advancedSearchInputDef } from "@/lib/domain/modules";
import { proseText } from "@/lib/domain/prose";
import { emitCsql } from "../../../csql/emitter";
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
			const field =
				outcome.draft.doc.modules[PATIENTS]?.caseListConfig?.searchInputs[0];
			expect(field?.kind === "advanced" ? field.predicate : field).toEqual(
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
			const field =
				outcome.draft.doc.modules[PATIENTS]?.caseListConfig?.searchInputs[0];
			const read = field?.kind === "advanced" ? field.predicate : field;
			expect(read).toEqual(one.reads);
			const context = slotContext(
				outcome.draft.doc,
				{
					entity: "module",
					uuid: PATIENTS,
					slot: "search_input_predicate",
					member: { searchInputUuid: PICKED },
				},
				new Map(),
			);
			if (context === undefined) throw new Error("The condition has no slot.");
			expect(canonicalExpression(one.condition, context)).toEqual(one.reads);
		});
});
