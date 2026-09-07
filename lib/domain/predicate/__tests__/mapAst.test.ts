import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { lookupColumnIdSchema, lookupTableIdSchema } from "@/lib/domain";
import {
	and,
	between,
	coalesce,
	concat,
	eq,
	gt,
	ifExpr,
	input,
	isBlank,
	literal,
	mapExpressionAst,
	mapPredicateAst,
	matchAll,
	multiSelectAny,
	not,
	or,
	prop,
	sessionContext,
	tableColumn,
	tableLookup,
	term,
	whenInput,
} from "@/lib/domain/predicate";

const TABLE = lookupTableIdSchema.parse("018f0000-0000-7000-8000-000000000001");
const COL_A = lookupColumnIdSchema.parse(
	"018f0000-0000-7000-8000-00000000000a",
);
const COL_B = lookupColumnIdSchema.parse(
	"018f0000-0000-7000-8000-00000000000b",
);

describe("identity preservation", () => {
	it("returns the SAME reference when no hook replaces anything", () => {
		const predicate = and(
			eq(prop("patient", "status"), literal("open")),
			or(
				isBlank(term(sessionContext("username"))),
				between(prop("patient", "age"), {
					lower: literal(3),
					upper: literal(9),
				}),
			),
			not(gt(prop("patient", "age"), literal(1))),
		);
		expect(mapPredicateAst(predicate, {})).toBe(predicate);
	});

	it("rebuilds only the envelopes on the path to a replacement", () => {
		const untouched = eq(prop("patient", "status"), literal("open"));
		const touched = eq(term(sessionContext("userid")), literal("u1"));
		const predicate = and(untouched, touched);
		const mapped = mapPredicateAst(predicate, {
			mapTerm: (node) =>
				node.kind === "session-context"
					? { kind: "term", term: literal("bound") }
					: undefined,
		});
		expect(mapped).not.toBe(predicate);
		if (mapped.kind !== "and") throw new Error("expected and");
		expect(mapped.clauses[0]).toBe(untouched);
		expect(mapped.clauses[1]).not.toBe(touched);
	});

	it("shares literal-only slots (multi-select values) untouched", () => {
		const predicate = multiSelectAny(
			prop("patient", "symptoms"),
			literal("fever"),
			literal("cough"),
		);
		expect(mapPredicateAst(predicate, { mapTerm: () => undefined })).toBe(
			predicate,
		);
	});
});

describe("term mapping coverage", () => {
	it("maps conditions and both branches while retaining the original expression", () => {
		const bound = { kind: "term", term: literal("X") } as const;
		const expression = concat(
			ifExpr(
				eq(term(sessionContext("username")), literal("a")),
				term(sessionContext("username")),
				coalesce(term(sessionContext("username")), term(literal("z"))),
			),
		);
		const original = structuredClone(expression);
		const mapped = mapExpressionAst(expression, {
			mapTerm: (node) => (node.kind === "session-context" ? bound : undefined),
		});
		expect(mapped).toEqual(
			concat(
				ifExpr(
					eq(literal("X"), literal("a")),
					term(literal("X")),
					coalesce(term(literal("X")), term(literal("z"))),
				),
			),
		);
		expect(expression).toEqual(original);
	});

	it("descends into a table-lookup's where and passes table-column through", () => {
		const lookup = tableLookup(
			TABLE,
			COL_A,
			and(
				eq(term(tableColumn(TABLE, COL_B)), term(sessionContext("userid"))),
				matchAll(),
			),
		);
		const mapped = mapExpressionAst(lookup, {
			mapTerm: (node) =>
				node.kind === "session-context"
					? { kind: "term", term: literal("u9") }
					: undefined,
		});
		expect(mapped).toEqual(
			tableLookup(
				TABLE,
				COL_A,
				and(eq(term(tableColumn(TABLE, COL_B)), literal("u9")), matchAll()),
			),
		);
	});
});

describe("node interception", () => {
	it("mapExpression replaces a whole node and stops descent", () => {
		const lookup = tableLookup(
			TABLE,
			COL_A,
			eq(term(tableColumn(TABLE, COL_B)), literal("x")),
		);
		const mapped = mapExpressionAst(lookup, {
			mapExpression: (expr) =>
				expr.kind === "table-lookup"
					? { kind: "term", term: literal("folded") }
					: undefined,
			// Must never fire inside the intercepted subtree:
			mapTerm: (node) => {
				if (node.kind === "table-column") {
					throw new Error("descended into an intercepted subtree");
				}
				return undefined;
			},
		});
		expect(mapped).toEqual(term(literal("folded")));
	});

	it("mapPredicate resolves a gate and re-enters mapping explicitly", () => {
		const gated = whenInput(
			input(testUuid("q")),
			eq(term(sessionContext("userid")), literal("u")),
		);
		const mapped = mapPredicateAst(gated, {
			mapPredicate: (predicate) =>
				predicate.kind === "when-input-present"
					? mapPredicateAst(predicate.clause, {
							mapTerm: (node) =>
								node.kind === "session-context"
									? { kind: "term", term: literal("resolved") }
									: undefined,
						})
					: undefined,
		});
		expect(mapped).toEqual(eq(literal("resolved"), literal("u")));
	});
});
