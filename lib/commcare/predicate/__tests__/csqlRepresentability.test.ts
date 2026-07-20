import { describe, expect, it } from "vitest";
import {
	ancestorPath,
	and,
	arith,
	between,
	coalesce,
	concat,
	count,
	dateAdd,
	dateCoerce,
	datetimeCoerce,
	double,
	eq,
	exists,
	formatDate,
	gt,
	ifExpr,
	input,
	isBlank,
	isIn,
	isNull,
	literal,
	match,
	matchAll,
	matchNone,
	missing,
	multiSelectAny,
	neq,
	not,
	now,
	or,
	prop,
	relationStep,
	selfPath,
	sessionContext,
	subcasePath,
	switchCase,
	switchExpr,
	term,
	today,
	unwrapList,
	whenInput,
	within,
} from "@/lib/domain/predicate";
import {
	checkCsqlRepresentability,
	normalizeCsqlPredicate,
} from "../csqlRepresentability";

const PATIENT = "patient";
const field = (name: string) => prop(PATIENT, name);

describe("checkCsqlRepresentability", () => {
	it.each([
		["literal term", term(literal("x"))],
		["search input term", term(input("query"))],
		["session term", term(sessionContext("userid"))],
		["today", today()],
		["now", now()],
		["date-add", dateAdd(today(), "days", term(literal(1)))],
		["date-coerce", dateCoerce(term(literal("2026-01-02")))],
		["datetime-coerce", datetimeCoerce(term(literal("2026-01-02T03:04:05Z")))],
		["double", double(term(literal("2")))],
		["arith", arith("+", term(literal(1)), term(literal(2)))],
		["concat", concat(term(literal("a")), term(literal("b")))],
		["coalesce", coalesce(term(input("q")), term(literal("fallback")))],
		["if", ifExpr(matchAll(), term(literal("yes")), term(literal("no")))],
		[
			"switch",
			switchExpr(
				term(input("q")),
				[switchCase(literal("a"), term(literal("A")))],
				term(literal("other")),
			),
		],
		["unwrap-list", unwrapList(term(literal('["a"]')))],
		["format-date", formatDate(today(), "iso")],
	] as const)(
		"accepts a pure %s expression on the value side",
		(_name, value) => {
			expect(checkCsqlRepresentability(eq(field("target"), value))).toEqual([]);
		},
	);

	it("accepts every query-predicate envelope when its value slots are portable", () => {
		const portable = and(
			eq(field("name"), literal("Alice")),
			neq(field("status"), literal("closed")),
			isIn(field("status"), literal("open"), literal("pending")),
			between(field("age"), { lower: literal(18), upper: literal(65) }),
			isBlank(field("nickname")),
			match(field("name"), input("query"), "fuzzy"),
			multiSelectAny(field("tags"), literal("vip")),
			within(field("location"), input("center"), 5, "miles"),
			or(matchAll(), not(matchNone())),
			whenInput(input("query"), eq(field("name"), input("query"))),
			exists(
				ancestorPath(relationStep("parent")),
				eq(field("status"), literal("active")),
			),
			missing(subcasePath("child")),
		);

		expect(checkCsqlRepresentability(portable)).toEqual([]);
	});

	it("accepts and canonicalizes a sole property authored on the right", () => {
		const authored = gt(literal(18), field("age"));
		expect(checkCsqlRepresentability(authored)).toEqual([]);
		expect(normalizeCsqlPredicate(authored)).toEqual({
			kind: "lt",
			left: term(field("age")),
			right: term(literal(18)),
		});
	});

	it("accepts a direct child count on either authored side", () => {
		const children = count(subcasePath("child"));
		expect(checkCsqlRepresentability(gt(children, literal(2)))).toEqual([]);
		expect(checkCsqlRepresentability(gt(literal(2), children))).toEqual([]);
	});

	it("requires calendar month/year quantities to be fixed or prompted whole numbers", () => {
		expect(
			checkCsqlRepresentability(
				eq(field("due_date"), dateAdd(today(), "months", term(literal(1.5)))),
			),
		).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					reason: "calendar-date-add-needs-whole-number",
					path: ["right", "quantity"],
				}),
			]),
		);
		expect(
			checkCsqlRepresentability(
				eq(
					field("due_date"),
					dateAdd(today(), "years", double(term(input("years")))),
				),
			),
		).toEqual([]);
		// Calendar shifts may move in either direction; the constraint is
		// integrality, not nonnegativity.
		expect(
			checkCsqlRepresentability(
				eq(field("due_date"), dateAdd(today(), "months", term(literal(-2)))),
			),
		).toEqual([]);
		expect(
			checkCsqlRepresentability(
				eq(field("due_date"), dateAdd(today(), "years", term(literal(0)))),
			),
		).toEqual([]);
	});

	it("requires child-count bounds to be nonnegative whole numbers", () => {
		const children = count(subcasePath("child"));
		for (const value of [-1, 1.5]) {
			expect(checkCsqlRepresentability(gt(children, literal(value)))).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						reason: "subcase-count-needs-nonnegative-whole-number",
						path: ["right"],
					}),
				]),
			);
		}
		expect(
			checkCsqlRepresentability(
				gt(children, double(term(input("minimum_children")))),
			),
		).toEqual([]);
		expect(checkCsqlRepresentability(gt(children, literal(-0)))).toEqual([]);
	});

	it("reports comparisons that cross independent case-row scopes", () => {
		const parent = ancestorPath(relationStep("parent"));
		const household = ancestorPath(relationStep("household"));
		const selfVsParent = checkCsqlRepresentability(
			eq(field("status"), prop(PATIENT, "status", parent)),
		);
		const parentVsHousehold = checkCsqlRepresentability(
			eq(prop(PATIENT, "status", parent), prop(PATIENT, "status", household)),
		);

		for (const issues of [selfVsParent, parentVsHousehold]) {
			expect(issues).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						reason: "multiple-property-scopes",
						path: [],
					}),
				]),
			);
		}
		expect(
			checkCsqlRepresentability(
				eq(prop(PATIENT, "status", parent), input("status")),
			),
		).toEqual([]);
	});

	it("rejects a direct fixed CSQL value containing both quote delimiters", () => {
		const issues = checkCsqlRepresentability(
			eq(field("name"), literal(`it's "quoted"`)),
		);

		expect(issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					reason: "csql-string-not-quotable",
					path: ["right"],
				}),
			]),
		);
	});

	it("rejects unquotable values in CSQL literal-list operators", () => {
		const inIssues = checkCsqlRepresentability(
			isIn(field("status"), literal("open"), literal(`it's "closed"`)),
		);
		const multiSelectIssues = checkCsqlRepresentability(
			multiSelectAny(field("tags"), literal(`team's "priority"`)),
		);

		expect(inIssues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					reason: "csql-string-not-quotable",
					path: ["values", 1],
				}),
			]),
		);
		expect(multiSelectIssues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					reason: "csql-string-not-quotable",
					path: ["values", 0],
				}),
			]),
		);
	});

	it("rejects a provably unquotable pure on-device output", () => {
		const issues = checkCsqlRepresentability(
			eq(field("name"), concat(term(literal("'")), term(literal('"')))),
		);

		expect(issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					reason: "csql-string-not-quotable",
					path: ["right"],
				}),
			]),
		);
	});

	it("rejects a reachable fixed bad branch while ignoring a statically dead one", () => {
		const dynamicCondition = eq(input("flag"), literal("yes"));
		const bad = term(literal(`it's "quoted"`));
		const safe = term(literal("safe"));
		const reachable = checkCsqlRepresentability(
			eq(field("name"), ifExpr(dynamicCondition, bad, safe)),
		);
		const dead = checkCsqlRepresentability(
			eq(field("name"), ifExpr(matchNone(), bad, safe)),
		);

		expect(reachable).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ reason: "csql-string-not-quotable" }),
			]),
		);
		expect(dead).not.toEqual(
			expect.arrayContaining([
				expect.objectContaining({ reason: "csql-string-not-quotable" }),
			]),
		);
	});

	it("does not inspect an unreachable coalesce fallback after a guaranteed non-empty value", () => {
		const value = coalesce(
			concat(term(literal("prefix:")), term(input("query"))),
			term(literal(`it's "quoted"`)),
		);

		expect(checkCsqlRepresentability(eq(field("name"), value))).not.toEqual(
			expect.arrayContaining([
				expect.objectContaining({ reason: "csql-string-not-quotable" }),
			]),
		);
	});

	it("allows dynamic branches whose individual outputs each use only one quote style", () => {
		const value = ifExpr(
			eq(input("flag"), literal("yes")),
			term(literal("'")),
			term(literal('"')),
		);

		expect(checkCsqlRepresentability(eq(field("name"), value))).not.toEqual(
			expect.arrayContaining([
				expect.objectContaining({ reason: "csql-string-not-quotable" }),
			]),
		);
	});

	it("rejects quote kinds guaranteed across different dynamic branches plus a fixed suffix", () => {
		const value = concat(
			ifExpr(
				eq(input("flag"), literal("yes")),
				term(literal("'a")),
				term(literal("'b")),
			),
			term(literal('"')),
		);

		expect(checkCsqlRepresentability(eq(field("label"), value))).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ reason: "csql-string-not-quotable" }),
			]),
		);
	});

	it("ignores bad branches proven unreachable by fixed predicates and switch discriminators", () => {
		const bad = term(literal(`it's "quoted"`));
		const safe = term(literal("safe"));
		const fixedIf = ifExpr(eq(literal("x"), literal("x")), safe, bad);
		const fixedSwitch = switchExpr(
			term(literal("selected")),
			[switchCase(literal("selected"), safe)],
			bad,
		);

		for (const value of [fixedIf, fixedSwitch]) {
			expect(checkCsqlRepresentability(eq(field("label"), value))).not.toEqual(
				expect.arrayContaining([
					expect.objectContaining({ reason: "csql-string-not-quotable" }),
				]),
			);
		}
	});

	it("stops coalesce reachability after a guaranteed non-empty formatted date", () => {
		const value = coalesce(
			formatDate(today(), "%Y"),
			term(literal(`it's "quoted"`)),
		);

		expect(checkCsqlRepresentability(eq(field("label"), value))).not.toEqual(
			expect.arrayContaining([
				expect.objectContaining({ reason: "csql-string-not-quotable" }),
			]),
		);
	});

	it("rejects a format-date pattern whose fixed output includes both quote kinds", () => {
		const value = formatDate(today(), `yyyy ' "`);
		const issues = checkCsqlRepresentability(eq(field("name"), value));

		expect(issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					reason: "csql-string-not-quotable",
					path: ["right"],
				}),
			]),
		);
	});

	it.each([
		{
			name: "property against property",
			predicate: eq(field("name"), field("nickname")),
			reason: "case-property-on-value-side",
		},
		{
			name: "comparison with no case-property anchor",
			predicate: eq(literal("a"), literal("b")),
			reason: "comparison-needs-case-property",
		},
		{
			name: "property hidden inside a left calculation",
			predicate: eq(
				concat(term(field("name")), term(literal("!"))),
				literal("Alice!"),
			),
			reason: "comparison-needs-case-property",
		},
		{
			name: "property hidden inside a right calculation",
			predicate: eq(
				field("name"),
				concat(term(field("nickname")), term(literal("!"))),
			),
			reason: "case-property-on-value-side",
		},
		{
			name: "parent count",
			predicate: gt(count(ancestorPath(relationStep("parent"))), literal(0)),
			reason: "unsupported-related-count",
		},
		{
			name: "child count on the value side of a property comparison",
			predicate: eq(field("expected_children"), count(subcasePath("child"))),
			reason: "related-count-on-value-side",
		},
		{
			name: "strict null",
			predicate: isNull(field("nickname")),
			reason: "strict-null-not-portable",
		},
		{
			name: "blank test without a property subject",
			predicate: isBlank(input("query")),
			reason: "comparison-needs-case-property",
		},
		{
			name: "case query inside a runtime if value",
			predicate: eq(
				field("label"),
				ifExpr(
					eq(field("status"), literal("active")),
					term(literal("yes")),
					term(literal("no")),
				),
			),
			reason: "case-property-on-value-side",
		},
		{
			name: "related count inside a runtime value",
			predicate: eq(field("count_text"), count(subcasePath("child"))),
			reason: "related-count-on-value-side",
		},
		{
			name: "case property as match value",
			predicate: match(field("name"), field("nickname"), "starts-with"),
			reason: "case-property-on-value-side",
		},
		{
			name: "case property as distance center",
			predicate: within(field("location"), field("other_location"), 5, "miles"),
			reason: "case-property-on-value-side",
		},
		{
			name: "self related-case envelope",
			predicate: exists(selfPath(), eq(field("status"), literal("active"))),
			reason: "self-relation-not-queryable",
		},
	] as const)("rejects $name", ({ predicate, reason }) => {
		expect(checkCsqlRepresentability(predicate)).toEqual(
			expect.arrayContaining([expect.objectContaining({ reason })]),
		);
	});
});
