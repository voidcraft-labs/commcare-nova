/**
 * Contract: the plan of the read columns writes the stored `sort_elements`, so every order rule
 * Nova emits reads back on its column, with blanks stored only where they are not the direction's
 * own, and a list Nova writes as the source holds it records no first-publish rewrite. The failure
 * it catches: a rule joined to the second column of one text; blanks stored where they are the
 * direction's own; a rewrite declared for a list the first publish writes unchanged.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	hasSort,
	suiteDocArbitrary,
} from "@/lib/commcare/__tests__/suiteDocArbitrary";
import type { BlueprintDoc, Column } from "@/lib/domain";
import { moduleCaseTypeForActions } from "@/lib/domain/basicCaseSlots";
import { now } from "@/lib/domain/expression/builders";
import {
	columnSort,
	dateColumn,
	orderedColumns,
	plainColumn,
	type SortBlanks,
	type SortDirection,
} from "@/lib/domain/modules";
import { patients, uuid } from "./fixtures";
import { codes, comparableList, listOf, readLists } from "./listReading";

describe("order rules read back on their columns", () => {
	const cases: [SortDirection, SortBlanks | undefined][] = [
		["asc", undefined],
		["asc", "first"],
		["desc", undefined],
		["desc", "last"],
	];
	for (const [direction, blanks] of cases)
		it(`reads ${direction} with blanks ${blanks ?? "the direction's own"}`, async () => {
			const columns = [
				plainColumn(uuid(1), "case_name", "Name"),
				dateColumn(uuid(2), "dob", "Born", "%d/%m/%Y", {
					sort: columnSort(direction, 0, blanks),
				}),
				plainColumn(uuid(3), "notes", "Notes", { sort: columnSort("asc", 1) }),
			];
			const reading = await readLists(patients(columns));
			expect(codes(reading)).toEqual([]);
			const read = comparableList(listOf(reading)) as {
				list: { field: string; sort?: unknown }[];
			};
			expect(read.list.map((column) => [column.field, column.sort])).toEqual([
				["case_name", undefined],
				["dob", columnSort(direction, 0, blanks)],
				["notes", columnSort("asc", 1)],
			]);
			expect(
				reading.ctx.facts.sameStateRewrites.filter((one) =>
					one.entry.startsWith("menus-and-case-lists/"),
				),
			).toEqual([]);
		});

	it("reads a rule on the first of two columns over one property", async () => {
		const columns = [
			plainColumn(uuid(1), "notes", "Notes", { sort: columnSort("desc", 0) }),
			plainColumn(uuid(2), "notes", "Notes again"),
		];
		const reading = await readLists(patients(columns));
		expect(codes(reading)).toEqual([]);
		const read = comparableList(listOf(reading)) as {
			list: { header: string; sort?: unknown }[];
		};
		expect(read.list.map((column) => column.sort)).toEqual([
			columnSort("desc", 0),
			undefined,
		]);
	});
});

/** Each rule of a list in priority order, with the column it lands on. */
function rules(columns: readonly Column[]): unknown[] {
	return columns
		.filter((column) => column.sort !== undefined)
		.sort((a, b) => (a.sort?.priority ?? 0) - (b.sort?.priority ?? 0))
		.map((column) => [
			column.kind,
			"field" in column ? column.field : undefined,
			column.sort?.direction,
			column.sort?.blanks,
		]);
}

describe("the order rules of generated case lists", () => {
	it("read back on their columns wherever the list reads", {
		// Each run is one expansion and one reading through the stages; 25 runs took a few seconds.
		timeout: 60_000,
	}, async () => {
		// A document the reader cannot hold whole reads to an account, whose list is no reading of
		// the source; the property holds over every document it reads.
		let compared = 0;
		await fc.assert(
			fc.asyncProperty(
				suiteDocArbitrary.filter(hasSort),
				async (doc: BlueprintDoc) => {
					const reading = await readLists(doc, { media: true });
					if (reading.findings.length > 0) return;
					doc.moduleOrder.forEach((moduleUuid, menu) => {
						// A menu with no case list of its own is written with HQ's one Name column.
						const config = doc.modules[moduleUuid]?.caseListConfig;
						if (
							config === undefined ||
							moduleCaseTypeForActions(doc, moduleUuid) === ""
						)
							return;
						compared += 1;
						const read = listOf(reading, menu);
						expect(rules(orderedColumns(read, "list"))).toEqual(
							rules(orderedColumns(config, "list")),
						);
					});
				},
			),
			{ numRuns: 25, seed: 7 },
		);
		expect(compared).toBeGreaterThan(0);
	});

	it("reads a rule over a date-and-time property as the rule on its column, with no record", async () => {
		const doc = buildDoc({
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [
						{
							name: "Register",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "name",
									caseWrite: { caseType: "patient", property: "case_name" },
								}),
								f({
									kind: "hidden",
									id: "seen",
									calculate: now(),
									caseWrite: { caseType: "patient", property: "seen" },
								}),
							],
						},
					],
					caseListConfig: {
						columns: [
							plainColumn(uuid(1), "case_name", "Name"),
							plainColumn(uuid(2), "seen", "Seen", {
								sort: columnSort("desc", 0),
							}),
						],
						searchInputs: [],
					},
				},
			],
		});
		const reading = await readLists(doc);
		expect(codes(reading)).toEqual([]);
		const read = comparableList(listOf(reading)) as {
			list: { field: string; sort?: unknown }[];
		};
		expect(read.list.map((column) => [column.field, column.sort])).toEqual([
			["case_name", undefined],
			["seen", columnSort("desc", 0)],
		]);
		expect(
			reading.ctx.facts.sameStateRewrites.filter((one) =>
				one.entry.startsWith("menus-and-case-lists/"),
			),
		).toEqual([]);
	});
});
