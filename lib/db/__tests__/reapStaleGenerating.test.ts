/**
 * `reapStaleGenerating` ordering tests.
 *
 * The reaper does two things to a dead `generating` build — refund its stranded
 * credit hold and flip it to `error` — and the ORDER plus the failure handling
 * are the whole contract:
 *
 *   - The refund runs BEFORE the status flip. A process death between them must
 *     leave the row still `generating` (reapable), so the next list/concurrency
 *     scan retries the refund. Flipping first would close the reapable window
 *     with the hold still booked and strand it forever.
 *   - A refund FAILURE returns early WITHOUT flipping status, for the same
 *     reason: leave the row reapable so the refund is retried, rather than
 *     marking it done with credits still held.
 *
 * The refund's own correctness (cross-doc atomicity, idempotency via the marker)
 * lives in `credits.test.ts`; here we mock `refundReservation` and observe only
 * the sequencing against the `failApp` status write.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { refundReservationMock, appSetMock, appMock } = vi.hoisted(() => {
	const appSetMock = vi.fn().mockResolvedValue(undefined);
	return {
		refundReservationMock: vi.fn(),
		appSetMock,
		// `failApp` writes status via `docs.app(appId).set(...)`; the spy lets us
		// see whether (and with what) the status flip fired.
		appMock: vi.fn().mockReturnValue({ set: appSetMock }),
	};
});

vi.mock("../credits", () => ({ refundReservation: refundReservationMock }));
vi.mock("../firestore", () => ({
	docs: { app: appMock },
	// Present but unused by `reapStaleGenerating` / `failApp`; `apps.ts` reads
	// these inside other functions the test never calls.
	collections: {},
	getDb: vi.fn(),
}));

describe("reapStaleGenerating", () => {
	beforeEach(() => {
		refundReservationMock.mockReset();
		appSetMock.mockClear().mockResolvedValue(undefined);
		appMock.mockClear().mockReturnValue({ set: appSetMock });
	});

	it("refunds the stranded hold by appId, THEN flips the app to error", async () => {
		refundReservationMock.mockResolvedValue(undefined);
		const { reapStaleGenerating } = await import("../apps");

		await reapStaleGenerating("app-1");

		expect(refundReservationMock).toHaveBeenCalledWith("app-1");
		// The status flip fired once, to `error`, via a merge write — and only
		// after the awaited refund resolved.
		expect(appSetMock).toHaveBeenCalledTimes(1);
		const [payload, options] = appSetMock.mock.calls[0];
		expect(payload).toMatchObject({ status: "error" });
		expect(options).toEqual({ merge: true });
	});

	it("leaves the app generating (no status flip) when the refund fails, so the next scan retries", async () => {
		refundReservationMock.mockRejectedValue(new Error("firestore down"));
		const { reapStaleGenerating } = await import("../apps");

		await reapStaleGenerating("app-1");

		// A refund failure must NOT flip status — flipping before the refund landed
		// would close the reapable window and strand the hold forever.
		expect(appSetMock).not.toHaveBeenCalled();
	});
});

describe("setAwaitingInput", () => {
	beforeEach(() => {
		appSetMock.mockClear().mockResolvedValue(undefined);
		appMock.mockClear().mockReturnValue({ set: appSetMock });
	});

	it("clearing (resume) re-arms updated_at so the resuming run gets a fresh staleness window", async () => {
		// The flag — not the timestamp — is what spared the paused row, so clearing
		// it must re-arm the clock. Otherwise the resuming run is born stale and a
		// concurrent list scan (whose reaper excludes no appId) could refund its
		// still-live hold before its first mutation advances `updated_at`.
		const { setAwaitingInput } = await import("../apps");
		void setAwaitingInput("app-1", false);

		expect(appSetMock).toHaveBeenCalledTimes(1);
		const [payload, options] = appSetMock.mock.calls[0];
		expect(payload).toMatchObject({ awaiting_input: false });
		expect(payload).toHaveProperty("updated_at");
		expect(options).toEqual({ merge: true });
	});

	it("setting (pause) does NOT bump updated_at — the flag, not the clock, protects a pause", async () => {
		const { setAwaitingInput } = await import("../apps");
		void setAwaitingInput("app-1", true);

		expect(appSetMock).toHaveBeenCalledTimes(1);
		const [payload] = appSetMock.mock.calls[0];
		expect(payload).toEqual({ awaiting_input: true });
	});
});
