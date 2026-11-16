/**
 * Contract: a menu with Search fields searches with Nova's own settings whether it holds a
 * settings object that sets nothing or none, so the two print one export; the reader returns no
 * settings object, and the canonical choice `empty-search-settings-beside-fields-are-absent`
 * returns the other member so. A settings object that sets something, and one on a menu with no
 * Search field (a search with nothing to fill in), are kept. The search button's label as CommCare
 * HQ stores it by default reads as Nova's own.
 *
 * The failures it catches, each a different document with no finding: a settings object read
 * where the document holds none; a row that drops a settings object a runtime reads.
 */
import { describe, expect, it } from "vitest";
import type { BlueprintDoc, SearchInputDef } from "@/lib/domain";
import {
	CASE_SEARCH_BUTTON_LABEL,
	type CaseSearchConfig,
	plainColumn,
	simpleSearchInputDef,
} from "@/lib/domain/modules";
import { expandDoc } from "../../../expander";
import { withCandidate } from "../../candidate";
import { patients, uuid } from "../../caseList/__tests__/fixtures";
import {
	closedCodes,
	readLists,
	searchOf,
} from "../../caseList/__tests__/listReading";
import { emptySearchSettingsBesideFieldsAreAbsent } from "../settings";

const FIELD: SearchInputDef = simpleSearchInputDef(
	uuid(9),
	"name",
	"Name",
	"text",
	"case_name",
);

function menu(
	search: CaseSearchConfig | undefined,
	inputs: SearchInputDef[] = [FIELD],
): BlueprintDoc {
	return patients([plainColumn(uuid(1), "case_name", "Name")], {
		searchInputs: inputs,
		...(search !== undefined && { search }),
	});
}

const configOf = (doc: BlueprintDoc) =>
	doc.modules[doc.moduleOrder[0] ?? ""]?.caseSearchConfig;

describe("a search with fields and no setting", () => {
	it("prints one export with an empty settings object and with none", () => {
		const empty = menu({});
		const none = withCandidate(empty, (draft) => {
			const module = draft.modules[draft.moduleOrder[0] ?? ""];
			if (module !== undefined) delete module.caseSearchConfig;
		});
		expect(configOf(none)).toBeUndefined();
		expect(JSON.stringify(expandDoc(empty))).toBe(
			JSON.stringify(expandDoc(none)),
		);
	});

	it("is returned with no settings object, and the row keeps every other search", () => {
		const empty = menu({});
		const chosen = emptySearchSettingsBesideFieldsAreAbsent(empty);
		expect(configOf(chosen)).toBeUndefined();
		expect(JSON.stringify(expandDoc(chosen))).toBe(
			JSON.stringify(expandDoc(empty)),
		);
		for (const kept of [
			menu(undefined),
			menu({ workflow: "skipToResults" }),
			menu({}, []),
		])
			expect(emptySearchSettingsBesideFieldsAreAbsent(kept)).toBe(kept);
	});

	for (const [name, search] of [
		["an empty settings object", {}],
		["none", undefined],
	] as const)
		it(`reads back with no settings object from ${name}`, async () => {
			const reading = await readLists(menu(search));
			expect(closedCodes(reading)).toEqual([]);
			expect(searchOf(reading)).toBeUndefined();
		});

	it("keeps a settings object that sets something, and one with no field", async () => {
		const set = await readLists(menu({ workflow: "skipToResults" }));
		expect(searchOf(set)).toEqual({ workflow: "skipToResults" });
		const bare = await readLists(menu({}, []));
		expect(closedCodes(bare)).toEqual([]);
		expect(searchOf(bare)).toEqual({});
	});
});

it("reads the search button's label CommCare HQ stores by default as Nova's own", async () => {
	const reading = await readLists(menu(undefined), {
		edit: (app) => {
			const config = app.modules[0]?.search_config;
			if (config !== undefined)
				config.search_button_label = { en: CASE_SEARCH_BUTTON_LABEL };
		},
	});
	// The label is HQ's model default, at which a claim records nothing
	// (`jsonCursor.ts`): what is held is that it raises no finding.
	expect(reading.app.modules[0]?.search_config.search_button_label).toEqual({
		en: CASE_SEARCH_BUTTON_LABEL,
	});
	expect(closedCodes(reading)).toEqual([]);
	expect(reading.ctx.close().findings).toEqual([]);
	expect(searchOf(reading)).toBeUndefined();
});
