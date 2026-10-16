/**
 * What a person keeps in HQ between Nova's publishes, and Nova's next publish
 * over it (the rows "4, translations", "4, `auto_gps_capture`", "4, add-ons",
 * finding 40's setting saved in HQ, and "1, language codes" with its build
 * profiles).
 *
 * `targeted-hq-side-state` is a survey in English and Simplified Mandarin.
 * Over Nova's first publish (A), a person saves in HQ (`hqSide`,
 * `proof/observe/hqside.py`):
 *
 * - a UI translation, `home.start`, on the UI translations page
 *   (`views/apps.py::edit_app_ui_translations`), a key the target owns,
 *   which Nova's next update carries back as HQ held it, so
 *   `app_strings.txt` keeps it (defect 4, translations);
 * - "Auto Capture Location" on the settings page
 *   (`views/apps.py::edit_app_attr`), a key Nova's update leaves out for an
 *   app that is not a Connect app, so HQ keeps it and each form's meta keeps
 *   its location (`xform.py::XForm._add_meta_2`; defect 4,
 *   `auto_gps_capture`), which the local archive of an app that is not a
 *   Connect app cannot hold (`proof/checks/proof3.py::stated_hq_side_values`);
 * - Menu Mode on in the add-ons section, which posts every add-on HQ lists
 *   at the value the section shows (`app_manager/js/add_ons.js`,
 *   `EditAddOns`), and HQ stores each slug posted
 *   (`views/apps.py::edit_add_ons`). Nova's app needs no add-on and holds
 *   none, so the section shows each at HQ's initial value, off for this app
 *   (`add_ons.py::init_app`), and the save stores all thirteen, Menu Mode
 *   alone on: add-ons Nova's document does not need, which Nova's update
 *   keeps (defect 4, add-ons);
 * - the update frequency `freq-daily` on the app settings page
 *   (`views/settings.py::edit_commcare_profile`), one of the settings Nova
 *   seeds only where the target holds none, so Nova's update carries the
 *   person's value back and HQ's build writes it, where the local archive
 *   writes Nova's (finding 40);
 * - a build profile holding Mandarin alone, by the code A gives it, `zho`
 *   (`views/releases.py::LanguageProfilesView`). Nova's import keeps build
 *   profiles, which it never sends. The edit adds Traditional Mandarin as
 *   `cmn-hant` while Simplified keeps `zho`, the code its root stores
 *   (`localization.wireCodes`), so the profile still names a code the app
 *   holds. Before step 2 Nova recoded both, as `cmn-hans` and `cmn-hant`,
 *   the profile named a code the app no longer held, and HQ's build of it
 *   removed every translation of every form and failed ("Form does not
 *   contain any translations for any of the build languages",
 *   `xform.py::XForm.exclude_languages`; defect 1, language codes).
 *
 * None of the saves is a value Nova owns, so the republish proceeds with no
 * discard (`republish: "proceeds"`).
 *
 * A lookup table a person keeps in HQ has a document of its own
 * (`./hqSideLookup.ts`), since that republish is the one Nova stops
 * (`hq_table_content_unsupported`, defect 5), and these symptoms need a
 * republish that lands.
 *
 * The configurations grant `BUILD_PROFILES`, which HQ's language profiles
 * page requires (`requires_privilege`).
 *
 * Fixed values: the form holds the note the worker enters (`./echo.ts`).
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	type BlueprintDoc,
	makeTranslationUnitId,
	proseText,
	type TranslationEntry,
	type TranslationUnitId,
	translationUnitsById,
} from "@/lib/domain";
import { targetedDocument, targetedUuid } from "../build";
import { answerHeld } from "./echo";

const ID = "targeted-hq-side-state";
const uuid = (name: string) => targetedUuid(ID, name);

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
	const texts = (app: string, noteLabel: string) =>
		new Map<TranslationUnitId, string | ReturnType<typeof proseText>>([
			[makeTranslationUnitId("app", "name"), app],
			[makeTranslationUnitId("field", note, "label"), proseText(noteLabel)],
		]);
	const simplified = entriesFor(doc, texts("地区走访", "备注"));
	doc.localization = {
		sourceLanguage: "eng",
		defaultLanguage: "eng",
		languageOrder: ["eng", "cmn-Hans"],
		wireCodes: { eng: "en", "cmn-Hans": "zho" },
		translations: { "cmn-Hans": simplified },
	};
	const edited = structuredClone(doc);
	edited.localization = {
		sourceLanguage: "eng",
		defaultLanguage: "eng",
		languageOrder: ["eng", "cmn-Hans", "cmn-Hant"],
		wireCodes: { eng: "en", "cmn-Hans": "zho", "cmn-Hant": "cmn-hant" },
		translations: {
			"cmn-Hans": simplified,
			"cmn-Hant": entriesFor(doc, texts("地區走訪", "備註")),
		},
	};
	return targetedDocument({
		id: ID,
		rows: [
			"1, language codes (a build profile)",
			"4, translations",
			"4, auto_gps_capture",
			"4, add-ons",
			"40 (a setting saved in HQ)",
		],
		doc,
		edit: edited,
		expected: {
			intent: [answerHeld("note-held", form, "/data/note", "seen")],
		},
		privileges: ["BUILD_PROFILES"],
		hqSide: {
			uiTranslations: { en: { "home.start": "Begin a visit" } },
			appAttributes: { auto_gps_capture: true },
			buildProfiles: [
				{ id: "mandarin-only", name: "Mandarin", langs: ["zho"] },
			],
			// Every slug HQ lists, in its order (`add_ons.py::_ADD_ONS`).
			addOns: {
				advanced_itemsets: false,
				calc_xpaths: false,
				case_detail_overwrite: false,
				case_list_menu_item: false,
				conditional_enum: false,
				conditional_form_actions: false,
				display_conditions: false,
				enum_image: false,
				menu_mode: true,
				register_from_case_list: false,
				subcases: false,
				submenus: false,
				empty_case_lists: false,
			},
			profileProperties: { "cc-autoup-freq": "freq-daily" },
			republish: "proceeds",
		},
	});
}
