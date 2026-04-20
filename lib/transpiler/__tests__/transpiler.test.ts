import { describe, expect, it } from "vitest";
import { parser } from "@/lib/commcare/xpath";
import { transpile } from "../index";
import type { XPathType } from "../typeInfer";
import { inferTypes } from "../typeInfer";

// ── Helpers ─────────────────────────────────────────────────────────

/** Parse + infer, return the root expression's type. */
function rootType(source: string): XPathType {
	const tree = parser.parse(source);
	const types = inferTypes(tree, source);
	return types.get(tree.topNode) ?? "unknown";
}

/** Parse + infer + run the dateArithmetic pass, return edited source. */
function applyDatePass(source: string): string {
	return transpile(source);
}

// ── Type inference ──────────────────────────────────────────────────

describe("type inference", () => {
	describe("literals", () => {
		it("number literal → number", () => {
			expect(rootType("42")).toBe("number");
			expect(rootType("3.14")).toBe("number");
		});

		it("string literal → string", () => {
			expect(rootType('"hello"')).toBe("string");
			expect(rootType("'world'")).toBe("string");
		});
	});

	describe("references", () => {
		it("path refs → string", () => {
			expect(rootType("/data/name")).toBe("string");
			expect(rootType("#form/age")).toBe("string");
			expect(rootType("#case/status")).toBe("string");
		});

		it("self/parent steps → string", () => {
			expect(rootType(".")).toBe("string");
		});
	});

	describe("functions", () => {
		it("today() → date", () => {
			expect(rootType("today()")).toBe("date");
		});

		it("now() → date", () => {
			expect(rootType("now()")).toBe("date");
		});

		it("date(x) → date", () => {
			expect(rootType("date(0)")).toBe("date");
			expect(rootType("date('2024-01-15')")).toBe("date");
		});

		it("string() → string", () => {
			expect(rootType("string(42)")).toBe("string");
		});

		it("number() → number", () => {
			expect(rootType("number('42')")).toBe("number");
		});

		it("true()/false()/not() → boolean", () => {
			expect(rootType("true()")).toBe("boolean");
			expect(rootType("false()")).toBe("boolean");
			expect(rootType("not(true())")).toBe("boolean");
		});

		it("contains/selected → boolean", () => {
			expect(rootType('contains("abc", "a")')).toBe("boolean");
			expect(rootType('selected("a b", "a")')).toBe("boolean");
		});

		it("concat/substr/join → string", () => {
			expect(rootType('concat("a", "b")')).toBe("string");
			expect(rootType('substr("hello", 1)')).toBe("string");
		});

		it("floor/ceiling/round/count → number", () => {
			expect(rootType("floor(3.7)")).toBe("number");
			expect(rootType("ceiling(3.2)")).toBe("number");
			expect(rootType("round(3.5)")).toBe("number");
		});

		it("format-date → string", () => {
			expect(rootType("format-date(today(), '%Y')")).toBe("string");
		});

		it("if() inherits branch type when both match", () => {
			expect(rootType('if(true(), "a", "b")')).toBe("string");
			expect(rootType("if(true(), 1, 2)")).toBe("number");
			expect(rootType("if(true(), today(), date('2024-01-01'))")).toBe("date");
		});

		it("if() returns unknown when branches differ", () => {
			expect(rootType('if(true(), 1, "hello")')).toBe("unknown");
			expect(rootType("if(true(), today(), 42)")).toBe("unknown");
		});

		it("unknown function → unknown", () => {
			expect(rootType("some_future_func()")).toBe("unknown");
		});
	});

	describe("arithmetic", () => {
		it("number + number → number", () => {
			expect(rootType("2 + 3")).toBe("number");
		});

		it("date + number → date", () => {
			expect(rootType("today() + 1")).toBe("date");
			expect(rootType("today() + 7")).toBe("date");
		});

		it("number + date → date (commutative)", () => {
			expect(rootType("1 + today()")).toBe("date");
		});

		it("date - number → date", () => {
			expect(rootType("today() - 7")).toBe("date");
		});

		it("date - date → number", () => {
			expect(rootType("date('2024-06-15') - date('2024-01-01')")).toBe(
				"number",
			);
		});

		it("date + date → number (unusual but consistent)", () => {
			expect(rootType("today() + today()")).toBe("number");
		});

		it("multiply/divide/mod always → number", () => {
			expect(rootType("3 * 4")).toBe("number");
			expect(rootType("10 div 2")).toBe("number");
			expect(rootType("10 mod 3")).toBe("number");
		});

		it("unary negative → number", () => {
			expect(rootType("-5")).toBe("number");
		});
	});

	describe("comparison and logical", () => {
		it("comparisons → boolean", () => {
			expect(rootType("1 = 1")).toBe("boolean");
			expect(rootType("1 != 2")).toBe("boolean");
			expect(rootType("3 > 2")).toBe("boolean");
			expect(rootType("3 < 2")).toBe("boolean");
			expect(rootType("3 >= 2")).toBe("boolean");
			expect(rootType("3 <= 2")).toBe("boolean");
		});

		it("and/or → boolean", () => {
			expect(rootType("true() and false()")).toBe("boolean");
			expect(rootType("true() or false()")).toBe("boolean");
		});
	});

	describe("nested expressions", () => {
		it("date arithmetic nested in comparison", () => {
			/* The comparison is boolean, but the left operand is date */
			expect(rootType("today() + 7 > today()")).toBe("boolean");
		});

		it("date function wrapping arithmetic", () => {
			/* date(number) → date, even if the number came from arithmetic */
			expect(rootType("date(today() + 1)")).toBe("date");
		});

		it("if with date branches", () => {
			expect(rootType("if(true(), today() + 1, today() - 1)")).toBe("date");
		});
	});
});

