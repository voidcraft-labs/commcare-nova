/**
 * What a person keeps in HQ between Nova's publishes, and Nova's next publish
 * over it (the rows "4, translations", "4, `auto_gps_capture`", "5, table
 * content" and "1, language codes" with its build profiles).
 *
 * `targeted-hq-side-state` is a survey in English and Simplified Mandarin
 * whose form selects a district from a lookup table. Over Nova's first
 * publish (A), a person saves in HQ (`hqSide`, `proof/observe/hqside.py`):
 *
 * - a UI translation, `home.start`, on the UI translations page
 *   (`views/apps.py::edit_app_ui_translations`), which HQ's next import
 *   replaces with the translations Nova sends
 *   (`models/applications.py::_merge_source_into_app`), so `app_strings.txt`
 *   loses it (defect 4, translations);
 * - "Auto Capture Location" on the settings page
 *   (`views/apps.py::edit_app_attr`), which Nova's import sets back to
 *   false, so each form's meta loses its location
 *   (`xform.py::XForm._add_meta_2`; defect 4, `auto_gps_capture`);
 * - a build profile holding Mandarin alone, by the code A gives it, `zho`
 *   (`views/releases.py::LanguageProfilesView`). Nova's import keeps build
 *   profiles, which it never sends. The edit adds Traditional Mandarin, so
 *   Nova's next publish codes the two `cmn-hans` and `cmn-hant`
 *   (`lib/commcare/languageWire.ts::planLanguageWire`), the profile names a
 *   code the app no longer holds, and HQ's build of it removes every
 *   translation of every form and fails ("Form does not contain any
 *   translations for any of the build languages",
 *   `xform.py::XForm.exclude_languages`; defect 1, language codes);
 * - the district table as a person keeps it: a property on its `name` field,
 *   an attribute and owners on every row, uploaded through HQ's lookup
 *   upload, and a description from HQ's table editor. Nova's next push
 *   uploads its own workbook for the tag with `replace`, which sees another
 *   table (`fixtures/upload/run_upload.py::table_key`), deletes it and makes
 *   it again: the table and its rows get new ids, and the property, the
 *   attributes, the owners and the description are gone (defect 5, table
 *   content).
 *
 * The configurations grant `BUILD_PROFILES`, which HQ's language profiles
 * page requires (`requires_privilege`).
 *
 * Fixed values: the form holds the note the worker enters (`./echo.ts`), over
 * a restore holding the district table as HQ serves it, which the form's
 * select loads.
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	wireRow,
	wireTable,
} from "@/lib/commcare/lookup/__tests__/lookupWireCorpus";
import {
	type BlueprintDoc,
	makeTranslationUnitId,
	proseText,
	type TranslationEntry,
	type TranslationUnitId,
	translationUnitsById,
} from "@/lib/domain";
import { parseLookupRevision } from "@/lib/lookup/schema";
import { targetedDocument, targetedUuid } from "../build";
import { restoreXml } from "../restore";
import { answerHeld } from "./echo";

const ID = "targeted-hq-side-state";
const uuid = (name: string) => targetedUuid(ID, name);

const DISTRICTS = "district";

/** Each translation unit's text in one language, as a reviewed human translation of English. */
function entriesFor(
	doc: BlueprintDoc,
	texts: ReadonlyMap<TranslationUnitId, string | ReturnType<typeof proseText>>,
): Record<TranslationUnitId, TranslationEntry> {
	const units = translationUnitsById(doc);
	const entries: Record<TranslationUnitId, TranslationEntry> = {};
	for (const [unitId, value] of texts) {
		const unit = units.get(unitId);
		if (unit === undefined) {
			throw new Error(
				`${ID} names the translation unit ${unitId}, which it does not hold.`,
			);
		}
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

export function hqSideState() {
	const table = wireTable(DISTRICTS, [
		{ name: "code", type: "text" },
		{ name: "name", type: "text" },
	]);
	const [code, name] = table.columns;
	if (code === undefined || name === undefined) {
		throw new Error(`The ${DISTRICTS} table has no code and name columns.`);
	}
	const rows = [
		wireRow(table, "north", { code: "north", name: "North district" }),
		wireRow(table, "south", { code: "south", name: "South district" }),
	];
	const form = uuid("form");
	const note = uuid("note");
	const doc = buildDoc({
		appId: ID,
		appName: "District visits",
		modules: [
			{
				uuid: uuid("module"),
				name: "Visits",
				forms: [
					{
						uuid: form,
						name: "Visit",
						type: "survey",
						fields: [
							f({
								kind: "single_select",
								uuid: uuid("district"),
								id: "district",
								label: proseText("District"),
								optionsSource: {
									kind: "lookup",
									tableId: table.id,
									valueColumnId: code.id,
									labelColumnId: name.id,
								},
							}),
							f({
								kind: "text",
								uuid: note,
								id: "note",
								label: proseText("Note"),
							}),
						],
					},
				],
			},
		],
	});
	const texts = (app: string, district: string, noteLabel: string) =>
		new Map<TranslationUnitId, string | ReturnType<typeof proseText>>([
			[makeTranslationUnitId("app", "name"), app],
			[
				makeTranslationUnitId("field", uuid("district"), "label"),
				proseText(district),
			],
			[makeTranslationUnitId("field", note, "label"), proseText(noteLabel)],
		]);
	const simplified = entriesFor(doc, texts("地区走访", "地区", "备注"));
	doc.localization = {
		sourceLanguage: "eng",
		defaultLanguage: "eng",
		languageOrder: ["eng", "cmn-Hans"],
		translations: { "cmn-Hans": simplified },
	};
	const edited = structuredClone(doc);
	edited.localization = {
		sourceLanguage: "eng",
		defaultLanguage: "eng",
		languageOrder: ["eng", "cmn-Hans", "cmn-Hant"],
		translations: {
			"cmn-Hans": simplified,
			"cmn-Hant": entriesFor(doc, texts("地區走訪", "地區", "備註")),
		},
	};
	return targetedDocument({
		id: ID,
		rows: [
			"1, language codes (a build profile)",
			"4, translations",
			"4, auto_gps_capture",
			"5, table content",
		],
		doc,
		edit: edited,
		lookup: {
			projectId: "project-targeted-hq-side-state",
			projectRevision: parseLookupRevision("1"),
			definitions: [table],
			rowsByTable: new Map([[table.id, rows]]),
		},
		// The form selects from the district table, which Core loads with the form, so the note is answered over
		// a restore that holds the table as HQ serves it.
		expected: {
			intent: [
				{
					...answerHeld("note-held", form, "/data/note", "seen"),
					restore: "restore.xml",
				},
			],
		},
		files: {
			"restore.xml": restoreXml({
				tables: [
					{
						tag: DISTRICTS,
						fields: ["code", "name"],
						rows: [
							["north", "North district"],
							["south", "South district"],
						],
					},
				],
			}),
		},
		privileges: ["BUILD_PROFILES"],
		hqSide: {
			uiTranslations: { en: { "home.start": "Begin a visit" } },
			appAttributes: { auto_gps_capture: true },
			buildProfiles: [
				{ id: "mandarin-only", name: "Mandarin", langs: ["zho"] },
			],
			lookupTable: {
				tag: DISTRICTS,
				fieldProperty: { field: "name", property: "lang", value: "en" },
				rowAttribute: { name: "zone", values: ["upland", "coastal"] },
				owners: {
					user: "district.lead",
					group: "District leads",
					location: { name: "North district office", siteCode: "north_office" },
				},
				description: "The districts the health team visits",
			},
		},
	});
}
