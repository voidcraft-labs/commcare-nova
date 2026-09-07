import { describe, expect, it } from "vitest";
import {
	and,
	eq,
	literal,
	matchAll,
	matchNone,
	or,
	prop,
} from "@/lib/domain/predicate";
import { logicalClauses, planLogicalGroupEdit } from "../logicalGroupModel";

const a = eq(prop("patient", "age"), literal(1));
const b = eq(prop("patient", "age"), literal(2));
const c = eq(prop("patient", "age"), literal(3));
describe("production logical group edits", () => {
	it("moves a specific occurrence while preserving child identity and emits the matching sidecar operation", () => {
		const source = and(a, b, a, c);
		const plan = planLogicalGroupEdit(source, {
			kind: "move",
			index: 2,
			direction: -1,
		});
		expect(plan).toEqual({
			clauses: [a, a, b, c],
			operation: { kind: "move", fromIndex: 2, toIndex: 1 },
			focusIndex: 1,
		});
		expect(plan?.clauses[2]).toBe(b);
		expect(source.clauses).toEqual([a, b, a, c]);
	});
	it.each([-1, 0.5, 3])(
		"rejects invalid row index %s before editing",
		(index) =>
			expect(
				planLogicalGroupEdit(and(a, b, c), { kind: "remove", index }),
			).toBeUndefined(),
	);
	it("refuses boundary moves and grouping without a following row", () => {
		expect(
			planLogicalGroupEdit(and(a, b), {
				kind: "move",
				index: 0,
				direction: -1,
			}),
		).toBeUndefined();
		expect(
			planLogicalGroupEdit(and(a, b), { kind: "move", index: 1, direction: 1 }),
		).toBeUndefined();
		expect(
			planLogicalGroupEdit(and(a, b), { kind: "group-next", index: 1 }),
		).toBeUndefined();
		expect(
			planLogicalGroupEdit(and(a, b), { kind: "ungroup", index: 0 }),
		).toBeUndefined();
	});
	it("groups two rows under the opposite connector and ungroups without dropping their authored values", () => {
		const plan = planLogicalGroupEdit(and(a, b, c), {
			kind: "group-next",
			index: 0,
		});
		expect(plan).toEqual({
			clauses: [or(a, b), c],
			operation: { kind: "splice", index: 0, deleteCount: 2, insertCount: 1 },
			focusIndex: 0,
		});
		const nested = logicalClauses("and", plan?.clauses ?? []);
		if (nested.kind !== "and") throw new Error("Expected group");
		expect(planLogicalGroupEdit(nested, { kind: "ungroup", index: 0 })).toEqual(
			{
				clauses: [a, b, c],
				operation: { kind: "splice", index: 0, deleteCount: 1, insertCount: 2 },
				focusIndex: 0,
			},
		);
	});
	it("replaces only the selected child and removes to the surviving identity", () => {
		const source = or(a, b);
		expect(
			planLogicalGroupEdit(source, { kind: "replace", index: 0, value: c })
				?.clauses,
		).toEqual([c, b]);
		const plan = planLogicalGroupEdit(source, { kind: "remove", index: 0 });
		expect(plan).toEqual({
			clauses: [b],
			operation: { kind: "splice", index: 0, deleteCount: 1, insertCount: 0 },
			focusIndex: 0,
		});
		expect(logicalClauses("or", plan?.clauses ?? [])).toBe(b);
	});
	it("only reduces zero/one envelopes, retaining nested and sentinel authoring", () => {
		expect(logicalClauses("and", [])).toEqual(matchAll());
		expect(logicalClauses("or", [])).toEqual(matchNone());
		const nested = or(a, b);
		const clauses = [a, matchAll(), nested];
		expect(logicalClauses("and", clauses)).toEqual({ kind: "and", clauses });
		expect(logicalClauses("and", [nested])).toBe(nested);
	});
});
