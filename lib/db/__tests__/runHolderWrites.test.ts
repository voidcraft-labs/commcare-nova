import { describe, expect, it } from "vitest";
import {
	type ExactRunHolderIdentity,
	exactRunHolderMatches,
	toExactRunHolderIdentity,
	updatedExactlyOne,
} from "../runHolderWrites";

describe("exact run-holder write helpers", () => {
	it("narrows only concrete database identities to caller tokens", () => {
		expect(
			toExactRunHolderIdentity({ mode: "build", runId: "build-1" }),
		).toEqual({ mode: "build", runId: "build-1" });
		expect(toExactRunHolderIdentity({ mode: "edit", runId: null })).toBeNull();
		expect(toExactRunHolderIdentity({ mode: "edit", runId: "" })).toBeNull();
		expect(toExactRunHolderIdentity(null)).toBeNull();
	});

	it("requires both mode and run id and never treats null as a wildcard", () => {
		const expected = { mode: "build", runId: "run-1" } as const;
		expect(
			exactRunHolderMatches({ mode: "build", runId: "run-1" }, expected),
		).toBe(true);
		expect(
			exactRunHolderMatches({ mode: "edit", runId: "run-1" }, expected),
		).toBe(false);
		expect(
			exactRunHolderMatches({ mode: "build", runId: "run-2" }, expected),
		).toBe(false);
		expect(
			exactRunHolderMatches({ mode: "build", runId: null }, expected),
		).toBe(false);
		expect(exactRunHolderMatches(null, expected)).toBe(false);
		const corruptExpected = {
			mode: "build",
			runId: null,
		} as unknown as ExactRunHolderIdentity;
		expect(
			exactRunHolderMatches({ mode: "build", runId: null }, corruptExpected),
		).toBe(false);
	});

	it("accepts exactly one affected row, never zero or a multi-row write", () => {
		expect(updatedExactlyOne({ numUpdatedRows: 1n })).toBe(true);
		expect(updatedExactlyOne({ numUpdatedRows: 0n })).toBe(false);
		expect(updatedExactlyOne({ numUpdatedRows: 2n })).toBe(false);
	});
});
