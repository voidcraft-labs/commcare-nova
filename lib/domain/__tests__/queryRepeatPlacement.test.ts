/**
 * The query repeat placement rule over a complete form's structure: which
 * shapes model iteration runs (its rows taken once, when the form opens) and
 * which need the count placement. The plausible failure is a rule that admits
 * model iteration where its rows would be wrong: a nested repeat, a query
 * over answers, or a group whose condition turns it on mid-entry.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, type FieldSpec } from "@/lib/__tests__/docHelpers";
import {
	concat,
	eq,
	formField,
	input,
	literal,
	now,
	prop,
	term,
	today,
} from "../expression/builders";
import { formStructure } from "../expression/formStructure";
import type { Expression } from "../expression/types";
import type { LookupColumnId, LookupTableId } from "../lookupIds";
import {
	effectiveQueryRepeatPlacement,
	type QueryRepeatPlacement,
	queryRepeatPlacementExpresses,
	queryRepeatPlacementNeeds,
} from "../queryRepeatPlacement";

const MODULE = testUuid("placement-module");
const FORM = testUuid("placement-form");
const REPEAT = testUuid("placement-repeat");
const OUTER = testUuid("placement-outer");
const MIDDLE = testUuid("placement-middle");
const GROUP = testUuid("placement-group");
const INNER_GROUP = testUuid("placement-inner-group");
const SECTION = testUuid("placement-section");
const ANSWER = testUuid("placement-answer");
const SEARCH = testUuid("placement-search");
const TABLE = "01900000-0000-7000-8000-000000000001" as LookupTableId;
const COLUMN = "01900000-0000-7000-8000-000000000002" as LookupColumnId;

const openCases: Expression = {
	kind: "project",
	of: {
		kind: "cases",
		source: "casedb",
		where: [eq(prop("visit", "status"), literal("open"))],
	},
	value: { kind: "literal", value: "@case_id" },
};

function queryRepeat(
	idsQuery: Expression,
	extra: Record<string, unknown> = {},
): FieldSpec {
	return {
		kind: "repeat",
		id: "visits",
		uuid: REPEAT,
		repeat_mode: "query_bound",
		data_source: { ids_query: idsQuery },
		children: [{ kind: "text", id: "note" }],
		...extra,
	};
}

/** One form holding `fields` beside an integer answer the queries may read. */
function structureOf(fields: FieldSpec[]) {
	const doc = buildDoc({
		modules: [
			{
				uuid: MODULE,
				name: "Visits",
				caseType: "visit",
				forms: [
					{
						uuid: FORM,
						name: "Review",
						type: "followup",
						fields: [{ kind: "int", id: "size", uuid: ANSWER }, ...fields],
					},
				],
			},
		],
	});
	const form = formStructure(doc, FORM);
	if (form === undefined) throw new Error("The fixture form is missing.");
	return form;
}

function verdict(fields: FieldSpec[]) {
	const form = structureOf(fields);
	return {
		needs: queryRepeatPlacementNeeds(form, REPEAT),
		placement: effectiveQueryRepeatPlacement(form, REPEAT),
		expresses: (placement: QueryRepeatPlacement) =>
			queryRepeatPlacementExpresses(form, REPEAT, placement),
	};
}

describe("a query that reads no answer", () => {
	const queries: Record<string, Expression> = {
		"today()": concat(openCases, today()),
		"now()": concat(openCases, now()),
		"a case query": openCases,
		"the form's case": term({
			kind: "form-case",
			caseType: "visit",
			property: "household",
		}),
		"a Search answer": term(input(SEARCH)),
		"a lookup read": {
			kind: "project",
			of: { kind: "table-rows", tableId: TABLE, where: [] },
			value: { kind: "table-column", tableId: TABLE, columnId: COLUMN },
		},
	};
	for (const [name, query] of Object.entries(queries)) {
		it(`reading ${name} takes model iteration`, () => {
			const result = verdict([queryRepeat(query)]);
			expect(result.needs).toEqual([]);
			expect(result.placement).toBe("model-iteration");
			expect(result.expresses("model-iteration")).toBe(true);
			expect(result.expresses("count")).toBe(true);
		});
	}
});

describe("a query that reads an answer", () => {
	const queries: Record<string, Expression> = {
		"a question": eq(term(formField(ANSWER)), literal(2)),
		"a form node": term({
			kind: "form-node",
			node: { kind: "form-root", form: FORM },
			spelling: "relative",
		}),
		"another repeat's row": term({
			kind: "repeat-row",
			repeat: OUTER,
			attribute: "index",
		}),
	};
	for (const [name, query] of Object.entries(queries)) {
		it(`reading ${name} needs the count placement`, () => {
			const result = verdict([
				{
					kind: "repeat",
					id: "outer_rows",
					uuid: OUTER,
					repeat_mode: "user_controlled",
					children: [{ kind: "text", id: "outer_note" }],
				},
				queryRepeat(concat(openCases, query)),
			]);
			expect(result.needs).toEqual([{ kind: "query-reads-answers" }]);
			expect(result.placement).toBe("count");
			expect(result.expresses("model-iteration")).toBe(false);
			expect(result.expresses("count")).toBe(true);
		});
	}
});

