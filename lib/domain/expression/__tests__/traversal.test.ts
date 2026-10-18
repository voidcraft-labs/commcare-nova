import { describe, expect, it } from "vitest";
import { asUuid } from "../../uuid";
import { and, literal, not, term } from "../builders";
import { mapExpressionAst } from "../mapAst";
import type { Expression, FormFieldRef } from "../types";
import { walkExpression } from "../walk";

const field = asUuid("00000000-0000-4000-8000-000000000001");
const option = asUuid("00000000-0000-4000-8000-000000000002");
describe("one structural expression traversal", () => {
	it("descends through unchanged hook results into path predicates and preserves untouched branches", () => {
		const nested = term({ kind: "prop", caseType: "patient", property: "age" });
		const path: FormFieldRef = {
			kind: "field",
			uuid: field,
			filters: [{ step: { kind: "field", uuid: field }, where: [nested] }],
		};
		const untouched = term(literal(4));
		const expression: Expression = {
			kind: "arith",
			op: "+",
			left: term(path),
			right: untouched,
		};
		const seen: string[] = [];
		walkExpression(expression, {
			visitTerm: (leaf, at) => {
				if (leaf.kind === "prop") seen.push(JSON.stringify(at));
			},
		});
		expect(seen).toEqual(['["left","field","filters",0,"where",0]']);
		const mapped = mapExpressionAst(expression, {
			mapExpression: (node) => node,
			mapTerm: (leaf) =>
				leaf.kind === "prop" ? { ...leaf, property: "years" } : leaf,
		});
		expect(mapped).not.toBe(expression);
		expect(mapped.kind === "arith" && mapped.right).toBe(untouched);
		expect((mapped as typeof expression).left).toMatchObject({
			term: { filters: [{ where: [{ term: { property: "years" } }] }] },
		});
		expect(nested.term).toMatchObject({ property: "age" });
		expect(
			mapExpressionAst(expression, {
				mapExpression: (node) => node,
				mapTerm: (leaf) => leaf,
			}),
		).toBe(expression);
	});
	it("visits direct switch choice references and preserves their direct replacement role", () => {
		const choice = { kind: "choice", field, options: [option] } as const;
		const expression: Expression = {
			kind: "switch",
			on: term(literal("a")),
			cases: [
				// biome-ignore lint/suspicious/noThenProperty: This persisted branch is expression data.
				{ when: { ...choice, options: [option] }, then: term(literal(1)) },
			],
			fallback: term(literal(0)),
		};
		const refs: string[] = [];
		walkExpression(expression, {
			visitTerm: (leaf, path) => {
				if (leaf.kind === "choice") refs.push(JSON.stringify(path));
			},
		});
		expect(refs).toEqual(['["switch","cases",0,"when"]']);
		expect(
			mapExpressionAst(expression, {
				mapTerm: (leaf) =>
					leaf.kind === "choice" ? literal("saved") : undefined,
			}),
		).toMatchObject({ cases: [{ when: { kind: "literal", value: "saved" } }] });
		expect(
			mapExpressionAst(term({ ...choice, options: [option] }), {
				mapTerm: (leaf) =>
					leaf.kind === "choice" ? literal("saved") : undefined,
			}),
		).toEqual(term(literal("saved")));
	});
	it("does not allow a leaf replacement to corrupt a constrained direct property slot", () => {
		const expression: Expression = {
			kind: "within-distance",
			property: { kind: "prop", caseType: "patient", property: "location" },
			center: term(literal("0 0 0 0")),
			distance: 1,
			unit: "miles",
		};
		expect(() =>
			mapExpressionAst(expression, {
				mapTerm: (leaf) => (leaf.kind === "prop" ? literal("bad") : undefined),
			}),
		).toThrow("within-distance");
	});
	it("preserves boolean coercion for scalar singleton logical construction", () => {
		const scalar = term(literal(2));
		expect(and(scalar)).toEqual({
			kind: "not",
			clause: { kind: "not", clause: scalar },
		});
		expect(not(not(scalar))).toEqual({
			kind: "not",
			clause: { kind: "not", clause: scalar },
		});
		const condition: Expression = {
			kind: "eq",
			left: scalar,
			right: term(literal(2)),
		};
		expect(and(condition)).toBe(condition);
		expect(not(not(condition))).toBe(condition);
	});
});