// ── Date arithmetic pass ────────────────────────────────────────────

describe("dateArithmetic pass", () => {
	describe("wraps date-producing arithmetic", () => {
		it("today() + N", () => {
			expect(applyDatePass("today() + 1")).toBe("date(today() + 1)");
			expect(applyDatePass("today() + 7")).toBe("date(today() + 7)");
			expect(applyDatePass("today() + 30")).toBe("date(today() + 30)");
		});

		it("today() - N", () => {
			expect(applyDatePass("today() - 1")).toBe("date(today() - 1)");
			expect(applyDatePass("today() - 30")).toBe("date(today() - 30)");
		});

		it("N + today() (commutative)", () => {
			expect(applyDatePass("1 + today()")).toBe("date(1 + today())");
		});

		it("date() + N", () => {
			expect(applyDatePass("date('2024-01-01') + 30")).toBe(
				"date(date('2024-01-01') + 30)",
			);
		});

		it("nested date arithmetic in expressions", () => {
			/* The inner addition is date-typed and needs wrapping,
			   but the outer comparison does not */
			expect(applyDatePass("today() + 7 > today()")).toBe(
				"date(today() + 7) > today()",
			);
		});
	});

	describe("skips non-date arithmetic", () => {
		it("number + number unchanged", () => {
			expect(applyDatePass("2 + 3")).toBe("2 + 3");
		});

		it("string path + number unchanged", () => {
			expect(applyDatePass("/data/age + 1")).toBe("/data/age + 1");
		});

		it("multiply/divide/mod unchanged", () => {
			expect(applyDatePass("3 * 4")).toBe("3 * 4");
			expect(applyDatePass("10 div 2")).toBe("10 div 2");
		});
	});

	describe("skips date - date (produces number, not date)", () => {
		it("date subtraction unchanged", () => {
			expect(applyDatePass("date('2024-06-15') - date('2024-01-01')")).toBe(
				"date('2024-06-15') - date('2024-01-01')",
			);
		});
	});

	describe("avoids double-wrapping", () => {
		it("already inside date() call", () => {
			expect(applyDatePass("date(today() + 1)")).toBe("date(today() + 1)");
		});

		it("date(date('...') + N) stays single-wrapped", () => {
			expect(applyDatePass("date(date('2024-01-01') + 30)")).toBe(
				"date(date('2024-01-01') + 30)",
			);
		});
	});

	describe("passthrough edge cases", () => {
		it("empty string", () => {
			expect(applyDatePass("")).toBe("");
		});

		it("parse error — passed through unchanged", () => {
			expect(applyDatePass("[[invalid")).toBe("[[invalid");
		});

		it("no-op expressions", () => {
			expect(applyDatePass("true()")).toBe("true()");
			expect(applyDatePass('"hello"')).toBe('"hello"');
			expect(applyDatePass("42")).toBe("42");
		});
	});
});

// ── End-to-end transpile ────────────────────────────────────────────

describe("transpile (end-to-end)", () => {
	it("real CommCare patterns: default value = today() + 30", () => {
		expect(transpile("today() + 30")).toBe("date(today() + 30)");
	});

	it("real CommCare patterns: deadline calculation", () => {
		/* "due date is 14 days from the visit date" */
		expect(transpile("date(#form/visit_date) + 14")).toBe(
			"date(date(#form/visit_date) + 14)",
		);
	});

	it("real CommCare patterns: age in days", () => {
		/* date - date produces a number — no wrapping */
		expect(transpile("today() - date(#form/dob)")).toBe(
			"today() - date(#form/dob)",
		);
	});

	it("complex expression with mixed types", () => {
		/* if(cond, date-expr, date-expr) — branches produce dates, but
		   the if() call itself isn't arithmetic, so no wrapping needed.
		   The inner arithmetic gets wrapped though. */
		expect(transpile("if(true(), today() + 1, today() - 1)")).toBe(
			"if(true(), date(today() + 1), date(today() - 1))",
		);
	});

	it("leaves non-date expressions untouched", () => {
		const expr =
			'if(/data/gender = "female" and /data/pregnant = "yes", "high", "normal")';
		expect(transpile(expr)).toBe(expr);
	});
});
