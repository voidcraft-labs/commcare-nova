import { describe, expect, it } from "vitest";
import {
	type ExactRunHolderIdentity,
	exactRunHolderMatches,
	updatedExactlyOne,
} from "../runHolderWrites";

const HOLDER_NONCE = "00000000-0000-4000-8000-000000000001";
const OTHER_NONCE = "00000000-0000-4000-8000-000000000002";

describe("exact run-holder write helpers", () => {
	it("requires mode, run id, and nonce and never treats null as a wildcard", () => {
		const expected = {
			mode: "build",
			runId: "run-1",
			nonce: HOLDER_NONCE,
		} as const;
		expect(
			exactRunHolderMatches(
				{ mode: "build", runId: "run-1", nonce: HOLDER_NONCE },
				expected,
			),
		).toBe(true);
		expect(
			exactRunHolderMatches(
				{ mode: "edit", runId: "run-1", nonce: HOLDER_NONCE },
				expected,
			),
		).toBe(false);
		expect(
			exactRunHolderMatches(
				{ mode: "build", runId: "run-2", nonce: HOLDER_NONCE },
				expected,
			),
		).toBe(false);
		expect(
			exactRunHolderMatches(
				{ mode: "build", runId: "run-1", nonce: OTHER_NONCE },
				expected,
			),
		).toBe(false);
		expect(
			exactRunHolderMatches(
				{ mode: "build", runId: null, nonce: HOLDER_NONCE },
				expected,
			),
		).toBe(false);
		expect(exactRunHolderMatches(null, expected)).toBe(false);
		const corruptExpected = {
			mode: "build",
			runId: null,
			nonce: null,
		} as unknown as ExactRunHolderIdentity;
		expect(
			exactRunHolderMatches(
				{ mode: "build", runId: null, nonce: null },
				corruptExpected,
			),
		).toBe(false);
	});

	it("accepts exactly one affected row, never zero or a multi-row write", () => {
		expect(updatedExactlyOne({ numUpdatedRows: BigInt(1) })).toBe(true);
		expect(updatedExactlyOne({ numUpdatedRows: BigInt(0) })).toBe(false);
		expect(updatedExactlyOne({ numUpdatedRows: BigInt(2) })).toBe(false);
	});
});
