/**
 * The claim + credit-transfer contract, end to end over an in-memory Firestore
 * fake: the REAL `claimRun` + `reapStaleGenerating` (apps.ts) composed with the
 * REAL `reserveCredits` + `refundReservation` (credits.ts), sharing one document
 * store, so each function reads exactly what the previous one wrote.
 *
 * The descoped model (no cross-mode takeover): a claim NEVER mutates a prior run's
 * marker — it only writes liveness fields. The credit-transfer for a displaced
 * HARD-KILLED run lives entirely in `reserveCredits` (its unconditional
 * leftover-refund). And a PAUSED run is no longer a claimable takeover — a claim
 * on a paused app THROWS. This suite pins that composition: a KEPT (settled)
 * charge survives an untouching claim; `reserveCredits` (not the claim) refunds a
 * hard-killed leftover before booking the fresh charge (to the CHARGED actor, not
 * the owner); the normal path's fresh reservation refunds a failed run in full;
 * and a claim on a paused app is rejected.
 *
 * The fake transaction applies writes immediately (single-threaded tests have no
 * contention to model). Its `set(..., {merge:true})` DEEP-merges and honors a
 * nested `FieldValue.delete()` sentinel as a key removal — matching the server SDK
 * — so the reaper's `reservation.runId` clear is enforceable HERE, in the
 * `--changed` unit sweep, not only in the emulator suite. It also enforces the
 * server SDK's read-before-write rule (a `get` after a write in the same
 * transaction throws), so a regression re-inlining a deferred credit write fails
 * here, not in prod.
 */

import { Timestamp } from "@google-cloud/firestore";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCurrentPeriod } from "../period";

/** An `updated_at` past the build staleness window (a hard-killed generating run). */
const staleTimestamp = () =>
	Timestamp.fromDate(new Date(Date.now() - 60 * 60_000));

