/**
 * Finding 75: a case list filter or search that asks for a date
 * and time "equal to" a value finds nothing on CommCare.
 *
 * HQ's receiver stores every date and time a form submits as the UTC instant
 * printed with six fraction digits and `Z`
 * (`corehq/form_processor/utils/xform.py::adjust_datetimes`), and a device's
 * restore carries that text. Core's `=` on two strings compares the text
 * (`commcare-core javarosa xpath/expr/XPathEqExpr.java::testEquality`), so a
 * literal naming the same instant in another spelling matches nothing, and
 * `!=` matches every case. HQ's search compares a custom property with `=` as
 * text too (`case_search/xpath_functions/comparison.py::property_comparison_query`).
 *
 * "Log visit" writes `seen` from a Hidden Value whose calculate is `now()`, so
 * no date and time question meets finding 74. "Visits" lists the visits seen
 * at 04:30 UTC on 2 January and "Other visits" the rest; each offers search.
 * "Opened visits" asks for the visits opened at 09:30 UTC that day in an
 * advanced Search input's predicate, which only HQ's search reads: no device
 * evaluates it, so it carries no expectation.
 *
 * Fixed values: Amina was seen at 04:30 UTC, Baraka at 05:30 UTC, and Chidi
 * has no `seen`. Chidi was opened on 2 January, the others on 1 January.
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	advancedSearchInputDef,
	plainColumn,
	proseText,
	simpleSearchInputDef,
} from "@/lib/domain";
import { datetimeLiteral, eq, neq, prop, term } from "@/lib/domain/expression";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import { restoreXml } from "../restore";

const ID = "targeted-datetime-equality";
const uuid = (name: string) => targetedUuid(ID, name);

export function datetimeEquality() {
	const visits = uuid("visits-review");
	const others = uuid("others-review");
	const opened = uuid("opened-review");
	const search = (name: string) => [
		simpleSearchInputDef(
			uuid(`${name}-input`),
			"case_name",
			"Name",
			"text",
			"case_name",
		),
	];
	const review = (name: string, form: ReturnType<typeof uuid>) => ({
		uuid: form,
		name: "Review visit",
		type: "followup" as const,
		fields: [
			f({
				kind: "text",
				uuid: uuid(`${name}-note`),
				id: "note",
				label: proseText("Note"),
			}),
		],
	});
	const doc = buildDoc({
		appId: ID,
		appName: "Visit times",
		caseTypes: [
			{
				name: "visit",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "seen", label: proseText("Seen"), data_type: "datetime" },
				],
			},
		],
		modules: [
			{
				uuid: uuid("visits-module"),
				name: "Visits",
				caseType: "visit",
				caseListConfig: caseListOf(
					[plainColumn(uuid("visits-name"), "case_name", "Name")],
					{
						filter: eq(
							prop("visit", "seen"),
							term(datetimeLiteral("2026-01-02T04:30:00")),
						),
						searchInputs: search("visits"),
					},
				),
				forms: [
					{
						uuid: uuid("log"),
						name: "Log visit",
						type: "registration",
						fields: [
							f({
								kind: "text",
								uuid: uuid("log-name"),
								id: "name",
								label: proseText("Name"),
								caseWrite: { caseType: "visit", property: "case_name" },
							}),
							f({
								kind: "hidden",
								uuid: uuid("log-seen"),
								id: "seen_at",
								calculate: "now()",
								caseWrite: { caseType: "visit", property: "seen" },
							}),
						],
					},
					review("visits", visits),
				],
			},
			{
				uuid: uuid("others-module"),
				name: "Other visits",
				caseType: "visit",
				caseListConfig: caseListOf(
					[plainColumn(uuid("others-name"), "case_name", "Name")],
					{
						filter: neq(
							prop("visit", "seen"),
							term(datetimeLiteral("2026-01-02T04:30:00")),
						),
						searchInputs: search("others"),
					},
				),
				forms: [review("others", others)],
			},
			{
				uuid: uuid("opened-module"),
				name: "Opened visits",
				caseType: "visit",
				caseListConfig: caseListOf(
					[plainColumn(uuid("opened-name"), "case_name", "Name")],
					{
						searchInputs: [
							advancedSearchInputDef(
								uuid("opened-input"),
								"opened_at",
								"Opened at",
								"text",
								eq(
									prop("visit", "date_opened"),
									term(datetimeLiteral("2026-01-02T09:30")),
								),
							),
						],
					},
				),
				forms: [review("opened", opened)],
			},
		],
	});
	// HQ's restore writes each case's `date_opened` as its day
	// (`casexml/apps/case/xml/generator.py::date_to_xml_string`).
	const restore = restoreXml({
		cases: [
			{
				id: "targeted-visit-amina",
				type: "visit",
				name: "Amina",
				properties: {
					date_opened: "2026-01-01",
					seen: "2026-01-02T04:30:00.000000Z",
				},
			},
			{
				id: "targeted-visit-baraka",
				type: "visit",
				name: "Baraka",
				properties: {
					date_opened: "2026-01-01",
					seen: "2026-01-02T05:30:00.000000Z",
				},
			},
			{
				id: "targeted-visit-chidi",
				type: "visit",
				name: "Chidi",
				properties: { date_opened: "2026-01-02" },
			},
		],
	});
	const listed = (
		id: string,
		form: ReturnType<typeof uuid>,
		command: string,
		caseIds: readonly string[],
	) => ({
		id,
		export: "local" as const,
		form,
		restore: "restore.xml",
		request: { session: { command }, caseList: {} },
		expect: caseIds.map((caseId, row) => ({
			pointer: `/caseList/rows/${row}/caseId`,
			value: caseId,
		})),
	});
	return targetedDocument({
		id: ID,
		rows: ["75"],
		doc,
		expected: {
			intent: [
				listed("equal-visits-listed-local", visits, "m0-f1", [
					"targeted-visit-amina",
				]),
				listed("other-visits-listed-local", others, "m1-f0", [
					"targeted-visit-baraka",
					"targeted-visit-chidi",
				]),
			],
		},
		files: { "restore.xml": restore },
	});
}
