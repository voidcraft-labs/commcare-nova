/**
 * What a project space keeps in CommCare HQ, and the `.ccz` Nova makes for
 * it: the control of every `mirrors` cell of `KEPT_AT_HQ`
 * (`lib/commcare/surface/keptAtHq.ts`).
 *
 * `targeted-kept-values` is a survey in English and French that declares
 * Android. Over Nova's first publish (A), a person saves in HQ (`hqSide`,
 * `proof/observe/hqside.py`) each value a `.ccz` made for the project space
 * mirrors:
 *
 * - the fifteen settings Nova seeds, each at a choice other than Nova's
 *   seed, and "Log Case Detail Views" on, on the app settings page
 *   (`views/settings.py::edit_commcare_profile`);
 * - "Worker Activity" at three months, on the same page, which HQ stores as
 *   the profile feature `credentials` and its build writes as the
 *   `<credentials>` block of `profile.xml`;
 * - one runtime UI text, `home.start`, in each language, on the UI
 *   translations page (`views/apps.py::edit_app_ui_translations`);
 * - secure submissions and "Auto Capture Location" on the settings page
 *   (`views/apps.py::edit_app_attr`), which move the profile's `PostURL` to
 *   the secure receiver (`ApplicationBase.post_url`) and add location
 *   capture to every form's meta block (`xform.py::XForm._add_meta_2`).
 *
 * None of the saves is a value Nova owns, so Nova's next publish (B)
 * proceeds and keeps each of them (`republish: "proceeds"`), and the local
 * archive, made for the project space as B left it
 * (`proof/corpus/publish.ts::capturedTargetFacts`), writes each as HQ's
 * build of B does: proof 3 compares the two, and proof 2 reads
 * `profile.ccpr` and each `app_strings.txt`.
 *
 * A custom base URL is not saved here: it is shown on the base
 * `hq-kept-settings`, and the profile's server properties on one are held
 * by `lib/commcare/__tests__/runtimeTarget.test.ts`.
 *
 * Fixed values: the form holds the note the worker enters (`./echo.ts`).
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	type BlueprintDoc,
	makeTranslationUnitId,
	NEW_APP_SETTINGS,
	proseText,
	type TranslationEntry,
	type TranslationUnitId,
	translationUnitsById,
} from "@/lib/domain";
import { targetedDocument, targetedUuid } from "../build";
import { answerHeld } from "./echo";

const ID = "targeted-kept-values";
const uuid = (name: string) => targetedUuid(ID, name);

/** Each translation unit's text in French, as a reviewed human translation of English. */
function frenchEntries(
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

/**
 * Each of the fifteen seeded settings at one of its own choices other than
 * Nova's seed (`static/app_manager/json/commcare-profile-settings.yml`),
 * and the detail-view log on, as the settings page posts a switch.
 */
const SETTINGS = {
	"cc-fuzzy-search-enabled": "yes",
	"cc-gps-auto-capture-accuracy": "20",
	"cc-content-valid": "yes",
	"cc-autoup-freq": "freq-weekly",
	"cc-enable-tts": "yes",
	"cc-autosync-freq": "freq-daily",
	"cc-days-form-retain": "31",
	"cc-inflation-target-density": "240",
	"cc-label-required-questions-with-asterisk": "yes",
	"cc-login-duration-seconds": "28800",
	"cc-maps-default-layer": "terrain",
	"cc-resize-images": "half",
	logenabled: "Disabled",
	"unsent-number-limit": "20",
	"unsent-time-limit": "14",
	"cc-log-entity-detail-enabled": true,
} as const;

export function keptValues() {
	const form = uuid("form");
	const note = uuid("note");
	const doc = buildDoc({
		appId: ID,
		appName: "Field visits",
		appSettings: { ...NEW_APP_SETTINGS, runsOnlyOn: "android" },
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
	doc.localization = {
		sourceLanguage: "eng",
		defaultLanguage: "eng",
		languageOrder: ["eng", "fra"],
		wireCodes: { eng: "en", fra: "fra" },
		translations: {
			fra: frenchEntries(
				doc,
				new Map<TranslationUnitId, string | ReturnType<typeof proseText>>([
					[makeTranslationUnitId("app", "name"), "Visites de terrain"],
					[makeTranslationUnitId("field", note, "label"), proseText("Note")],
				]),
			),
		},
	};
	return targetedDocument({
		id: ID,
		rows: [
			"a CCZ made for a project space writes what that project space keeps",
		],
		doc,
		expected: {
			intent: [answerHeld("note-held", form, "/data/note", "seen")],
		},
		hqSide: {
			uiTranslations: {
				en: { "home.start": "Begin a visit" },
				fra: { "home.start": "Commencer une visite" },
			},
			appAttributes: { auto_gps_capture: true, secure_submissions: true },
			profileProperties: SETTINGS,
			profileFeatures: { credentials: "3MON_ACTIVE" },
			republish: "proceeds",
		},
	});
}
