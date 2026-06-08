// scripts/__tests__/creditReconcile.test.ts
//
// Pure-function coverage for the migration reconciliation. These tests
// pin the per-`(owner, period)` cell math the read-only scan (and the
// later dry-run migrator) both depend on:
//
//   1. ledgerSum = Σ every run's costEstimate (deleted runs INCLUDED),
//      grouped by the run's finishedPeriod (the attribution month).
//   2. delta = ledgerSum − current usage cost_estimate (0 when absent).
//   3. crossMonthRuns = the cell's runs whose started/finished months
//      differ — the threads that mis-attribute their whole cost.
//   4. softDeletedContribution = the deleted-run subset of ledgerSum,
//      noted for transparency but NOT excluded.
//   5. current-month routing: isCurrentMonth + overBackstopCurrentMonth
//      (the only cells whose re-baseline trips the live $50 backstop).
//
// currentPeriod and backstopUsd are explicit params here — the pure
// function never reads the system clock, so the fixtures are stable.

import { describe, expect, it } from "vitest";
import {
	type CellRow,
	creditReconcile,
	planRebaseline,
	type RunInput,
} from "@/scripts/lib/creditReconcile";

/** A run fixture with the rarely-varied fields defaulted. */
function run(over: Partial<RunInput> & Pick<RunInput, "ownerId">): RunInput {
	return {
		runId: "run-default",
		appId: "app-default",
		deleted: false,
		costEstimate: 0,
		startedPeriod: "2026-04",
		finishedPeriod: "2026-04",
		...over,
	};
}

/** Find the single cell for an owner, asserting uniqueness. */
function cellFor(rows: CellRow[], ownerId: string, period: string): CellRow {
	const matches = rows.filter(
		(r) => r.ownerId === ownerId && r.period === period,
	);
	expect(matches).toHaveLength(1);
	return matches[0];
}

