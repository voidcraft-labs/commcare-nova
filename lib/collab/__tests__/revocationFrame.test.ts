import { describe, expect, it } from "vitest";
import { parseRevocationFrame } from "@/lib/collab/revocationFrame";

describe("current revocation frame", () => {
	it.each([
		"access-revoked",
		"session-revoked",
		"account-inactive",
		"client-upgrade-required",
	] as const)("accepts the exact %s reason", (reason) => {
		expect(parseRevocationFrame(JSON.stringify({ reason }))).toEqual({
			reason,
		});
	});

	it("rejects malformed JSON, missing reasons, unknown reasons, and extra keys", () => {
		expect(parseRevocationFrame("{")).toBeNull();
		expect(parseRevocationFrame("{}")).toBeNull();
		expect(
			parseRevocationFrame(JSON.stringify({ reason: "something-else" })),
		).toBeNull();
		expect(
			parseRevocationFrame(
				JSON.stringify({ reason: "access-revoked", stale: true }),
			),
		).toBeNull();
	});
});
