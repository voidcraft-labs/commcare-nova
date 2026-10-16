import { describe, expect, it } from "vitest";
import { testMediaAssetId, testUuid } from "@/__tests__/helpers/uuid";
import {
	type Column,
	type ColumnCommonSlots,
	calculatedColumn,
	idMappingColumn,
	idMappingEntry,
	imageMapColumn,
	imageMapEntry,
	plainColumn,
} from "@/lib/domain";
import { prop, term } from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";
import {
	admittedCaseListDoc,
	findings,
	withColumns,
} from "./caseListRuleFixture";

const caseTypes = [
	{
		name: "patient",
		properties: [
			{ name: "rank", label: proseText("Rank"), data_type: "text" as const },
			{ name: "zone", label: proseText("Zone"), data_type: "text" as const },
			{ name: "code", label: proseText("Code"), data_type: "text" as const },
		],
	},
];

const first: ColumnCommonSlots = { sort: { direction: "asc", priority: 0 } };
const second: ColumnCommonSlots = { sort: { direction: "asc", priority: 1 } };
const hiddenSecond: ColumnCommonSlots = { ...second, visibleInList: false };

function ownershipFindings(columns: Column[]) {
	return findings(
		withColumns(admittedCaseListDoc({ caseTypes }), columns),
	).filter((finding) => finding.code === "CASE_LIST_SORT_PROPERTY_AMBIGUOUS");
}

const zoneMapping = (slots: ColumnCommonSlots = {}) =>
	idMappingColumn(
		testUuid("zone-map"),
		"zone",
		"Zone name",
		[idMappingEntry("2", "North"), idMappingEntry("10", "South")],
		slots,
	);

