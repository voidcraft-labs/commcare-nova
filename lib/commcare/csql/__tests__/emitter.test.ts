import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import {
	advancedSearchInputDef,
	blueprintDocSchema,
	proseText,
} from "@/lib/domain";
import {
	ancestorPath,
	and,
	anyRelationPath,
	arith,
	between,
	count,
	dateAdd,
	dateCoerce,
	double,
	eq,
	exists,
	gt,
	gte,
	ifExpr,
	input,
	isBlank,
	isIn,
	literal,
	lt,
	lte,
	match,
	matchAll,
	matchNone,
	missing,
	multiSelectAll,
	multiSelectAny,
	neq,
	not,
	or,
	prop,
	relationStep,
	selfPath,
	sessionUserProperty,
	subcasePath,
	switchCase,
	switchExpr,
	term,
	today as todayValue,
} from "@/lib/domain/expression/builders";
import type { Expression } from "@/lib/domain/expression/types";
import {
	csqlArgumentFixture,
	csqlFixtureContext,
	csqlInputContext,
	functionLookupContext,
} from "../../__tests__/csqlFunctionFixture";
import { runValidation } from "../../validator/runner";
import { w } from "../../xpath/wire/builders";
import {
	searchInputInstance,
	sessionInstance,
} from "../../xpath/wire/instances";
import type { CsqlEmissionContext } from "../emitter";
import { emitCsql, emitCsqlTree } from "../emitter";
import { printCsql } from "../print";

// Private formatting and normalization contracts, with positive predicates
// admitted inside real apps. Native query evaluation/compilation lives in the
// Search, prompt, navigation and CSQL function proof corpora.
function contextFor(predicate: Expression): CsqlEmissionContext {
	const doc = structuredClone(csqlArgumentFixture());
	const config = doc.modules[doc.moduleOrder[0]].caseListConfig;
	if (!config || !doc.caseTypes) throw new Error("Fixture has typed Search");
	doc.caseTypes = doc.caseTypes.map((caseType) => ({
		...caseType,
		properties: [
			...caseType.properties,
			...(caseType.name === "patient" || caseType.name === "family"
				? [{ name: "age", label: proseText("Age"), data_type: "int" as const }]
				: []),
			...(caseType.name === "patient"
				? [
						{
							name: "tags",
							label: proseText("Tags"),
							data_type: "multi_select" as const,
						},
					]
				: []),
		],
	}));
	delete config.filter;
	config.searchInputs = [
		advancedSearchInputDef(
			testUuid("predicate-check"),
			"query",
			"Query",
			"text",
			predicate,
		),
	];
	blueprintDocSchema.parse(toPersistableDoc(doc));
	expect(runValidation(doc, functionLookupContext)).toEqual([]);
	return csqlFixtureContext(doc);
}
const name = prop("patient", "first_name");
const age = prop("patient", "age");
const tags = prop("patient", "tags");

it.each<[Expression, string]>([
	[eq(name, literal("Ada")), `first_name = 'Ada'`],
	[neq(name, literal("Bea")), `first_name != 'Bea'`],
	[gt(age, literal(18)), "age > 18"],
	[gte(age, literal(18)), "age >= 18"],
	[lt(age, literal(65)), "age < 65"],
	[lte(age, literal(65)), "age <= 65"],
	[eq(name, literal(null)), `first_name = ''`],
	[isBlank(name), `first_name = ''`],
	[
		isIn(name, literal("Ada Lovelace"), literal("Bea")),
		`(first_name = 'Ada Lovelace' or first_name = 'Bea')`,
	],
	[multiSelectAny(tags, literal("doctor")), `selected(tags, 'doctor')`],
	[
		multiSelectAny(tags, literal("doctor"), literal("volunteer")),
		`(selected(tags, 'doctor') or selected(tags, 'volunteer'))`,
	],
	[
		multiSelectAll(tags, literal("doctor"), literal("volunteer")),
		`(selected(tags, 'doctor') and selected(tags, 'volunteer'))`,
	],
	[
		and(
			or(eq(name, literal("Ada")), eq(name, literal("Bea"))),
			gt(age, literal(18)),
		),
		`(first_name = 'Ada' or first_name = 'Bea') and age > 18`,
	],
	[not(eq(name, literal("Bea"))), `not(first_name = 'Bea')`],
	[matchAll(), "match-all()"],
	[matchNone(), "match-none()"],
	[
		between(age, { lower: term(literal(18)), upper: term(literal(65)) }),
		"(age >= 18 and age <= 65)",
	],
	[
		between(age, {
			lower: term(literal(18)),
			upper: term(literal(65)),
			lowerInclusive: false,
			upperInclusive: false,
		}),
		"(age > 18 and age < 65)",
	],
	[between(age, { lower: term(literal(18)) }), "age >= 18"],
	[between(age, { upper: term(literal(65)) }), "age <= 65"],
	[match(name, "Ada", "fuzzy"), `fuzzy-match(first_name, 'Ada')`],
	[match(name, "Ada", "phonetic"), `phonetic-match(first_name, 'Ada')`],
	[match(name, "Ad", "starts-with"), `starts-with(first_name, 'Ad')`],
	[
		match(
			prop("patient", "visit_date"),
			dateCoerce(term(literal("2024-02-28"))),
			"fuzzy-date",
		),
		`fuzzy-date(visit_date, (date('2024-02-28')))`,
	],
	[eq(name, literal("O'Brien")), `first_name = "O'Brien"`],
	[
		eq(
			prop("patient", "visit_date"),
			dateAdd(
				dateCoerce(term(literal("2024-02-28"))),
				"days",
				double(term(literal("2"))),
			),
		),
		`visit_date = date-add(date('2024-02-28'), 'days', (double('2')))`,
	],
])(
	"keeps the complete CSQL text as one constant for an admitted predicate: %j",
	(predicate, wrapper) => {
		expect(emitCsql(predicate, contextFor(predicate))).toEqual({
			wrapper: w.str(wrapper),
		});
	},
);

