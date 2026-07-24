import { describe, expect, it } from "vitest";
import {
	parseClientStreamReceiverVersion,
	resolveEffectiveStreamReceiverVersion,
	resolveServingStreamReceiverVersion,
} from "@/lib/db/streamReceiverCapabilities";
import { RUNTIME_CAPABILITIES } from "@/lib/runtimeCapabilities";

function receiverQuery(...values: string[]): URLSearchParams {
	const params = new URLSearchParams({ since: "17" });
	for (const value of values) params.append("receiverVersion", value);
	return params;
}

describe("stream receiver capability admission", () => {
	it("serves the compiled manifest's receiver capability", () => {
		expect(RUNTIME_CAPABILITIES.streamReceiverVersion).toBe(3);
		expect(RUNTIME_CAPABILITIES.streamRegistryVersion).toBe(1);
		// The baked image environment is deliberately not consulted: the startup
		// probe proves it identical to the compiled manifest before an instance
		// serves, and environments with no baked declaration (local dev, CI)
		// must not fail closed to v0 under a nonzero admission floor.
		expect(resolveServingStreamReceiverVersion()).toBe(3);
		expect(resolveEffectiveStreamReceiverVersion(receiverQuery("3"))).toBe(3);
		/* The min-of-browser-and-manifest clamp: an old bundle still declares
		 * its own lower version and stays admitted above the DB floor. */
		expect(resolveEffectiveStreamReceiverVersion(receiverQuery("2"))).toBe(2);
		expect(resolveEffectiveStreamReceiverVersion(receiverQuery("1"))).toBe(1);
	});

	it.each([
		["0", 0],
		["1", 1],
		["2147483647", 2_147_483_647],
	])(
		"accepts exactly one strict receiver declaration %j",
		(value, expected) => {
			expect(parseClientStreamReceiverVersion(receiverQuery(value))).toBe(
				expected,
			);
		},
	);

	it.each([
		["missing", receiverQuery()],
		["empty", receiverQuery("")],
		["duplicate valid", receiverQuery("1", "1")],
		["duplicate mixed", receiverQuery("1", "bad")],
		[
			"wrong-case key",
			new URLSearchParams({ ReceiverVersion: "1", since: "17" }),
		],
		["leading zero", receiverQuery("01")],
		["positive sign", receiverQuery("+1")],
		["negative", receiverQuery("-1")],
		["integer decimal", receiverQuery("1.0")],
		["fractional", receiverQuery("1.5")],
		["exponent", receiverQuery("1e0")],
		["Postgres integer overflow", receiverQuery("2147483648")],
		["JavaScript safe-integer overflow", receiverQuery("9007199254740992")],
		["suffix", receiverQuery("1-old")],
		["NaN", receiverQuery("NaN")],
		["leading whitespace", receiverQuery(" 1")],
		["trailing whitespace", receiverQuery("1 ")],
	] as const)("fails %s client input closed to v0", (_name, params) => {
		expect(parseClientStreamReceiverVersion(params)).toBe(0);
	});

	it("takes the minimum of browser and serving revision support", () => {
		expect(
			resolveEffectiveStreamReceiverVersion(receiverQuery("2147483647")),
		).toBe(RUNTIME_CAPABILITIES.streamReceiverVersion);
		expect(resolveEffectiveStreamReceiverVersion(receiverQuery("bad"))).toBe(0);
		expect(resolveEffectiveStreamReceiverVersion(receiverQuery())).toBe(0);
	});
});
