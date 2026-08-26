import { describe, expect, it, vi } from "vitest";
import { GEOPOINT_CENTER_PATTERN } from "@/lib/commcare/predicate/geopoint";
import { xpathToString } from "../coerce";
import { evaluate } from "../evaluator";
import { invokeGeneratedJavaRosaFunction } from "../generatedJavaRosaFunctions";
import type { EvalContext } from "../types";
import { isXPathDate } from "../types";

function makeCtx(
	values: Record<string, string> = {},
	caseData: Record<string, string> = {},
	instances: Record<string, Record<string, string>> = {},
): EvalContext {
	return {
		getValue: (path) => values[path],
		resolveInstance: (instanceId, path) =>
			Object.hasOwn(instances, instanceId)
				? { kind: "supported", value: instances[instanceId]?.[path] }
				: { kind: "unsupported" },
		resolveHashtag: (ref) => {
			if (ref.startsWith("#form/"))
				return values[`/data/${ref.slice(6)}`] ?? "";
			if (ref.startsWith("#patient/")) return caseData[ref.slice(9)] ?? "";
			if (ref.startsWith("#user/")) return "demo_user";
			return "";
		},
		contextPath: "/data/current",
		position: 1,
	};
}

describe("XPath evaluator", () => {
	describe("parenthesized left operands", () => {
		// The grammar splices grouping parens flat into the parent node, so a
		// binary node's first child can be the `(` token. The evaluator must
		// still read the whole binary expression, not just the group.
		it("keeps the right operand of a binary expression whose left is parenthesized", () => {
			expect(evaluate("(true()) and false()", makeCtx())).toBe(false);
			expect(evaluate("(false()) or true()", makeCtx())).toBe(true);
			expect(evaluate("(1 + 2) * 3", makeCtx())).toBe(9);
			expect(evaluate("(10 - 4) div 2", makeCtx())).toBe(3);
			expect(evaluate("(2) = 3", makeCtx())).toBe(false);
			expect(evaluate("(2) < 3", makeCtx())).toBe(true);
			expect(evaluate("((1 + 2)) * 3", makeCtx())).toBe(9);
			expect(evaluate("(true()) and (false())", makeCtx())).toBe(false);
		});

		it("still evaluates a fully parenthesized expression and a parenthesized right operand", () => {
			expect(evaluate("(1 + 2)", makeCtx())).toBe(3);
			expect(evaluate("((true()))", makeCtx())).toBe(true);
			expect(evaluate("3 * (1 + 2)", makeCtx())).toBe(9);
			expect(evaluate("true() and (false())", makeCtx())).toBe(false);
		});

		it("negates a parenthesized operand and fails closed on an inadmissible filter", () => {
			expect(evaluate("-(2)", makeCtx())).toBe(-2);
			expect(evaluate("-(1 + 2)", makeCtx())).toBe(-3);
			expect(evaluate("-2", makeCtx())).toBe(-2);
			expect(() => evaluate("(5)[1]", makeCtx())).toThrow(
				"without structural context",
			);
		});
	});

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

		it("evaluates a fully-parenthesized root expression", () => {
			// The grammar splices grouping parens flat into the parent (no
			// wrapper node), so the root's first child is the `(` token —
			// the evaluator must skip it rather than fall through to blank.
			// CSQL rejection guards parenthesize each obligation, so a
			// single-obligation condition arrives exactly in this shape.
			expect(evaluate("(1 = 1)", makeCtx())).toBe(true);
			expect(evaluate("('a')", makeCtx())).toBe("a");
			expect(evaluate("((1 = 1))", makeCtx())).toBe(true);
			expect(evaluate("(true())", makeCtx())).toBe(true);
			expect(evaluate("(1 = 1) or (2 = 3)", makeCtx())).toBe(true);
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

		it("uses Java double division by zero", () => {
			expect(evaluate("1 div 0", makeCtx())).toBe(Number.POSITIVE_INFINITY);
			expect(evaluate("-1 div 0", makeCtx())).toBe(Number.NEGATIVE_INFINITY);
			expect(evaluate("0 div 0", makeCtx())).toBeNaN();
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

		it("date strings compare against today() (JavaRosa's toNumeric date fallback)", () => {
			// A date field's instance value is the ISO string — the natural
			// authored rule `. <= today()` must accept a past date, exactly
			// as it does on-device.
			expect(evaluate('"2000-05-01" <= today()', makeCtx())).toBe(true);
			expect(evaluate('"2099-01-01" <= today()', makeCtx())).toBe(false);
			expect(evaluate('today() >= "2000-05-01"', makeCtx())).toBe(true);
		});

		it("does not reinterpret authored datetime strings as typed dates", () => {
			// Core's string gate rejects the `T`, `:` and timezone characters.
			// Casedb timestamps reach the evaluator as XPathDate instead.
			expect(
				evaluate('number("2000-05-01T21:31:18.377Z")', makeCtx()),
			).toBeNaN();
			expect(evaluate('"2000-05-01T21:31:18.377Z" <= today()', makeCtx())).toBe(
				false,
			);
		});

		it("non-padded date literals compare (JavaRosa parses '1900-1-1')", () => {
			// DateUtils.parseDate Integer.parseInt's dash-split pieces, so a
			// non-padded authored literal is legal on-device.
			expect(evaluate('"2000-05-01" >= "1900-1-1"', makeCtx())).toBe(true);
			expect(evaluate('"1899-12-31" >= "1900-1-1"', makeCtx())).toBe(false);
		});

		it("non-numeric non-date strings compare as NaN (always false)", () => {
			expect(evaluate('"banana" <= today()', makeCtx())).toBe(false);
			expect(evaluate('"banana" > today()', makeCtx())).toBe(false);
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

		it("resolves an instance-rooted path through the context namespace", () => {
			const ctx = makeCtx(
				{},
				{},
				{
					commcaresession: { "/session/context/userid": "worker-1" },
				},
			);
			expect(
				evaluate("instance('commcaresession')/session/context/userid", ctx),
			).toBe("worker-1");
		});

		it("fails loudly for a secondary instance with no Preview resolver", () => {
			expect(() =>
				evaluate("instance('casedb')/casedb/case/name", makeCtx()),
			).toThrow("Unsupported XPath instance in Preview: instance('casedb')");
		});

		it("fails loudly for path initializers Preview cannot model", () => {
			expect(() => evaluate("current()/name", makeCtx())).toThrow(
				"Unsupported XPath path initializer in Preview: current()",
			);
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

		it("resolves explicit case-type refs", () => {
			const ctx = makeCtx({}, { risk_level: "high" });
			expect(evaluate("#patient/risk_level", ctx)).toBe("high");
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

		it("evaluates only the selected if() branch", () => {
			expect(
				evaluate("if(false(), unsupported-function('x'), 'ok')", makeCtx()),
			).toBe("ok");
			expect(() =>
				evaluate("if(true(), unsupported-function('x'), 'ok')", makeCtx()),
			).toThrow(
				"Unsupported XPath function in Preview: unsupported-function()",
			);
		});

		it("not()", () => {
			expect(evaluate("not(true())", makeCtx())).toBe(false);
			expect(evaluate("not(false())", makeCtx())).toBe(true);
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
			expect(evaluate('selected(/data/symptoms, " fever ")', ctx)).toBe(true);
			expect(evaluate('selected(/data/symptoms, "headache")', ctx)).toBe(false);
			expect(() => evaluate("selected(1, '1')", ctx)).toThrow(
				"must be a string",
			);
		});

		it("count-selected()", () => {
			const ctx = makeCtx({ "/data/items": "a  b" });
			expect(evaluate("count-selected(/data/items)", ctx)).toBe(2);
			const three = makeCtx({ "/data/items": "a b c" });
			expect(evaluate("count-selected(/data/items)", three)).toBe(3);
			expect(() => evaluate("count-selected(1)", ctx)).toThrow(
				"must be a string",
			);
		});

		it("uses the active form locale for alternate-calendar month names", () => {
			expect(
				evaluate("format-date-for-calendar('2017-07-15', 'ethiopian')", {
					...makeCtx(),
					locale: "amh",
				}),
			).toBe("8 ሐምሌ 2009");
		});

		it("preserves JavaRosa's malformed-date failure for alternate calendars", () => {
			expect(
				evaluate("format-date-for-calendar('', 'nepali')", makeCtx()),
			).toBe("");
			expect(() =>
				evaluate("format-date-for-calendar('not-a-date', 'nepali')", makeCtx()),
			).toThrow("format-date-for-calendar() value is invalid");
		});

		it("selected-at() returns the Nth token and throws out of range like JavaRosa", () => {
			const ctx = makeCtx({ "/data/items": "a b c" });
			expect(evaluate("selected-at(/data/items, 1)", ctx)).toBe("b");
			// commcare-core `XPathSelectedAtFunc.selectedAt` THROWS for an
			// out-of-range index — the device errors the evaluating screen
			// instead of rendering blank, and Preview must fail the same way.
			expect(() => evaluate("selected-at(/data/items, 3)", ctx)).toThrow(
				/select element 3 of a list with only 3 elements/,
			);
			expect(() => evaluate("selected-at(/data/items, -1)", ctx)).toThrow();
			expect(() => evaluate("selected-at(1, 0)", ctx)).toThrow(
				"must be a string",
			);
			expect(evaluate("selected-at(/data/items, number('bad'))", ctx)).toBe(
				"a",
			);
		});

		it("today() returns an XPathDate", () => {
			const result = evaluate("today()", makeCtx());
			expect(isXPathDate(result)).toBe(true);
			/* String coercion produces ISO date format */
			expect(xpathToString(result)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
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
			expect(() =>
				evaluate("coalesce('ok', unsupported-function('x'))", makeCtx()),
			).toThrow(
				"Unsupported XPath function in Preview: unsupported-function()",
			);
			expect(() =>
				evaluate("coalesce('ok', selected(1, '1'))", makeCtx()),
			).toThrow("must be a string");
			expect(evaluate("coalesce(number('bad'))", makeCtx())).toBeNaN();
			expect(() =>
				evaluate("coalesce('', unsupported-function('x'))", makeCtx()),
			).toThrow(
				"Unsupported XPath function in Preview: unsupported-function()",
			);
		});

		it("starts-with()", () => {
			expect(evaluate('starts-with("hello", "hel")', makeCtx())).toBe(true);
			expect(evaluate('starts-with("hello", "world")', makeCtx())).toBe(false);
		});

		it("substr()", () => {
			expect(evaluate('substr("hello", 1, 3)', makeCtx())).toBe("el");
			expect(evaluate('substr("abc", -1)', makeCtx())).toBe("c");
			expect(evaluate('substr("abc", 3, 1)', makeCtx())).toBe("");
			expect(evaluate('substr("abc", number("bad"))', makeCtx())).toBe("abc");
		});

		it("uuid(length) uses JavaRosa's requested uppercase base-36 shape", () => {
			const value = evaluate("uuid(4)", makeCtx());
			expect(value).toMatch(/^[0-9A-Z]{4}$/);
		});

		it("preserves scalar forms of nodeset-overloaded functions", () => {
			expect(evaluate("concat('a', 'b')", makeCtx())).toBe("ab");
			expect(evaluate("concat('a')", makeCtx())).toBe("a");
			expect(evaluate("join(',', 'a', 'b')", makeCtx())).toBe("a,b");
			expect(evaluate("join(',', 'a')", makeCtx())).toBe("a");
			expect(evaluate("min(2, 1)", makeCtx())).toBe(1);
			expect(evaluate("max(2, 1)", makeCtx())).toBe(2);
		});

		it("does not scalarize nodeset signatures in a legacy scalar context", () => {
			for (const expression of ["count(/data/items)", "sum(/data/items)"]) {
				expect(() => evaluate(expression, makeCtx())).toThrow(
					"requires a nodeset argument",
				);
			}
			expect(
				evaluate(
					"concat(string(/data/items))",
					makeCtx({ "/data/items": "a" }),
				),
			).toBe("a");
		});

		it("rejects position(nodeset) while preserving context position()", () => {
			expect(evaluate("position()", { ...makeCtx(), position: 3 })).toBe(3);
			expect(() => evaluate("position(/data/items)", makeCtx())).toThrow(
				"Unsupported XPath function signature in Preview: position(nodeset)",
			);
		});

		it("normalize-space()", () => {
			expect(evaluate('normalize-space("  hello   world  ")', makeCtx())).toBe(
				"hello world",
			);
			// XPath XML whitespace excludes NBSP; JavaRosa leaves it intact.
			expect(evaluate("normalize-space('a   b')", makeCtx())).toBe("a  b");
		});

		it("rejects Java-regex functions rather than approximating Pattern", () => {
			for (const expression of [
				String.raw`regex('é', '\p{L}')`,
				"replace('abc', 'b', 'x')",
			]) {
				expect(() => evaluate(expression, makeCtx())).toThrow(
					"Unsupported XPath function in Preview",
				);
			}
		});

		it("admits only verified machine-generated Java Pattern calls", () => {
			const generatedCtx = {
				...makeCtx(),
				invokeGeneratedFunction: invokeGeneratedJavaRosaFunction,
			};
			expect(
				evaluate(`regex('42 -71', '${GEOPOINT_CENTER_PATTERN}')`, generatedCtx),
			).toBe(true);
			expect(
				evaluate(
					String.raw`replace('  $&  ', '^[\x00-\x20]+|[\x00-\x20]+$', '$1')`,
					generatedCtx,
				),
			).toBe("$1$&$1");
			expect(() => evaluate("replace('abc', 'b', 'x')", generatedCtx)).toThrow(
				"Unsupported XPath function in Preview",
			);
		});

		it("translate() iterates Java UTF-16 char units", () => {
			expect(evaluate("translate('😀', '😀', 'AB')", makeCtx())).toBe("AB");
			// Core checks its excess-source deletion suffix before the replacement
			// map, so a duplicated source unit in that suffix is deleted.
			expect(evaluate("translate('a', 'aa', 'b')", makeCtx())).toBe("");
		});

		it("uses Core's numeric boolean epsilon", () => {
			expect(evaluate("boolean(0.0000000000001)", makeCtx())).toBe(false);
			expect(evaluate("boolean(0.0000000000011)", makeCtx())).toBe(true);
		});

		it("uses Core's numeric equality epsilon and Java number text", () => {
			expect(evaluate("1 = 1.0000000000001", makeCtx())).toBe(true);
			expect(evaluate("1 = 1.0000000000011", makeCtx())).toBe(false);
			expect(evaluate("string(0.0000000000001)", makeCtx())).toBe("0");
			expect(evaluate("string(10000000)", makeCtx())).toBe("10000000");
			expect(evaluate("string(10000000000)", makeCtx())).toBe("1.0E10");
			expect(evaluate("string(pow(10, 23))", makeCtx())).toBe(
				"9.999999999999999E22",
			);
		});

		it("fails loudly for unknown or prototype method names", () => {
			for (const name of ["unknownFunction", "valueOf", "hasOwnProperty"]) {
				expect(() => evaluate(`${name}()`, makeCtx())).toThrow(
					`Unsupported XPath function in Preview: ${name}()`,
				);
			}
		});
	});

	describe("date arithmetic", () => {
		it("today() + 1 returns tomorrow's numeric epoch day", () => {
			const todayPlus1 = evaluate("today() + 1", makeCtx());
			expect(typeof todayPlus1).toBe("number");
			expect(todayPlus1).toBe(
				(evaluate("number(today())", makeCtx()) as number) + 1,
			);
		});

		it("today() - 1 returns yesterday's numeric epoch day", () => {
			const result = evaluate("today() - 1", makeCtx());
			expect(typeof result).toBe("number");
			expect(result).toBe(
				(evaluate("number(today())", makeCtx()) as number) - 1,
			);
		});

		it("date(today() + 1) converts the numeric result back to a date", () => {
			const bare = evaluate("today() + 1", makeCtx());
			const wrapped = evaluate("date(today() + 1)", makeCtx());
			expect(typeof bare).toBe("number");
			expect(isXPathDate(wrapped)).toBe(true);
			expect(evaluate("number(date(today() + 1))", makeCtx())).toBe(bare);
		});

		it("date - date returns a plain number (day difference)", () => {
			const result = evaluate(
				"date('2024-01-15') - date('2024-01-10')",
				makeCtx(),
			);
			expect(typeof result).toBe("number");
			expect(result).toBe(5);
		});

		it("date + number returns a numeric epoch day", () => {
			const result = evaluate("date('1970-01-01') + 0", makeCtx());
			expect(result).toBe(0);
		});

		it("date + 1 increments the numeric epoch day", () => {
			const result = evaluate("date('1970-01-01') + 1", makeCtx());
			expect(result).toBe(1);
		});

		it("date(0) gives epoch", () => {
			const result = evaluate("date(0)", makeCtx());
			expect(isXPathDate(result)).toBe(true);
			expect(xpathToString(result)).toBe("1970-01-01");
		});

		it("parses the BMP decimal digits accepted by Java date components", () => {
			expect(xpathToString(evaluate("date('٢٠٢٦-٠٨-٢٥')", makeCtx()))).toBe(
				"2026-08-25",
			);
			expect(
				isXPathDate(evaluate("date('٢٠٢٦-٠٨-٢٥T١٢:٣٤+٠٢:٣٠')", makeCtx())),
			).toBe(true);
		});

		it("rejects Core's out-of-range numeric date inputs", () => {
			expect(() => evaluate("date(1 div 0)", makeCtx())).toThrow(
				"date() value is invalid",
			);
			expect(() => evaluate("date(2147483648)", makeCtx())).toThrow(
				"date() value is invalid",
			);
			expect(() => evaluate("date(-2147483649)", makeCtx())).toThrow(
				"date() value is invalid",
			);
		});

		it("date comparison works via numeric coercion", () => {
			expect(
				evaluate("date('2024-06-15') > date('2024-01-01')", makeCtx()),
			).toBe(true);
			expect(
				evaluate("date('2024-01-01') > date('2024-06-15')", makeCtx()),
			).toBe(false);
		});

		it("today() is truthy", () => {
			expect(evaluate("boolean(today())", makeCtx())).toBe(true);
		});

		it("format-date works with XPathDate from today()", () => {
			const result = evaluate("format-date(today(), '%Y')", makeCtx());
			expect(result).toBe(String(new Date().getFullYear()));
		});

		it("format-date preserves now() time and maps NaN to blank", () => {
			vi.useFakeTimers();
			try {
				vi.setSystemTime(new Date("2026-08-15T12:34:56Z"));
				expect(evaluate("format-date(now(), '%H:%M')", makeCtx())).toBe(
					`${String(new Date().getHours()).padStart(2, "0")}:${String(new Date().getMinutes()).padStart(2, "0")}`,
				);
				expect(evaluate("format-date(number('bad'), '%Y')", makeCtx())).toBe(
					"",
				);
			} finally {
				vi.useRealTimers();
			}
		});

		it("format-date fails loudly for an unsupported pattern", () => {
			expect(() =>
				evaluate("format-date('2026-07-14', '%Q')", makeCtx()),
			).toThrow("XPath format-date() pattern is unsupported in Preview");
		});

		it("number(date('2008-09-05')) returns days since epoch", () => {
			const result = evaluate("number(date('2008-09-05'))", makeCtx());
			/* 2008-09-05 = 14127 days since epoch (matches CommCare test suite) */
			expect(result).toBe(14127);
		});

		it("string(today()) produces ISO date string", () => {
			const result = evaluate("string(today())", makeCtx());
			expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		});

		it("matches Core's date, now, and double coercions", () => {
			expect(xpathToString(evaluate("date(-0.5)", makeCtx()))).toBe(
				"1970-01-01",
			);
			const originalTimeZone = process.env.TZ;
			vi.useFakeTimers();
			try {
				process.env.TZ = "America/Los_Angeles";
				vi.setSystemTime(new Date("2026-08-15T01:34:56Z"));
				expect(evaluate("string(today())", makeCtx())).toBe("2026-08-14");
				const rounded = evaluate("date(now())", makeCtx());
				expect(isXPathDate(rounded) && rounded.time).toBeNull();
				expect(evaluate("string(now())", makeCtx())).toBe("2026-08-14");
				expect(Number.isInteger(evaluate("double(now())", makeCtx()))).toBe(
					false,
				);
			} finally {
				vi.useRealTimers();
				if (originalTimeZone === undefined) delete process.env.TZ;
				else process.env.TZ = originalTimeZone;
			}
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
				evaluate('if(not(false()), string-length("ab"), 0)', makeCtx()),
			).toBe(2);
		});
	});

	describe("error handling", () => {
		it("fails closed for parse errors that bypassed admission", () => {
			expect(() => evaluate("[[invalid", makeCtx())).toThrow(
				"did not pass admission",
			);
		});
	});
});
