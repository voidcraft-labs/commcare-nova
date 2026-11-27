/**
 * One record slot of HQ's JSON read from its text: interpolated as HQ's
 * build interpolates it, bound with the record rule set's folds, printed by
 * the production HQ JSON emitter and interpolated again. The failures this
 * holds: `#parent` not read as the relation, `cond` refused where it is the
 * nested `if` it equals, an `or` of equalities, a pair of orderings or a
 * nested `if` not folded to the one card Nova has, a date literal left text
 * against a date, a filter holding a boolean identity left unrecognized
 * where the withheld print holds it, a non-equality host read held, `current()` in a case list refused where it names the listed
 * case, a `name` step read as the case's name, and a Search answer in a
 * menu's own slot left unbound. Read by the whole stage: a form's display
 * condition naming the case and the worker not held; a menu's display
 * condition naming the case held, where HQ cannot interpolate it; the health
 * starter's filter not held; a filter Nova wrote with a clause on a Search
 * answer read from the detail text with that clause; Nova's counts over an
 * ancestor and over every relation of an index not read back as counts;
 * numbers in an `or` of equalities or a nested `if` left unfolded; a claim
 * named otherwise than by its column's header or its Search field's name;
 * and a menu's condition a device cannot evaluate let through behind a
 * leading `false()`.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { EMISSION_REWRITE_IDS } from "@/lib/commcare/emissionRewrites";
import { parseFormExpression } from "@/lib/commcare/xpath/expressionAst";
import type { BlueprintDoc } from "@/lib/domain/blueprint";
import {
	instanceReadsDoc,
	reads,
} from "@/lib/domain/expression/__tests__/instanceReadsFixture";
import type { Expression, SlotContextRef } from "@/lib/domain/expression/types";
import { calculatedColumn, simpleSearchInputDef } from "@/lib/domain/modules";
import type { PendingExpression } from "../../pendingExpressions";
import { readExpressions } from "../index";
import { printSlot, readExpression, readingScope } from "../readExpression";
import { readEnv, registration } from "./expressionReadFixture";

const COLUMN = testUuid("calculated-column");

function patientsDoc() {
	return buildDoc({
		caseTypes: [
			{
				name: "household",
				properties: [{ name: "village", label: "Village" }],
			},
			{
				name: "patient",
				parent_type: "household",
				properties: [
					{ name: "age", label: "Age", data_type: "int" },
					{ name: "dob", label: "Date of birth", data_type: "date" },
					{ name: "p", label: "P" },
				],
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: {
					columns: [
						calculatedColumn(COLUMN, "Group", {
							kind: "term",
							term: { kind: "literal", value: "" },
						}),
					],
					searchInputs: [],
				},
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [f({ kind: "text", id: "q1", label: "Q1" })],
					},
				],
			},
		],
	});
}

function moduleOf(doc: ReturnType<typeof patientsDoc>) {
	return doc.moduleOrder[0] as (typeof doc.moduleOrder)[number];
}

function held(judgment: ReturnType<typeof readExpression>): Expression {
	expect(judgment.kind).toBe("bound");
	if (judgment.kind !== "bound") throw new Error("not bound");
	expect(judgment.equal).toBe(true);
	return judgment.candidate;
}

describe("a record slot's text read as HQ's build interpolates it", () => {
	it("reads #parent in the case list filter as the parent relation", () => {
		const doc = patientsDoc();
		const ref = {
			entity: "module",
			uuid: moduleOf(doc),
			slot: "case_list_filter",
		} as const;
		// HQ's casedb join binds as the relation read; Nova writes a scalar
		// test of a relation as a presence test of the related case, so the
		// join itself prints otherwise and is no exact reading.
		const judgment = readExpression(
			doc,
			registration(doc, ref, "#parent/village = 'x'"),
			readEnv(),
		);
		expect(judgment).toMatchObject({
			kind: "bound",
			equal: false,
			candidate: {
				kind: "eq",
				left: {
					kind: "term",
					term: {
						kind: "prop",
						caseType: "patient",
						property: "village",
						via: { kind: "ancestor", via: [{ identifier: "parent" }] },
					},
				},
			},
		});
		// The presence test Nova writes reads back as the relation's presence.
		const presence = held(
			readExpression(
				doc,
				registration(
					doc,
					ref,
					"count(index/parent) > 0 and selected(join(' ', instance('casedb')/casedb/case[@case_type = 'household' and village = 'x']/@case_id), index/parent)",
				),
				readEnv(),
			),
		);
		expect(presence).toMatchObject({
			kind: "exists",
			via: {
				kind: "ancestor",
				via: [{ identifier: "parent", throughCaseType: "household" }],
			},
		});
	});

	it("refuses a bare dot, which HQ reads as the case node", () => {
		const doc = patientsDoc();
		const ref = {
			entity: "module",
			uuid: moduleOf(doc),
			slot: "case_list_filter",
		} as const;
		const judgment = readExpression(
			doc,
			registration(doc, ref, ". = 'x'"),
			readEnv(),
		);
		expect(judgment.kind === "bound" && judgment.equal).toBe(false);
	});

	it("reads cond in a calculated column as the nested if it equals", () => {
		const doc = patientsDoc();
		const ref = {
			entity: "module",
			uuid: moduleOf(doc),
			slot: "case_list_column_expression",
			member: { columnUuid: COLUMN },
		} as const;
		const tree = held(
			readExpression(
				doc,
				registration(
					doc,
					ref,
					"cond(age > 60, 'old', age > 18, 'adult', 'young')",
				),
				readEnv(),
			),
		);
		expect(tree).toMatchObject({ kind: "if", else: { kind: "if" } });
	});

	it("folds an or of equalities, a bounded pair and a nested if on one subject", () => {
		const doc = patientsDoc();
		const filter = {
			entity: "module",
			uuid: moduleOf(doc),
			slot: "case_list_filter",
		} as const;
		const column = {
			entity: "module",
			uuid: moduleOf(doc),
			slot: "case_list_column_expression",
			member: { columnUuid: COLUMN },
		} as const;
		expect(
			held(
				readExpression(
					doc,
					registration(doc, filter, "p = 'a' or p = 'b'"),
					readEnv(),
				),
			),
		).toMatchObject({ kind: "in", values: [{ value: "a" }, { value: "b" }] });
		expect(
			held(
				readExpression(
					doc,
					registration(doc, filter, "age >= 1 and age < 5"),
					readEnv(),
				),
			),
		).toMatchObject({
			kind: "between",
			lowerInclusive: true,
			upperInclusive: false,
		});
		expect(
			held(
				readExpression(
					doc,
					registration(doc, column, "if(p = 'a', 'x', if(p = 'b', 'y', 'z'))"),
					readEnv(),
				),
			),
		).toMatchObject({ kind: "switch", cases: [{}, {}] });
	});

	it("keeps a range whose bounds an author wrote upper first as the author's and", () => {
		const doc = patientsDoc();
		const filter = {
			entity: "module",
			uuid: moduleOf(doc),
			slot: "case_list_filter",
		} as const;
		// A `between` prints its lower bound first, so read as one this text
		// would print otherwise.
		expect(
			held(
				readExpression(
					doc,
					registration(doc, filter, "age < 5 and age >= 1"),
					readEnv(),
				),
			),
		).toMatchObject({
			kind: "and",
			clauses: [{ kind: "lt" }, { kind: "gte" }],
		});
	});

	it("types a date literal against a date and leaves one against text alone", () => {
		const doc = patientsDoc();
		const ref = {
			entity: "module",
			uuid: moduleOf(doc),
			slot: "case_list_filter",
		} as const;
		expect(
			held(
				readExpression(
					doc,
					registration(doc, ref, "dob > '2000-01-01'"),
					readEnv(),
				),
			),
		).toMatchObject({
			kind: "gt",
			right: {
				kind: "term",
				term: { kind: "literal", value: "2000-01-01", data_type: "date" },
			},
		});
		expect(
			held(
				readExpression(
					doc,
					registration(doc, ref, "p = '2000-01-01'"),
					readEnv(),
				),
			),
		).toMatchObject({
			kind: "eq",
			right: { kind: "term", term: { kind: "literal", value: "2000-01-01" } },
		});
	});

	it("holds a filter with a boolean identity at the withheld print alone", () => {
		const doc = patientsDoc();
		const ref = {
			entity: "module",
			uuid: moduleOf(doc),
			slot: "case_list_filter",
		} as const;
		const pending = registration(doc, ref, "true() and p = 'x'");
		const exact = readExpression(doc, pending, readEnv());
		expect(exact.kind === "bound" && exact.equal).toBe(false);
		const reached: string[] = [];
		const withheld = readExpression(doc, pending, readEnv(), {
			rewrites: {
				withhold: new Set(EMISSION_REWRITE_IDS),
				reached: (id) => reached.push(id),
			},
		});
		expect(withheld.kind === "bound" && withheld.equal).toBe(true);
		expect(reached).toContain("filter-identities-dropped");
	});

	it("binds current() as the listed case, at the slot's own row and inside a nested query", () => {
		const doc = patientsDoc();
		const filter = {
			entity: "module",
			uuid: moduleOf(doc),
			slot: "case_list_filter",
		} as const;
		const column = {
			entity: "module",
			uuid: moduleOf(doc),
			slot: "case_list_column_expression",
			member: { columnUuid: COLUMN },
		} as const;
		const listedP = {
			kind: "term",
			term: { kind: "prop", caseType: "patient", property: "p" },
		};
		expect(
			readExpression(
				doc,
				registration(doc, filter, "current()/p = 'x'"),
				readEnv(),
			),
		).toMatchObject({
			kind: "bound",
			candidate: { kind: "eq", left: listedP },
		});
		expect(
			readExpression(
				doc,
				registration(doc, column, "if(current()/p = 'a', 'x', 'y')"),
				readEnv(),
			),
		).toMatchObject({
			kind: "bound",
			candidate: { kind: "if", cond: { kind: "eq", left: listedP } },
		});
		// Core keeps the listed case as current() inside a nested predicate,
		// where Nova has no tree for it: the read binds, prints otherwise and
		// is left unread, never refused as text Core cannot run.
		const nested = readExpression(
			doc,
			registration(
				doc,
				filter,
				"count(instance('casedb')/casedb/case[@case_type = 'household'][village = current()/p]) > 0",
			),
			readEnv(),
		);
		expect(nested.kind).not.toBe("refused");
		expect(nested.kind === "bound" && nested.equal).toBe(false);
	});

	it("reads a case row's name step as the property name, never the case's name", () => {
		const doc = patientsDoc();
		const ref = {
			entity: "module",
			uuid: moduleOf(doc),
			slot: "case_list_filter",
		} as const;
		const judgment = readExpression(
			doc,
			registration(doc, ref, "name = 'x'"),
			readEnv(),
		);
		expect(judgment).toMatchObject({
			kind: "bound",
			candidate: {
				kind: "eq",
				left: { kind: "term", term: { kind: "prop", property: "name" } },
			},
		});
		expect(judgment.kind === "bound" && judgment.candidate).not.toMatchObject({
			left: { term: { property: "case_name" } },
		});
	});

	it("binds a Search answer read in a menu's own slot to the menu's field", () => {
		const doc = instanceReadsDoc();
		const ref = {
			entity: "module",
			uuid: reads.find,
			slot: "case_list_filter",
		} as const;
		const text =
			"instance('search-input:results')/input/field[@name = 'district'] = 'north'";
		const parsed = parseFormExpression(
			text,
			readingScope(doc, registration(doc, ref, text), readEnv(), new Set()),
		);
		expect(parsed).toMatchObject({
			ok: true,
			expression: {
				kind: "eq",
				left: {
					kind: "term",
					term: { kind: "input", searchInputUuid: reads.district },
				},
			},
		});
	});

	it("reads the direct host's text equality as the reached record", () => {
		const doc = patientsDoc();
		const ref = {
			entity: "module",
			uuid: moduleOf(doc),
			slot: "case_list_filter",
		} as const;
		const expression = held(
			readExpression(
				doc,
				registration(doc, ref, "#host/village = 'north'"),
				readEnv(),
			),
		);
		expect(expression).toMatchObject({
			kind: "eq",
			left: {
				kind: "term",
				term: {
					kind: "prop",
					caseType: "patient",
					property: "village",
					readReached: true,
					via: { kind: "ancestor", via: [{ identifier: "host" }] },
				},
			},
			right: { kind: "term", term: { kind: "literal", value: "north" } },
		});
	});

	it("keeps another comparison on the host outside the supported list filter", () => {
		const doc = patientsDoc();
		const ref = {
			entity: "module",
			uuid: moduleOf(doc),
			slot: "case_list_filter",
		} as const;
		const judgment = readExpression(
			doc,
			registration(doc, ref, "#host/village != 'x'"),
			readEnv(),
		);
		if (judgment.kind === "bound")
			expect(judgment.candidate).not.toMatchObject({
				left: {
					kind: "term",
					term: { kind: "prop", via: { kind: "ancestor" } },
				},
			});
		// The whole stage holds none of it: the slot claims its HELD-NEW
		// entry, for the host relation.
		const reading = readExpressions(
			doc,
			[registration(doc, ref, "#host/village != 'x'")],
			readEnv(),
		);
		expect(reading.bound[0]).toBeUndefined();
		expect(
			reading.claims
				.filter(
					(claim) => claim.source === 0 && claim.detail.reason !== undefined,
				)
				.map((claim) => [claim.entryId, claim.detail.reason]),
		).toEqual([
			[
				"menus-and-case-lists/detail-filter-value-outside-predicate",
				"relation:host",
			],
		]);
	});
});

/** One registration read by the whole stage: its held tree, or undefined,
 *  with the refusal it claims and its circumstances. */