/* Model iteration gives a new row the place `int(@current_index)`, and
 * `@current_index` is `count(<rows>)`, which counts only the relevant rows
 * (Core `XPathLazyNodeset.java::performEvaluation`): a row made while the
 * condition hides an earlier one would take an earlier row's record. */
describe("a query repeat with a condition", () => {
	it("needs the count placement, whatever the condition reads", () => {
		const result = verdict([
			queryRepeat(openCases, {
				relevant: eq(
					term({ kind: "repeat-row", repeat: REPEAT, attribute: "id" }),
					literal("b"),
				),
			}),
		]);
		expect(result.needs).toEqual([{ kind: "row-condition" }]);
		expect(result.placement).toBe("count");
		expect(result.expresses("model-iteration")).toBe(false);
	});

	it("lists the condition after the query's own need", () => {
		const result = verdict([
			queryRepeat(term(formField(ANSWER)), {
				relevant: eq(term(formField(ANSWER)), literal(1)),
			}),
		]);
		expect(result.needs).toEqual([
			{ kind: "query-reads-answers" },
			{ kind: "row-condition" },
		]);
	});
});

describe("what surrounds the repeat", () => {
	it("names the nearest enclosing repeat of any mode", () => {
		const result = verdict([
			{
				kind: "repeat",
				id: "outer_rows",
				uuid: OUTER,
				repeat_mode: "user_controlled",
				children: [
					{
						kind: "repeat",
						id: "middle_rows",
						uuid: MIDDLE,
						repeat_mode: "count_bound",
						repeat_count: literal(2),
						children: [
							{
								kind: "group",
								id: "plain",
								uuid: GROUP,
								children: [queryRepeat(openCases)],
							},
						],
					},
				],
			},
		]);
		expect(result.needs).toEqual([{ kind: "nested", repeatUuid: MIDDLE }]);
		expect(result.placement).toBe("count");
	});

	it("needs the count placement under a group whose condition calls now()", () => {
		const result = verdict([
			{
				kind: "group",
				id: "late",
				uuid: GROUP,
				relevant: { kind: "gt", left: now(), right: literal("2026-01-01") },
				children: [queryRepeat(openCases)],
			},
		]);
		expect(result.needs).toEqual([
			{ kind: "ancestor-condition-changes", groupUuid: GROUP },
		]);
		expect(result.placement).toBe("count");
	});

	it("names the nearest group whose condition reads an answer", () => {
		const result = verdict([
			{
				kind: "group",
				id: "outer_group",
				uuid: GROUP,
				relevant: eq(term(formField(ANSWER)), literal(1)),
				children: [
					{
						kind: "group",
						id: "inner_group",
						uuid: INNER_GROUP,
						relevant: eq(term(formField(ANSWER)), literal(1)),
						children: [queryRepeat(openCases)],
					},
				],
			},
		]);
		expect(result.needs).toEqual([
			{ kind: "ancestor-condition-changes", groupUuid: INNER_GROUP },
		]);
	});

	it("keeps model iteration under a group whose condition reads only today()", () => {
		const result = verdict([
			{
				kind: "group",
				id: "dated",
				uuid: GROUP,
				relevant: { kind: "gt", left: today(), right: literal("2026-01-01") },
				children: [queryRepeat(openCases)],
			},
		]);
		expect(result.needs).toEqual([]);
		expect(result.placement).toBe("model-iteration");
	});

	it("keeps model iteration inside a section, which has no condition", () => {
		const result = verdict([
			{
				kind: "section",
				id: "page",
				uuid: SECTION,
				children: [queryRepeat(openCases)],
			},
		]);
		expect(result.needs).toEqual([]);
		expect(result.placement).toBe("model-iteration");
	});

	it("lists the query's need first, then the needs around it nearest first", () => {
		const result = verdict([
			{
				kind: "repeat",
				id: "outer_rows",
				uuid: OUTER,
				repeat_mode: "user_controlled",
				children: [
					{
						kind: "group",
						id: "shown",
						uuid: GROUP,
						relevant: eq(term(formField(ANSWER)), literal(1)),
						children: [queryRepeat(term(formField(ANSWER)))],
					},
				],
			},
		]);
		expect(result.needs).toEqual([
			{ kind: "query-reads-answers" },
			{ kind: "ancestor-condition-changes", groupUuid: GROUP },
			{ kind: "nested", repeatUuid: OUTER },
		]);
	});
});

describe("a held placement", () => {
	it("is returned against the rule's answer, in both directions", () => {
		const heldCount = verdict([queryRepeat(openCases, { placement: "count" })]);
		expect(heldCount.needs).toEqual([]);
		expect(heldCount.placement).toBe("count");

		const heldIteration = verdict([
			queryRepeat(term(formField(ANSWER)), { placement: "model-iteration" }),
		]);
		expect(heldIteration.placement).toBe("model-iteration");
		// The hold is out of shape: model iteration no longer expresses it.
		expect(heldIteration.expresses("model-iteration")).toBe(false);
	});
});
