import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { csqlStaticQuoteFixture } from "@/lib/commcare/__tests__/csqlStaticQuoteFixture";
import { runValidation } from "@/lib/commcare/validator/runner";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	actingUser,
	ancestorPath,
	and,
	between,
	coalesce,
	concat,
	count,
	dateAdd,
	double,
	eq,
	exists,
	formatDate,
	formField,
	gt,
	gte,
	idOf,
	ifExpr,
	input,
	isBlank,
	isIn,
	literal,
	lt,
	lte,
	match,
	matchAll,
	matchesPattern,
	matchNone,
	missing,
	multiSelectAny,
	neq,
	not,
	or,
	type Predicate,
	prop,
	relationStep,
	selfPath,
	subcasePath,
	switchCase,
	switchExpr,
	term,
	today,
	unowned,
	type ValueExpression,
	whenInput,
	within,
} from "@/lib/domain/predicate";
import {
	checkCsqlRepresentability,
	normalizeCsqlPredicate,
} from "../csqlRepresentability";

const field = (name: string) => prop("patient", name);
const query = input(testUuid("query"));
const badLiteral = literal(`it's "quoted"`);
const bad = term(badLiteral);
const safe = term(literal("safe"));
const dynamic = eq(query, literal("yes"));
// This private analysis has no document/type context. Its output proves only
// diagnostics and normalization; admitted export/runtime evidence lives below
// and in the native function, quote and search corpora.
const issues = (predicate: Predicate) =>
	checkCsqlRepresentability(predicate).map(({ reason, path }) => ({
		reason,
		path,
	}));

it("rejects all four unsafe native branches and admits their safe counterparts through the full gate", () => {
	const unsafe = csqlStaticQuoteFixture("unsafe");
	const findings = runValidation(unsafe, LOOKUP_CONTEXT_UNAVAILABLE);
	expect(findings.map(({ code, details }) => ({ code, details }))).toEqual(
		[0, 1, 2, 3].map((index) => ({
			code: "CASE_LIST_CSQL_NOT_REPRESENTABLE",
			details: {
				reason: "csql-string-not-quotable",
				path: `and.[${index}].right`,
				slot: "caseListConfig.filter",
				surface: "filter",
			},
		})),
	);
	expect(
		runValidation(csqlStaticQuoteFixture("safe"), LOOKUP_CONTEXT_UNAVAILABLE),
	).toEqual([]);
});

describe("private CSQL boundary diagnostics", () => {
	it.each([
		[
			"two properties",
			eq(field("name"), field("nickname")),
			"case-property-on-value-side",
			["right"],
		],
		[
			"no anchor",
			eq(literal("a"), literal("b")),
			"comparison-needs-case-property",
			["left"],
		],
		[
			"calculated anchor",
			eq(concat(term(field("name")), safe), safe),
			"comparison-needs-case-property",
			["left"],
		],
		[
			"nested property",
			eq(field("name"), concat(term(field("nickname")), safe)),
			"case-property-on-value-side",
			["right", "parts", 0],
		],
		[
			"parent count",
			gt(count(ancestorPath(relationStep("parent"))), literal(0)),
			"unsupported-related-count",
			["left"],
		],
		[
			"count as value",
			eq(field("name"), count(subcasePath("child"))),
			"related-count-on-value-side",
			["right"],
		],
		["blank input", isBlank(query), "comparison-needs-case-property", ["left"]],
		[
			"case condition in value",
			eq(
				field("name"),
				ifExpr(eq(field("status"), literal("active")), safe, safe),
			),
			"case-property-on-value-side",
			["right", "if", "cond", "left"],
		],
		[
			"relation in value",
			eq(field("name"), ifExpr(exists(subcasePath("child")), safe, safe)),
			"case-query-in-runtime-value",
			["right", "if", "cond"],
		],
		[
			"property match value",
			match(field("name"), field("nickname"), "starts-with"),
			"case-property-on-value-side",
			["value"],
		],
		[
			"property distance center",
			within(field("location"), field("other_location"), 5, "miles"),
			"case-property-on-value-side",
			["center"],
		],
		[
			"self relation",
			exists(selfPath()),
			"self-relation-not-queryable",
			["exists", "via"],
		],
		[
			"server regex",
			matchesPattern(field("name"), "^[A-Z]"),
			"pattern-match-not-csql",
			[],
		],
		[
			"form field",
			eq(field("name"), formField(testUuid("field"))),
			"form-context-value-not-csql",
			["right"],
		],
		[
			"operation ID",
			eq(field("name"), idOf(testUuid("operation"))),
			"form-context-value-not-csql",
			["right"],
		],
		[
			"acting user",
			eq(field("name"), actingUser()),
			"form-context-value-not-csql",
			["right"],
		],
		[
			"unowned",
			eq(field("name"), unowned()),
			"form-context-value-not-csql",
			["right"],
		],
	] as const)(
		"reports the complete violation for %s",
		(_name, predicate, reason, path) => {
			expect(issues(predicate)).toEqual([{ reason, path }]);
		},
	);

	it("reports independent violations in authored traversal order without mutating the AST", () => {
		const authored = and(
			not(eq(field("name"), bad)),
			whenInput(
				query,
				or(
					isIn(field("status"), literal("ok"), badLiteral),
					missing(selfPath(), multiSelectAny(field("tags"), badLiteral)),
				),
			),
			between(count(subcasePath("child")), {
				lower: literal(-1),
				upper: literal(1.5),
			}),
		);
		const before = structuredClone(authored);
		expect(issues(authored)).toEqual([
			{
				reason: "csql-string-not-quotable",
				path: ["and", 0, "not", "clause", "right"],
			},
			{
				reason: "csql-string-not-quotable",
				path: ["and", 1, "when-input-present", "clause", "or", 0, "values", 1],
			},
			{
				reason: "self-relation-not-queryable",
				path: [
					"and",
					1,
					"when-input-present",
					"clause",
					"or",
					1,
					"missing",
					"via",
				],
			},
			{
				reason: "csql-string-not-quotable",
				path: [
					"and",
					1,
					"when-input-present",
					"clause",
					"or",
					1,
					"missing",
					"where",
					"values",
					0,
				],
			},
			{
				reason: "subcase-count-needs-nonnegative-whole-number",
				path: ["and", 2, "lower"],
			},
			{
				reason: "subcase-count-needs-nonnegative-whole-number",
				path: ["and", 2, "upper"],
			},
		]);
		expect(authored).toEqual(before);
	});

	it("stops at conflicting row scopes, including range bounds", () => {
		const parent = prop(
			"patient",
			"status",
			ancestorPath(relationStep("parent")),
		);
		const household = prop(
			"patient",
			"status",
			ancestorPath(relationStep("household")),
		);
		for (const predicate of [
			eq(field("status"), parent),
			eq(parent, household),
			between(parent, { lower: household }),
		]) {
			expect(issues(predicate)).toEqual([
				{ reason: "multiple-property-scopes", path: [] },
			]);
		}
	});

	it("distinguishes integral calendar shifts from nonnegative child counts", () => {
		for (const value of [-2, 0, 2]) {
			expect(
				issues(
					eq(field("date"), dateAdd(today(), "months", term(literal(value)))),
				),
			).toEqual([]);
		}
		expect(
			issues(eq(field("date"), dateAdd(today(), "years", term(literal(1.5))))),
		).toEqual([
			{
				reason: "calendar-date-add-needs-whole-number",
				path: ["right", "quantity"],
			},
		]);
		for (const value of [
			term(literal(0)),
			term(literal(2)),
			double(term(query)),
		]) {
			expect(issues(gt(count(subcasePath("child")), value))).toEqual([]);
		}
	});
});