describe("sort property ownership", () => {
	describe("two order rules over one value", () => {
		it("refuses the later of two rules over one property name", () => {
			const shown = plainColumn(testUuid("rank"), "rank", "Rank", first);
			const hidden = plainColumn(
				testUuid("rank-hidden"),
				"rank",
				"Rank again",
				hiddenSecond,
			);
			const result = ownershipFindings([shown, hidden]);
			expect(result).toHaveLength(1);
			expect(result[0]).toMatchObject({
				location: { moduleName: "Patients" },
				details: {
					slot: "caseListConfig.columns[1].sort",
					columnIndex: "1",
					columnUuid: hidden.uuid,
					shape: "same-value",
					otherUuid: shown.uuid,
					otherLabel: "Rank",
				},
			});
			expect(result[0].message).toBe(
				'Module "Patients" has two order rules over one value, on "Rank" (column #1) and on "Rank again" (column #2). CommCare keeps one order rule for each value, so only one of them would order the list. Remove the sort from one of the two columns.',
			);
		});

		it("refuses two rules over one case attribute", () => {
			const shown = plainColumn(testUuid("owner"), "owner_id", "Owner", first);
			const hidden = plainColumn(
				testUuid("owner-hidden"),
				"owner_id",
				"",
				hiddenSecond,
			);
			expect(
				ownershipFindings([shown, hidden]).map((finding) => finding.details),
			).toEqual([
				expect.objectContaining({
					columnUuid: hidden.uuid,
					shape: "same-value",
					otherLabel: "Owner",
				}),
			]);
		});

		it("refuses two calculated columns with one expression", () => {
			const score = calculatedColumn(
				testUuid("score"),
				"",
				term(prop("patient", "rank")),
				first,
			);
			const copy = calculatedColumn(
				testUuid("score-copy"),
				"Score copy",
				term(prop("patient", "rank")),
				second,
			);
			expect(
				ownershipFindings([score, copy]).map((finding) => finding.details),
			).toEqual([
				expect.objectContaining({
					columnUuid: copy.uuid,
					shape: "same-value",
					otherUuid: score.uuid,
					otherLabel: "a calculation",
				}),
			]);
		});
	});

	describe("a rule an earlier column with another key would take", () => {
		it("refuses a plain column's rule after an ID mapping over its property", () => {
			const mapping = zoneMapping();
			const plain = plainColumn(testUuid("zone"), "zone", "Zone", first);
			const result = ownershipFindings([mapping, plain]);
			expect(result).toHaveLength(1);
			expect(result[0]).toMatchObject({
				details: {
					slot: "caseListConfig.columns[1].sort",
					columnIndex: "1",
					columnUuid: plain.uuid,
					shape: "first-column-differs",
					firstUuid: mapping.uuid,
					firstLabel: "Zone name",
				},
			});
			expect(result[0].message).toBe(
				'The order rule on "Zone" (column #2) in module "Patients" would go to "Zone name" (column #1): CommCare gives an order rule to the first column with the same value, and that column orders differently. Put the sort on "Zone name" (column #1), or move "Zone" (column #2) ahead of it in the Results order.',
			);
		});

		it("refuses an ID mapping's rule after a plain column over its property", () => {
			const plain = plainColumn(testUuid("zone"), "zone", "Zone");
			const mapping = zoneMapping(first);
			expect(
				ownershipFindings([plain, mapping]).map((finding) => finding.details),
			).toEqual([
				expect.objectContaining({
					columnUuid: mapping.uuid,
					shape: "first-column-differs",
					firstUuid: plain.uuid,
				}),
			]);
		});

		it("refuses a plain status column's rule after an ID mapping over status", () => {
			const mapping = idMappingColumn(
				testUuid("status-map"),
				"status",
				"State",
				[idMappingEntry("open", "Open")],
			);
			const plain = plainColumn(testUuid("status"), "status", "Status", first);
			expect(
				ownershipFindings([mapping, plain]).map((finding) => finding.details),
			).toEqual([
				expect.objectContaining({
					columnUuid: plain.uuid,
					shape: "first-column-differs",
					firstUuid: mapping.uuid,
				}),
			]);
		});

		it("refuses a hidden column's rule after an image map over its property", () => {
			const image = imageMapColumn(testUuid("code-image"), "code", "Code", [
				imageMapEntry("alpha", testMediaAssetId("alpha")),
				imageMapEntry("bravo", testMediaAssetId("bravo")),
			]);
			const hidden = plainColumn(testUuid("code"), "code", "Code value", {
				...first,
				visibleInList: false,
			});
			expect(
				ownershipFindings([image, hidden]).map((finding) => finding.details),
			).toEqual([
				expect.objectContaining({
					columnUuid: hidden.uuid,
					shape: "first-column-differs",
					firstUuid: image.uuid,
				}),
			]);
		});

		it("refuses a property rule that lands on a calculated column printing that property", () => {
			const calculated = calculatedColumn(
				testUuid("zone-calc"),
				"Zone copy",
				term(prop("patient", "zone")),
			);
			const hidden = plainColumn(testUuid("zone"), "zone", "Zone", {
				...first,
				visibleInList: false,
			});
			expect(
				ownershipFindings([calculated, hidden]).map(
					(finding) => finding.details,
				),
			).toEqual([
				expect.objectContaining({
					columnUuid: hidden.uuid,
					shape: "first-column-differs",
					firstUuid: calculated.uuid,
					firstLabel: "Zone copy",
				}),
			]);
		});
	});

	describe("joins that keep the authored key", () => {
		it("accepts a hidden order carrier after a shown column over one property", () => {
			expect(
				ownershipFindings([
					plainColumn(testUuid("code-shown"), "code", "Code"),
					plainColumn(testUuid("code-hidden"), "code", "Code", {
						...first,
						visibleInList: false,
					}),
				]),
			).toEqual([]);
		});

		it("accepts a hidden case_id rule after a shown case_id column", () => {
			expect(
				ownershipFindings([
					plainColumn(testUuid("record-shown"), "case_id", "Record"),
					plainColumn(testUuid("record-hidden"), "case_id", "Record", {
						...first,
						visibleInList: false,
					}),
				]),
			).toEqual([]);
		});

		it("accepts an ID mapping's own rule before a plain column over its property", () => {
			expect(
				ownershipFindings([
					zoneMapping(first),
					plainColumn(testUuid("zone"), "zone", "Zone"),
				]),
			).toEqual([]);
		});
	});
});