function readOne(
	doc: BlueprintDoc,
	pending: PendingExpression,
	env = readEnv(),
) {
	const reading = readExpressions(doc, [pending], env);
	return {
		tree: reading.bound[0],
		claims: reading.claims.filter(
			(claim) => claim.source === 0 && claim.detail.reason !== undefined,
		),
		circumstances: reading.circumstances,
	};
}

/** `tree` printed by the emitter in `ref`, read back by the whole stage. */
function readBackOf(
	doc: BlueprintDoc,
	ref: SlotContextRef,
	tree: Expression,
	env = readEnv(),
) {
	return readOne(
		doc,
		registration(doc, ref, printSlot(doc, ref, tree, env)),
		env,
	);
}

describe("a record slot read by the whole expression stage", () => {
	const REGION = testUuid("record-region");
	/** The patients' menu, with a search whose field `region` names a village. */
	function searchedDoc() {
		return buildDoc({
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "age", label: "Age", data_type: "int" },
						{ name: "p", label: "P" },
					],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: {
						columns: [
							calculatedColumn(COLUMN, "Group", {
								kind: "term",
								term: { kind: "literal", value: "" },
							}),
						],
						searchInputs: [
							simpleSearchInputDef(REGION, "region", "Region", "text", "p", {
								required: { when: { kind: "match-all" } },
							}),
						],
					},
					caseSearchConfig: {},
					forms: [
						{
							name: "Visit",
							type: "followup",
							fields: [f({ kind: "text", id: "q1", label: "Q1" })],
						},
					],
				},
			],
		});
	}
	const p = (property: string): Expression => ({
		kind: "term",
		term: { kind: "prop", caseType: "patient", property },
	});
	const lit = (value: string | number): Expression => ({
		kind: "term",
		term: { kind: "literal", value },
	});

	it("reads a form's display condition naming the case and the worker", () => {
		const doc = patientsDoc();
		const form = doc.formOrder[moduleOf(doc)]?.[0];
		if (form === undefined) throw new Error("No form.");
		const ref = {
			entity: "form",
			uuid: form,
			slot: "form_display_condition",
		} as const;
		const read = readOne(
			doc,
			registration(doc, ref, "#case/p = 'x' and #user/role = 'chw'"),
		);
		expect(read.circumstances).toEqual([]);
		expect(read.tree).toMatchObject({
			kind: "and",
			clauses: [
				{
					kind: "eq",
					left: {
						kind: "term",
						term: { kind: "prop", caseType: "patient", property: "p" },
					},
				},
				{
					kind: "eq",
					left: { kind: "term", term: { kind: "session-user", field: "role" } },
				},
			],
		});
	});

	it("refuses a menu's display condition that names the case, which HQ cannot build", () => {
		const doc = patientsDoc();
		const ref = {
			entity: "module",
			uuid: moduleOf(doc),
			slot: "module_display_condition",
		} as const;
		const read = readOne(doc, registration(doc, ref, "#case/p = 'x'"));
		expect(read.tree).toBeUndefined();
		expect(read.claims).toEqual([
			expect.objectContaining({
				detail: expect.objectContaining({
					reason: expect.stringContaining("case-reference"),
				}),
			}),
		]);
	});

	it("holds the health starter's case list filter", () => {
		// `had_referral_checkup` is written by Hidden Values that give whole
		// numbers, as in the health starter.
		const doc = buildDoc({
			caseTypes: [{ name: "patient", properties: [] }],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: { columns: [], searchInputs: [] },
					forms: [
						{
							name: "Checkup",
							type: "followup",
							fields: [
								f({
									kind: "hidden",
									id: "had_referral_checkup",
									calculate: "1",
									caseWrite: {
										caseType: "patient",
										property: "had_referral_checkup",
									},
								}),
							],
						},
					],
				},
			],
		});
		const ref = {
			entity: "module",
			uuid: moduleOf(doc),
			slot: "case_list_filter",
		} as const;
		const read = readOne(
			doc,
			registration(
				doc,
				ref,
				"(referral ='Yes' or referral_anyway = 'yes_refer_now') and had_referral_checkup != 1",
			),
		);
		expect(read.circumstances).toEqual([]);
		expect(read.tree).toMatchObject({ kind: "and" });
	});

	it("reads a filter Nova wrote with a clause on a Search answer from the detail text without it", () => {
		const doc = searchedDoc();
		const ref = {
			entity: "module",
			uuid: moduleOf(doc),
			slot: "case_list_filter",
		} as const;
		const tree: Expression = {
			kind: "and",
			clauses: [
				{ kind: "eq", left: p("p"), right: lit("x") },
				{
					kind: "when-input-present",
					input: { kind: "input", searchInputUuid: REGION },
					clause: {
						kind: "eq",
						left: p("p"),
						right: {
							kind: "term",
							term: { kind: "input", searchInputUuid: REGION },
						},
					},
				},
			],
		};
		// The detail's filter holds what a case list can evaluate; the clause
		// on the Search answer is the search's own row, which the search
		// reader reads.
		const read = readBackOf(doc, ref, tree);
		expect(read.circumstances).toEqual([]);
		expect(read.tree).toEqual(tree.clauses[0]);
	});

	it("reads Nova's counts over an ancestor and over every relation of an index back as counts", () => {
		const doc = patientsDoc();
		const ref = {
			entity: "module",
			uuid: moduleOf(doc),
			slot: "case_list_column_expression",
			member: { columnUuid: COLUMN },
		} as const;
		for (const tree of [
			{
				kind: "count",
				via: {
					kind: "ancestor",
					via: [{ identifier: "parent", throughCaseType: "household" }],
				},
			},
			{
				kind: "count",
				via: {
					kind: "any-relation",
					identifier: "link",
					ofCaseType: "patient",
				},
			},
		] as const satisfies readonly Expression[]) {
			const read = readBackOf(doc, ref, tree);
			expect(read.circumstances, JSON.stringify(tree)).toEqual([]);
			expect(read.tree).toEqual(tree);
		}
	});

	it("reads Nova's presence tests of subcases and of every relation of an index back", () => {
		// A household list, whose patients are its subcases.
		const doc = buildDoc({
			caseTypes: [
				{
					name: "household",
					properties: [{ name: "village", label: "Village" }],
				},
				{
					name: "patient",
					parent_type: "household",
					properties: [{ name: "age", label: "Age", data_type: "int" }],
				},
			],
			modules: [
				{
					name: "Households",
					caseType: "household",
					caseListConfig: { columns: [], searchInputs: [] },
					forms: [
						{
							name: "Visit",
							type: "followup",
							fields: [f({ kind: "text", id: "q1", label: "Q1" })],
						},
					],
				},
			],
		});
		const ref = {
			entity: "module",
			uuid: moduleOf(doc),
			slot: "case_list_filter",
		} as const;
		const adult: Expression = {
			kind: "gte",
			left: {
				kind: "term",
				term: { kind: "prop", caseType: "patient", property: "age" },
			},
			right: { kind: "term", term: { kind: "literal", value: 18 } },
		};
		const subcases = {
			kind: "subcase",
			identifier: "parent",
			ofCaseType: "patient",
		} as const;
		const everyLink = {
			kind: "any-relation",
			identifier: "link",
			ofCaseType: "patient",
		} as const;
		for (const tree of [
			{ kind: "exists", via: subcases },
			{ kind: "exists", via: subcases, where: adult },
			{ kind: "missing", via: subcases, where: adult },
			{ kind: "exists", via: everyLink },
			{ kind: "missing", via: everyLink, where: adult },
		] as const satisfies readonly Expression[]) {
			const read = readBackOf(doc, ref, tree);
			expect(read.circumstances, JSON.stringify(tree)).toEqual([]);
			expect(read.claims, JSON.stringify(tree)).toEqual([]);
			expect(read.tree).toEqual(tree);
		}
	});

	it("folds numbers into an in and a switch as it folds text", () => {
		const doc = patientsDoc();
		const filter = {
			entity: "module",
			uuid: moduleOf(doc),
			slot: "case_list_filter",
		} as const;
		const column = {
			entity: "module",
			uuid: moduleOf(doc),
			slot: "case_list_column_expression",
			member: { columnUuid: COLUMN },
		} as const;
		expect(
			readOne(doc, registration(doc, filter, "age = 1 or age = 2")).tree,
		).toEqual({
			kind: "in",
			left: p("age"),
			values: [
				{ kind: "literal", value: 1 },
				{ kind: "literal", value: 2 },
			],
		});
		expect(
			readOne(
				doc,
				registration(doc, column, "if(age = 1, 'a', if(age = 2, 'b', 'c'))"),
			).tree,
		).toMatchObject({
			kind: "switch",
			cases: [{ when: { value: 1 } }, { when: { value: 2 } }],
		});
	});

	it("names a calculated column's claim by its header and a Search field's by its name", () => {
		const doc = searchedDoc();
		const column = {
			entity: "module",
			uuid: moduleOf(doc),
			slot: "case_list_column_expression",
			member: { columnUuid: COLUMN },
		} as const;
		const required = {
			entity: "module",
			uuid: moduleOf(doc),
			slot: "search_input_required_when",
			member: { searchInputUuid: REGION },
		} as const;
		const reading = readExpressions(
			doc,
			[
				registration(doc, column, "int(age)"),
				registration(doc, required, "int('1') = 1"),
			],
			readEnv(),
		);
		expect(reading.bound).toEqual([undefined, undefined]);
		expect(
			reading.claims
				.filter((claim) => claim.detail.reason !== undefined)
				.map((claim) => claim.detail.name),
		).toEqual(["Group", "region"]);
	});

	it("checks a menu's display condition after a leading false() for a device", () => {
		const doc = patientsDoc();
		const ref = {
			entity: "module",
			uuid: moduleOf(doc),
			slot: "module_display_condition",
		} as const;
		// A day added to the clock, which a device cannot add without losing
		// the time of day, so Nova's emitter writes nothing for it.
		const notOnDevice = readOne(
			doc,
			registration(
				doc,
				ref,
				"false() and format-date(date(floor(now() + 1)), '%Y') = '2020'",
			),
		);
		expect(notOnDevice.circumstances).toEqual([]);
		expect(notOnDevice.tree).toBeUndefined();
		expect(
			notOnDevice.claims.filter((claim) => claim.detail.reason !== undefined),
		).toEqual([
			expect.objectContaining({
				detail: expect.objectContaining({
					reason: "validator:DISPLAY_CONDITION_NOT_ON_DEVICE",
				}),
			}),
		]);
		// The hidden spelling alone is no refusal: the menu reader reads it.
		const hidden = readOne(
			doc,
			registration(doc, ref, "false() and today() > date('2020-01-01')"),
		);
		expect(hidden.tree).toMatchObject({
			kind: "and",
			clauses: [{ kind: "match-none" }, {}],
		});
	});
});
