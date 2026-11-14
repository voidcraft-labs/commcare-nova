/**
 * The appearance table held to the manifest's section "Appearances": every
 * entry of the section is read by a rule of `appearances.ts` (a refused-class
 * port, a row, or rule 4), every row's entry is in that section or is a kind
 * row of the field kind table, and no row's entry is HELD, since every row is
 * claimed with `account`, which a HELD entry does not permit. It would catch
 * an entry no rule reaches, a row under an entry another section holds, and a
 * row whose entry became HELD while no code reads its value.
 */

import { describe, expect, it } from "vitest";
import questions from "../../../surface/entries/questions.json";
import { inventoryIndex } from "../../../surface/inventory";
import { APPEARANCE_ROWS, APPEARANCE_RULE_ENTRIES } from "../appearances";
import { FIELD_KIND_ROWS } from "../kinds";

const SECTION = (questions as readonly { id: string; section: string }[])
	.filter((entry) => entry.section === "Appearances")
	.map((entry) => entry.id);

describe("APPEARANCE_ROWS", () => {
	it("reads every entry of the section Appearances by a rule", () => {
		const named = new Set(APPEARANCE_RULE_ENTRIES);
		expect(
			SECTION.filter((entry) => !named.has(entry)).map(
				(entry) =>
					`The appearance entry ${entry} is named by no rule of lib/commcare/reader/xform/appearances.ts. Give it a row of APPEARANCE_ROWS, or the refused-class port that reads it.`,
			),
		).toEqual([]);
	});

	it("names only entries of that section or of the field kind table", () => {
		const allowed = new Set([
			...SECTION,
			...FIELD_KIND_ROWS.map((row) => row.claim.entry),
		]);
		expect(
			APPEARANCE_RULE_ENTRIES.filter((entry) => !allowed.has(entry)),
		).toEqual([]);
	});

	it("holds no row under a HELD entry", () => {
		const index = inventoryIndex();
		expect(
			APPEARANCE_ROWS.filter(
				(row) => index.entry(row.claim.entry)?.standing === "held",
			).map((row) => row.claim.entry),
		).toEqual([]);
		for (const row of APPEARANCE_ROWS) expect(row.claim.use).toBe("account");
	});
});
