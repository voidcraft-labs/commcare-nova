/**
 * The names a finding of the case list and menu readers shows a person.
 *
 * Contract: a finding's `detail.name` holds only words a person knows from
 * CommCare HQ's pages: a name they typed there, or the label HQ's own page
 * shows for a closed word (`hqPageLabels.ts`), never the stored word itself, a
 * surface key or a column HQ named for itself. A finding at a workflow word
 * carries the end-of-form menu's label, and one at a column format the
 * format menu's. The battery reads Nova's emission with one key changed as
 * HQ's pages store it, through the reader's own stages, and every case of the
 * suites that read HQ's own shapes and formats (`basicActions`,
 * `advancedActions`, `afterSubmit` and `order` hqShapes, `columns` hqFormats)
 * reads through `hqPageNames.ts::namingFromHqPages`, which holds each of
 * their findings to the same rule. The failure it
 * catches: "In CommCare HQ: previous_screen" shown to a person.
 */
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { plainColumn } from "@/lib/domain/modules";
import { patients, uuid } from "../caseList/__tests__/fixtures";
import { readLists } from "../caseList/__tests__/listReading";
import { readMenusOf } from "../menus/__tests__/menuReading";
import { manifestFindings, storedNames } from "./hqPageNames";

const M = "menus-and-case-lists/";
const F = "forms-and-case-writes/";

async function readColumnChange(change: Record<string, unknown>) {
	const reading = await readLists(
		patients([
			plainColumn(uuid(1), "case_name", "Name"),
			plainColumn(uuid(2), "notes", "Notes"),
		]),
		{
			edit: (app) => {
				for (const detail of [
					app.modules[0]?.case_details.short,
					app.modules[0]?.case_details.long,
				]) {
					const column = detail?.columns[1];
					if (column !== undefined) Object.assign(column, change);
				}
			},
			firstPassOnly: true,
		},
	);
	return reading.findings;
}

async function readSortChange(field: string) {
	const reading = await readLists(
		patients([plainColumn(uuid(1), "case_name", "Name")]),
		{
			edit: (app) => {
				const short = app.modules[0]?.case_details.short;
				if (short !== undefined)
					short.sort_elements = [
						{
							doc_type: "SortElement",
							field,
							type: "plain",
							direction: "ascending",
							blanks: "",
							display: {},
							sort_calculation: "",
						},
					];
			},
			firstPassOnly: true,
		},
	);
	return reading.findings;
}

/** A follow-up in a menu whose list chooses several cases, stored with `previous_screen`, which
 *  HQ's form settings page does not offer there. */
async function readPreviousOnSeveralCases() {
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
						],
					},
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
				caseListConfig: {
					columns: [],
					searchInputs: [],
					selection: { kind: "multiple", maximum: 10 },
				},
			},
		],
	});
	const reading = await readMenusOf(doc, (app) => {
		(app.modules[0]?.forms[1] as Record<string, unknown>).post_form_workflow =
			"previous_screen";
	});
	return reading.findings;
}

describe("a finding's name", () => {
	it("names a `previous_screen` workflow by the end-of-form menu's label", async () => {
		const findings = await readPreviousOnSeveralCases();
		const atWorkflow = findings.filter(
			(one) => one.code.startsWith(F) && one.place.kind === "form",
		);
		expect(
			atWorkflow.map((one) => (one.detail as { name?: string }).name),
		).toContain("Previous Screen");
	});

	it("never shows a stored word, a surface key or a column HQ named for itself", async () => {
		const readings = await Promise.all([
			readPreviousOnSeveralCases(),
			...[
				{ format: "audio" },
				{ format: "graph" },
				{ format: "time-ago", time_ago_interval: 14 },
				{ format: "address" },
				{ format: "distance" },
				{ format: "picture" },
				{ format: "markdown" },
				{ format: "geo-points" },
				{ format: "invisible" },
				{ format: "date", date_format: "%Q" },
				{ model: "product" },
				{ field: "parent/notes" },
				{ field: "#owner_name" },
				{ field: "#notes" },
				{ field: `n${"o".repeat(255)}` },
				{
					field: "_cc_calculated_3",
					useXpathExpression: true,
					format: "late-flag",
					late_flag: 1,
				},
			].map(readColumnChange),
			readSortChange("_cc_calculated_7"),
			readSortChange("notes"),
		]);
		const findings = readings.flatMap(manifestFindings);
		expect(findings.length).toBeGreaterThan(10);
		expect(storedNames(findings)).toEqual([]);
	});

	it("tells a stored word, a surface key and a column HQ named for itself from a name typed in HQ", () => {
		const at = (name: string) => ({
			code: `${M}owner-name`,
			detail: { name },
		});
		const names = [
			"previous_screen",
			"late-flag",
			"schema:Detail.filter",
			"_cc_calculated_2",
			"Previous Screen",
			"notes",
		].map(at);
		expect(storedNames(names as never)).toEqual([
			`${M}owner-name: previous_screen`,
			`${M}owner-name: late-flag`,
			`${M}owner-name: schema:Detail.filter`,
			`${M}owner-name: _cc_calculated_2`,
		]);
	});

	it("names a column over a property Nova's grammar cannot hold by its own entry", async () => {
		const hashed = await readColumnChange({ field: "#notes" });
		expect(hashed.map((one) => one.code)).toContain(
			`${M}column-reading-an-unknown-hash-property`,
		);
		const long = await readColumnChange({ field: `n${"o".repeat(255)}` });
		expect(long).toEqual([]);
		const nearOwner = await readColumnChange({ field: "#owner_names" });
		expect(nearOwner.map((one) => one.code)).toContain(
			`${M}column-reading-an-unknown-hash-property`,
		);
		expect(nearOwner.map((one) => one.code)).not.toContain(`${M}owner-name`);
		const failing = await readColumnChange({ field: "no tes" });
		expect(failing.map((one) => one.code)).toContain(
			`${M}field-failing-details-utils-js-isvalidpropertyname-non`,
		);
	});
});
