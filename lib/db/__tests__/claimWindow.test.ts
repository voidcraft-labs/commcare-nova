/**
 * The claim-window charge contract, end to end over an in-memory
 * Firestore fake: the REAL `claimBuildRun` + `reapStaleGenerating`
 * (apps.ts) composed with the REAL `reserveCredits` + `refundReservation`
 * (credits.ts), sharing one document store — no scripted per-call
 * snapshots, so each function reads exactly what the previous one wrote.
 *
 * What this proves that the per-function unit suites can't: the window
 * between `claimBuildRun` and `reserveCredits` is the one stretch where
 * a `generating` row carries the PREVIOUS run's marker. The claim settles
 * that marker (the displaced charge was kept), so a hard kill inside the
 * window reaps to `error` with NO refund — and the normal path's fresh
 * reservation still refunds a failed run in full. Both arms run here
 * against the same store.
 *
 * The fake transaction applies writes immediately (single-threaded
 * tests have no contention to model) and merges shallowly — every write
 * under test replaces whole top-level fields, so the semantics match.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCurrentPeriod } from "../period";

const { firestoreMock, seedDoc, readDoc, resetStore } = vi.hoisted(() => {
	const store = new Map<string, Record<string, unknown>>();

	const snapshotOf = (path: string) => ({
		exists: store.has(path),
		data: () => store.get(path),
	});
	const applySet = (
		path: string,
		data: Record<string, unknown>,
		opts?: { merge?: boolean },
	) => {
		store.set(
			path,
			opts?.merge ? { ...(store.get(path) ?? {}), ...data } : { ...data },
		);
	};
	const applyUpdate = (path: string, data: Record<string, unknown>) => {
		const existing = store.get(path);
		if (!existing) throw new Error(`update on missing doc: ${path}`);
		store.set(path, { ...existing, ...data });
	};

	const tx = {
		get: async (ref: { path: string }) => snapshotOf(ref.path),
		set: (
			ref: { path: string },
			data: Record<string, unknown>,
			opts?: { merge?: boolean },
		) => applySet(ref.path, data, opts),
		update: (ref: { path: string }, data: Record<string, unknown>) =>
			applyUpdate(ref.path, data),
	};
	const db = {
		runTransaction: (body: (t: typeof tx) => Promise<unknown>) => body(tx),
	};
	const makeRef = (path: string) => ({
		path,
		firestore: db,
		get: async () => snapshotOf(path),
		set: async (data: Record<string, unknown>, opts?: { merge?: boolean }) =>
			applySet(path, data, opts),
		update: async (data: Record<string, unknown>) => applyUpdate(path, data),
	});

	return {
		firestoreMock: {
			getDb: () => db,
			docs: {
				app: (id: string) => makeRef(`apps/${id}`),
				appRaw: (id: string) => makeRef(`apps/${id}`),
				creditMonthRaw: (userId: string, period: string) =>
					makeRef(`credits/${userId}/months/${period}`),
			},
			collections: {},
		},
		seedDoc: (path: string, data: Record<string, unknown>) => {
			store.set(path, structuredClone(data));
		},
		readDoc: (path: string) => store.get(path),
		resetStore: () => store.clear(),
	};
});

vi.mock("../firestore", () => firestoreMock);

describe("claim window — kept charges survive a hard kill; live holds still refund", () => {
	const PERIOD = getCurrentPeriod();
	const APP = "apps/app-1";
	const CREDITS = `credits/user-1/months/${PERIOD}`;

	beforeEach(() => {
		resetStore();
		/* A finished build at rest: its 100-credit charge was KEPT, so the
		 * marker is unsettled (only refunds settle it). */
		seedDoc(APP, {
			owner: "user-1",
			status: "complete",
			error_type: null,
			reservation: { period: PERIOD, reserved: 100, settled: false },
		});
		seedDoc(CREDITS, { allowance: 2000, consumed: 100, bonus: 0 });
	});

	it("a hard kill between claim and reserve reaps to error with NO refund — the kept charge stays booked", async () => {
		const { claimBuildRun, reapStaleGenerating } = await import("../apps");

		const claim = await claimBuildRun("app-1");
		expect(claim).toEqual({ from: "complete" });
		// The claim settled the displaced kept charge's marker.
		expect(readDoc(APP)?.reservation).toEqual({
			period: PERIOD,
			reserved: 100,
			settled: true,
		});

		/* Hard kill here — `reserveCredits` never runs. The row is a
		 * `generating` orphan the reaper eventually scans. */
		await reapStaleGenerating("app-1");

		expect(readDoc(APP)).toMatchObject({ status: "error" });
		// The kept charge was NOT handed back.
		expect(readDoc(CREDITS)).toMatchObject({ consumed: 100 });
	});

	it("the normal path's fresh reservation still refunds a failed run in full", async () => {
		const { claimBuildRun } = await import("../apps");
		const { refundReservation, reserveCredits } = await import("../credits");

		await claimBuildRun("app-1");
		await reserveCredits("user-1", 100, "app-1");
		// The new run's debit booked on top of the kept charge, under a
		// fresh unsettled marker.
		expect(readDoc(CREDITS)).toMatchObject({ consumed: 200 });
		expect(readDoc(APP)?.reservation).toEqual({
			period: PERIOD,
			reserved: 100,
			settled: false,
		});

		/* The run fails — the failure funnel refunds off the marker. */
		await refundReservation("app-1");

		expect(readDoc(CREDITS)).toMatchObject({ consumed: 100 });
		expect(readDoc(APP)?.reservation).toEqual({
			period: PERIOD,
			reserved: 100,
			settled: true,
		});
	});

	it("a displaced-then-restored PAUSED run's failed resume still refunds in full", async () => {
		// The paused arm must NOT settle the displaced marker: it is the LIVE
		// hold an earlier chargeable POST booked, and the route's failure
		// funnel reads it back when a resume of the restored run fails. This
		// drives that whole life: claim displaces the paused run, a bail-out
		// restores the pause, a free continuation resumes it and fails, and
		// the refund lands in full off the original marker.
		const { claimBuildRun, setAwaitingInput } = await import("../apps");
		const { refundReservation } = await import("../credits");

		seedDoc(APP, {
			owner: "user-1",
			status: "generating",
			awaiting_input: true,
			error_type: null,
			reservation: { period: PERIOD, reserved: 100, settled: false },
		});

		const claim = await claimBuildRun("app-1");
		expect(claim).toEqual({ from: "paused" });
		// The live hold survived the claim untouched.
		expect(readDoc(APP)?.reservation).toEqual({
			period: PERIOD,
			reserved: 100,
			settled: false,
		});

		/* Pre-stream bail-out — the route restores the pause. */
		await setAwaitingInput("app-1", true);
		expect(readDoc(APP)).toMatchObject({ awaiting_input: true });

		/* A later free continuation resumes the run and FAILS — the failure
		 * funnel's post-flush refund reads the hold off the marker. */
		await refundReservation("app-1");

		expect(readDoc(CREDITS)).toMatchObject({ consumed: 0 });
		expect(readDoc(APP)?.reservation).toEqual({
			period: PERIOD,
			reserved: 100,
			settled: true,
		});
	});
});