it.each(["owner_id", "status"] as const)(
	"preserves metadata identity for %s",
	(property) => {
		const predicate = eq(
			prop("patient", property),
			literal(property === "status" ? "open" : "known-id"),
		);
		expect(emitCsql(predicate, contextFor(predicate))).toEqual({
			wrapper: w.str(
				`@${property} = '${property === "status" ? "open" : "known-id"}'`,
			),
		});
	},
);

it("keeps comparison direction and every typed ancestor hop", () => {
	const predicate = gt(
		literal(18),
		prop("patient", "age", ancestorPath(relationStep("parent", "family"))),
	);
	expect(emitCsql(predicate, contextFor(predicate))).toEqual({
		wrapper: w.str(
			`ancestor-exists(parent, (@case_type = 'family' and (age < 18)))`,
		),
	});
	const chain = exists(
		ancestorPath(
			relationStep("parent", "family"),
			relationStep("parent", "village"),
		),
	);
	expect(emitCsql(chain, contextFor(chain))).toEqual({
		wrapper: w.str(
			`ancestor-exists(parent, (@case_type = 'family' and (ancestor-exists(parent, (@case_type = 'village' and (match-all()))))))`,
		),
	});
});

it("narrows a canonical relation to its graph direction and groups a negated filter", () => {
	for (const [target, expected] of [
		["family", "ancestor-exists(parent,"],
		["child", "subcase-exists('parent',"],
	] as const) {
		const predicate = missing(anyRelationPath("parent", target));
		expect(emitCsql(predicate, contextFor(predicate))).toEqual({
			wrapper: w.str(
				`not(${expected} (@case_type = '${target}' and (match-all()))))`,
			),
		});
	}
});

it("keeps child-count filters with a zero bound", () => {
	const predicate = eq(
		count(subcasePath("parent", "child"), matchAll()),
		literal(0),
	);
	expect(emitCsql(predicate, contextFor(predicate))).toEqual({
		wrapper: w.str(
			`subcase-count('parent', (@case_type = 'child' and (match-all()))) = 0`,
		),
	});
});

it("requires current saved-name bindings for custom worker identities", () => {
	const uuid = testUuid("worker-property");
	const predicate = eq(name, sessionUserProperty(uuid));
	const context = {
		...csqlFixtureContext(),
		bindings: { userPropertySlugs: new Map([[uuid, "renamed_value"]]) },
	};
	const path = w.instance(
		sessionInstance(),
		["session", "user", "data", "renamed_value"].map((name) => w.step(name)),
	);
	expect(emitCsql(predicate, context).runtimeRejections).toEqual([
		{
			kind: "quote",
			condition: w.and(
				w.call("contains", [path, w.str("'")]),
				w.call("contains", [path, w.str('"')]),
			),
		},
	]);
	expect(() => emitCsql(predicate, csqlFixtureContext())).toThrow(
		`Worker-information property '${uuid}' has no current saved-name binding`,
	);
});