const { firestoreMock, seedDoc, readDoc, resetStore } = vi.hoisted(() => {
	const store = new Map<string, Record<string, unknown>>();

	const snapshotOf = (path: string) => ({
		exists: store.has(path),
		data: () => store.get(path),
	});
	// The real `FieldValue.delete()` sentinel `credits.ts` writes — detected via its
	// own `.isEqual` so the fake honors a NESTED delete instead of storing the raw
	// sentinel. Without this, a regression BACK to omitting `runId` (rather than an
	// explicit delete) would pass this unit suite even though it silently fails the
	// real `set(..., { merge: true })` nested-merge (the reaper-race bug the emulator
	// window cell caught). Deep-merging + honoring the delete makes THIS suite catch it.
	const { FieldValue } = require("@google-cloud/firestore");
	const isDeleteSentinel = (v: unknown): boolean =>
		typeof (v as { isEqual?: unknown })?.isEqual === "function" &&
		(v as { isEqual: (o: unknown) => boolean }).isEqual(FieldValue.delete());
	const isPlainObject = (v: unknown): v is Record<string, unknown> =>
		typeof v === "object" && v !== null && (v as object).constructor === Object;

	/** Deep-merge `data` into `into`, applying `FieldValue.delete()` sentinels as
	 *  key removals — the same semantics the server SDK's `set(..., {merge:true})`
	 *  has for a nested map. */
	const deepMerge = (
		into: Record<string, unknown>,
		data: Record<string, unknown>,
	): Record<string, unknown> => {
		const out: Record<string, unknown> = { ...into };
		for (const [k, v] of Object.entries(data)) {
			if (isDeleteSentinel(v)) delete out[k];
			else if (isPlainObject(v) && isPlainObject(out[k]))
				out[k] = deepMerge(out[k] as Record<string, unknown>, v);
			else out[k] = v;
		}
		return out;
	};

	const applySet = (
		path: string,
		data: Record<string, unknown>,
		opts?: { merge?: boolean },
	) => {
		store.set(
			path,
			opts?.merge ? deepMerge(store.get(path) ?? {}, data) : { ...data },
		);
	};
	const applyUpdate = (path: string, data: Record<string, unknown>) => {
		const existing = store.get(path);
		if (!existing) throw new Error(`update on missing doc: ${path}`);
		store.set(path, { ...existing, ...data });
	};

	const db = {
		runTransaction: (
			body: (t: {
				get: (ref: { path: string }) => Promise<unknown>;
				set: (
					ref: { path: string },
					data: Record<string, unknown>,
					opts?: { merge?: boolean },
				) => void;
				update: (ref: { path: string }, data: Record<string, unknown>) => void;
			}) => Promise<unknown>,
		) => {
			/* Per-transaction write latch — the real server SDK rejects any
			 * read once the transaction has written. */
			let wrote = false;
			return body({
				get: async (ref) => {
					if (wrote) {
						throw new Error(
							`This transaction already wrote and then tried to read ${ref.path}. Firestore server-SDK transactions require every read to precede every write — defer the write (a closure) until all reads are done.`,
						);
					}
					return snapshotOf(ref.path);
				},
				set: (ref, data, opts) => {
					wrote = true;
					applySet(ref.path, data, opts);
				},
				update: (ref, data) => {
					wrote = true;
					applyUpdate(ref.path, data);
				},
			});
		},
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
		/* Shallow copy, not structuredClone — seeds may carry a Timestamp
		 * instance (`updated_at`), and cloning would strip its prototype
		 * (no `.toDate()`). Writers replace top-level fields wholesale and
		 * never mutate nested values, so sharing them is safe here. */
		seedDoc: (path: string, data: Record<string, unknown>) => {
			store.set(path, { ...data });
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
		/* A finished build at rest: its 100-credit charge was KEPT, and a clean
		 * completion settles the marker ATOMICALLY (`completeAndSettleRun`), so a
		 * kept charge's marker is `settled: true`. (An UNSETTLED marker on a
		 * `complete` app is NOT a kept charge — it's a hard-killed run that owes a
		 * refund, which the claim now hands back.) */
		seedDoc(APP, {
			owner: "user-1",
			status: "complete",
			error_type: null,
			reservation: { period: PERIOD, reserved: 100, settled: true },
		});
		seedDoc(CREDITS, { allowance: 2000, consumed: 100, bonus: 0 });
	});

	/** Invoke the generalized `claimRun` in build mode with the run/actor ids
	 *  the route threads. */
	const claimBuild = async (appId: string) => {
		const { claimRun } = await import("../apps");
		return claimRun(appId, "build", "run-1", "user-1");
	};

	it("a claim NEVER touches the reservation marker — a KEPT (settled) charge survives untouched", async () => {
		const { reapStaleGenerating } = await import("../apps");

		const claim = await claimBuild("app-1");
		expect(claim.mode).toBe("build");
		expect(claim.prior).toMatchObject({
			status: "complete",
			error_type: null,
			awaiting_input: false,
			run_lock: null,
		});
		// Descoped model: the claim only writes liveness fields, never the marker.
		// A KEPT charge's marker (settled) is left exactly as-is.
		expect(readDoc(APP)?.reservation).toEqual({
			period: PERIOD,
			reserved: 100,
			settled: true,
		});

		/* Hard kill here — `reserveCredits` never runs. The `generating` orphan is
		 * reaped; `refundStaleGeneration` re-validates in-txn and, finding the marker
		 * settled, flips to error WITHOUT refunding. */
		await reapStaleGenerating("app-1");
		expect(readDoc(APP)).toMatchObject({ status: "error" });
		expect(readDoc(CREDITS)).toMatchObject({ consumed: 100 });
	});

	it("the build reaper CLEARS the marker's runId (the reaper-race fix — a regression to omitting it fails HERE)", async () => {
		// The reaper-race guard, at unit altitude. A stale `generating` build with an
		// UNSETTLED runId'd marker is reaped; `refundStaleGeneration` must refund AND
		// clear `reservation.runId` (via a nested `FieldValue.delete()`) so the reaped
		// run's own stale terminal writer can't later read the marker as `mine`. The
		// fake honors the nested delete, so a regression BACK to omitting `runId` (which
		// silently survives the real `set(..., {merge:true})` nested-merge) leaves the
		// runId here and FAILS this assertion — closing the coverage gap that would
		// otherwise let the reaper-race ship green through the `--changed` unit sweep.
		const { reapStaleGenerating } = await import("../apps");
		seedDoc(APP, {
			owner: "user-1",
			status: "generating",
			error_type: null,
			updated_at: staleTimestamp(),
			reservation: {
				period: PERIOD,
				reserved: 100,
				settled: false,
				userId: "user-1",
				runId: "run-dead",
			},
		});
		seedDoc(CREDITS, { allowance: 2000, consumed: 100, bonus: 0 });

		await reapStaleGenerating("app-1");

		const marker = readDoc(APP)?.reservation as Record<string, unknown>;
		expect(marker).toMatchObject({
			settled: true,
			userId: "user-1",
			reserved: 100,
		});
		expect(marker).not.toHaveProperty("runId"); // ← the reaper-race clear
		expect(readDoc(CREDITS)).toMatchObject({ consumed: 0 }); // refunded
	});

	it("reserveCredits (not the claim) refunds a hard-killed run's leftover before booking the fresh charge", async () => {
		// The credit-transfer moved OFF the claim onto `reserveCredits`. Seed a
		// hard-killed run's UNSETTLED leftover on a complete app; the retry claims
		// (touching nothing), then `reserveCredits` un-books the leftover and books
		// the fresh 100 — net 100, not 200, and the dead actor isn't buried.
		const { reserveCredits } = await import("../credits");
		seedDoc(APP, {
			owner: "user-1",
			status: "complete",
			error_type: null,
			reservation: { period: PERIOD, reserved: 100, settled: false },
		});
		seedDoc(CREDITS, { allowance: 2000, consumed: 100, bonus: 0 });

		await claimBuild("app-1");
		// The claim left the leftover marker as-is (no credit touch).
		expect(readDoc(APP)?.reservation).toMatchObject({ settled: false });

		await reserveCredits("user-1", 100, "app-1", "run-2");
		// Leftover 100 refunded, fresh 100 booked → net stays 100.
		expect(readDoc(CREDITS)).toMatchObject({ consumed: 100 });
		expect(readDoc(APP)?.reservation).toMatchObject({
			period: PERIOD,
			reserved: 100,
			settled: false,
			userId: "user-1",
			runId: "run-2",
		});
	});

	it("the normal path's fresh reservation still refunds a failed run in full", async () => {
		const { refundReservation, reserveCredits } = await import("../credits");

		await claimBuild("app-1");
		await reserveCredits("user-1", 100, "app-1", "run-1");
		// The prior marker was already settled (a kept charge), so there's no
		// leftover to refund; the fresh 100 books on top → 200. A BUILD marker clears
		// `expireAt` via `FieldValue.delete()`; the fake honors it, so the stored
		// marker has no `expireAt` key.
		expect(readDoc(CREDITS)).toMatchObject({ consumed: 200 });
		expect(readDoc(APP)?.reservation).not.toHaveProperty("expireAt");
		expect(readDoc(APP)?.reservation).toMatchObject({
			period: PERIOD,
			reserved: 100,
			settled: false,
			userId: "user-1",
		});

		/* The run fails — the failure funnel refunds off the marker. */
		await refundReservation("app-1", "run-1");
		expect(readDoc(CREDITS)).toMatchObject({ consumed: 100 });
		expect(readDoc(APP)?.reservation).toMatchObject({
			period: PERIOD,
			reserved: 100,
			settled: true,
			userId: "user-1",
		});
	});

	it("reserveCredits refunds the CHARGED ACTOR of a leftover, not the owner (owner != actor)", async () => {
		// A Project co-member (NOT the owner) ran a build, was charged 100, then
		// hard-killed. The retry's `reserveCredits` leftover-refund must un-book the
		// ACTOR's hold (`marker.userId`), NOT `app.owner`.
		const { reserveCredits } = await import("../credits");
		const ACTOR_CREDITS = `credits/member-2/months/${PERIOD}`;
		const OWNER_CREDITS = `credits/owner-1/months/${PERIOD}`;
		seedDoc(APP, {
			owner: "owner-1",
			status: "complete",
			error_type: null,
			reservation: {
				period: PERIOD,
				reserved: 100,
				settled: false,
				userId: "member-2",
			},
		});
		seedDoc(OWNER_CREDITS, { allowance: 2000, consumed: 0, bonus: 0 });
		seedDoc(ACTOR_CREDITS, { allowance: 2000, consumed: 100, bonus: 0 });

		await claimBuild("app-1");
		// The owner (member-1 in claimBuild is "user-1"; here the retry actor is the
		// owner-1) books fresh; the leftover refunds to member-2.
		await reserveCredits("owner-1", 100, "app-1", "run-2");

		// The dead member's hold is handed back…
		expect(readDoc(ACTOR_CREDITS)).toMatchObject({ consumed: 0 });
		// …and the fresh 100 booked on the owner's own ledger.
		expect(readDoc(OWNER_CREDITS)).toMatchObject({ consumed: 100 });
	});

	it("a claim on a PAUSED app THROWS — a paused run blocks (no takeover)", async () => {
		const { RunConflictError } = await import("../apps");
		seedDoc(APP, {
			owner: "user-1",
			status: "generating",
			awaiting_input: true,
			error_type: null,
			reservation: { period: PERIOD, reserved: 100, settled: false },
		});

		await expect(claimBuild("app-1")).rejects.toBeInstanceOf(RunConflictError);
		// Nothing written — the paused run's marker is untouched.
		expect(readDoc(APP)?.reservation).toEqual({
			period: PERIOD,
			reserved: 100,
			settled: false,
		});
		expect(readDoc(APP)).toMatchObject({ awaiting_input: true });
	});
});
