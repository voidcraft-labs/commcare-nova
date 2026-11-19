/**
 * A sort rule's name in the list's Sort by menu (`ColumnSort.label`), on a
 * column hidden from Results.
 *
 * CommCare HQ's build gives a field of the short detail a header only where
 * its sort element has display text: an `invisible` column's own locale id
 * (`detail_screen.py::Invisible.header`), and the column it appends for a sort
 * row no column takes, whose header is the row's display
 * (`util.py::create_temp_sort_column`). Android's Sort by lists every field
 * whose header is not blank (`EntitySelectActivity.getSortOptionsList`), which
 * Core's list holds as `headers`. Nova writes the name as the hidden column's
 * header and the sort element's display in HQ JSON, and as the field's locale
 * id in the local suite, in every language (`lib/domain/caseListOrder.ts`,
 * rule 10). Two menus: a list whose score column is hidden from Results and
 * shown on Details, under the name "Highest score" ("Meilleur score" in
 * French), and a tile list whose rank column is shown nowhere and is carried
 * by its rule alone, under the name "Rank" ("Rang"). The document declares
 * both platforms. Core's case list opens only on the installed local archive
 * (`proof/observe/intent.py::expectations`), so the values below hold Nova's
 * local suite in each language; proof 3 holds Core's list in HQ's build of A
 * and of B to the local archive's in the app's default language, and proof 2
 * holds A's and B's app strings in every language.
 *
 * Fixed values: Amani has score 5 and rank 2, Baraka score 9 and rank 1. The
 * list orders by score descending, so Baraka comes first; the tile list orders
 * by rank ascending, so Baraka comes first there too.
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	type BlueprintDoc,
	columnSort,
	makeTranslationUnitId,
	plainColumn,
	proseText,
	type TranslationEntry,
	type TranslationUnitId,
	tileCell,
	translationUnitsById,
} from "@/lib/domain";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import type { Expectation } from "../expected";
import { restoreXml } from "../restore";

const ID = "targeted-sort-labels";
const uuid = (name: string) => targetedUuid(ID, name);

/** Each named unit's French text, reviewed, from English. */
function frenchEntries(
	doc: BlueprintDoc,
	texts: ReadonlyMap<TranslationUnitId, string>,
): Record<TranslationUnitId, TranslationEntry> {
	const units = translationUnitsById(doc);
	const entries: Record<TranslationUnitId, TranslationEntry> = {};
	for (const [unitId, value] of texts) {
		const unit = units.get(unitId);
		if (unit === undefined)
			throw new Error(
				`${ID} names the translation unit ${unitId}, which it does not hold.`,
			);
		entries[unitId] = {
			value,
			sourceFingerprint: unit.sourceFingerprint,
			origin: "human",
			review: "reviewed",
			translatedFrom: "eng",
		};
	}
	return entries;
}

export function sortLabels() {
	const listForm = uuid("list-form");
	const tileForm = uuid("tile-form");
	const score = uuid("score");
	const rank = uuid("rank");
	const doc = buildDoc({
		appId: ID,
		appName: "Household scores",
		caseTypes: [
			{
				name: "household",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "score", label: proseText("Score"), data_type: "int" },
					{ name: "rank", label: proseText("Rank"), data_type: "int" },
				],
			},
		],
		modules: [
			{
				uuid: uuid("list-module"),
				name: "Households",
				caseType: "household",
				caseListConfig: caseListOf([
					plainColumn(uuid("name"), "case_name", "Name"),
					plainColumn(score, "score", "Score", {
						visibleInList: false,
						sort: columnSort("desc", 0, undefined, "Highest score"),
					}),
				]),
				forms: [
					{
						uuid: listForm,
						name: "Visit",
						type: "followup",
						fields: [
							f({
								kind: "text",
								uuid: uuid("list-notes"),
								id: "notes",
								label: proseText("Notes"),
							}),
						],
					},
				],
			},
			{
				uuid: uuid("tile-module"),
				name: "Households on tiles",
				caseType: "household",
				caseListConfig: caseListOf(
					[
						plainColumn(uuid("tile-name"), "case_name", "Name", {
							tile: tileCell(0, 0, 12, 1),
						}),
						plainColumn(rank, "rank", "Rank", {
							visibleInList: false,
							visibleInDetail: false,
							sort: columnSort("asc", 0, undefined, "Rank"),
						}),
					],
					{ tile: {} },
				),
				forms: [
					{
						uuid: tileForm,
						name: "Check",
						type: "followup",
						fields: [
							f({
								kind: "text",
								uuid: uuid("tile-notes"),
								id: "notes",
								label: proseText("Notes"),
							}),
						],
					},
				],
			},
		],
	});
	doc.localization = {
		sourceLanguage: "eng",
		defaultLanguage: "eng",
		languageOrder: ["eng", "fra"],
		wireCodes: { eng: "en", fra: "fr" },
		translations: {
			fra: frenchEntries(
				doc,
				new Map([
					[
						makeTranslationUnitId("column", score, "sort-label"),
						"Meilleur score",
					],
					[makeTranslationUnitId("column", rank, "sort-label"), "Rang"],
				]),
			),
		},
	};
	const restore = restoreXml({
		cases: [
			{
				id: "targeted-amani",
				type: "household",
				name: "Amani",
				properties: { score: "5", rank: "2" },
			},
			{
				id: "targeted-baraka",
				type: "household",
				name: "Baraka",
				properties: { score: "9", rank: "1" },
			},
		],
	});
	const named = (
		list: "list" | "tile",
		locale: "en" | "fr",
		name: string,
	): Expectation => ({
		id: `${list}-sort-name-${locale}-local`,
		export: "local",
		form: list === "list" ? listForm : tileForm,
		restore: "restore.xml",
		request: {
			locale,
			session: { command: list === "list" ? "m0-f0" : "m1-f0" },
			caseList: {},
		},
		expect: [
			// The name field follows the one field the list shows.
			{ pointer: "/caseList/headers/0", value: "Name" },
			{ pointer: "/caseList/headers/1", value: name },
			{ pointer: "/caseList/rows/0/caseId", value: "targeted-baraka" },
			{ pointer: "/caseList/rows/1/caseId", value: "targeted-amani" },
		],
	});
	return targetedDocument({
		id: ID,
		rows: ["menus-and-case-lists, a sort's name in Sort by"],
		doc,
		expected: {
			intent: [
				named("list", "en", "Highest score"),
				named("list", "fr", "Meilleur score"),
				named("tile", "en", "Rank"),
				named("tile", "fr", "Rang"),
			],
		},
		files: { "restore.xml": restore },
	});
}
