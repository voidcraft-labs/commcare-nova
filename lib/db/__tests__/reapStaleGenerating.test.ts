/**
 * `reapStaleGenerating` delegation tests.
 *
 * The reaper delegates the whole reap — refund the stranded hold + flip
 * `generating → error` — to `refundStaleGeneration`, which does both in ONE
 * transaction with the staleness re-validated inside it (the build analogue of
 * `refundStaleReservation`; its in-txn correctness lives in the emulator invariant
 * matrix). `reapStaleGenerating`'s remaining contract is thin: delegate, and
 * SWALLOW a transient throw (leaving the row untouched — since the refund + flip
 * are one atomic commit, a failure means neither happened, so the next scan
 * retries). Here we mock `refundStaleGeneration` and observe only that delegation.
 */

import { Timestamp } from "@google-cloud/firestore";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	refundStaleGenerationMock,
	appSetMock,
	appMock,
	appRawMock,
	creditMonthRawMock,
	txGetMock,
	txUpdateMock,
	txSetMock,
	getDbMock,
} = vi.hoisted(() => {
	const appSetMock = vi.fn().mockResolvedValue(undefined);
	const txGetMock = vi.fn();
	const txUpdateMock = vi.fn();
	const txSetMock = vi.fn();
	return {
		refundStaleGenerationMock: vi.fn(),
		appSetMock,
		// `setAwaitingInput` writes via `docs.app(appId).set(...)`; the spy lets the
		// setAwaitingInput suite below see what it wrote.
		appMock: vi.fn().mockReturnValue({ set: appSetMock }),
		appRawMock: vi.fn().mockReturnValue({ id: "raw-ref" }),
		creditMonthRawMock: vi.fn().mockReturnValue({ id: "credit-ref" }),
		txGetMock,
		txUpdateMock,
		txSetMock,
		// `claimRun` runs a transaction; the fake runs the body
		// against the `tx` spies so tests control the fresh read(s) and
		// observe the conditional flip + the stale arm's credit write.
		getDbMock: vi.fn().mockReturnValue({
			runTransaction: (body: (tx: unknown) => Promise<unknown>) =>
				body({ get: txGetMock, update: txUpdateMock, set: txSetMock }),
		}),
	};
});

vi.mock("../credits", () => ({
	refundStaleGeneration: refundStaleGenerationMock,
}));
vi.mock("../firestore", async () => ({
	...(await import("./throttlePassthrough")).throttlePassthrough,
	docs: {
		app: appMock,
		appRaw: appRawMock,
		creditMonthRaw: creditMonthRawMock,
	},
	// Present but unused by `reapStaleGenerating` / `failApp`; `apps.ts` reads
	// these inside other functions the test never calls.
	collections: {},
	getDb: getDbMock,
}));

