/**
 * Contract: an order rule on a column hidden from Results over a property a shown column orders
 * by its raw value prints the element the shown column's own rule prints, in a list with a tile
 * layout and in one without; the reader reads that element on the shown column it lands on, and
 * the canonical choice `order-rules-on-the-columns-they-land-on` returns that document from
 * either. The failure it catches: a canonical choice that moves a rule to a column whose rule
 * prints another export, or to one the reader does not read it on.
 */
import { describe, expect, it } from "vitest";
import type { BlueprintDoc, Column } from "@/lib/domain";
import {
	columnSort,
	orderedColumns,
	phoneColumn,
	plainColumn,
} from "@/lib/domain/modules";
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

const listRules = (doc: BlueprintDoc) => {
	const config = doc.modules[doc.moduleOrder[0] as string]?.caseListConfig;
	if (config === undefined) throw new Error("The document holds no list.");
	return rules(orderedColumns(config, "list"));
};

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
