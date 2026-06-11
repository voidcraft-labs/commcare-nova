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

import { Timestamp } from "@google-cloud/firestore";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	refundReservationMock,
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
		refundReservationMock: vi.fn(),
		appSetMock,
		// `failApp` writes status via `docs.app(appId).set(...)`; the spy lets us
		// see whether (and with what) the status flip fired.
		appMock: vi.fn().mockReturnValue({ set: appSetMock }),
		appRawMock: vi.fn().mockReturnValue({ id: "raw-ref" }),
		creditMonthRawMock: vi.fn().mockReturnValue({ id: "credit-ref" }),
		txGetMock,
		txUpdateMock,
		txSetMock,
		// `claimBuildRun` runs a transaction; the fake runs the body
		// against the `tx` spies so tests control the fresh read(s) and
		// observe the conditional flip + the stale arm's credit write.
		getDbMock: vi.fn().mockReturnValue({
			runTransaction: (body: (tx: unknown) => Promise<unknown>) =>
				body({ get: txGetMock, update: txUpdateMock, set: txSetMock }),
		}),
	};
});

vi.mock("../credits", () => ({ refundReservation: refundReservationMock }));
vi.mock("../firestore", () => ({
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

describe("claimBuildRun", () => {
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
		const { claimBuildRun } = await import("../apps");
		const claim = await claimBuildRun("app-1");

		expect(claim).toEqual({ from: "error", errorType: "model_error" });
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
		const { claimBuildRun } = await import("../apps");
		const claim = await claimBuildRun("app-1");

		expect(claim).toEqual({ from: "complete" });
		expect(txUpdateMock).toHaveBeenCalledTimes(1);
		const [, payload] = txUpdateMock.mock.calls[0];
		expect(payload).toMatchObject({ status: "generating", error_type: null });
	});

	it("settles a displaced KEPT charge's marker in the claim transaction", async () => {
		// The displaced `complete` run kept its charge, so its marker sits
		// unsettled — safe while the app is at rest, lethal once this claim
		// flips the row to `generating`: a hard kill between the claim and
		// the new run's `reserveCredits` would hand the reaper an unsettled
		// marker for a charge that was KEPT, and the refund would un-book it.
		// Settling at claim time closes that window.
		txGetMock.mockResolvedValue(
			snapshotWith({
				status: "complete",
				reservation: { period: "2026-05", reserved: 100, settled: false },
			}),
		);
		const { claimBuildRun } = await import("../apps");
		await claimBuildRun("app-1");

		const [, payload] = txUpdateMock.mock.calls[0];
		expect(payload.reservation).toEqual({
			period: "2026-05",
			reserved: 100,
			settled: true,
		});
		// A kept charge settles WITHOUT a refund — no credit doc is touched.
		expect(txSetMock).not.toHaveBeenCalled();
	});

	it("leaves an already-settled marker untouched", async () => {
		// A displaced `error` run's marker was settled by its refund; the
		// claim has nothing to do and writes no reservation field at all
		// (`reserveCredits` overwrites it fresh either way).
		txGetMock.mockResolvedValue(
			snapshotWith({
				status: "error",
				error_type: "internal",
				reservation: { period: "2026-05", reserved: 100, settled: true },
			}),
		);
		const { claimBuildRun } = await import("../apps");
		await claimBuildRun("app-1");

		const [, payload] = txUpdateMock.mock.calls[0];
		expect(payload).not.toHaveProperty("reservation");
	});

	it("claims a build PAUSED on questions, clearing the pause flag in the same transaction", async () => {
		// A paused build (`generating` + `awaiting_input`) has no live
		// process — a fresh chargeable instruction may take over its window.
		// The flag clears inside the claim so two such POSTs arbitrate on the
		// compare-and-flip: the loser's re-read sees a live `generating`
		// (flag gone) and throws.
		txGetMock.mockResolvedValue(
			snapshotWith({ status: "generating", awaiting_input: true }),
		);
		const { claimBuildRun } = await import("../apps");
		const claim = await claimBuildRun("app-1");

		expect(claim).toEqual({ from: "paused" });
		expect(txUpdateMock).toHaveBeenCalledTimes(1);
		const [, payload] = txUpdateMock.mock.calls[0];
		expect(payload).toMatchObject({
			status: "generating",
			awaiting_input: false,
		});
	});

	it("fails the second same-app contender — a LIVE generating row is owned", async () => {
		// Two near-simultaneous POSTs share ONE row, and the concurrency
		// check excludes the contender's own appId — so the compare inside
		// this transaction is the only arbitration between them. The loser's
		// fresh read sees the winner's `generating` (its `updated_at` inside
		// the staleness window) and must throw with nothing written (the
		// route 429s it), or two SA loops would interleave their saves on
		// one app.
		txGetMock.mockResolvedValue(
			snapshotWith({ status: "generating", updated_at: freshClock() }),
		);
		const { claimBuildRun, BuildRunConflictError } = await import("../apps");

		await expect(claimBuildRun("app-1")).rejects.toBeInstanceOf(
			BuildRunConflictError,
		);
		expect(txUpdateMock).not.toHaveBeenCalled();
	});

	it("displaces a STALE generating row — refunds its stranded hold and claims in one transaction", async () => {
		// A hard-killed run the reapers never scanned (a retry POST runs no
		// list scan, and the concurrency check excludes this appId) would
		// otherwise 429 forever. The claim settles it exactly as
		// `reapStaleGenerating` would — refund off the unsettled marker,
		// classification `internal` — and takes the window in the same
		// transaction.
		txGetMock
			.mockResolvedValueOnce(
				snapshotWith({
					owner: "user-1",
					status: "generating",
					updated_at: staleClock(),
					reservation: { period: "2026-05", reserved: 100, settled: false },
				}),
			)
			// The credit doc the marker points at.
			.mockResolvedValueOnce(snapshotWith({ consumed: 150 }));
		const { claimBuildRun } = await import("../apps");
		const claim = await claimBuildRun("app-1");

		// Reports the shape the reaper would have left, so a bail-out
		// restore lands the row at `error`/`internal` — never back to a
		// phantom live run.
		expect(claim).toEqual({ from: "error", errorType: "internal" });
		expect(creditMonthRawMock).toHaveBeenCalledWith("user-1", "2026-05");
		expect(txSetMock).toHaveBeenCalledTimes(1);
		const [, refundPayload, refundOpts] = txSetMock.mock.calls[0];
		expect(refundPayload).toMatchObject({ consumed: 50 });
		expect(refundOpts).toEqual({ merge: true });
		const [, payload] = txUpdateMock.mock.calls[0];
		expect(payload).toMatchObject({ status: "generating" });
		expect(payload.reservation).toEqual({
			period: "2026-05",
			reserved: 100,
			settled: true,
		});
	});

	it("displaces a stale row with a SETTLED marker without refunding — the hold was already resolved", async () => {
		// Composition with the claim-window settle rule: a row stranded
		// between a previous claim and its `reserveCredits` carries a
		// settled marker (the displaced charge was kept), so this
		// displacement refunds nothing.
		txGetMock.mockResolvedValueOnce(
			snapshotWith({
				owner: "user-1",
				status: "generating",
				updated_at: staleClock(),
				reservation: { period: "2026-05", reserved: 100, settled: true },
			}),
		);
		const { claimBuildRun } = await import("../apps");
		const claim = await claimBuildRun("app-1");

		expect(claim).toEqual({ from: "error", errorType: "internal" });
		expect(creditMonthRawMock).not.toHaveBeenCalled();
		expect(txSetMock).not.toHaveBeenCalled();
		expect(txUpdateMock).toHaveBeenCalledTimes(1);
	});
});
