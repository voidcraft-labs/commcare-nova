/**
 * The one rule both bring-in surfaces keep a table's answer by when a review
 * comes back: only over the very entry it was given against. The plausible
 * failure is an answer kept by its tag alone, which arrives pre-selected over
 * consequences the person never answered (another app reading the table,
 * other columns going empty), or an entry compared by key order.
 */

import { describe, expect, it } from "vitest";
import { lookupTableIdSchema } from "@/lib/domain/lookupIds";
import { keptTableChoices, type ReviewTable } from "../reviewTypes";

const offered = { offered: true as const, goneColumns: [], retypedColumns: [] };

function entry(overrides: Partial<ReviewTable> = {}): ReviewTable {
	return {
		tag: "districts",
		standing: "choice",
		hqDigest: "d".repeat(64),
		projectTable: {
			tableId: lookupTableIdSchema.parse(
				"019a7f3c-2b1d-7e40-8a9b-0c1d2e3f4a5b",
			),
			definitionRevision: "4",
			rowsRevision: "5",
		},
		choice: {
			differs: ["rows"],
			apps: [{ appId: "visits", appName: "Visits", deleted: false }],
			options: { "use-commcare-hq": offered, "use-project": offered },
		},
		...overrides,
	};
}

describe("keptTableChoices", () => {
	it("keeps an answer over the same entry, whatever the order of its keys", () => {
		const before = entry();
		const choice = before.choice as NonNullable<ReviewTable["choice"]>;
		/* The same entry, every key written in another order. */
		const now: ReviewTable = {
			choice: {
				options: {
					"use-project": offered,
					"use-commcare-hq": offered,
				},
				apps: choice.apps,
				differs: choice.differs,
			},
			projectTable: before.projectTable,
			hqDigest: before.hqDigest,
			standing: "choice",
			tag: "districts",
		};
		expect(
			keptTableChoices([before], [now], { districts: "use-commcare-hq" }),
		).toEqual({ choices: { districts: "use-commcare-hq" }, dropped: false });
	});

	it.each<[string, ReviewTable]>([
		[
			"an app now reads the table",
			entry({
				choice: {
					...(entry().choice as NonNullable<ReviewTable["choice"]>),
					apps: [
						{ appId: "visits", appName: "Visits", deleted: false },
						{ appId: "stock", appName: "Stock counts", deleted: false },
					],
				},
			}),
		],
		["CommCare HQ's table moved", entry({ hqDigest: "e".repeat(64) })],
		[
			"the Project table's rows moved",
			entry({
				projectTable: {
					...(entry().projectTable as NonNullable<ReviewTable["projectTable"]>),
					rowsRevision: "6",
				},
			}),
		],
		[
			"another column would go empty",
			entry({
				choice: {
					...(entry().choice as NonNullable<ReviewTable["choice"]>),
					options: {
						"use-commcare-hq": {
							offered: true,
							goneColumns: ["Population"],
							retypedColumns: [],
						},
						"use-project": offered,
					},
				},
			}),
		],
	])("asks again where %s", (_, now) => {
		expect(
			keptTableChoices([entry()], [now], { districts: "use-commcare-hq" }),
		).toEqual({ choices: {}, dropped: true });
	});

	it("drops an answer no longer offered, one for a table gone from the review, and one given against no entry", () => {
		const refused = entry({
			choice: {
				...(entry().choice as NonNullable<ReviewTable["choice"]>),
				options: {
					"use-commcare-hq": {
						offered: false,
						why: "needs-admin",
						name: null,
					},
					"use-project": offered,
				},
			},
		});
		expect(
			keptTableChoices([refused], [refused], {
				districts: "use-commcare-hq",
			}),
		).toEqual({ choices: {}, dropped: true });
		expect(
			keptTableChoices([entry()], [], { districts: "use-project" }),
		).toEqual({ choices: {}, dropped: true });
		expect(
			keptTableChoices([], [entry()], { districts: "use-project" }),
		).toEqual({ choices: {}, dropped: true });
	});
});
