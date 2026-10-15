/**
 * What a person keeps in HQ between Nova's publishes, and Nova's next publish
 * over it (the rows "4, translations", "4, `auto_gps_capture`" and "1,
 * language codes" with its build profiles).
 *
 * `targeted-hq-side-state` is a survey in English and Simplified Mandarin.
 * Over Nova's first publish (A), a person saves in HQ (`hqSide`,
 * `proof/observe/hqside.py`):
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
 *   `xform.py::XForm.exclude_languages`; defect 1, language codes).
 *
 * A lookup table a person keeps in HQ has a document of its own
 * (`./hqSideLookup.ts`), since that republish is the one Nova stops once
 * defect 5 is fixed, and these symptoms need a republish that lands.
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
		translations: { "cmn-Hans": simplified },
	};
	const edited = structuredClone(doc);
	edited.localization = {
		sourceLanguage: "eng",
		defaultLanguage: "eng",
		languageOrder: ["eng", "cmn-Hans", "cmn-Hant"],
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
		},
	});
}
