import { describe, expect, it } from "vitest";
import {
	type ExactRunHolderIdentity,
	exactRunHolderMatches,
	toExactRunHolderIdentity,
	updatedExactlyOne,
} from "../runHolderWrites";

const HOLDER_NONCE = "00000000-0000-4000-8000-000000000001";
const OTHER_NONCE = "00000000-0000-4000-8000-000000000002";

describe("exact run-holder write helpers", () => {
	it("narrows only concrete database identities to caller tokens", () => {
		expect(
			toExactRunHolderIdentity({
				mode: "build",
				runId: "build-1",
				nonce: HOLDER_NONCE,
			}),
		).toEqual({ mode: "build", runId: "build-1", nonce: HOLDER_NONCE });
		expect(
			toExactRunHolderIdentity({
				mode: "edit",
				runId: null,
				nonce: HOLDER_NONCE,
			}),
		).toBeNull();
		expect(
			toExactRunHolderIdentity({
				mode: "edit",
				runId: "",
				nonce: HOLDER_NONCE,
			}),
		).toBeNull();
		expect(
			toExactRunHolderIdentity({
				mode: "edit",
				runId: "edit-1",
				nonce: null,
			}),
		).toEqual({ mode: "edit", runId: "edit-1", nonce: null });
		expect(toExactRunHolderIdentity(null)).toBeNull();
	});

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
				true,
			),
		).toBe(true);
		expect(
			exactRunHolderMatches(
				{ mode: "edit", runId: "run-1", nonce: HOLDER_NONCE },
				expected,
				true,
			),
		).toBe(false);
		expect(
			exactRunHolderMatches(
				{ mode: "build", runId: "run-2", nonce: HOLDER_NONCE },
				expected,
				true,
			),
		).toBe(false);
		expect(
			exactRunHolderMatches(
				{ mode: "build", runId: "run-1", nonce: OTHER_NONCE },
				expected,
				true,
			),
		).toBe(false);
		expect(
			exactRunHolderMatches(
				{ mode: "build", runId: null, nonce: HOLDER_NONCE },
				expected,
				true,
			),
		).toBe(false);
		expect(exactRunHolderMatches(null, expected, true)).toBe(false);
		const corruptExpected = {
			mode: "build",
			runId: null,
			nonce: null,
		} as unknown as ExactRunHolderIdentity;
		expect(
			exactRunHolderMatches(
				{ mode: "build", runId: null, nonce: null },
				corruptExpected,
				true,
			),
		).toBe(false);
	});

	it("keeps legacy mode/run admission until nonce enforcement activates", () => {
		const expected = {
			mode: "build",
			runId: "run-1",
			nonce: HOLDER_NONCE,
		} as const;
		expect(
			exactRunHolderMatches(
				{ mode: "build", runId: "run-1", nonce: OTHER_NONCE },
				expected,
				false,
			),
		).toBe(true);
		expect(
			exactRunHolderMatches(
				{ mode: "build", runId: "run-1", nonce: null },
				{ ...expected, nonce: null },
				false,
			),
		).toBe(true);
	});

	it("accepts exactly one affected row, never zero or a multi-row write", () => {
		expect(updatedExactlyOne({ numUpdatedRows: 1n })).toBe(true);
		expect(updatedExactlyOne({ numUpdatedRows: 0n })).toBe(false);
		expect(updatedExactlyOne({ numUpdatedRows: 2n })).toBe(false);
	});
});
