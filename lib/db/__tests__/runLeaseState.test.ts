import { describe, expect, it } from "vitest";
import { MAX_GENERATION_MINUTES, MAX_RUN_MINUTES } from "../constants";
import { editLeaseDeadlineMs, runLeaseState } from "../runLiveness";
import type { AppDoc } from "../types";

/**
 * The pure spec of the single-reader liveness model. Every credit/claim decision
 * derives from `runLeaseState`, so this matrix over {build, edit, none} ×
 * {clean, live, paused, hard-killed} IS the authoritative statement of what
 * `live` / `paused` / `mine` / `terminalWriteOwned` /
 * `buildFailureWriteOwned` / `ownedByResume` /
 * `markerSettleable` / `reapableStrandedEdit` / `reapableStaleBuild` mean. A
 * behavior change to the model must change a row here.
 *
 * The run-state timestamps are plain `Date`s now (Postgres `timestamptz`
 * columns come back as `Date` — `runLeaseState` reads `.getTime()`), so a
 * corrupt/non-Date leaf reads as dead rather than throwing.
 */

const NOW = Date.UTC(2026, 6, 1, 12, 0, 0);
const RUN = "run-me";
const OTHER = "run-other";

/** A `run_lock.expireAt` `mins` minutes from NOW (negative = already lapsed). */
const lockAt = (mins: number, runId = RUN) => ({
	runId,
	actorUserId: "u1",
	expireAt: new Date(NOW + mins * 60_000),
});
/** An `updated_at` `mins` minutes before NOW (a build's staleness clock). */
const updatedAgo = (mins: number) =>
	new Date(NOW - mins * 60_000) as AppDoc["updated_at"];

const marker = (
	over: Partial<NonNullable<AppDoc["reservation"]>> = {},
): AppDoc["reservation"] => ({
	period: "2026-07",
	reserved: 5,
	settled: false,
	userId: "u1",
	runId: RUN,
	...over,
});

const lease = (fresh: Partial<AppDoc>) => runLeaseState(fresh, NOW);

describe("runLeaseState — mode", () => {
	it("build: status generating (regardless of any stale lock)", () => {
		expect(lease({ status: "generating" }).mode).toBe("build");
		expect(lease({ status: "generating", run_lock: lockAt(5) }).mode).toBe(
			"build",
		);
	});
	it("edit: complete with a run_lock", () => {
		expect(lease({ status: "complete", run_lock: lockAt(5) }).mode).toBe(
			"edit",
		);
	});
	it("none: complete, no lock", () => {
		expect(lease({ status: "complete" }).mode).toBe("none");
		expect(lease({ status: "error" }).mode).toBe("none");
	});
});

describe("runLeaseState — live (within the mode's horizon, not paused)", () => {
	it("build live inside the updated_at window", () => {
		expect(
			lease({ status: "generating", updated_at: updatedAgo(1) }).live,
		).toBe(true);
	});
	it("build NOT live past the staleness window (hard kill)", () => {
		expect(
			lease({
				status: "generating",
				updated_at: updatedAgo(MAX_GENERATION_MINUTES + 1),
			}).live,
		).toBe(false);
	});
	it("build NOT live when paused (awaiting_input)", () => {
		expect(
			lease({
				status: "generating",
				awaiting_input: true,
				updated_at: updatedAgo(1),
			}).live,
		).toBe(false);
	});
	it("edit live while its lease is in the future", () => {
		expect(lease({ status: "complete", run_lock: lockAt(5) }).live).toBe(true);
	});
	it("edit NOT live once the lease lapsed (hard kill)", () => {
		expect(lease({ status: "complete", run_lock: lockAt(-1) }).live).toBe(
			false,
		);
	});
	it("edit NOT live when paused, even with a future lease", () => {
		expect(
			lease({ status: "complete", run_lock: lockAt(5), awaiting_input: true })
				.live,
		).toBe(false);
	});
	it("none is never live", () => {
		expect(lease({ status: "complete" }).live).toBe(false);
	});
	it("a non-Date updated_at / expireAt reads as NOT live (total, never throws)", () => {
		// A corrupt/partial doc must not throw the whole derivation — it reads dead.
		expect(
			lease({
				status: "generating",
				updated_at: 12345 as unknown as AppDoc["updated_at"],
			}).live,
		).toBe(false);
		expect(
			lease({
				status: "complete",
				run_lock: {
					runId: RUN,
					actorUserId: "u1",
					expireAt: 12345 as unknown as Date,
				},
			}).live,
		).toBe(false);
	});
});

