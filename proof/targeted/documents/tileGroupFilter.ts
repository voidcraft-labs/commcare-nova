/**
 * A grouped tile list's cards under the list's filter.
 *
 * Formplayer builds a list in four steps (`EntityListSubscreen.java`'s
 * constructor calls `util/screen/EntityScreenHelper.java::initEntities`):
 * `filterEntities` keeps the rows the typed text matches, `sortEntities` puts
 * them in the list's own order with a stable sort, `groupEntities` gives each
 * group key the ordinal of its first appearance among those rows and sorts by
 * it, and the page is cut on group boundaries. The Web Apps client keeps one
 * model a group, the first, which draws the card's heading and takes its tap
 * (`menus/views.js::CaseTileGroupedListView.initialize`,
 * `CaseTileGroupedView.templateContext`, `CaseView.rowClick`). So under a
 * filter the cards are made from the rows that remain: the groups stand in the
 * order of each one's first match, and a card's heading and its choice are
 * that match. Preview's cards follow the same rule
 * (`lib/preview/caseTileGrouping.ts::tileGroupCards`).
 *
 * The tile groups visits by `parent` with one header row, which reads the
 * visit's own `seen_by`, so the case a heading is drawn from can be told
 * apart; the row below holds the name, which orders the list, and the
 * outcome.
 *
 * Fixed values: visits Ada and Cal belong to Kijiji, Ben and Dot to
 * Riverside, and Eve to no household. No name and no `seen_by` holds the
 * letters of "referred", so that text matches on `outcome` alone, keeping Ben,
 * Cal and Dot. With no text Core's rows are Ada, Cal, Ben, Dot, Eve; with
 * "Referred" they are Ben, Dot, Cal, which is neither the list's own order of
 * the matches (Ben, Cal, Dot) nor the unfiltered group order (Cal, Ben, Dot),
 * so it holds the sequence filter, sort, group and nothing else.
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { plainColumn, proseText, tileCell } from "@/lib/domain";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import { restoreXml } from "../restore";

const ID = "targeted-tile-group-filter";
const uuid = (name: string) => targetedUuid(ID, name);

const HOUSEHOLDS = {
	kijiji: "targeted-kijiji-household",
	riverside: "targeted-riverside-household",
} as const;

/** The five visits, in the list's own order (by name). */
const VISITS = [
	{
		id: "targeted-ada-visit",
		name: "Ada",
		household: HOUSEHOLDS.kijiji,
		seenBy: "Nurse Amani",
		outcome: "Seen",
	},
	{
		id: "targeted-ben-visit",
		name: "Ben",
		household: HOUSEHOLDS.riverside,
		seenBy: "Nurse Chiku",
		outcome: "Referred",
	},
	{
		id: "targeted-cal-visit",
		name: "Cal",
		household: HOUSEHOLDS.kijiji,
		seenBy: "Nurse Baraka",
		outcome: "Referred",
	},
	{
		id: "targeted-dot-visit",
		name: "Dot",
		household: HOUSEHOLDS.riverside,
		seenBy: "Nurse Dalila",
		outcome: "Referred",
	},
	{
		id: "targeted-eve-visit",
		name: "Eve",
		household: undefined,
		seenBy: "Nurse Imani",
		outcome: "Seen",
	},
] as const;

/** The intent expectation that Core's rows are these cases, in this order. */
function rowsAre(caseIds: readonly string[]) {
	return caseIds.map((caseId, index) => ({
		pointer: `/caseList/rows/${index}/caseId`,
		value: caseId,
	}));
}

export function tileGroupFilter() {
	const followup = uuid("followup");
	const doc = buildDoc({
		appId: ID,
		appName: "Grouped visits",
		caseTypes: [
			{
				name: "household",
				properties: [{ name: "case_name", label: proseText("Name") }],
			},
			{
				name: "visit",
				parent_type: "household",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					...["seen_by", "outcome"].map((name) => ({
						name,
						label: proseText(name),
						data_type: "text" as const,
					})),
				],
			},
		],
		modules: [
			{
				uuid: uuid("module"),
				name: "Visits",
				caseType: "visit",
				caseListConfig: caseListOf(
					[
						plainColumn(uuid("seen-by"), "seen_by", "Seen by", {
							tile: tileCell(0, 0, 12, 1),
						}),
						plainColumn(uuid("name"), "case_name", "Name", {
							sort: { direction: "asc", priority: 0 },
							tile: tileCell(0, 1, 6, 1),
						}),
						plainColumn(uuid("outcome"), "outcome", "Outcome", {
							tile: tileCell(6, 1, 6, 1),
						}),
					],
					{ tile: { grouping: { identifier: "parent", headerRows: 1 } } },
				),
				forms: [
					{
						uuid: followup,
						name: "Follow up",
						type: "followup",
						fields: [
							f({
								kind: "text",
								uuid: uuid("notes"),
								id: "notes",
								label: proseText("Notes"),
							}),
						],
					},
				],
			},
		],
	});
	const restore = restoreXml({
		cases: [
			{ id: HOUSEHOLDS.kijiji, type: "household", name: "Kijiji" },
			{ id: HOUSEHOLDS.riverside, type: "household", name: "Riverside" },
			...VISITS.map((visit) => ({
				id: visit.id,
				type: "visit",
				name: visit.name,
				properties: { seen_by: visit.seenBy, outcome: visit.outcome },
				...(visit.household !== undefined && {
					indices: [
						{
							identifier: "parent",
							caseType: "household",
							caseId: visit.household,
						},
					],
				}),
			})),
		],
	});
	return targetedDocument({
		id: ID,
		rows: ["a grouped tile list's cards under a filter"],
		doc,
		expected: {
			intent: [
				{
					id: "grouped-unfiltered",
					export: "local",
					form: followup,
					restore: "restore.xml",
					request: {
						session: { command: "m0-f0" },
						caseList: {},
					},
					expect: rowsAre([
						"targeted-ada-visit",
						"targeted-cal-visit",
						"targeted-ben-visit",
						"targeted-dot-visit",
						"targeted-eve-visit",
					]),
				},
				{
					id: "grouped-filtered",
					export: "local",
					form: followup,
					restore: "restore.xml",
					request: {
						session: { command: "m0-f0" },
						caseList: { searchText: "Referred" },
					},
					expect: rowsAre([
						"targeted-ben-visit",
						"targeted-dot-visit",
						"targeted-cal-visit",
					]),
				},
			],
		},
		files: { "restore.xml": restore },
	});
}
