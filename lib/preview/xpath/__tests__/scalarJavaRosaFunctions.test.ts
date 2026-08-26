import { describe, expect, it } from "vitest";
import {
	EAGER_SCALAR_JAVAROSA_FUNCTIONS,
	scalarJavaRosaFunctions,
	selectCondArgument,
} from "../scalarJavaRosaFunctions";
import type { XPathValue } from "../types";

function call(name: string, ...args: XPathValue[]): XPathValue {
	const fn = scalarJavaRosaFunctions.get(name);
	if (!fn) throw new Error(`Missing scalar JavaRosa function ${name}()`);
	return fn(args) as XPathValue;
}

describe("scalar JavaRosa function ports", () => {
	it("ports Core's scalar math functions", () => {
		expect(call("pi")).toBe(Math.PI);
		expect(call("log", Math.E)).toBeCloseTo(1);
		expect(call("log10", 100)).toBe(2);
		expect(call("sqrt", 4)).toBe(2);
		expect(call("exp", 1)).toBe(Math.E);
		expect(call("sin", 0)).toBe(0);
		expect(call("cos", 0)).toBe(1);
		expect(call("tan", 0)).toBe(0);
		expect(call("asin", 0)).toBe(0);
		expect(call("acos", 1)).toBe(0);
		expect(call("atan", 0)).toBe(0);
		expect(call("atan2", 0, 0)).toBe(0);
	});

	it("matches boolean-from-string and the selected alias", () => {
		for (const truthy of ["true", "TRUE", "1", 1, true] as const) {
			expect(call("boolean-from-string", truthy)).toBe(true);
		}
		for (const falsey of ["false", "0", "whatever", 1.0001] as const) {
			expect(call("boolean-from-string", falsey)).toBe(false);
		}
		expect(call("is-selected", "apple baby crimson", " baby ")).toBe(true);
		expect(call("is-selected", "apple", "\u00a0apple\u00a0")).toBe(false);
		expect(call("is-selected", "apple baby crimson", "bab")).toBe(false);
		expect(() => call("is-selected", 1, "1")).toThrow("must be a string");
	});

	it("ports Core's string edge behavior", () => {
		expect(call("upper-case", "SimpLY")).toBe("SIMPLY");
		expect(call("lower-case", "rEd")).toBe("red");
		expect(call("ends-with", "elements", "nts")).toBe(true);
		expect(call("substring-before", "1999/04/01", "/")).toBe("1999");
		expect(call("substring-before", "abc", "abc")).toBe("");
		expect(call("substring-after", "1999/04/01", "/")).toBe("04/01");
		// This is Core's intentional behavior, despite differing from XPath 1.0.
		expect(call("substring-after", "abc", "missing")).toBe("abc");
	});

	it("preserves cond() laziness and depend() eagerness metadata", () => {
		const visited: number[] = [];
		const selected = selectCondArgument(7, (index) => {
			visited.push(index);
			return index === 2;
		});
		expect(selected).toBe(3);
		expect(visited).toEqual([0, 2]);
		expect(selectCondArgument(5, () => false)).toBe(4);
		expect(EAGER_SCALAR_JAVAROSA_FUNCTIONS.has("depend")).toBe(true);
		expect(call("depend", "answer", "dependency")).toBe("answer");
	});

	it("ports scalar checklist and join-chunked behavior", () => {
		expect(call("checklist", 1, 2, true, false, true)).toBe(true);
		expect(call("checklist", -1, 1, true, true)).toBe(false);
		expect(call("weighted-checklist", 2, 4, true, 1.5, true, 2)).toBe(true);
		expect(call("join-chunked", "-", 3, "AA", "BBB", "C")).toBe("AAB-BBC");
		expect(() => call("join-chunked", "-", 0, "AB")).toThrow("zero chunk size");
	});

	it("ports sort and sort-by's space-list and tie-break contracts", () => {
		expect(call("sort", "commcare is the best tool ever", false)).toBe(
			"tool the is ever commcare best",
		);
		expect(call("sort-by", "2222 5555 9999 1111", "d b c a", true)).toBe(
			"1111 5555 9999 2222",
		);
		expect(call("sort-by", "c c z f z f", "4 2 1 5 3 2", true)).toBe(
			"z c f z c f",
		);
		expect(() => call("sort-by", "a b c", "1 2")).toThrow("same length");
	});

	it("ports checksum and compressed-id vectors from Core", () => {
		expect(call("checksum", "verhoeff", "41310785898")).toBe("4");
		expect(call("checksum", "verhoeff", "66671496237")).toBe("3");
		expect(call("checksum", "verhoeff", "٤١٣١٠٧٨٥٨٩٨")).toBe("4");
		expect(call("checksum", "verhoeff", "７")).toBe("0");
		expect(() => call("checksum", "verhoeff", "*1310785898")).toThrow(
			"Illegal character",
		);
		expect(call("id-compress", 0, "CD", "AB", "ABCDE", 1)).toBe("AA");
		expect(call("id-compress", 9, "CD", "AB", "ABCDE", 1)).toBe("BE");
		expect(call("id-compress", 10, "CD", "AB", "ABCDE", 1)).toBe("DAA");
		expect(() => call("id-compress", -1, "CD", "AB", "ABCDE", 1)).toThrow(
			"nonnegative",
		);
		expect(() => call("id-compress", 1, "CD", "AB", "ABCDE", -1)).toThrow(
			"nonnegative",
		);
		expect(() => call("id-compress", 0, "CD", "", "ABCDE", 1)).toThrow(
			"non-empty",
		);
		expect(() => call("id-compress", 0, "CD", "A", "", 1)).toThrow(
			"body symbols",
		);
		expect(() => call("id-compress", 1, "C", "A", "B", 0)).toThrow(
			"cannot encode",
		);
	});

	it("matches json-property's blank-on-invalid behavior", () => {
		expect(call("json-property", '{"name":"Ada"}', "name")).toBe("Ada");
		expect(call("json-property", '{"name":"Ada"}', "city")).toBe("");
		expect(call("json-property", "not json", "name")).toBe("");
		expect(call("json-property", '{"count":3}', "count")).toBe("");
		expect(call("json-property", "{name:}", "name")).toBe("");
	});

	it("matches JSONObject's default permissive grammar", () => {
		// Pinned Core delegates to new JSONObject(source).getString(property).
		expect(call("json-property", "{'name':'Ada'}", "name")).toBe("Ada");
		expect(call("json-property", "{name:'Ada'}", "name")).toBe("Ada");
		expect(call("json-property", "{name:'Ada',}", "name")).toBe("Ada");
		expect(call("json-property", "{name:'Ada'} trailing", "name")).toBe("Ada");
		expect(call("json-property", "{name:Ada}", "name")).toBe("Ada");
		expect(call("json-property", "{x:1; name:'A\\'da'}", "name")).toBe("A'da");
		expect(call("json-property", "{nested:{x:1}, name:'Ada'}", "name")).toBe(
			"Ada",
		);
		// JSONObject routes decimal/exponent tokens through BigDecimal, which
		// accepts leading zeroes. Integer tokens take a separate path that rejects
		// them and therefore remain strings.
		expect(call("json-property", "{value:01.0}", "value")).toBe("");
		expect(call("json-property", "{value:01}", "value")).toBe("01");
		expect(call("json-property", "{value:1.0f}", "value")).toBe("");
		expect(call("json-property", "{value:1e9999}", "value")).toBe("");
		expect(call("json-property", "{value:0x1.0p2}", "value")).toBe("");
		expect(call("json-property", "{value:-.5}", "value")).toBe("");
		expect(call("json-property", "{1.0:'decimal'}", "1.0")).toBe("decimal");
		expect(
			call(
				"json-property",
				"{9223372036854775807:'long'}",
				"9223372036854775807",
			),
		).toBe("long");
		expect(call("json-property", "{-.5:'negative'}", "-0.5")).toBe("negative");
		expect(call("json-property", "{1e2:'exponent'}", "1E+2")).toBe("exponent");
		expect(call("json-property", "{0x1.0p2:'hex'}", "4.0")).toBe("hex");
		expect(call("json-property", "{-0.00:'zero'}", "-0.0")).toBe("zero");
		expect(call("json-property", "{value:\u00a0Ada\u00a0}", "value")).toBe(
			"\u00a0Ada\u00a0",
		);
		expect(call("json-property", '{value:"A\0da"}', "value")).toBe("");
		expect(call("json-property", "{value:A\0}", "value")).toBe("");
		expect(call("json-property", "{wanted:'ok';}", "wanted")).toBe("ok");
		expect(call("json-property", "{wanted:'ok',arr:[,]}", "wanted")).toBe("ok");
		expect(call("json-property", "{wanted:'ok',arr:[,1]}", "wanted")).toBe(
			"ok",
		);
		expect(call("json-property", "{wanted:'ok',arr:[1;2]}", "wanted")).toBe("");
		expect(call("json-property", "{wanted:'ok',arr:[1,,2]}", "wanted")).toBe(
			"",
		);
	});

	it("uses Web Crypto for random() and both uuid() signatures", () => {
		for (let index = 0; index < 20; index += 1) {
			const random = call("random") as number;
			expect(random).toBeGreaterThanOrEqual(0);
			expect(random).toBeLessThan(1);
		}
		expect(call("uuid")).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
		expect(call("uuid", 24)).toMatch(/^[0-9A-Z]{24}$/);
	});
});
