/**
 * Where a sort rule puts blank values, against its direction.
 *
 * `targeted-sort-blanks` is one menu of households whose list holds two sort
 * rules: rank ascending with blanks last, and score descending with blanks
 * first, each the side its direction would not take (`Column.sort.blanks`,
 * stored where it differs from the direction's own). Nova writes each rule's
 * `blanks` into the HQ JSON's sort element and the local suite's `<sort>`
 * (`lib/domain/caseListOrder.ts::caseListOrderPlan`). Core reads the field's
 * own preference (`DetailFieldParser.java::parseBlanksPreference`) and
 * places a blank by it alone, whatever the direction
 * (`EntitySorter.java::getCmp`, `detailFields[index].showBlanksLastInSort()`).
 * Proofs 2 to 4 compare states of one emission, so they cannot show an order
 * every side gets wrong; the two `caseList` expectations can. Each sorts the
 * list by one rule's field (`sortIndex`, Core's one-indexed field, which
 * keeps the field's own direction, `EntityScreenHelper.java::sortEntities`).
 * The document declares both platforms.
 *
 * Fixed values: Amani has rank 1 and score 5, Chiku rank 2 and score 9, and
 * Baraka neither. By rank ascending with blanks last the list reads Amani,
 * Chiku, Baraka; by score descending with blanks first it reads Baraka,
 * Chiku, Amani. By direction alone each blank would sit at the other end.
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { columnSort, plainColumn, proseText } from "@/lib/domain";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import { restoreXml } from "../restore";

const ID = "targeted-sort-blanks";
const uuid = (name: string) => targetedUuid(ID, name);

export function sortBlanks() {
	const visit = uuid("visit");
	const doc = buildDoc({
		appId: ID,
		appName: "Household ranks",
		caseTypes: [
			{
				name: "household",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "rank", label: proseText("Rank"), data_type: "int" },
					{ name: "score", label: proseText("Score"), data_type: "int" },
				],
			},
		],
		modules: [
			{
				uuid: uuid("module"),
				name: "Households",
				caseType: "household",
				caseListConfig: caseListOf([
					plainColumn(uuid("name"), "case_name", "Name"),
					plainColumn(uuid("rank"), "rank", "Rank", {
						sort: columnSort("asc", 0, "last"),
					}),
					plainColumn(uuid("score"), "score", "Score", {
						sort: columnSort("desc", 1, "first"),
					}),
				]),
				forms: [
					{
						uuid: visit,
						name: "Visit",
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
			{
				id: "targeted-amani",
				type: "household",
				name: "Amani",
				properties: { rank: "1", score: "5" },
			},
			{
				id: "targeted-baraka",
				type: "household",
				name: "Baraka",
				properties: {},
			},
			{
				id: "targeted-chiku",
				type: "household",
				name: "Chiku",
				properties: { rank: "2", score: "9" },
			},
		],
	});
	const listed = (id: string, sortIndex: number, order: readonly string[]) => ({
		id,
		export: "local" as const,
		form: visit,
		restore: "restore.xml",
		request: {
			session: { command: "m0-f0" },
			caseList: { sortIndex },
		},
		expect: order.map((caseId, row) => ({
			pointer: `/caseList/rows/${row}/caseId`,
			value: caseId,
		})),
	});
	return targetedDocument({
		id: ID,
		rows: ["menus-and-case-lists, blanks first or last"],
		doc,
		expected: {
			intent: [
				// Rank is the list's second field.
				listed("rank-blanks-last", 2, [
					"targeted-amani",
					"targeted-chiku",
					"targeted-baraka",
				]),
				// Score is the list's third field.
				listed("score-blanks-first", 3, [
					"targeted-baraka",
					"targeted-chiku",
					"targeted-amani",
				]),
			],
		},
		files: { "restore.xml": restore },
	});
}
