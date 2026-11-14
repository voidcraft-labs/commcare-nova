/**
 * Contract: a case list Nova emits reads back as the columns it was emitted from. Each of the
 * column kinds, on both screens, on one, hidden from both and not on the list, goes through
 * `projectCaseListForHq` (inside `expandDoc`) and back through the reader's own stages, and the
 * read list equals the authored one with no finding. The failure it catches: an interval column
 * read as a calculated one, a select property's label column read as calculated, a column that
 * changes screens on the way back.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { Column, Uuid } from "@/lib/domain";
import { concat, prop, term } from "@/lib/domain/expression/builders";
import {
	calculatedColumn,
	dateColumn,
	idMappingColumn,
	idMappingEntry,
	imageMapColumn,
	imageMapEntry,
	intervalColumn,
	linkColumn,
	phoneColumn,
	plainColumn,
} from "@/lib/domain/modules";
import type { MediaAssetId } from "@/lib/domain/multimedia";
import { proseText } from "@/lib/domain/prose";
import { codes, comparableList, listOf, readLists } from "./listReading";

/** A standard property of the list's case type, as the reader binds it. */
const nameRead = prop("patient", "case_name");

const uuid = (n: number) =>
	`00000000-0000-4000-8000-${String(n).padStart(12, "0")}` as Uuid;

function app(columns: Column[], listOrder?: Uuid[], detailOrder?: Uuid[]) {
	return buildDoc({
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
								kind: "text",
								id: "notes",
								caseWrite: { caseType: "patient", property: "notes" },
							}),
							f({
								kind: "date",
								id: "dob",
								caseWrite: { caseType: "patient", property: "dob" },
							}),
							f({
								kind: "text",
								id: "phone",
								caseWrite: { caseType: "patient", property: "phone" },
							}),
							f({
								kind: "single_select",
								id: "risk",
								caseWrite: { caseType: "patient", property: "risk" },
								optionsSource: {
									kind: "inline",
									options: [
										{
											value: "low",
											label: proseText("Low"),
											uuid: testUuid("o-low"),
										},
										{
											value: "high",
											label: proseText("High"),
											uuid: testUuid("o-high"),
										},
									],
								},
							}),
						],
					},
				],
				caseListConfig: {
					columns,
					searchInputs: [],
					...(listOrder !== undefined && { listColumnOrder: listOrder }),
					...(detailOrder !== undefined && { detailColumnOrder: detailOrder }),
				},
			},
		],
	});
}

describe("a case list Nova emits reads back as the columns it was emitted from", () => {
	const kinds: [string, Column][] = [
		["plain", plainColumn(uuid(1), "case_name", "Name")],
		["date", dateColumn(uuid(2), "dob", "Born", "%d/%m/%Y")],
		["phone", phoneColumn(uuid(3), "phone", "Phone")],
		[
			"id-mapping",
			idMappingColumn(uuid(4), "notes", "Notes", [
				idMappingEntry("a", "Alpha"),
				idMappingEntry("b", "Beta"),
			]),
		],
		["link", linkColumn(uuid(5), "notes", "Link", "Open")],
		[
			"interval",
			intervalColumn(uuid(6), "dob", "Due", 7, "days", "flag", "Late"),
		],
		[
			"interval shown always",
			intervalColumn(uuid(8), "dob", "Age", 2, "weeks", "always", "Old"),
		],
		[
			"calculated",
			calculatedColumn(
				uuid(7),
				"Twice",
				concat(term(nameRead), term(nameRead)),
			),
		],
	];

	for (const [kind, column] of kinds)
		it(`reads a ${kind} column shown on both screens`, async () => {
			const doc = app([column]);
			const reading = await readLists(doc);
			expect(codes(reading)).toEqual([]);
			expect(comparableList(listOf(reading))).toEqual(
				comparableList(
					doc.modules[doc.moduleOrder[0] as Uuid]?.caseListConfig as never,
				),
			);
		});

	it("reads an image-map column shown on both screens", async () => {
		const icon = testUuid("asset-icon") as unknown as MediaAssetId;
		const doc = app([
			imageMapColumn(uuid(10), "notes", "Icon", [imageMapEntry("a", icon)]),
		]);
		const reading = await readLists(doc, { media: true });
		expect(codes(reading)).toEqual([]);
		expect(comparableList(listOf(reading))).toEqual(
			comparableList(
				doc.modules[doc.moduleOrder[0] as Uuid]?.caseListConfig as never,
			),
		);
	});

	it("reads a column shown on one screen, hidden from both, and not on the list", async () => {
		const columns = [
			plainColumn(uuid(1), "case_name", "Name"),
			plainColumn(uuid(2), "notes", "Notes", { visibleInDetail: false }),
			plainColumn(uuid(3), "phone", "Phone", {
				visibleInList: false,
				notOnList: true,
			}),
			plainColumn(uuid(4), "dob", "Born", { visibleInList: false }),
		];
		const doc = app(columns);
		const reading = await readLists(doc);
		expect(codes(reading)).toEqual([]);
		const read = comparableList(listOf(reading)) as {
			list: Record<string, unknown>[];
		};
		expect(
			read.list.map((column) => [
				column.field,
				column.visibleInList,
				column.visibleInDetail,
				column.notOnList,
			]),
		).toEqual([
			["case_name", undefined, undefined, undefined],
			["notes", undefined, false, undefined],
			["dob", false, undefined, undefined],
			["phone", false, undefined, true],
		]);
	});
});
