import { describe, expect, it } from "vitest";
import {
	and,
	concat,
	count,
	dateAdd,
	dateCoerce,
	datetimeCoerce,
	eq,
	exists,
	gte,
	ifExpr,
	input,
	literal,
	match,
	now,
	or,
	prop,
	sessionUser,
	subcasePath,
	switchCase,
	switchExpr,
	term,
	today,
	whenInput,
	within,
} from "@/lib/domain/expression/builders";
import type { CheckPath, Expression } from "@/lib/domain/expression/types";
import { asUuid } from "@/lib/domain/uuid";
import {
	type CsqlPosition,
	csqlPositionAt,
	csqlPositions,
	csqlRuntimeRoots,
	isRuntimeSubtreeRoot,
} from "../positions";

const SEARCH = asUuid("00000000-0000-4000-8000-000000000001");
const dob = prop("person", "dob");
const name = prop("person", "name");
const tags = prop("person", "tags");
const gps = prop("person", "gps");

type Row = readonly [
	string,
	Expression,
	readonly (readonly [CheckPath, CsqlPosition | undefined])[],
];

const rows: readonly Row[] = [
	[
		"a comparison's anchor and value",
		eq(name, literal("Amina")),
		[
			[[], "query"],
			[["left"], "anchor"],
			[["right"], "server-value"],
		],
	],
	[
		"an anchor authored on the right is still the anchor",
		eq(literal("Amina"), name),
		[
			[["left"], "server-value"],
			[["right"], "anchor"],
		],
	],
	[
		"today is the worker's day, so it is a runtime segment",
		gte(dob, today()),
		[[["right"], "runtime"]],
	],
	[
		"now stays HQ's own value function",
		gte(dob, now()),
		[[["right"], "server-value"]],
	],
	[
		"a native value function keeps HQ's position over a runtime operand",
		gte(dob, datetimeCoerce(term(input(SEARCH)))),
		[
			[["right"], "server-value"],
			[["right", "value"], "runtime"],
		],
	],
	[
		"a native value function around today interpolates today",
		gte(dob, datetimeCoerce(today())),
		[
			[["right"], "server-value"],
			[["right", "value"], "runtime"],
		],
	],
	[
		"a date-add over literals stays native",
		gte(
			dob,
			dateAdd(
				dateCoerce(term(literal("2026-01-01"))),
				"days",
				term(literal(3)),
			),
		),
		[
			[["right"], "server-value"],
			[["right", "date"], "server-value"],
			[["right", "date", "value"], "server-value"],
			[["right", "quantity"], "server-value"],
		],
	],
	[
		"a non-native value is runtime whole",
		eq(name, concat(term(sessionUser("first")), term(literal(" ")))),
		[
			[["right"], "runtime"],
			[["right", "parts", 0], "runtime"],
			[["right", "parts", 1], "runtime"],
		],
	],
	[
		"a native value function in a raw argument is runtime",
		match(name, dateCoerce(term(literal("2026-01-01"))), "starts-with"),
		[
			[["property"], "anchor"],
			[["value"], "runtime"],
			[["value", "value"], "runtime"],
		],
	],
	[
		"fuzzy's value is HQ's to evaluate",
		match(name, dateCoerce(term(literal("2026-01-01"))), "fuzzy"),
		[
			[["value"], "server-value"],
			[["value", "value"], "server-value"],
		],
	],
	[
		"selected values are raw, a computed one runtime",
		{
			kind: "multi-select-contains",
			property: tags,
			values: [literal("a"), term(input(SEARCH))],
			quantifier: "any",
		},
		[
			[["property"], "anchor"],
			[["values", 0], "raw"],
			[["values", 1], "runtime"],
		],
	],
	[
		"a distance's center, radius and unit are raw",
		within(gps, literal("1 2"), term(input(SEARCH)), "miles"),
		[
			[["center"], "raw"],
			[["distance"], "runtime"],
		],
	],
	[
		"a value list's items are raw",
		eq(name, {
			kind: "value-list",
			items: [term(literal("a")), term(sessionUser("b"))],
		}),
		[
			[["right"], "server-value"],
			[["right", "items", 0], "raw"],
			[["right", "items", 1], "runtime"],
		],
	],
	[
		"a child-case count's filter is a query",
		gte(count(subcasePath("parent"), eq(name, literal("x"))), term(literal(1))),
		[
			[["left"], "anchor"],
			[["left", "count", "where"], "query"],
			[["left", "count", "where", "left"], "anchor"],
			[["right"], "server-value"],
		],
	],
	[
		"a related case's filter is a query",
		exists(subcasePath("parent"), eq(name, literal("x"))),
		[[["exists", "where"], "query"]],
	],
	[
		"a clause that reads no case row is runtime",
		and(eq(term(sessionUser("role")), literal("lead")), eq(name, literal("x"))),
		[
			[[], "query"],
			[["and", 0], "runtime"],
			[["and", 0, "left"], "runtime"],
			[["and", 1], "query"],
		],
	],
	[
		"a negation of a constant stays HQ's",
		{ kind: "not", clause: { kind: "match-none" } },
		[
			[[], "query"],
			[["not", "clause"], "query"],
		],
	],
	[
		"a runtime choice's condition is runtime and its branches are queries",
		ifExpr(
			eq(term(sessionUser("role")), literal("lead")),
			{ kind: "match-all" },
			eq(prop("person", "owner_id"), term(sessionUser("id"))),
		),
		[
			[[], "query"],
			[["if", "cond"], "runtime"],
			[["if", "then"], "query"],
			[["if", "else"], "query"],
			[["if", "else", "left"], "anchor"],
			[["if", "else", "right"], "runtime"],
		],
	],
	[
		"a choice whose condition reads the row is a query throughout",
		ifExpr(eq(name, literal("a")), eq(dob, literal("2020-01-01")), {
			kind: "match-none",
		}),
		[
			[["if", "cond"], "query"],
			[["if", "cond", "left"], "anchor"],
		],
	],
	[
		"a switch chooses its clause on the device",
		switchExpr(
			term(sessionUser("role")),
			[switchCase(literal("lead"), { kind: "match-all" })],
			eq(name, literal("x")),
		),
		[
			[["switch", "on"], "runtime"],
			[["switch", "cases", 0, "when"], "runtime"],
			[["switch", "cases", 0, "then"], "query"],
			[["switch", "fallback"], "query"],
		],
	],
	[
		"a switch whose selector reads the row is a query throughout",
		switchExpr(
			term(prop("person", "status")),
			[switchCase(literal("lead"), { kind: "match-all" })],
			eq(name, literal("x")),
		),
		[
			[[], "query"],
			[["switch", "on"], "anchor"],
			[["switch", "cases", 0, "when"], "server-value"],
			[["switch", "cases", 0, "then"], "query"],
			[["switch", "fallback"], "query"],
		],
	],
	[
		"a presence gate's trigger is read on the device",
		whenInput(input(SEARCH), eq(name, term(input(SEARCH)))),
		[
			[[], "query"],
			[["when-input-present", "input"], "runtime"],
			[["when-input-present", "clause"], "query"],
			[["when-input-present", "clause", "right"], "runtime"],
		],
	],
	[
		"an or of row clauses",
		or(eq(name, literal("a")), gte(dob, literal("2020-01-01"))),
		[
			[["or", 0], "query"],
			[["or", 1, "right"], "server-value"],
		],
	],
];

describe("csqlPositions", () => {
	it.each(rows)("%s", (_label, expression, expected) => {
		const positions = csqlPositions(expression);
		for (const [path, position] of expected)
			expect([path, csqlPositionAt(positions, path)]).toEqual([path, position]);
	});

	it("names each runtime subtree once, at its root", () => {
		const expression = and(
			eq(name, concat(term(sessionUser("a")), term(literal("b")))),
			gte(dob, datetimeCoerce(today())),
		);
		const roots = csqlRuntimeRoots(expression);
		expect(roots.map((root) => [root.path, root.within])).toEqual([
			[["and", 0, "right"], "server-value"],
			[["and", 1, "right", "value"], "server-value"],
		]);
		const positions = csqlPositions(expression);
		expect(isRuntimeSubtreeRoot(positions, ["and", 0, "right"])).toBe(true);
		expect(
			isRuntimeSubtreeRoot(positions, ["and", 0, "right", "parts", 0]),
		).toBe(false);
		expect(isRuntimeSubtreeRoot(positions, ["and", 1, "right"])).toBe(false);
	});
});
