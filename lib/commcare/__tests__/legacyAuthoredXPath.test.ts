import { describe, expect, it } from "vitest";
import {
	type AuthoredXPathValue,
	isLegacyAuthoredXPath,
	isLegacyFormLinkXPath,
	legacyAuthoredAnd,
	legacyAuthoredBinary,
	legacyAuthoredCall,
	legacyAuthoredOr,
	legacyFormLinkGuard,
	legacyProjectedAuthoredXPath,
	legacyProjectedFormLinkXPath,
} from "../xform/legacyAuthoredXPath";
import { w } from "../xpath/wire/builders";
import { serializeWire } from "../xpath/wire/serialize";
import { xpathEvidence } from "./xpathEvidence";

const mode = { target: "xform", constraint: false } as const;
function printed(value: AuthoredXPathValue): string {
	return isLegacyAuthoredXPath(value)
		? value.text
		: serializeWire(value, mode).text;
}

describe("temporary authored XPath composition", () => {
	it("keeps generated ambiguity guards in the canonical form Vellum retains", () => {
		const guards = ["/data/meals", "/data/address"].map((source) =>
			legacyAuthoredBinary(
				">",
				legacyAuthoredCall(
					"count",
					[legacyProjectedAuthoredXPath(source)],
					mode,
				),
				w.num(1),
				mode,
			),
		);
		expect(printed(legacyAuthoredOr(guards, mode))).toBe(
			"count(/data/meals) > 1 or count(/data/address) > 1",
		);
	});

	it("groups opaque authored operands without inferring their syntax", () => {
		const source = legacyProjectedAuthoredXPath("2 + 3");
		for (const [left, right, expected] of [
			[source, w.num(4), "(2 + 3) * 4"],
			[w.num(4), source, "4 * (2 + 3)"],
		] as const) {
			expect(printed(legacyAuthoredBinary("*", left, right, mode))).toBe(
				expected,
			);
		}
		expect(
			printed(
				legacyAuthoredAnd(
					[legacyProjectedAuthoredXPath("true() or false()"), w.call("false")],
					mode,
				),
			),
		).toBe("(true() or false()) and false()");
	});

	it.each(["-", "div", "="] as const)(
		"keeps a helper-built right %s operand grouped at equal precedence",
		(op) => {
			const count = legacyAuthoredCall(
				"count",
				[legacyProjectedAuthoredXPath("/data/value")],
				mode,
			);
			const right = legacyAuthoredBinary(op, count, w.num(1), mode);
			const expression = printed(
				legacyAuthoredBinary(op, w.num(10), right, mode),
			);
			expect(expression).toBe(`10 ${op} (count(/data/value) ${op} 1)`);
			expect(xpathEvidence(expression)).toEqual(
				xpathEvidence(`(10) ${op} ((count(/data/value)) ${op} (1))`),
			);
		},
	);

	it("groups mixed logical operators while flattening the same operator", () => {
		const count = legacyAuthoredCall(
			"count",
			[legacyProjectedAuthoredXPath("/data/value")],
			mode,
		);
		const guard = legacyAuthoredBinary(">", count, w.num(1), mode);
		const either = legacyAuthoredOr([guard, w.call("false")], mode);
		expect(printed(legacyAuthoredAnd([w.call("true"), either], mode))).toBe(
			"true() and (count(/data/value) > 1 or false())",
		);
		expect(printed(legacyAuthoredOr([guard, either], mode))).toBe(
			"count(/data/value) > 1 or count(/data/value) > 1 or false()",
		);
	});

	it("preserves HQ's literal positive and exclusion guard spelling", () => {
		const positive = legacyProjectedFormLinkXPath("/data/value = 'yes'");
		const excluded = legacyProjectedFormLinkXPath("/data/other = 'no'");
		const guard = legacyFormLinkGuard(positive, [excluded, w.call("false")]);
		expect(isLegacyFormLinkXPath(guard) ? guard.text : undefined).toBe(
			"(/data/value = 'yes') and not(/data/other = 'no') and not(false())",
		);
	});
});