it("refuses compiler bypasses that cannot preserve property scope", () => {
	const parentAge = prop("family", "age", ancestorPath(relationStep("parent")));
	for (const predicate of [
		eq(age, parentAge),
		between(age, { lower: term(parentAge) }),
		eq(arith("+", term(age), term(literal(1))), parentAge),
	]) {
		expect(() => emitCsql(predicate, csqlFixtureContext())).toThrow(
			expect.objectContaining({ reason: "mixed-property-scopes" }),
		);
	}
	expect(() => emitCsql(exists(selfPath()), csqlFixtureContext())).toThrow(
		/over 'this case'/,
	);
	expect(() =>
		emitCsql(eq(name, literal(`both'"`)), csqlFixtureContext()),
	).toThrow(/no portable escape/);
});

it("writes match-none() in the quote cascade's arm for an answer holding both quote marks", () => {
	const query = testUuid("query-input");
	const value = w.instance(searchInputInstance("search-input:results"), [
		w.step("input"),
		w.step("field", [w.eq(w.context([w.attr("name")]), w.str("query"))]),
	]);
	const context = csqlInputContext([
		advancedSearchInputDef(query, "query", "Query", "text", matchAll()),
	]);
	expect(emitCsql(eq(name, term(input(query))), context)).toEqual({
		// No double quote: the double-quoted arm. A double quote and no single
		// one: the single-quoted arm. Both: the search finds nothing.
		wrapper: w.call("if", [
			w.call("contains", [value, w.str('"')]),
			w.call("if", [
				w.call("contains", [value, w.str("'")]),
				w.str("match-none()"),
				w.call("concat", [w.str("first_name = '"), value, w.str("'")]),
			]),
			w.call("concat", [w.str('first_name = "'), value, w.str('"')]),
		]),
		runtimeRejections: [
			{
				condition: w.and(
					w.call("contains", [value, w.str("'")]),
					w.call("contains", [value, w.str('"')]),
				),
				kind: "quote",
				inputNames: ["query"],
			},
		],
	});
});

it("folds every obligation of a clause into one match-none() guard", () => {
	const query = testUuid("query-input");
	const value = w.instance(searchInputInstance("search-input:results"), [
		w.step("input"),
		w.step("field", [w.eq(w.context([w.attr("name")]), w.str("query"))]),
	]);
	const context = csqlInputContext([
		advancedSearchInputDef(query, "query", "Query", "text", matchAll()),
	]);
	const wrapper = emitCsql(
		and(eq(name, term(input(query))), gt(age, term(input(query)))),
		context,
	).wrapper;
	expect(wrapper).toMatchObject({ k: "call", fn: "if" });
	if (wrapper.k !== "call") throw new Error("Expected an outer guard");
	expect(wrapper.args[0]).toEqual(
		w.or(
			w.and(
				w.call("contains", [value, w.str("'")]),
				w.call("contains", [value, w.str('"')]),
			),
			w.eq(value, w.str("")),
		),
	);
	expect(wrapper.args[1]).toEqual(w.str("match-none()"));
	expect(wrapper.args[2]).toMatchObject({ k: "call", fn: "concat" });
});

it("sends today as the worker's day, a runtime segment between fixed quotes that is never blank", () => {
	// Core's today() is the device's date; HQ's is the project
	// time zone's. HQ reads the spliced `yyyy-MM-dd` as a date.
	const predicate = gte(age, todayValue());
	const segments = printCsql(emitCsqlTree(predicate, csqlFixtureContext()));
	expect(segments).toMatchObject([
		{ kind: "constant", text: 'age >= "' },
		{ kind: "runtime", xpath: w.call("today") },
		{ kind: "constant", text: '"' },
	]);
	expect(segments.some((segment) => "rejectWhen" in segment)).toBe(false);
	expect(emitCsql(predicate, csqlFixtureContext()).runtimeRejections).toBe(
		undefined,
	);
});

it("writes a switch on the row's own value as HQ's own clause, as the if it stands for", () => {
	// A condition that reads the row makes the choice native,
	// `((c) and (A)) or (not(c) and (B))`, case by case for a switch.
	const switched = switchExpr(
		term(name),
		[
			switchCase(literal("Ada"), gt(age, literal(18))),
			switchCase(literal("Bea"), matchAll()),
		],
		lt(age, literal(5)),
	);
	const nested = ifExpr(
		eq(name, literal("Ada")),
		gt(age, literal(18)),
		ifExpr(eq(name, literal("Bea")), matchAll(), lt(age, literal(5))),
	);
	const emitted = emitCsql(switched, contextFor(switched));
	expect(emitted.wrapper.k).toBe("str");
	expect(emitted).toEqual(emitCsql(nested, contextFor(nested)));
});
