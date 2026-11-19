/**
 * The one way text CommCare HQ wrote becomes values in Nova.
 *
 * Contract: every object of the value holds its own keys and nothing else,
 * so a lookup by a name an app supplies (`constructor`, `toString`,
 * `__proto__`) answers what HQ wrote or nothing; a `"__proto__"` key stays a
 * key of its own and sets no prototype; and a value nested deeper than
 * anything HQ can answer is refused as text that is no JSON, with no walk of
 * it reaching the stack.
 */

import { describe, expect, it } from "vitest";
import { HQ_JSON_MAX_DEPTH, parseHqJsonText } from "../jsonText";

function deep(depth: number): string {
	return `${'{"a":'.repeat(depth)}1${"}".repeat(depth)}`;
}

describe("HQ's JSON as Nova holds it", () => {
	it("answers only what HQ wrote for a name an object's prototype holds", () => {
		const value = parseHqJsonText(
			'{"langs": ["en"], "map": {"en": "Visits"}, "list": [{"x": 1}]}',
		) as Record<string, Record<string, unknown>>;
		const map = value.map as Record<string, unknown>;
		for (const name of ["constructor", "toString", "hasOwnProperty", "valueOf"])
			expect(map[name]).toBeUndefined();
		expect(Object.getPrototypeOf(value)).toBeNull();
		expect(Object.getPrototypeOf(map)).toBeNull();
		expect(
			Object.getPrototypeOf((value.list as unknown as unknown[])[0]),
		).toBeNull();
		/* An array is still an array. */
		expect(Array.isArray(value.list)).toBe(true);
		expect(map.en).toBe("Visits");
	});

	it("keeps a __proto__ key as a key of its own, setting no prototype", () => {
		const value = parseHqJsonText(
			'{"constructor": 1, "__proto__": {"x": 1}}',
		) as Record<string, unknown>;
		expect(Object.keys(value)).toEqual(["constructor", "__proto__"]);
		expect(value.constructor).toBe(1);
		expect(Object.getPrototypeOf(value)).toBeNull();
		expect((value as { x?: unknown }).x).toBeUndefined();
	});

	it("refuses a value nested past the depth HQ can answer, as text that is no JSON", () => {
		expect(() => parseHqJsonText(deep(HQ_JSON_MAX_DEPTH - 1))).not.toThrow();
		expect(() => parseHqJsonText(deep(HQ_JSON_MAX_DEPTH + 1))).toThrow(
			SyntaxError,
		);
		expect(() => parseHqJsonText(deep(200_000))).toThrow(SyntaxError);
	});

	it("throws JSON.parse's own error for text that is no JSON", () => {
		expect(() => parseHqJsonText("<html>")).toThrow(SyntaxError);
	});
});
