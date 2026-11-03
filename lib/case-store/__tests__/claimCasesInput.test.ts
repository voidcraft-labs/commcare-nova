// The bounds `CaseStore.claimCases` checks before it reads anything: 1 to
// 1,000 distinct case ids of 1 to 255 characters.

import { describe, expect, it } from "vitest";
import {
	CLAIM_CASE_ID_MAX_LENGTH,
	CLAIM_CASE_IDS_LIMIT,
	ClaimCasesInputError,
	requireClaimCaseIds,
} from "../errors";

const ids = (count: number) =>
	Array.from({ length: count }, (_, index) => `case-${index}`);

describe("requireClaimCaseIds", () => {
	it("admits one id, the most ids, and the longest id", () => {
		expect(() => requireClaimCaseIds(["a"])).not.toThrow();
		expect(() => requireClaimCaseIds(ids(CLAIM_CASE_IDS_LIMIT))).not.toThrow();
		expect(() =>
			requireClaimCaseIds(["x".repeat(CLAIM_CASE_ID_MAX_LENGTH)]),
		).not.toThrow();
	});

	it.each([
		["no ids", []],
		["one id too many", ids(CLAIM_CASE_IDS_LIMIT + 1)],
		["an empty id", ["a", ""]],
		[
			"an id one character too long",
			["x".repeat(CLAIM_CASE_ID_MAX_LENGTH + 1)],
		],
		["a repeated id", ["a", "b", "a"]],
	])("refuses %s, naming the bounds", (_label, caseIds) => {
		let thrown: unknown;
		try {
			requireClaimCaseIds(caseIds);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(ClaimCasesInputError);
		expect((thrown as Error).message).toBe(
			"A claim names 1 to 1,000 distinct case ids, each 1 to 255 characters. Check the caller that collects the chosen cases.",
		);
	});
});
