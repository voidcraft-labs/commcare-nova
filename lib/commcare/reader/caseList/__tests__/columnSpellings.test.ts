/**
 * Two column spellings CommCare HQ stores that the reader names by their own
 * entries.
 *
 * Contract: an indicator column of HQ's call-center set, which HQ names
 * `call-center` (`callcenter/indicator_sets.py::CallCenterIndicators.name`,
 * the set before `/` in `detail_screen.py`'s indicator field), reads as that
 * set's entry, and another set's as the other sets' entry; a date column
 * holding an empty pattern, which HQ's column editor can store and Nova holds
 * no date column with (`lib/domain/modules.ts`, a pattern of at least one
 * character), reads as the date format entry, one finding with no reader
 * defect.
 *
 * The plausible failures: the call-center set read under the other sets'
 * entry for a spelling HQ never uses, and an empty pattern held into a
 * document Nova's writer cannot write.
 */
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	type AppJson,
	codesOf,
	readMenusOf,
} from "../../menus/__tests__/menuReading";

const M = "menus-and-case-lists";

const doc = () =>
	buildDoc({
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [
							f({
								kind: "text",
								id: "notes",
								caseWrite: { caseType: "patient", property: "notes" },
							}),
						],
					},
				],
			},
		],
	});

/** The first menu's case list with `column` after its own. */
function withColumn(app: AppJson, column: Record<string, unknown>): void {
	const details = app.modules[0].case_details as Record<
		string,
		{ columns: Record<string, unknown>[] }
	>;
	const [first] = details.short.columns;
	details.short.columns.push({ ...first, ...column });
}

describe("an indicator column", () => {
	it("of HQ's call-center set reads as that set's entry, and another set's as the other sets'", async () => {
		const callCenter = await readMenusOf(doc(), (app) =>
			withColumn(app, { field: "indicator:call-center/forms_submitted" }),
		);
		expect(codesOf(callCenter)).toContain(`${M}/indicator-call-center-name`);
		const other = await readMenusOf(doc(), (app) =>
			withColumn(app, { field: "indicator:visits/forms_submitted" }),
		);
		expect(codesOf(other)).not.toContain(`${M}/indicator-call-center-name`);
	});
});

describe("a date column", () => {
	it("holding an empty pattern reads as the date format entry, with no reader defect", async () => {
		const empty = await readMenusOf(doc(), (app) =>
			withColumn(app, { field: "dob", format: "date", date_format: "" }),
		);
		expect(codesOf(empty)).toContain(`${M}/2p-date-any-other-date-format`);
		expect(codesOf(empty)).not.toContain(
			"unrecognized:schema:Application.modules",
		);
		expect(empty.outcome.defects).toEqual([]);
		const held = await readMenusOf(doc(), (app) =>
			withColumn(app, {
				field: "dob",
				format: "date",
				date_format: "%d/%m/%y",
			}),
		);
		expect(codesOf(held)).not.toContain(`${M}/2p-date-any-other-date-format`);
	});
});