describe("creditReconcile", () => {
	it("returns no cells for empty input (pure + total)", () => {
		expect(creditReconcile([], new Map(), "2026-06", 50)).toEqual([]);
	});

	it("fixture 1 — single-period user: ledgerSum, delta, no flags", () => {
		// Owner A: one run finished 2026-04 costing $3, current usage $2.
		const runs = [
			run({ ownerId: "A", costEstimate: 3, finishedPeriod: "2026-04" }),
		];
		const usage = new Map([["A/2026-04", 2]]);

		const rows = creditReconcile(runs, usage, "2026-06", 50);

		expect(rows).toHaveLength(1);
		const a = cellFor(rows, "A", "2026-04");
		expect(a.ledgerSum).toBe(3);
		expect(a.current).toBe(2);
		expect(a.delta).toBe(1);
		expect(a.isCurrentMonth).toBe(false);
		expect(a.overBackstopCurrentMonth).toBe(false);
		expect(a.softDeletedContribution).toBe(0);
		expect(a.crossMonthRuns).toEqual([]);
	});

	it("fixture 2 — cross-month run: attributed to finishedPeriod, flagged", () => {
		// Owner B: one thread started 2026-05, finished 2026-06, cost $4.
		const runs = [
			run({
				ownerId: "B",
				runId: "run-b",
				appId: "app-b",
				costEstimate: 4,
				startedPeriod: "2026-05",
				finishedPeriod: "2026-06",
			}),
		];

		const rows = creditReconcile(runs, new Map(), "2026-01", 50);

		// Attributed to the FINISHED month (2026-06), not the started one.
		const b = cellFor(rows, "B", "2026-06");
		expect(b.ledgerSum).toBe(4);
		expect(b.current).toBe(0); // no usage doc → 0
		expect(b.delta).toBe(4);
		expect(b.crossMonthRuns).toHaveLength(1);
		expect(b.crossMonthRuns[0]).toEqual({
			runId: "run-b",
			appId: "app-b",
			startedPeriod: "2026-05",
			finishedPeriod: "2026-06",
			costEstimate: 4,
		});
	});

	it("fixture 3 — soft-deleted contribution: included in ledgerSum, noted", () => {
		// Owner C: a deleted run ($5) + a live run ($1), same period.
		const runs = [
			run({ ownerId: "C", runId: "c-del", deleted: true, costEstimate: 5 }),
			run({ ownerId: "C", runId: "c-live", deleted: false, costEstimate: 1 }),
		];

		const rows = creditReconcile(runs, new Map(), "2026-06", 50);

		const c = cellFor(rows, "C", "2026-04");
		// Deleted runs are real cost — INCLUDED in the sum, not excluded.
		expect(c.ledgerSum).toBe(6);
		expect(c.softDeletedContribution).toBe(5);
		expect(c.crossMonthRuns).toEqual([]);
	});

	it("fixture 4 — current-month over $50: both current + backstop flags set", () => {
		// Owner D: finished period === currentPeriod, ledgerSum $60 ≥ $50.
		const runs = [
			run({
				ownerId: "D",
				costEstimate: 60,
				startedPeriod: "2026-06",
				finishedPeriod: "2026-06",
			}),
		];

		const rows = creditReconcile(runs, new Map(), "2026-06", 50);

		const d = cellFor(rows, "D", "2026-06");
		expect(d.ledgerSum).toBe(60);
		expect(d.isCurrentMonth).toBe(true);
		expect(d.overBackstopCurrentMonth).toBe(true);
	});

	it("fixture 4b — current-month UNDER $50: current flag yes, backstop no", () => {
		// Boundary partner to fixture 4: same period, sum below the backstop.
		const runs = [
			run({
				ownerId: "D2",
				costEstimate: 49.99,
				startedPeriod: "2026-06",
				finishedPeriod: "2026-06",
			}),
		];

		const rows = creditReconcile(runs, new Map(), "2026-06", 50);

		const d = cellFor(rows, "D2", "2026-06");
		expect(d.isCurrentMonth).toBe(true);
		expect(d.overBackstopCurrentMonth).toBe(false);
	});

	it("fixture 5 — delta zero when ledgerSum equals current usage", () => {
		// Owner E: ledgerSum $10, current usage $10 → no shift.
		const runs = [run({ ownerId: "E", costEstimate: 10 })];
		const usage = new Map([["E/2026-04", 10]]);

		const rows = creditReconcile(runs, usage, "2026-06", 50);

		const e = cellFor(rows, "E", "2026-04");
		expect(e.ledgerSum).toBe(10);
		expect(e.current).toBe(10);
		expect(e.delta).toBe(0);
	});

	it("groups multiple owners + periods deterministically (ownerId, then period)", () => {
		// Out-of-order input across owners and periods; output must be
		// sorted so PROD scan output is stable run-to-run.
		const runs = [
			run({ ownerId: "Z", finishedPeriod: "2026-05", costEstimate: 1 }),
			run({ ownerId: "A", finishedPeriod: "2026-06", costEstimate: 1 }),
			run({ ownerId: "A", finishedPeriod: "2026-04", costEstimate: 1 }),
		];

		const rows = creditReconcile(runs, new Map(), "2026-06", 50);

		expect(rows.map((r) => `${r.ownerId}/${r.period}`)).toEqual([
			"A/2026-04",
			"A/2026-06",
			"Z/2026-05",
		]);
	});
});

