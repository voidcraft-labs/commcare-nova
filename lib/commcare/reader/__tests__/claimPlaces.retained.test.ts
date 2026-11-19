/**
 * Where a reading of an app CommCare HQ made records its claims of the app's
 * JSON: each claim at the place its key's value sits and under an entry that
 * names that key, which is where the lane's parity joins the claim log to its
 * own uses (`proof/checks/parity.py::join`, `manifest_usage.py::app_json_uses`,
 * which names each key of each of HQ's objects at its own pointer).
 *
 * Contract, read over retained bases (`proof/hq-apps/<base>/`) through the
 * lane's own first reading (`proof/reader/laneReading.ts::readForLane`): the
 * app's class at its root; each key inside a value a claim takes whole (a
 * build spec, a media map's items, the reference details HQ never builds, a
 * hidden case list menu item, a blank Register action, an inactive case
 * action and its condition, an `if` condition's answer) at its own pointer
 * under the claim's entry; a key `CaseSearch` does not declare under its
 * undeclared-key item, and an inactive search's declared key under its own;
 * a language the app does not hold, and a media reference with no file, at
 * the key whose value their entry names; a display condition's `#case` as
 * HQ's shorthand; and a link's carried value under its datum's entry.
 *
 * Plausible failure: a container claimed whole while each key inside is its
 * own surface key (the lane's use there unclaimed), a claim recorded at a
 * container under the key of a value inside it, or at a slot under the key
 * of the map that lacks it (a record the lane never extracted there), and a
 * claim under an entry that does not name the key it reads.
 */

import { describe, expect, it } from "vitest";
import { laneInputOf, retainedBase } from "@/__tests__/helpers/retainedHqApps";
import { readForLane } from "@/proof/reader/laneReading";

/** A base's reading covers acceptance of the whole app; a starter app is the largest. */
const READING_MS = 180_000;

interface Record {
	readonly artifact: string;
	readonly where: string;
	readonly key: string | null;
	readonly entry: string;
}

async function appRecords(id: string): Promise<readonly Record[]> {
	const reading = await readForLane(laneInputOf(retainedBase(id)));
	if (reading.kind !== "read")
		throw new Error(
			`The base ${id} reads as ${reading.kind}, and it comes in.`,
		);
	return reading.claims
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as Record)
		.filter((record) => record.artifact === "app.json");
}

/** The records at `where`, as `key entry` lines. */
function at(records: readonly Record[], where: string): string[] {
	return records
		.filter((record) => record.where === where)
		.map((record) => `${record.key} ${record.entry}`);
}

const M = "menus-and-case-lists";
const F = "forms-and-case-writes";

describe("a starter app's claims of its JSON", () => {
	it(
		"stand at each key's own pointer, under an entry naming the key",
		async () => {
			const records = await appRecords("starter-agriculture");
			expect(at(records, "")).toContain(
				"schema:Application application-and-settings/doc-type-application",
			);
			expect(at(records, "/build_spec/version")).toEqual([
				"schema:BuildSpec.version application-and-settings/34-hq-build-spec-at-or-above-nova-s-floor-2-57",
			]);
			expect(at(records, "/modules/0/ref_details/short")).toEqual([
				`schema:DetailPair.short ${M}/module-ref-details`,
			]);
			expect(at(records, "/modules/0/ref_details/short/display")).toEqual([
				`schema:Detail.display ${M}/module-ref-details`,
			]);
			expect(
				at(records, "/modules/0/ref_details/short/custom_variables"),
			).toEqual([`schema:Detail.<undeclared> ${M}/module-ref-details`]);
			expect(at(records, "/modules/0/case_list_form")).toEqual([
				`schema:Module.case_list_form ${M}/case-list-form-fields-beside-a-blank-form-id`,
			]);
			expect(at(records, "/modules/0/case_list_form/label")).toEqual([
				`schema:CaseListForm.label ${M}/case-list-form-fields-beside-a-blank-form-id`,
			]);
			expect(at(records, "/modules/0/search_config/search_label")).toEqual([
				"schema:CaseSearch.<undeclared> case-search/removed-keys-dynamic-search-additional-relevant-search-filter",
			]);
			expect(at(records, "/modules/1/forms/0/actions/close_case")).toEqual([
				`schema:FormActions.close_case ${F}/form-requires-case-no-close`,
			]);
			expect(at(records, "/translations")).toContain(
				"schema:Application.translations application-and-settings/translations-key-no-runtime-reads",
			);
			expect(at(records, "/translations/fra")).toEqual([]);
		},
		READING_MS,
	);

	it(
		"stand inside a hidden case list menu item, at its label, and at a condition's answer HQ reads past",
		async () => {
			const records = await appRecords("starter-wash");
			expect(at(records, "/modules/3/case_list")).toEqual([
				`schema:Module.case_list ${M}/module-case-list-label-or-media-beside-show-false`,
			]);
			expect(at(records, "/modules/3/case_list/label")).toEqual([
				`schema:CaseList.label ${M}/module-case-list-label-or-media-beside-show-false`,
			]);
			expect(
				at(records, "/modules/3/forms/0/actions/close_case/condition/answer"),
			).toEqual([
				`schema:FormActionCondition.answer ${F}/close-case-condition-if-operator-boolean-true-on-a-requires-case`,
			]);
		},
		READING_MS,
	);
});

describe("an app's expression and media claims", () => {
	it(
		"read a display condition's `#case` as HQ's shorthand, and a carried value under its datum's entry",
		async () => {
			const records = await appRecords("hq-menus");
			expect(
				at(records, "/modules/1/forms/0/form_filter").filter((line) =>
					line.startsWith("hashtag:"),
				),
			).toEqual([
				"hashtag:#case expressions-and-data/case-prop-case-parent-prop-case-grandparent-prop",
			]);
			expect(
				at(records, "/modules/1/forms/0/form_links/0/datums/0/xpath").filter(
					(line) => line.startsWith("schema:"),
				),
			).toEqual([
				`schema:FormDatum.xpath ${F}/form-links-datums-on-a-form-target-names-among-the-target-s`,
			]);
		},
		READING_MS,
	);

	it(
		"stand an inactive search's declared key at its own item",
		async () => {
			const records = await appRecords("hq-nova-then-builder");
			expect(at(records, "/modules/0/search_config/description")).toEqual([
				"schema:CaseSearch.description case-search/the-generated-search-round-trip-remote-request-query-results",
			]);
		},
		READING_MS,
	);

	it(
		"stand a media reference with no file at the media map, never at its slot",
		async () => {
			const records = await appRecords("hq-media");
			expect(at(records, "/multimedia_map")).toContain(
				"schema:Application.multimedia_map expressions-and-data/a-media-reference-on-a-slot-nova-holds-with-no-multimedia-map",
			);
			expect(
				records.filter(
					(record) =>
						record.key === "schema:Application.multimedia_map" &&
						record.where !== "/multimedia_map",
				),
			).toEqual([]);
		},
		READING_MS,
	);
});
