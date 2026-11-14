/**
 * Contract: an order rule on a column hidden from Results over a property a shown column orders
 * by its raw value prints the element the shown column's own rule prints, in a list with a tile
 * layout and in one without; the reader reads that element on the shown column it lands on, and
 * the canonical choice `order-rules-on-the-columns-they-land-on` returns that document from
 * either. The failure it catches: a canonical choice that moves a rule to a column whose rule
 * prints another export, or to one the reader does not read it on.
 */
import { describe, expect, it } from "vitest";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc, Column } from "@/lib/domain";
import {
	columnSort,
	idMappingColumn,
	idMappingEntry,
	orderedColumns,
	phoneColumn,
	plainColumn,
} from "@/lib/domain/modules";
import { runValidation } from "../../../validator/runner";
import { rulesOnTheColumnsTheyLandOn } from "../order";
import { patients, uuid } from "./fixtures";
import { codes, emittedApp, listOf, readLists } from "./listReading";

/** Each rule in priority order with the kind of the column it is on. */
function rules(columns: readonly Column[]): unknown[] {
	return columns
		.filter((column) => column.sort !== undefined)
		.map((column) => [
			column.kind,
			"field" in column ? column.field : undefined,
			column.sort,
		]);
}

const docList = (doc: BlueprintDoc) => {
	const config = doc.modules[doc.moduleOrder[0] as string]?.caseListConfig;
	if (config === undefined) throw new Error("The document holds no list.");
	return config;
};

const listRules = (doc: BlueprintDoc) =>
	rules(orderedColumns(docList(doc), "list"));

/** The case list as HQ's import holds it: both details and the order. */
async function exportedList(doc: BlueprintDoc): Promise<unknown> {
	const app = await emittedApp(doc);
	return app.modules.map((module) => module.case_details);
}

for (const tiled of [false, true])
	describe(`a rule on a hidden column after a shown one over its property, ${tiled ? "with" : "without"} a tile`, () => {
		const tile = (y: number) =>
			tiled
				? {
						tile: {
							x: 0,
							y,
							width: 12,
							height: 1,
							horizontalAlign: "left" as const,
							verticalAlign: "top" as const,
							fontSize: "medium" as const,
						},
					}
				: {};
		const list = tiled ? { list: { tile: {} } } : {};
		const onHidden = patients(
			[
				plainColumn(uuid(1), "notes", "Notes", tile(0)),
				phoneColumn(uuid(2), "notes", "Notes again", {
					visibleInList: false,
					sort: columnSort("desc", 0),
				}),
			],
			list,
		);
		const onShown = patients(
			[
				plainColumn(uuid(1), "notes", "Notes", {
					...tile(0),
					sort: columnSort("desc", 0),
				}),
				phoneColumn(uuid(2), "notes", "Notes again", { visibleInList: false }),
			],
			list,
		);

		it("prints the export the rule on the shown column prints", async () => {
			expect(await exportedList(onHidden)).toEqual(await exportedList(onShown));
		});

		it("reads either back with the rule on the shown column", async () => {
			for (const doc of [onHidden, onShown]) {
				const reading = await readLists(doc);
				expect(codes(reading)).toEqual([]);
				expect(rules(orderedColumns(listOf(reading), "list"))).toEqual([
					["plain", "notes", columnSort("desc", 0)],
				]);
			}
		});

		it("returns the rule on the shown column from either", () => {
			expect(listRules(rulesOnTheColumnsTheyLandOn(onHidden))).toEqual(
				listRules(onShown),
			);
			expect(rulesOnTheColumnsTheyLandOn(onShown)).toBe(onShown);
		});
	});

/**
 * Contract: a rule on an expression column prints the positional element `_cc_calculated_<n>`
 * of the column it is authored on, so a rule on a column hidden from Results after a shown
 * column over the same attribute-backed property prints another export than the rule on the
 * shown column, though HQ's build lands both on the shown one. The failure it catches: a
 * canonical choice that moves such a rule, or a reading that reads it on the column it lands
 * on, so a first publish of the reading rewrites the element's `field`.
 */
describe("a rule on a hidden expression column after a shown one over case_id", () => {
	const placed = (onHidden: boolean) =>
		patients([
			plainColumn(uuid(1), "case_name", "Name"),
			plainColumn(uuid(2), "case_id", "Record ID", {
				...(!onHidden && { sort: columnSort("asc", 0) }),
			}),
			plainColumn(uuid(3), "case_id", "Record order", {
				visibleInList: false,
				...(onHidden && { sort: columnSort("asc", 0) }),
			}),
		]);
	const onHidden = placed(true);
	const onShown = placed(false);

	it("prints the position of the column the rule is on", async () => {
		expect(await elementFields(onShown)).toEqual([["_cc_calculated_1"]]);
		expect(await elementFields(onHidden)).toEqual([["_cc_calculated_2"]]);
	});

	/** Each rule with the header of the column it is on and whether Results shows it. */
	const placement = (columns: readonly Column[]) =>
		columns
			.filter((column) => column.sort !== undefined)
			.map((column) => [
				column.header,
				column.visibleInList !== false,
				column.sort,
			]);

	it("reads each back with the rule where it is", async () => {
		expect(placement(docList(onHidden).columns)).not.toEqual(
			placement(docList(onShown).columns),
		);
		for (const doc of [onHidden, onShown]) {
			const reading = await readLists(doc);
			expect(codes(reading)).toEqual([]);
			expect(placement(orderedColumns(listOf(reading), "list"))).toEqual(
				placement(orderedColumns(docList(doc), "list")),
			);
		}
	});

	it("leaves either as it is", () => {
		expect(rulesOnTheColumnsTheyLandOn(onHidden)).toBe(onHidden);
		expect(rulesOnTheColumnsTheyLandOn(onShown)).toBe(onShown);
	});
});

