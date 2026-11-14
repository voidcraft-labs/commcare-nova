/**
 * The names a finding of the case list and menu readers shows a person.
 *
 * Contract: a finding's `detail.name` holds only words a person knows from
 * CommCare HQ's pages: a name they typed there, or the label HQ's own page
 * shows for a closed word (`HQ_PAGE_LABELS`), never the stored word itself, a
 * surface key or a column HQ named for itself. A finding at a workflow word
 * carries the end-of-form menu's label, and one at a column format the
 * format menu's. The battery reads Nova's emission with one key changed as
 * HQ's pages store it, through the reader's own stages. The failure it
 * catches: "In CommCare HQ: previous_screen" shown to a person.
 */
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { plainColumn } from "@/lib/domain/modules";
import type { Finding } from "@/lib/publish/hqFindings";
import { patients, uuid } from "../caseList/__tests__/fixtures";
import { readLists } from "../caseList/__tests__/listReading";
import { HQ_PAGE_LABELS } from "../hqPageLabels";
import { readMenusOf } from "../menus/__tests__/menuReading";

const M = "menus-and-case-lists/";
const F = "forms-and-case-writes/";

/** Every word a map of `HQ_PAGE_LABELS` holds: the stored words a finding must never show. */
const STORED_WORDS: ReadonlySet<string> = new Set(
	Object.values(HQ_PAGE_LABELS).flatMap((labels) => Object.keys(labels)),
);

/** A manifest finding's name a person would not know from HQ's pages, or undefined. */
function storedName(finding: Finding): string | undefined {
	const name = (finding.detail as { name?: unknown }).name;
	if (typeof name !== "string") return undefined;
	return name.startsWith("schema:") ||
		name.includes("_cc_calculated_") ||
		STORED_WORDS.has(name)
		? name
		: undefined;
}

/** The manifest's findings (an entry's id, `<area>/<slug>`), the circumstances left out. */
const manifestFindings = (findings: readonly Finding[]) =>
	findings.filter((one) => one.code.includes("/"));

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

	it("names a `late-flag` column by the format menu's label", async () => {
		const findings = await readColumnChange({
			format: "late-flag",
			late_flag: 30,
		});
		const flag = findings.find(
			(one) => one.code === `${M}6-late-flag-late-flag-1`,
		);
		expect(flag?.detail).toMatchObject({ name: "Late Flag" });
	});

	it("never shows a stored word, a surface key or a column HQ named for itself", async () => {
		const readings = await Promise.all([
			readPreviousOnSeveralCases(),
			...[
				{ format: "late-flag", late_flag: 30 },
				{ format: "late-flag", late_flag: 0 },
				{ format: "time-ago" },
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
		expect(
			findings.flatMap((one) =>
				storedName(one) === undefined
					? []
					: [`${one.code}: ${storedName(one)}`],
			),
		).toEqual([]);
	});

	it("names a column over a property Nova's grammar cannot hold by its own entry", async () => {
		const hashed = await readColumnChange({ field: "#notes" });
		expect(hashed.map((one) => one.code)).toContain(
			`${M}column-field-outside-nova-s-property-grammar`,
		);
		const long = await readColumnChange({ field: `n${"o".repeat(255)}` });
		expect(long.map((one) => one.code)).toContain(
			`${M}column-field-outside-nova-s-property-grammar`,
		);
		const failing = await readColumnChange({ field: "no tes" });
		expect(failing.map((one) => one.code)).toContain(
			`${M}field-failing-details-utils-js-isvalidpropertyname-non`,
		);
	});
});
