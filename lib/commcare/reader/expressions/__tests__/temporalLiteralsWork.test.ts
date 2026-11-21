/**
 * Typing a record slot's literals where their positions require a date is one
 * pass over the tree.
 *
 * Contract: `temporalLiterals.ts::typedWhereRequired` visits each node once
 * and each requirement descends only where a requirement reaches a literal,
 * so the work meter's `visit` units of a chain of comparisons nested through
 * branch nodes grow with the chain's length, never with its square or its
 * powers, and the chain's literal is typed where its comparison requires it,
 * whatever the depth.
 *
 * Plausible failure: a comparison that visits both of its sides whole and then
 * each again to type it, which doubles the work at every level of nesting, so
 * a filter of a few hundred characters is billions of visits; or a branch node
 * that visits its children again once a branch gives a type.
 */

import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig } from "@/lib/__tests__/docHelpers";
import { proseText, type Uuid } from "@/lib/domain";
import {
	type Expression,
	eq,
	ifExpr,
	literal,
	prop,
	term,
} from "@/lib/domain/expression";
import { slotContext } from "@/lib/domain/expression/context";
import { underMeter, WorkMeter } from "../../../workMeter";
import { typedWhereRequired } from "../temporalLiterals";

const MODULE = testUuid("temporal-module") as Uuid;

/** `visit_date = '2026-01-01'`, then `depth` times wrapped in `if(<it>, 'a', 'b') = 'a'`. */
function chain(depth: number): Expression {
	let node: Expression = eq(
		prop("visit", "visit_date"),
		term(literal("2026-01-01")),
	);
	for (let level = 0; level < depth; level++)
		node = eq(
			ifExpr(node, term(literal("a")), term(literal("b"))),
			term(literal("a")),
		);
	return node;
}

/** The node `depth` levels in: the innermost comparison. */
function innermost(node: Expression, depth: number): Expression {
	let at = node;
	for (let level = 0; level < depth; level++) {
		if (at.kind !== "eq" || at.left.kind !== "if")
			throw new Error("The chain lost its shape.");
		at = at.left.cond;
	}
	return at;
}

/** The chain typed in a case list filter, with the visits it took. */
function typed(depth: number): {
	readonly tree: Expression;
	readonly visits: number;
} {
	const doc = buildDoc({
		caseTypes: [
			{
				name: "visit",
				properties: [
					{ name: "visit_date", label: proseText("Day"), data_type: "date" },
				],
			},
		],
		modules: [
			{
				uuid: MODULE,
				name: "Visits",
				caseType: "visit",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [],
			},
		],
	});
	const context = slotContext(
		doc,
		{ entity: "module", uuid: MODULE, slot: "case_list_filter" },
		new Map(),
	);
	if (context === undefined) throw new Error("The filter has no context.");
	const meter = new WorkMeter({ limit: Number.POSITIVE_INFINITY });
	const tree = underMeter(meter, () =>
		typedWhereRequired(chain(depth), context),
	);
	return { tree, visits: meter.byKind.visit };
}

it("types the literal of a chain thirty comparisons deep in one pass", () => {
	const shallow = typed(15);
	const deep = typed(30);
	expect(innermost(deep.tree, 30)).toEqual(
		eq(
			prop("visit", "visit_date"),
			term({ kind: "literal", value: "2026-01-01", data_type: "date" }),
		),
	);
	// A chain twice as long, plus the walk each comparison charges to its side, which the
	// checker types: a square of the length at most, never a power of two.
	expect(deep.visits).toBeLessThanOrEqual(4.5 * shallow.visits);
	expect(deep.visits).toBeLessThan(100_000);
});