describe("planRebaseline", () => {
	// Build a CellRow fixture with just the fields the planner reads.
	function cell(over: Partial<CellRow> & Pick<CellRow, "ownerId">): CellRow {
		return {
			period: "2026-04",
			current: 0,
			ledgerSum: 0,
			delta: 0,
			isCurrentMonth: false,
			softDeletedContribution: 0,
			crossMonthRuns: [],
			overBackstopCurrentMonth: false,
			...over,
		};
	}

	it("routes a closed-month material delta to closedWrites", () => {
		// Owner A, a closed month (isCurrentMonth false): $2 → $3 always applies.
		const rows = [
			cell({
				ownerId: "A",
				period: "2026-04",
				current: 2,
				ledgerSum: 3,
				delta: 1,
				isCurrentMonth: false,
			}),
		];

		const plan = planRebaseline(rows, new Set(), new Map([["A", "a@x.com"]]));

		expect(plan.closedWrites).toEqual([
			{ ownerId: "A", period: "2026-04", from: 2, to: 3 },
		]);
		expect(plan.currentWrites).toEqual([]);
		expect(plan.currentSkipped).toEqual([]);
	});

	it("holds a current-month delta NOT opted-in as currentSkipped, propagating overBackstop", () => {
		// Owner B, current month, NOT in the opt-in set, and over the backstop:
		// must be surfaced (never written) with overBackstop carried through.
		const rows = [
			cell({
				ownerId: "B",
				period: "2026-06",
				current: 10,
				ledgerSum: 60,
				delta: 50,
				isCurrentMonth: true,
				overBackstopCurrentMonth: true,
			}),
		];

		const plan = planRebaseline(rows, new Set(), new Map([["B", "b@x.com"]]));

		expect(plan.closedWrites).toEqual([]);
		expect(plan.currentWrites).toEqual([]);
		expect(plan.currentSkipped).toEqual([
			{
				ownerId: "B",
				period: "2026-06",
				from: 10,
				to: 60,
				overBackstop: true,
			},
		]);
	});

	it("applies the SAME current-month delta when the owner's email is opted in", () => {
		// Identical cell to the prior test, but b@x.com is now in the opt-in set
		// (matched via emailOf): it moves from skipped to currentWrites.
		const rows = [
			cell({
				ownerId: "B",
				period: "2026-06",
				current: 10,
				ledgerSum: 60,
				delta: 50,
				isCurrentMonth: true,
				overBackstopCurrentMonth: true,
			}),
		];

		const plan = planRebaseline(
			rows,
			new Set(["b@x.com"]),
			new Map([["B", "b@x.com"]]),
		);

		expect(plan.currentWrites).toEqual([
			{ ownerId: "B", period: "2026-06", from: 10, to: 60 },
		]);
		expect(plan.currentSkipped).toEqual([]);
		expect(plan.closedWrites).toEqual([]);
	});

	it("matches an opt-in case/whitespace-insensitively (stored mixed-case email)", () => {
		// Stored email is mixed-case `Alice@X.com`; the operator's pre-normalized
		// opt-in set holds `alice@x.com`. The planner folds the resolved email the
		// same way, so this EXACT-but-differently-cased opt-in must still apply —
		// not silently fall into currentSkipped.
		const rows = [
			cell({
				ownerId: "A",
				period: "2026-06",
				current: 10,
				ledgerSum: 30,
				delta: 20,
				isCurrentMonth: true,
			}),
		];

		const plan = planRebaseline(
			rows,
			new Set(["alice@x.com"]),
			new Map([["A", "  Alice@X.com  "]]),
		);

		expect(plan.currentWrites).toEqual([
			{ ownerId: "A", period: "2026-06", from: 10, to: 30 },
		]);
		expect(plan.currentSkipped).toEqual([]);
	});

	it("NEVER opts in an unresolved-email owner — empty resolved email can't match (fail-safe)", () => {
		// Owner U is NOT in emailOf, so its resolved email folds to "". The
		// documented invariant: an owner with no resolvable email can never be
		// opted in, regardless of the opt-in set's contents. The dangerous input
		// is a STRAY "" in the set (an unset `--current-user "$VAR"`): with a naive
		// `set.has(resolved)` that would route EVERY unresolved-email current-month
		// cell into currentWrites and silently re-baseline (re-block) the user.
		const rows = [
			cell({
				ownerId: "U",
				period: "2026-06",
				current: 10,
				ledgerSum: 60,
				delta: 50,
				isCurrentMonth: true,
				overBackstopCurrentMonth: true,
			}),
		];

		// (a) Stray "" in the opt-in set: must NOT opt the unresolved owner in.
		const withEmptyEntry = planRebaseline(
			rows,
			new Set([""]),
			new Map(), // U absent → resolved email ""
		);
		expect(withEmptyEntry.currentWrites).toEqual([]);
		expect(withEmptyEntry.currentSkipped).toEqual([
			{ ownerId: "U", period: "2026-06", from: 10, to: 60, overBackstop: true },
		]);

		// (b) Empty opt-in set: same fail-safe — surfaced, never written.
		const withEmptySet = planRebaseline(rows, new Set(), new Map());
		expect(withEmptySet.currentWrites).toEqual([]);
		expect(withEmptySet.currentSkipped).toEqual([
			{ ownerId: "U", period: "2026-06", from: 10, to: 60, overBackstop: true },
		]);
	});

	it("plans nothing for a zero-delta current-month cell, even when opted in", () => {
		// Owner C, current month, opted in, but delta below the material threshold
		// (float noise) → no write of any kind.
		const rows = [
			cell({
				ownerId: "C",
				period: "2026-06",
				current: 10,
				ledgerSum: 10 + 1e-12,
				delta: 1e-12,
				isCurrentMonth: true,
			}),
		];

		const plan = planRebaseline(
			rows,
			new Set(["c@x.com"]),
			new Map([["C", "c@x.com"]]),
		);

		expect(plan.closedWrites).toEqual([]);
		expect(plan.currentWrites).toEqual([]);
		expect(plan.currentSkipped).toEqual([]);
	});
});
