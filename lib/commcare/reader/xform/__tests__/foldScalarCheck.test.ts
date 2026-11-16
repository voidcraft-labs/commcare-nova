/**
 * The scalar check folded out of a question's constraint, over the
 * emitter's own print of `w.and(validation, check)`: the reader must return
 * the check and the author's validation whatever shape either takes, since
 * `w.and` flattens and the `reject` check holds two operands of its own.
 */
import { describe, expect, it } from "vitest";
import type { CaseScalarTextGuard } from "@/lib/domain/caseScalarTextGuard";
import { questionScalarCheck } from "../../../xform/builder";
import { w } from "../../../xpath/wire/builders";
import { serializeWire } from "../../../xpath/wire/serialize";
import type { WireExpr } from "../../../xpath/wire/tree";
import { sameXPathText } from "../../syntaxCompare";
import { foldScalarCheck } from "../logic";

const print = (expr: WireExpr) =>
	serializeWire(expr, { target: "xform", constraint: true }).text;

const self = w.context([w.self()]);
const length = w.call("string-length", [self]);

const VALIDATIONS: ReadonlyArray<readonly [string, WireExpr]> = [
	["a comparison", w.gt(length, w.num(2))],
	["an or", w.or(w.eq(self, w.str("a")), w.eq(self, w.str("b")))],
	["an and", w.and(w.gt(length, w.num(2)), w.ne(self, w.str("x")))],
	["a call", w.call("regex", [self, w.str("^[a-z]+$")])],
];

const CHECKS: readonly CaseScalarTextGuard[] = ["reject", "allow"];

describe("foldScalarCheck", () => {
	for (const check of CHECKS) {
		it(`reads the ${check} check standing alone`, () => {
			expect(foldScalarCheck(print(questionScalarCheck(check)))).toEqual({
				check,
				authored: undefined,
			});
		});
		for (const [name, validation] of VALIDATIONS)
			it(`reads the ${check} check after ${name}`, () => {
				const folded = foldScalarCheck(
					print(w.and(validation, questionScalarCheck(check))),
				);
				expect(folded?.check).toBe(check);
				const authored = folded?.authored;
				expect(authored).toBeDefined();
				expect(
					sameXPathText(authored ?? "", print(validation), {
						ruleSet: "form",
					}),
				).toBe(true);
			});
	}

	it("leaves a constraint holding no check whole", () => {
		expect(foldScalarCheck(print(w.gt(length, w.num(2))))).toBeUndefined();
		expect(
			foldScalarCheck(
				print(w.and(w.gt(length, w.num(2)), w.ne(self, w.str("x")))),
			),
		).toBeUndefined();
	});
});