describe("static branch reachability", () => {
	it.each([
		["reachable conditional", ifExpr(dynamic, bad, safe), true],
		["dead conditional", ifExpr(matchNone(), bad, safe), false],
		[
			"fixed conjunction",
			ifExpr(and(matchAll(), not(matchNone())), safe, bad),
			false,
		],
		[
			"fixed disjunction",
			ifExpr(or(matchNone(), matchAll()), safe, bad),
			false,
		],
		[
			"single styles in separate branches",
			ifExpr(dynamic, term(literal("'")), term(literal('"'))),
			false,
		],
		["fixed concat", concat(term(literal("'")), term(literal('"'))), true],
		[
			"common quote plus suffix",
			concat(
				ifExpr(dynamic, term(literal("'a")), term(literal("'b"))),
				term(literal('"')),
			),
			true,
		],
		[
			"nonempty prefix",
			coalesce(concat(term(literal("prefix:")), term(query)), bad),
			false,
		],
		["unknown coalesce", coalesce(term(query), bad), true],
		["empty coalesce", coalesce(term(literal("")), bad), true],
		["formatted date", coalesce(formatDate(today(), "%Y"), bad), false],
		["quoted date pattern", formatDate(today(), `yyyy ' "`), true],
		[
			"null is empty text",
			ifExpr(eq(literal(null), literal("")), safe, bad),
			false,
		],
		[
			"boolean literal is text",
			ifExpr(eq(literal(false), literal("false")), safe, bad),
			false,
		],
		[
			"numeric tolerance",
			ifExpr(eq(literal(0), literal(1e-13)), safe, bad),
			false,
		],
		[
			"numeric tolerance boundary",
			ifExpr(eq(literal(0), literal(1e-12)), bad, safe),
			false,
		],
		[
			"unknown mixed equality",
			ifExpr(eq(literal(1), literal("1")), bad, safe),
			true,
		],
		[
			"unknown mixed inequality",
			ifExpr(neq(literal(1), literal("1")), safe, bad),
			true,
		],
		[
			"switch first match",
			switchExpr(
				term(literal(null)),
				[switchCase(literal(""), safe), switchCase(literal(null), bad)],
				bad,
			),
			false,
		],
		[
			"switch uncertain earlier match",
			switchExpr(
				term(literal(1)),
				[switchCase(literal("1"), bad), switchCase(literal(1), safe)],
				safe,
			),
			true,
		],
	] satisfies readonly (readonly [string, ValueExpression, boolean])[])(
		"handles %s",
		(_name, value, rejected) => {
			expect(issues(eq(field("name"), value))).toEqual(
				rejected
					? [{ reason: "csql-string-not-quotable", path: ["right"] }]
					: [],
			);
		},
	);
});

it.each([
	[eq, eq],
	[neq, neq],
	[gt, lt],
	[gte, lte],
	[lt, gt],
	[lte, gte],
])(
	"canonicalizes each comparison direction recursively without rewriting runtime conditionals (%#)",
	(authoredComparison, normalizedComparison) => {
		for (const anchor of [term(field("age")), count(subcasePath("child"))]) {
			const runtime = ifExpr(
				gt(literal(2), literal(1)),
				term(literal(3)),
				term(literal(4)),
			);
			const authored = whenInput(
				query,
				not(
					exists(
						ancestorPath(relationStep("parent")),
						authoredComparison(runtime, anchor),
					),
				),
			);
			const before = structuredClone(authored);
			expect(normalizeCsqlPredicate(authored)).toEqual(
				whenInput(
					query,
					not(
						exists(
							ancestorPath(relationStep("parent")),
							normalizedComparison(anchor, runtime),
						),
					),
				),
			);
			expect(authored).toEqual(before);
		}
	},
);
