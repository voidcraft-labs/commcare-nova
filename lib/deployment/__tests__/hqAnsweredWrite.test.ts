/**
 * Whether CommCare HQ answered a write (`remoteWrites.ts::hqAnsweredWrite`),
 * which decides how long the write's admission stays open: at once where HQ
 * answered, for the grace where the answer never reached Nova.
 *
 * Contract: an acknowledgement, a definitive refusal and a completed body
 * are answers. A network failure or a gateway giving up on an upstream write
 * leaves that write open. A list read's `moved` names passes HQ answered. Plausible failure: a cause added to the
 * failure's union read as answered without a decision, settling a write HQ
 * may still apply after Nova stopped waiting, so a bring-in of the HQ app is
 * granted while that write can still land.
 */

import { describe, expect, it, vi } from "vitest";
import type { CommCareApiError } from "@/lib/commcare/client";
import { hqAnsweredWrite } from "../remoteWrites";

/* The module's other half reads Postgres and CommCare HQ; this file holds the pure decision alone. */
vi.mock("../store", () => ({
	readOpenMediaJobs: vi.fn(),
	settleRemoteWrites: vi.fn(),
}));
vi.mock("@/lib/commcare/client", () => ({
	readAppMediaBundleStatus: vi.fn(),
}));

function failed(
	status: number,
	cause?: CommCareApiError["cause"],
): CommCareApiError {
	return { success: false, status, ...(cause !== undefined && { cause }) };
}

describe("hqAnsweredWrite", () => {
	it("settles an acknowledgement and a definitive refusal", () => {
		expect(hqAnsweredWrite({ success: true })).toBe(true);
		expect(hqAnsweredWrite(failed(400))).toBe(true);
		expect(hqAnsweredWrite(failed(501))).toBe(true);
	});

	it.each([500, 502, 503, 504])(
		"holds a write open after HTTP %i",
		(status) => {
			expect(hqAnsweredWrite(failed(status))).toBe(false);
			expect(hqAnsweredWrite({ ...failed(status), edgeRefusal: true })).toBe(
				false,
			);
		},
	);

	it("answers yes for a body Nova could not use, since HQ ended the request", () => {
		expect(hqAnsweredWrite(failed(502, "malformed"))).toBe(true);
		expect(hqAnsweredWrite(failed(502, "too-large"))).toBe(true);
		expect(hqAnsweredWrite(failed(502, "browser-page"))).toBe(true);
	});

	it("answers yes for a list that moved under every pass, each of which HQ answered", () => {
		expect(hqAnsweredWrite(failed(503, "moved"))).toBe(true);
	});

	it("answers no where the answer never reached Nova or the deadline ran out", () => {
		expect(hqAnsweredWrite(failed(503, "network"))).toBe(false);
		expect(hqAnsweredWrite(failed(503, "timeout"))).toBe(false);
	});

	it("refuses a cause it holds no decision for, naming it", () => {
		const unknown = {
			success: false,
			status: 503,
			cause: "throttled",
		} as unknown as CommCareApiError;
		expect(() => hqAnsweredWrite(unknown)).toThrow(/"throttled"/);
	});
});
