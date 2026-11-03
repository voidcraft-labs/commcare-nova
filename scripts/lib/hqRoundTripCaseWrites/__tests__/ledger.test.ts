/**
 * What every mode decides from its two first reads (step 5's part 09,
 * section 6), and which ledger the window accepts (section 11). The
 * plausible failures: a classifier that goes on over a database whose
 * horizon already landed, so a second run would write the fleet again; one
 * that calls a half-marked fleet `already-applied`, so the operator reopens
 * ingress over apps the cutover never migrated; and a pending-set check that
 * accepts a ledger the cutover was not reviewed against.
 */

import { describe, expect, it } from "vitest";
import {
	classifyApplied,
	ledgerIsReviewed,
	partiallyApplied,
	unexpectedLedger,
} from "../ledger";
import { HORIZON_MIGRATION, PENDING_MIGRATIONS } from "../types";

describe("classifyApplied", () => {
	it.each([
		{ horizonApplied: true, apps: 3, marked: 3, state: "already-applied" },
		{ horizonApplied: true, apps: 0, marked: 0, state: "already-applied" },
		{ horizonApplied: true, apps: 3, marked: 2, state: "partially-applied" },
		{ horizonApplied: true, apps: 3, marked: 0, state: "partially-applied" },
		{ horizonApplied: false, apps: 3, marked: 0, state: "go-on" },
		{ horizonApplied: false, apps: 0, marked: 0, state: "go-on" },
		{ horizonApplied: false, apps: 3, marked: 1, state: "partially-applied" },
	] as const)(
		"horizon applied $horizonApplied, $marked of $apps marked: $state",
		({ horizonApplied, apps, marked, state }) => {
			expect(classifyApplied({ horizonApplied }, { apps, marked })).toBe(state);
		},
	);

	it("names both reads in the partially-applied stop", () => {
		const error = partiallyApplied(
			{ horizonApplied: true },
			{ apps: 3, marked: 2 },
		);
		expect(error.code).toBe("partially-applied");
		expect(error.message).toContain("2 of 3 apps");
		expect(error.message).toContain(`holds ${HORIZON_MIGRATION}`);
	});
});

describe("the reviewed ledger", () => {
	it("accepts exactly the window's three pending, in order", () => {
		expect(
			ledgerIsReviewed({
				horizonApplied: false,
				pendingMigrations: [...PENDING_MIGRATIONS],
			}),
		).toBe(true);
	});

	it.each([
		{
			name: "one of the three already applied",
			pending: PENDING_MIGRATIONS.slice(1),
		},
		{
			name: "a fourth migration pending",
			pending: [...PENDING_MIGRATIONS, "20261111000000_unreviewed"],
		},
		{ name: "nothing pending", pending: [] },
	])("refuses $name", ({ pending }) => {
		expect(
			ledgerIsReviewed({ horizonApplied: false, pendingMigrations: pending }),
		).toBe(false);
	});

	it("speaks section 11's sentence", () => {
		const error = unexpectedLedger(PENDING_MIGRATIONS, []);
		expect(error.code).toBe("ledger");
		expect(error.message).toBe(
			`The migration ledger is not the one this cutover was reviewed against: it expected exactly ${PENDING_MIGRATIONS.join(", ")} to be pending and found none. The cutover stopped with nothing written and no migration applied. Compare a dry run's ledger line with main's migrations, and find out how the ledger moved before running again.`,
		);
	});
});
