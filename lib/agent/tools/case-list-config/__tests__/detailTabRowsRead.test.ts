/**
 * A Details tab's records reach the Solutions Architect as record-dialect
 * text and come back as the stored trees. The contract: `getModule` prints a
 * child tab's filter over the child row and a records tab's collection
 * (`cases('<type>', …)`, `table-rows('<table>', …)`, `places()`), each the
 * text the record dialect's judge prints for that slot, and each print parses
 * back to the stored tree. The failures this catches: a collection with no
 * record spelling (the read throws, and the reader refuses every such tab an
 * app made in CommCare HQ holds), and a child filter read over the outer case,
 * which names a property of the wrong case type.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { projectAuthoringRead } from "@/lib/agent/authoring/output";
import { recordDialectRoundTrip } from "@/lib/agent/authoring/recordRoundTrip";
import type { BlueprintDoc } from "@/lib/domain";
import { calculatedColumn, plainColumn } from "@/lib/domain";
import { eq, literal, prop, term } from "@/lib/domain/expression";
import type { Expression, SlotContextRef } from "@/lib/domain/expression/types";
import { proseText } from "@/lib/domain/prose";
import { getModuleTool } from "../../getModule";
import {
	BASE_COLUMN,
	MOD_A,
	makeCaseListDoc,
	makeCaseListFixture,
} from "./fixtures";

const NOTES = testUuid("detail-rows-notes");
const VISIT_NAME = testUuid("detail-rows-visit-name");
const PLACE = testUuid("detail-rows-place");
const CHILD_TAB = testUuid("detail-rows-child-tab");
const RECORDS_TAB = testUuid("detail-rows-records-tab");
const PLACES_TAB = testUuid("detail-rows-places-tab");

const visitRows: Expression = {
	kind: "cases",
	source: "casedb",
	where: [
		eq(
			term({ kind: "case-row-type" }),
			term({ kind: "case-type", caseType: "visit" }),
		),
		eq(term(prop("visit", "notes")), term(literal("due"))),
	],
};
const dueChildren = eq(term(prop("visit", "notes")), term(literal("due")));

function tabbedDoc(): BlueprintDoc {
	const doc = makeCaseListDoc();
	doc.caseTypes = [
		...(doc.caseTypes ?? []),
		{
			name: "visit",
			parent_type: "patient",
			properties: [
				{ name: "case_name", label: proseText("Visit") },
				{ name: "notes", label: proseText("Notes") },
			],
		},
	];
	const module = doc.modules[MOD_A];
	const config = module?.caseListConfig;
	if (!module || !config) throw new Error("The fixture menu has no case list.");
	config.columns = [
		...config.columns,
		plainColumn(NOTES, "notes", "Notes", {
			notOnList: true,
			visibleInList: false,
		}),
		calculatedColumn(VISIT_NAME, "Visit", term(prop("visit", "case_name")), {
			notOnList: true,
			visibleInList: false,
		}),
		calculatedColumn(
			PLACE,
			"Place",
			term({ kind: "location-field", field: "name" }),
			{ notOnList: true, visibleInList: false },
		),
	];
	config.detailColumnOrder = [BASE_COLUMN, NOTES, VISIT_NAME, PLACE];
	config.listColumnOrder = [BASE_COLUMN, NOTES, VISIT_NAME, PLACE];
	config.detailTabs = [
		{
			uuid: testUuid("detail-rows-own-tab"),
			title: "Patient",
			startColumnUuid: BASE_COLUMN,
		},
		{
			uuid: CHILD_TAB,
			title: "Due visits",
			startColumnUuid: NOTES,
			rowSource: {
				kind: "children",
				caseType: "visit",
				condition: dueChildren,
			},
		},
		{
			uuid: RECORDS_TAB,
			title: "All due visits",
			startColumnUuid: VISIT_NAME,
			rowSource: { kind: "records", rows: visitRows },
		},
		{
			uuid: PLACES_TAB,
			title: "Places",
			startColumnUuid: PLACE,
			rowSource: { kind: "records", rows: { kind: "locations", where: [] } },
		},
	];
	return doc;
}

describe("a Details tab's records in the record dialect", () => {
	it("reads each tab's rows as text the judge prints and parses back unchanged", async () => {
		const doc = tabbedDoc();
		const h = makeCaseListFixture(doc);
		const result = (await h.runTool(getModuleTool, { moduleUuid: MOD_A })) as {
			data: unknown;
		};
		const read = projectAuthoringRead({
			toolName: "getModule",
			data: result.data,
			doc,
		}) as {
			case_list_config: {
				detailTabs: { rowSource?: Record<string, unknown> }[];
				columns: { uuid: string; expression?: unknown }[];
			};
		};
		// Each field reads the row its tab lists: a visit, or a place.
		const expressionOf = (uuid: string) =>
			read.case_list_config.columns.find((column) => column.uuid === uuid)
				?.expression;
		expect(expressionOf(VISIT_NAME)).toBe("#row/case_name");
		expect(expressionOf(PLACE)).toBe("place-field('name')");
		const sources = read.case_list_config.detailTabs.map(
			(tab) => tab.rowSource,
		);
		expect(sources).toEqual([
			undefined,
			{
				kind: "children",
				caseType: "visit",
				condition: "(#row/notes = 'due')",
			},
			{ kind: "records", rows: "cases('visit', (#row/notes = 'due'))" },
			{ kind: "records", rows: "places()" },
		]);
		const slot = (
			name: "case_detail_tab_filter" | "case_detail_tab_rows",
			tabUuid: typeof CHILD_TAB,
		): SlotContextRef => ({
			entity: "module",
			uuid: MOD_A,
			slot: name,
			member: { tabUuid },
		});
		const lookup = new Map();
		expect(
			recordDialectRoundTrip(
				doc,
				slot("case_detail_tab_filter", CHILD_TAB),
				dueChildren,
				lookup,
			),
		).toBeUndefined();
		expect(
			recordDialectRoundTrip(
				doc,
				slot("case_detail_tab_rows", RECORDS_TAB),
				visitRows,
				lookup,
			),
		).toBeUndefined();
		const column = (columnUuid: typeof VISIT_NAME): SlotContextRef => ({
			entity: "module",
			uuid: MOD_A,
			slot: "case_list_column_expression",
			member: { columnUuid },
		});
		expect(
			recordDialectRoundTrip(
				doc,
				column(VISIT_NAME),
				term(prop("visit", "case_name")),
				lookup,
			),
		).toBeUndefined();
		expect(
			recordDialectRoundTrip(
				doc,
				column(PLACE),
				term({ kind: "location-field", field: "name" }),
				lookup,
			),
		).toBeUndefined();
		expect(
			recordDialectRoundTrip(
				doc,
				slot("case_detail_tab_rows", PLACES_TAB),
				{ kind: "locations", where: [] },
				lookup,
			),
		).toBeUndefined();
	});
});
