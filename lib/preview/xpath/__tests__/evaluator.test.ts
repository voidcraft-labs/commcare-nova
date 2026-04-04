import { describe, expect, it } from "vitest";
import { evaluate } from "../evaluator";
import type { EvalContext } from "../types";

function makeCtx(
	values: Record<string, string> = {},
	caseData: Record<string, string> = {},
): EvalContext {
	return {
		getValue: (path) => values[path],
		resolveHashtag: (ref) => {
			if (ref.startsWith("#form/"))
				return values[`/data/${ref.slice(6)}`] ?? "";
			if (ref.startsWith("#case/")) return caseData[ref.slice(6)] ?? "";
			if (ref.startsWith("#user/")) return "demo_user";
			return "";
		},
		contextPath: "/data/current",
		position: 1,
		size: 1,
	};
}

describe("XPath evaluator", () => {
	describe("literals", () => {
		it("evaluates number literals", () => {
			expect(evaluate("42", makeCtx())).toBe(42);
			expect(evaluate("3.14", makeCtx())).toBeCloseTo(3.14);
			expect(evaluate(".5", makeCtx())).toBeCloseTo(0.5);
		});

		it("evaluates string literals", () => {
			expect(evaluate('"hello"', makeCtx())).toBe("hello");
			expect(evaluate("'world'", makeCtx())).toBe("world");
		});

		it("returns empty string for empty expression", () => {
			expect(evaluate("", makeCtx())).toBe("");
			expect(evaluate("  ", makeCtx())).toBe("");
		});
	});

	describe("arithmetic", () => {
		it("addition", () => {
			expect(evaluate("2 + 3", makeCtx())).toBe(5);
		});

		it("subtraction", () => {
			expect(evaluate("10 - 4", makeCtx())).toBe(6);
		});

		it("multiplication", () => {
			expect(evaluate("3 * 7", makeCtx())).toBe(21);
		});

		it("division", () => {
			expect(evaluate("15 div 3", makeCtx())).toBe(5);
		});

		it("modulus", () => {
			expect(evaluate("10 mod 3", makeCtx())).toBe(1);
		});

		it("unary negative", () => {
			expect(evaluate("-5", makeCtx())).toBe(-5);
		});

		it("compound expressions", () => {
			expect(evaluate("2 + 3 * 4", makeCtx())).toBe(14);
		});

		it("division by zero returns NaN", () => {
			expect(evaluate("1 div 0", makeCtx())).toBeNaN();
		});
	});

	describe("comparison", () => {
		it("equals", () => {
			expect(evaluate("1 = 1", makeCtx())).toBe(true);
			expect(evaluate("1 = 2", makeCtx())).toBe(false);
			expect(evaluate('"a" = "a"', makeCtx())).toBe(true);
		});

		it("not equals", () => {
			expect(evaluate("1 != 2", makeCtx())).toBe(true);
			expect(evaluate("1 != 1", makeCtx())).toBe(false);
		});

		it("relational", () => {
			expect(evaluate("3 > 2", makeCtx())).toBe(true);
			expect(evaluate("3 < 2", makeCtx())).toBe(false);
			expect(evaluate("3 >= 3", makeCtx())).toBe(true);
			expect(evaluate("2 <= 3", makeCtx())).toBe(true);
		});
	});

	describe("logical", () => {
		it("and", () => {
			expect(evaluate("true() and true()", makeCtx())).toBe(true);
			expect(evaluate("true() and false()", makeCtx())).toBe(false);
		});

		it("or", () => {
			expect(evaluate("false() or true()", makeCtx())).toBe(true);
			expect(evaluate("false() or false()", makeCtx())).toBe(false);
		});
	});

	describe("path resolution", () => {
		it("resolves absolute paths", () => {
			const ctx = makeCtx({ "/data/name": "Alice" });
			expect(evaluate("/data/name", ctx)).toBe("Alice");
		});

		it("returns empty string for missing path", () => {
			expect(evaluate("/data/missing", makeCtx())).toBe("");
		});

		it("resolves nested paths", () => {
			const ctx = makeCtx({ "/data/group/child": "value" });
			expect(evaluate("/data/group/child", ctx)).toBe("value");
		});

		it("resolves self step", () => {
			const ctx = makeCtx({ "/data/current": "42" });
			expect(evaluate(".", ctx)).toBe("42");
		});
	});

	describe("hashtag references", () => {
		it("resolves #form/ refs", () => {
			const ctx = makeCtx({ "/data/age": "25" });
			expect(evaluate("#form/age", ctx)).toBe("25");
		});

		it("resolves #case/ refs", () => {
			const ctx = makeCtx({}, { risk_level: "high" });
			expect(evaluate("#case/risk_level", ctx)).toBe("high");
		});

		it("resolves #user/ refs", () => {
			expect(evaluate("#user/username", makeCtx())).toBe("demo_user");
		});
	});

	describe("functions", () => {
		it("if()", () => {
			expect(evaluate('if(true(), "yes", "no")', makeCtx())).toBe("yes");
			expect(evaluate('if(false(), "yes", "no")', makeCtx())).toBe("no");
		});

		it("not()", () => {
			expect(evaluate("not(true())", makeCtx())).toBe(false);
			expect(evaluate("not(false())", makeCtx())).toBe(true);
		});

		it("concat()", () => {
			expect(evaluate('concat("hello", " ", "world")', makeCtx())).toBe(
				"hello world",
			);
		});

		it("string-length()", () => {
			expect(evaluate('string-length("hello")', makeCtx())).toBe(5);
		});

		it("contains()", () => {
			expect(evaluate('contains("hello world", "world")', makeCtx())).toBe(
				true,
			);
			expect(evaluate('contains("hello", "xyz")', makeCtx())).toBe(false);
		});

		it("selected()", () => {
			const ctx = makeCtx({ "/data/symptoms": "fever cough" });
			expect(evaluate('selected(/data/symptoms, "fever")', ctx)).toBe(true);
			expect(evaluate('selected(/data/symptoms, "headache")', ctx)).toBe(false);
		});

		it("count-selected()", () => {
			const ctx = makeCtx({ "/data/items": "a b c" });
			expect(evaluate("count-selected(/data/items)", ctx)).toBe(3);
		});

		it("today() returns date string", () => {
			const result = evaluate("today()", makeCtx());
			expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		});

		it("int()", () => {
			expect(evaluate("int(3.7)", makeCtx())).toBe(3);
			expect(evaluate("int(-2.3)", makeCtx())).toBe(-2);
		});

		it("round()", () => {
			expect(evaluate("round(3.5)", makeCtx())).toBe(4);
			expect(evaluate("round(3.14)", makeCtx())).toBe(3);
		});

		it("coalesce()", () => {
			expect(evaluate('coalesce("", "", "fallback")', makeCtx())).toBe(
				"fallback",
			);
			expect(evaluate('coalesce("first", "second")', makeCtx())).toBe("first");
		});

		it("starts-with()", () => {
			expect(evaluate('starts-with("hello", "hel")', makeCtx())).toBe(true);
			expect(evaluate('starts-with("hello", "world")', makeCtx())).toBe(false);
		});

		it("substr()", () => {
			expect(evaluate('substr("hello", 1, 3)', makeCtx())).toBe("el");
		});

		it("normalize-space()", () => {
			expect(evaluate('normalize-space("  hello   world  ")', makeCtx())).toBe(
				"hello world",
			);
		});
	});

	describe("complex expressions", () => {
		it("comparison with path refs", () => {
			const ctx = makeCtx({ "/data/age": "25" });
			expect(evaluate("/data/age > 18", ctx)).toBe(true);
		});

		it("if with path comparison", () => {
			const ctx = makeCtx({
				"/data/gender": "female",
				"/data/pregnant": "yes",
			});
			expect(
				evaluate(
					'if(/data/gender = "female" and /data/pregnant = "yes", "high", "normal")',
					ctx,
				),
			).toBe("high");
		});

		it("nested function calls", () => {
			expect(
				evaluate('if(not(false()), concat("a", "b"), "c")', makeCtx()),
			).toBe("ab");
		});
	});

	describe("error handling", () => {
		it("returns empty string on parse error", () => {
			expect(evaluate("[[invalid", makeCtx())).toBe("");
		});
	});
});