describe("runLeaseState — paused", () => {
	it("a build/edit with awaiting_input is paused; a run with none is not", () => {
		expect(lease({ status: "generating", awaiting_input: true }).paused).toBe(
			true,
		);
		expect(
			lease({ status: "complete", run_lock: lockAt(-1), awaiting_input: true })
				.paused,
		).toBe(true);
		expect(lease({ status: "generating" }).paused).toBe(false);
		// awaiting_input with no occupying run (complete, no lock) is not "paused".
		expect(lease({ status: "complete", awaiting_input: true }).paused).toBe(
			false,
		);
	});
});

describe("runLeaseState — pausedBy (the same-actor supersede gate)", () => {
	it("edit pause belongs to its lock actor — same actor supersedes, another blocks", () => {
		const l = lease({
			status: "complete",
			run_lock: lockAt(5),
			awaiting_input: true,
		});
		expect(l.pausedBy("u1")).toBe(true);
		expect(l.pausedBy("u2")).toBe(false);
	});
	it("build pause belongs to its marker's charged actor", () => {
		const l = lease({
			status: "generating",
			awaiting_input: true,
			updated_at: updatedAgo(1),
			reservation: marker(),
		});
		expect(l.pausedBy("u1")).toBe(true);
		expect(l.pausedBy("u2")).toBe(false);
	});
	it("build pause with a legacy actor-less marker falls back to owner (the refund-actor rule)", () => {
		const l = lease({
			status: "generating",
			awaiting_input: true,
			updated_at: updatedAgo(1),
			owner: "u1",
			reservation: marker({ userId: undefined }),
		});
		expect(l.pausedBy("u1")).toBe(true);
		expect(l.pausedBy("u2")).toBe(false);
	});
	it("a LIVE run is never pausedBy anyone — supersede must not kill an in-flight generation", () => {
		expect(
			lease({ status: "complete", run_lock: lockAt(5) }).pausedBy("u1"),
		).toBe(false);
		expect(
			lease({ status: "generating", updated_at: updatedAgo(1) }).pausedBy("u1"),
		).toBe(false);
	});
	it("an unresolvable holder never matches — a corrupt pause blocks rather than hands over", () => {
		// Empty lock actor (a corrupt row maps null → "").
		expect(
			lease({
				status: "complete",
				run_lock: { runId: RUN, actorUserId: "", expireAt: lockAt(5).expireAt },
				awaiting_input: true,
			}).pausedBy(""),
		).toBe(false);
		// Paused build with neither a marker actor nor an owner on the slice.
		expect(
			lease({
				status: "generating",
				awaiting_input: true,
				updated_at: updatedAgo(1),
			}).pausedBy("u1"),
		).toBe(false);
	});
});

describe("runLeaseState — mine", () => {
	it("edit owns via run_lock.runId", () => {
		const l = lease({ status: "complete", run_lock: lockAt(5, RUN) });
		expect(l.mine(RUN)).toBe(true);
		expect(l.mine(OTHER)).toBe(false);
	});
	it("build owns via the reservation marker's runId", () => {
		const l = lease({
			status: "generating",
			reservation: marker({ runId: RUN }),
		});
		expect(l.mine(RUN)).toBe(true);
		expect(l.mine(OTHER)).toBe(false);
	});
	it("build with a no-runId marker is mine for NOBODY (non-lenient)", () => {
		// A marker with no runId is a legacy pre-P9 marker OR a REAPED GHOST (the
		// reapers clear the runId when they settle). Non-lenient `mine` returns false
		// for everyone, so a reaped run's stale terminal writer can't read it as `mine`
		// and failApp a taker (the reaper-race fix). Both are resolved by the reapers'
		// OWN lenient clauses, never through `mine`.
		const l = lease({
			status: "generating",
			reservation: marker({ runId: undefined }),
		});
		expect(l.mine(RUN)).toBe(false);
		expect(l.mine(OTHER)).toBe(false);
	});
	it("none is nobody's", () => {
		expect(lease({ status: "complete" }).mine(RUN)).toBe(false);
	});
	it("is the exact-holder gate for pause stamps and prelude cleanup after replacement/reap", () => {
		/* Replacement: both holder shapes now name OTHER, so RUN's late pause or
		 * cleanup write must not touch them. */
		expect(
			lease({
				status: "generating",
				reservation: marker({ runId: OTHER }),
			}).mine(RUN),
		).toBe(false);
		expect(
			lease({ status: "complete", run_lock: lockAt(5, OTHER) }).mine(RUN),
		).toBe(false);
		/* Reap: the build marker's run id and the edit lock are gone. */
		expect(
			lease({
				status: "error",
				reservation: marker({ settled: true, runId: undefined }),
			}).mine(RUN),
		).toBe(false);
		expect(lease({ status: "complete" }).mine(RUN)).toBe(false);
	});
});