describe("reapStaleGenerating", () => {
	beforeEach(() => {
		refundStaleGenerationMock.mockReset();
	});

	it("delegates the reap (refund + flip, one atomic txn) to refundStaleGeneration", async () => {
		refundStaleGenerationMock.mockResolvedValue(undefined);
		const { reapStaleGenerating } = await import("../apps");

		await reapStaleGenerating("app-1");

		// The whole reap — refund the stranded hold + flip generating→error, with the
		// staleness re-validated in the same txn — lives in `refundStaleGeneration`.
		expect(refundStaleGenerationMock).toHaveBeenCalledWith("app-1");
	});

	it("SWALLOWS a transient throw — the row is untouched, so the next scan retries", async () => {
		refundStaleGenerationMock.mockRejectedValue(new Error("firestore down"));
		const { reapStaleGenerating } = await import("../apps");

		// A throw must not escape (fire-and-forget at the call sites). The refund +
		// flip are one commit, so a failure means neither happened — the row stays
		// `generating` for the next scan to retry, no partial state to clean up.
		await expect(reapStaleGenerating("app-1")).resolves.toBeUndefined();
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

describe("claimRun (build mode)", () => {
	/** Invoke the generalized `claimRun` in build mode with the run/actor ids
	 *  the route threads. */
	const claimBuild = async (appId: string) => {
		const { claimRun } = await import("../apps");
		return claimRun(appId, "build", "run-1", "user-1");
	};
	beforeEach(() => {
		txGetMock.mockReset();
		txUpdateMock.mockReset();
		txSetMock.mockReset();
		creditMonthRawMock.mockClear();
	});

	const snapshotWith = (data: Record<string, unknown>) => ({
		exists: true,
		data: () => data,
	});

	/** A `updated_at` inside the 10-minute staleness window (a live run). */
	const freshClock = () => Timestamp.fromDate(new Date(Date.now() - 60_000));
	/** A `updated_at` past the window (a hard-killed run). */
	const staleClock = () =>
		Timestamp.fromDate(new Date(Date.now() - 11 * 60_000));

	it("claims a FAILED build's window with a fresh staleness clock, carrying the displaced classification", async () => {
		// A retry of a failed build flips error → generating before the
		// route's concurrency check (write-then-check — the row is the
		// lock). The fresh `updated_at` is load-bearing: the row's old
		// timestamp belongs to the FAILED run and may already sit outside
		// the staleness window, so without re-arming, a concurrent list
		// scan could reap (and refund) the retry at birth. The claim clears
		// `error_type` on the row but RETURNS it, so a bail-out restore
		// writes back the original failure rather than the bail-out's own
		// reason.
		txGetMock.mockResolvedValue(
			snapshotWith({ status: "error", error_type: "model_error" }),
		);
		const claim = await claimBuild("app-1");

		// The prior snapshot captures the EXACT displaced shape for a faithful
		// bail-out restore — including the original `error_type` classification.
		expect(claim.mode).toBe("build");
		expect(claim.prior).toMatchObject({
			status: "error",
			error_type: "model_error",
			awaiting_input: false,
			run_lock: null,
		});
		expect(txUpdateMock).toHaveBeenCalledTimes(1);
		const [, payload] = txUpdateMock.mock.calls[0];
		expect(payload).toMatchObject({ status: "generating", error_type: null });
		expect(payload).toHaveProperty("updated_at");
	});

	it("claims a COMPLETE app's window — a new instruction into a finished build re-enters liveness coverage", async () => {
		// Without this arm, a chargeable build POST against a `complete` app
		// (the reply after a purely conversational first turn) would run with
		// NO durable `generating` row: a hard kill would strand its 100-credit
		// hold forever (the reaper keys on `generating`), and a duplicate POST
		// would pass the concurrency check and interleave two SA loops on one
		// doc. The claim reports what it moved the app out of so a pre-stream
		// bail-out can restore `complete` rather than failing a working app.
		txGetMock.mockResolvedValue(snapshotWith({ status: "complete" }));
		const claim = await claimBuild("app-1");

		expect(claim.mode).toBe("build");
		expect(claim.prior).toMatchObject({
			status: "complete",
			error_type: null,
			awaiting_input: false,
			run_lock: null,
		});
		expect(txUpdateMock).toHaveBeenCalledTimes(1);
		const [, payload] = txUpdateMock.mock.calls[0];
		expect(payload).toMatchObject({ status: "generating", error_type: null });
	});

	it("NEVER touches the reservation marker — the claim only writes liveness fields", async () => {
		// Descoped model: a claim never mutates a prior run's marker. A displaced
		// HARD-KILLED run's stranded hold is handed back by THIS run's own
		// `reserveCredits` leftover-refund, not by the claim. So a claim on a stale
		// `generating` row with an unsettled marker writes NO credit doc and NO
		// reservation field — just the liveness flip.
		txGetMock.mockResolvedValue(
			snapshotWith({
				owner: "user-1",
				status: "generating",
				updated_at: staleClock(),
				reservation: { period: "2026-05", reserved: 100, settled: false },
			}),
		);
		const claim = await claimBuild("app-1");

		expect(claim.mode).toBe("build");
		// No credit-doc touch and no reservation field in the liveness write.
		expect(creditMonthRawMock).not.toHaveBeenCalled();
		expect(txSetMock).not.toHaveBeenCalled();
		expect(txUpdateMock).toHaveBeenCalledTimes(1);
		const [, payload] = txUpdateMock.mock.calls[0];
		expect(payload).toMatchObject({ status: "generating" });
		expect(payload).not.toHaveProperty("reservation");
	});

	it("fails a claim on a PAUSED app — a paused run BLOCKS (no takeover)", async () => {
		// Descoped model: a paused run is NO LONGER a claimable takeover. Its
		// `awaiting_input` shape makes `lease.paused` true, so the busy check throws
		// with nothing written; the route serializes-with-wait until the paused run
		// completes or its lease lapses and it is reaped.
		txGetMock.mockResolvedValue(
			snapshotWith({ status: "generating", awaiting_input: true }),
		);
		const { RunConflictError } = await import("../apps");

		await expect(claimBuild("app-1")).rejects.toBeInstanceOf(RunConflictError);
		expect(txUpdateMock).not.toHaveBeenCalled();
		expect(txSetMock).not.toHaveBeenCalled();
	});

	it("fails a claim on a LIVE generating row — a live run BLOCKS", async () => {
		// Two near-simultaneous POSTs share ONE row; the compare inside this
		// transaction is the arbitration. The loser's fresh read sees the winner's
		// `generating` inside the staleness window (live) and throws with nothing
		// written (the route serializes-with-wait), or two SA loops would interleave.
		txGetMock.mockResolvedValue(
			snapshotWith({ status: "generating", updated_at: freshClock() }),
		);
		const { RunConflictError } = await import("../apps");

		await expect(claimBuild("app-1")).rejects.toBeInstanceOf(RunConflictError);
		expect(txUpdateMock).not.toHaveBeenCalled();
	});
});