/** The codes of the ownership rule's findings on a document. */
const ownershipCodes = (doc: BlueprintDoc) =>
	runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)
		.map((finding) => finding.code)
		.filter((code) => code === "CASE_LIST_SORT_PROPERTY_AMBIGUOUS");

/** The `field` of each sort element a document's export writes. */
const elementFields = async (doc: BlueprintDoc) =>
	(await emittedApp(doc)).modules.map((module) =>
		module.case_details.short.sort_elements.map((element) => element.field),
	);

/** Each rule with the header of the column it is on. */
const ruledHeaders = (columns: readonly Column[]) =>
	columns
		.filter((column) => column.sort !== undefined)
		.map((column) => [column.header, column.sort]);

/** Two shown ID mappings over `status` after a name column, the rule on the one `ruled` names. */
function statusMappings(ruled: 2 | 3, laterValues = ["open", "closed"]) {
	return patients([
		plainColumn(uuid(1), "case_name", "Name"),
		idMappingColumn(
			uuid(2),
			"status",
			"Status",
			[idMappingEntry("open", "Open"), idMappingEntry("closed", "Closed")],
			ruled === 2 ? { sort: columnSort("asc", 0) } : {},
		),
		idMappingColumn(
			uuid(3),
			"status",
			"Status again",
			laterValues.map((value) => idMappingEntry(value, value.toUpperCase())),
			ruled === 3 ? { sort: columnSort("asc", 0) } : {},
		),
	]);
}

/**
 * Contract: a rule on a shown ID mapping over an attribute-backed property, after another shown
 * ID mapping over it with the same values, prints the positional element of its own column, and
 * the ownership rule admits it there, since both order by one table; the reader reads each
 * placement back where it is and the landing row moves neither. The failure it catches: a
 * reading that reads the rule on the earlier mapping, the column it lands on, so a first publish
 * rewrites the element's `field`.
 */
describe("a rule on the later of two shown ID mappings over status with one table", () => {
	const onLater = statusMappings(3);
	const onEarlier = statusMappings(2);

	it("is admitted on either and prints the position of the column it is on", async () => {
		expect(ownershipCodes(onLater)).toEqual([]);
		expect(ownershipCodes(onEarlier)).toEqual([]);
		expect(await elementFields(onEarlier)).toEqual([["_cc_calculated_1"]]);
		expect(await elementFields(onLater)).toEqual([["_cc_calculated_2"]]);
	});

	it("reads each back with the rule where it is", async () => {
		for (const doc of [onLater, onEarlier]) {
			const reading = await readLists(doc);
			expect(codes(reading)).toEqual([]);
			expect(ruledHeaders(orderedColumns(listOf(reading), "list"))).toEqual(
				ruledHeaders(orderedColumns(docList(doc), "list")),
			);
		}
	});

	it("leaves either as it is", () => {
		expect(rulesOnTheColumnsTheyLandOn(onLater)).toBe(onLater);
		expect(rulesOnTheColumnsTheyLandOn(onEarlier)).toBe(onEarlier);
	});
});

/**
 * Contract: where the column a positional element names orders by another table than the column
 * the element lands on, which the ownership rule refuses in a Nova document, a source that stores
 * the element (an app made in HQ) is read with the rule on the column it lands on, a document the
 * rule admits. The failure it catches: a reading that puts the rule on the named column, which
 * the commit gate then refuses.
 */
describe("a positional element naming an ID mapping with another table than its landing", () => {
	const named = statusMappings(3, ["closed", "open"]);
	const landing = statusMappings(2, ["closed", "open"]);

	it("reads the rule on the column it lands on", async () => {
		expect(ownershipCodes(named)).toEqual([
			"CASE_LIST_SORT_PROPERTY_AMBIGUOUS",
		]);
		expect(ownershipCodes(landing)).toEqual([]);
		const reading = await readLists(landing, {
			edit: (app) => {
				const [element] =
					app.modules[0]?.case_details.short.sort_elements ?? [];
				if (element === undefined) throw new Error("The export holds no rule.");
				element.field = "_cc_calculated_2";
			},
		});
		expect(codes(reading)).toEqual([]);
		const read = listOf(reading);
		expect(ruledHeaders(orderedColumns(read, "list"))).toEqual([
			["Status", columnSort("asc", 0)],
		]);
	});
});