describe("runLeaseState — terminalWriteOwned", () => {
	it("edit: owns via the lock (regardless of the marker)", () => {
		const l = lease({ status: "complete", run_lock: lockAt(5, RUN) });
		expect(l.terminalWriteOwned(RUN)).toBe(true);
		expect(l.terminalWriteOwned(OTHER)).toBe(false);
	});
	it("build: owns only an UNSETTLED marker that is mine (a settled/absent marker is not writable)", () => {
		expect(
			lease({
				status: "generating",
				reservation: marker({ settled: false, runId: RUN }),
			}).terminalWriteOwned(RUN),
		).toBe(true);
		// Settled marker → not writable (closes the marker-less/settled window).
		expect(
			lease({
				status: "generating",
				reservation: marker({ settled: true, runId: RUN }),
			}).terminalWriteOwned(RUN),
		).toBe(false);
		// A different run's marker → not mine.
		expect(
			lease({
				status: "generating",
				reservation: marker({ settled: false, runId: OTHER }),
			}).terminalWriteOwned(RUN),
		).toBe(false);
		// A no-runId marker (reaped ghost or legacy) → not mine (non-lenient) → not
		// writable, so a reaped run's stale writer can't clobber a taker.
		expect(
			lease({
				status: "generating",
				reservation: marker({ settled: false, runId: undefined }),
			}).terminalWriteOwned(RUN),
		).toBe(false);
	});
	it("none: always owned (no competing run occupies the app)", () => {
		expect(lease({ status: "complete" }).terminalWriteOwned(RUN)).toBe(true);
	});
});

describe("runLeaseState — buildFailureWriteOwned", () => {
	it("accepts this build before reservation and after its marker settles", () => {
		expect(
			lease({ status: "generating", run_id: RUN }).buildFailureWriteOwned(RUN),
		).toBe(true);
		expect(
			lease({
				status: "generating",
				run_id: RUN,
				reservation: marker({ settled: true, runId: RUN }),
			}).buildFailureWriteOwned(RUN),
		).toBe(true);
	});

	it("rejects a reaped ghost, replacement holder, edit, or idle app", () => {
		expect(
			lease({
				status: "generating",
				run_id: RUN,
				reservation: marker({ settled: true, runId: undefined }),
			}).buildFailureWriteOwned(RUN),
		).toBe(false);
		expect(
			lease({
				status: "generating",
				run_id: RUN,
				reservation: marker({ runId: OTHER }),
			}).buildFailureWriteOwned(RUN),
		).toBe(false);
		expect(
			lease({ status: "complete", run_lock: lockAt(5) }).buildFailureWriteOwned(
				RUN,
			),
		).toBe(false);
		expect(lease({ status: "complete" }).buildFailureWriteOwned(RUN)).toBe(
			false,
		);
	});
});

describe("runLeaseState — ownedByResume (mode-specific to the RESUME's mode)", () => {
	it("edit-resume: owns only when the app is STILL an edit run it holds", () => {
		expect(
			lease({ status: "complete", run_lock: lockAt(5, RUN) }).ownedByResume(
				RUN,
				"edit",
			),
		).toBe(true);
		// The app is a build (status generating, no lock) → derived mode "build" →
		// an edit-resume (which requires mode "edit") bails.
		expect(
			lease({
				status: "generating",
				reservation: marker({ runId: undefined }),
			}).ownedByResume(RUN, "edit"),
		).toBe(false);
	});
	it("build-resume: owns only a PAUSED-build shape whose marker is mine", () => {
		expect(
			lease({
				status: "generating",
				awaiting_input: true,
				reservation: marker({ runId: RUN }),
			}).ownedByResume(RUN, "build"),
		).toBe(true);
		// Not paused → a build-resume (which requires the paused-build shape) bails.
		expect(
			lease({
				status: "generating",
				reservation: marker({ runId: undefined }),
			}).ownedByResume(RUN, "build"),
		).toBe(false);
	});
});

describe("runLeaseState — markerSettleable", () => {
	it("true for an unsettled marker, false when settled or absent", () => {
		expect(
			lease({ reservation: marker({ settled: false }) }).markerSettleable,
		).toBe(true);
		expect(
			lease({ reservation: marker({ settled: true }) }).markerSettleable,
		).toBe(false);
		expect(lease({}).markerSettleable).toBe(false);
	});
});

describe("runLeaseState — reapableStrandedEdit", () => {
	const strandedEdit: Partial<AppDoc> = {
		status: "complete",
		run_lock: lockAt(-1, RUN),
		reservation: marker({ settled: false, runId: RUN }),
	};

	it("true: complete + unsettled marker + a lapsed lock of the same run", () => {
		expect(lease(strandedEdit).reapableStrandedEdit).toBe(true);
	});
	it("true: the ORPHAN shape — the marker's run differs from the lapsed lock's", () => {
		// A taker hard-killed inside its own [claimRun, reserveCredits) window
		// leaves the PRIOR run's unsettled marker under the taker's lapsed lock
		// (the claim overwrites the lock, never the marker; the taker died before
		// its leftover-refund could hand the hold back). Both runs are dead, so
		// the hold must still reap — a same-run clause would strand it forever.
		expect(
			lease({
				...strandedEdit,
				run_lock: lockAt(-1, "run-taker"),
			}).reapableStrandedEdit,
		).toBe(true);
	});
	it("false: a LIVE edit (lease in the future) — never claw back a live hold", () => {
		expect(
			lease({ ...strandedEdit, run_lock: lockAt(5, RUN) }).reapableStrandedEdit,
		).toBe(false);
	});
	it("false: settled marker (a kept charge)", () => {
		expect(
			lease({ ...strandedEdit, reservation: marker({ settled: true }) })
				.reapableStrandedEdit,
		).toBe(false);
	});
	it("false: a BUILD's kept charge (no run_lock — never reaped as an edit)", () => {
		expect(
			lease({ status: "complete", reservation: marker({ settled: false }) })
				.reapableStrandedEdit,
		).toBe(false);
	});
	it("true: an ABANDONED PAUSED edit (paused + lapsed lease) IS reaped", () => {
		// Descoped model: a paused run has no heartbeat, so its lease lapses; an
		// abandoned paused edit must be reaped so a waiter can proceed.
		expect(
			lease({ ...strandedEdit, awaiting_input: true }).reapableStrandedEdit,
		).toBe(true);
	});
	it("false: a RECENTLY-paused edit (paused + FUTURE lease) is NOT reaped", () => {
		// Its lease is still in the future (paused < MAX_RUN_MINUTES ago) → alive.
		expect(
			lease({
				status: "complete",
				awaiting_input: true,
				run_lock: lockAt(5, RUN),
				reservation: marker({ settled: false, runId: RUN }),
			}).reapableStrandedEdit,
		).toBe(false);
	});
	it("true: a legacy marker with no runId reaps off the lapsed lock (lenient)", () => {
		expect(
			lease({ ...strandedEdit, reservation: marker({ runId: undefined }) })
				.reapableStrandedEdit,
		).toBe(true);
	});
});

describe("runLeaseState — reapableStaleBuild", () => {
	it("true: generating past the staleness window, not paused", () => {
		expect(
			lease({
				status: "generating",
				updated_at: updatedAgo(MAX_GENERATION_MINUTES + 1),
			}).reapableStaleBuild,
		).toBe(true);
	});
	it("false: a LIVE build (inside the window)", () => {
		expect(
			lease({ status: "generating", updated_at: updatedAgo(1) })
				.reapableStaleBuild,
		).toBe(false);
	});
	it("true: an ABANDONED PAUSED build (paused + stale clock) IS reaped", () => {
		// A paused build's `updated_at` freezes (no heartbeat), so an abandoned one
		// drifts past the window and is reaped so a waiter can proceed.
		expect(
			lease({
				status: "generating",
				awaiting_input: true,
				updated_at: updatedAgo(MAX_GENERATION_MINUTES + 1),
			}).reapableStaleBuild,
		).toBe(true);
	});
	it("false: a RECENTLY-paused build (paused + fresh clock) is NOT reaped", () => {
		expect(
			lease({
				status: "generating",
				awaiting_input: true,
				updated_at: updatedAgo(1),
			}).reapableStaleBuild,
		).toBe(false);
	});
	it("false: an EDIT (mode edit) or a complete app is never a stale build", () => {
		expect(
			lease({ status: "complete", run_lock: lockAt(-1) }).reapableStaleBuild,
		).toBe(false);
		expect(lease({ status: "complete" }).reapableStaleBuild).toBe(false);
	});
});

describe("editLeaseDeadlineMs", () => {
	it("is now + MAX_RUN_MINUTES", () => {
		expect(editLeaseDeadlineMs(NOW)).toBe(NOW + MAX_RUN_MINUTES * 60_000);
	});
});
