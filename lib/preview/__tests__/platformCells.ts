/**
 * The cell table: how Preview answers for every platform cell where the
 * surface manifest says a runtime reads an item differently.
 *
 * The required set is every `(entry, platform)` whose entry is HELD, reads
 * per platform (`platforms.kind` `each`), and on that platform reads neither
 * `runs` nor `not-applicable` (`platformCells.test.ts` derives it from the
 * manifest as it stands). Each row carries one kind of evidence:
 *
 * - `model`: a check that drives the production model for the platform
 *   (`platformCellModels.ts`);
 * - `browser`: a Playwright scenario (`e2e/lib/previewPlatformScenarios.ts`,
 *   implemented by `e2e/tests/browser/preview-platforms.spec.ts`);
 * - `refused`: the gate keeps the feature out of an app on that platform,
 *   through the platform rule (`structural`), the checker (`expression`) or
 *   the media acceptance (`media`), so Preview never plays it there;
 * - `stated`: the builder states the difference through the feature's note,
 *   or the public docs do;
 * - `outside-preview`: what differs is outside what Preview runs.
 */

import type { PreviewPlatformScenarioId } from "@/e2e/lib/previewPlatformScenarios";
import type { Platform, PlatformFeatureId } from "@/lib/domain/platforms";
import type { PlatformModelCheckId } from "./platformCellModels";

export const PREVIEW_DOCS_SECTION =
	"content/docs/building-with-nova.mdx#preview-on-web-apps-and-android" as const;

export type PlatformCell =
	| { readonly kind: "model"; readonly check: PlatformModelCheckId }
	| { readonly kind: "browser"; readonly scenario: PreviewPlatformScenarioId }
	| {
			readonly kind: "refused";
			readonly channel: "structural" | "expression";
			readonly feature: PlatformFeatureId;
	  }
	| { readonly kind: "refused"; readonly channel: "media" }
	| { readonly kind: "stated"; readonly feature: PlatformFeatureId }
	| { readonly kind: "stated"; readonly docs: typeof PREVIEW_DOCS_SECTION }
	| { readonly kind: "outside-preview"; readonly reason: string };

const model = (check: PlatformModelCheckId): PlatformCell => ({
	kind: "model",
	check,
});
const browser = (scenario: PreviewPlatformScenarioId): PlatformCell => ({
	kind: "browser",
	scenario,
});
const structural = (feature: PlatformFeatureId): PlatformCell => ({
	kind: "refused",
	channel: "structural",
	feature,
});
const expression = (feature: PlatformFeatureId): PlatformCell => ({
	kind: "refused",
	channel: "expression",
	feature,
});
const media: PlatformCell = { kind: "refused", channel: "media" };
const stated = (feature: PlatformFeatureId): PlatformCell => ({
	kind: "stated",
	feature,
});
const statedInDocs: PlatformCell = {
	kind: "stated",
	docs: PREVIEW_DOCS_SECTION,
};
const outside = (reason: string): PlatformCell => ({
	kind: "outside-preview",
	reason,
});

const PROFILE_PROPERTY_ONLY_ANDROID_READS = outside(
	"A profile property only Android reads; Preview reads no profile property.",
);

export const PLATFORM_CELLS: Readonly<
	Record<`${string}@${Platform}`, PlatformCell>
> = {
	// ── Refused, structural ────────────────────────────────────────────
	"questions/date-and-time-xsd-datetime@web-apps":
		structural("datetime-question"),
	"case-search/inline-search-true-auto-launch-true-on-a-module-with-visible@android":
		structural("search-first"),
	"case-search/inline-search-default-search-on-a-module-without-visible-inputs@android":
		structural("search-first"),
	"menus-and-case-lists/inline-search-in-a-parent-select-module-hq-adds-xpath-query@android":
		structural("search-first"),
	"menus-and-case-lists/case-list-form-on-a-search-first-host-pointing-at-a-registration@android":
		structural("search-first"),
	/* The read is admitted only in a search-first module, which Android refuses. */
	"expressions-and-data/search-input-read-in-form-expressions-of-an-inline-search-module@android":
		structural("search-first"),
	"expressions-and-data/search-input-results-read-in-the-case-list-of-an-inline-search@android":
		structural("search-first"),
	"menus-and-case-lists/detail-multi-select@android":
		structural("several-cases"),
	"menus-and-case-lists/detail-max-select-value-on-a-multi-select-basic-list@android":
		structural("several-cases"),
	"expressions-and-data/selected-cases-search-selected-cases-parent-selected-cases-jr@android":
		structural("several-cases"),
	"case-search/input-date@android": structural("search-field-single-date"),
	"case-search/input-select-multi-lookup-itemset@android": structural(
		"search-field-multiple-choice",
	),
	"application-and-settings/connect-app-opened-in-the-connect-app@web-apps":
		structural("connect-app"),
	/* Its only use is a Connect app's, which Web Apps refuses. */
	"application-and-settings/45-hq-auto-gps-capture@web-apps":
		structural("connect-app"),

	// ── Refused, expression ────────────────────────────────────────────
	"expressions-and-data/here-in-a-case-list-calculated-column-or-sort@web-apps":
		expression("case-list-here"),
	"expressions-and-data/session-data-stringquery@web-apps": expression(
		"case-list-search-text",
	),
	"expressions-and-data/session-context-window-width@android":
		expression("window-width"),
	"case-search/runtime-values-read-from-the-session-context-window-width@android":
		expression("window-width"),

	// ── Refused, media ─────────────────────────────────────────────────
	"expressions-and-data/audio-raw-aac-adts-aac-amr-midi@web-apps": media,
	"expressions-and-data/video-hevc-mp4-mpeg-4-part-2-mp4-and-mkv-holding-a-codec-android@web-apps":
		media,
	"expressions-and-data/image-ico-avif@android": media,

	// ── Model ──────────────────────────────────────────────────────────
	"expressions-and-data/now@web-apps": model("recalculation-every-request"),
	"expressions-and-data/random@web-apps": model("recalculation-every-request"),
	"expressions-and-data/uuid@web-apps": model("recalculation-every-request"),
	"expressions-and-data/sleep@web-apps": model("recalculation-every-request"),
	"expressions-and-data/today@web-apps": model("recalculation-every-request"),
	"expressions-and-data/int@web-apps": model("day-number-utc-epoch"),
	"expressions-and-data/double@web-apps": model("day-number-utc-epoch"),
	"expressions-and-data/number@web-apps": model("day-number-utc-epoch"),
	"expressions-and-data/regex@web-apps": model("java-pattern-ascii-classes"),
	"expressions-and-data/replace@web-apps": model("java-pattern-ascii-classes"),
	"expressions-and-data/session-context-deviceid@web-apps": model(
		"session-context-web-apps",
	),
	"expressions-and-data/session-context-appversion@web-apps": model(
		"session-context-web-apps",
	),
	"expressions-and-data/session-context-drift@web-apps": model(
		"session-context-web-apps",
	),
	"expressions-and-data/session-context-applanguage@web-apps": model(
		"session-context-web-apps",
	),
	"case-search/runtime-values-read-from-the-session-context-drift@web-apps":
		model("session-context-web-apps"),
	"expressions-and-data/commcaresession-jr-instance-session@web-apps": model(
		"session-context-web-apps",
	),
	"menus-and-case-lists/session-endpoint-id@web-apps": model(
		"entry-point-web-apps",
	),
	"menus-and-case-lists/case-list-session-endpoint-id@web-apps": model(
		"entry-point-web-apps",
	),
	"forms-and-case-writes/session-endpoint-id@web-apps": model(
		"entry-point-web-apps",
	),
	"menus-and-case-lists/session-endpoint-id@android": model(
		"entry-point-android",
	),
	"menus-and-case-lists/case-list-session-endpoint-id@android": model(
		"entry-point-android",
	),
	"forms-and-case-writes/session-endpoint-id@android": model(
		"entry-point-android",
	),
	"menus-and-case-lists/module-case-list-on-a-formless-basic-module-show-true@web-apps":
		model("case-list-menu-item-web-apps"),
	"menus-and-case-lists/detail-case-tile-group-index-identifier-header-rows@android":
		model("tiles-flat-android"),
	"menus-and-case-lists/show-border-show-shading@android": model(
		"tile-border-shading-android",
	),
	"menus-and-case-lists/horizontal-align-vertical-align@android": model(
		"tile-vertical-align-android",
	),
	"menus-and-case-lists/7-invisible-search-only-on-the-case-list-outside-a-custom-tile@web-apps":
		model("hidden-column-searchable"),
	"menus-and-case-lists/10-markdown-any-property-or-expression@android": model(
		"link-column-raw-android",
	),
	"case-search/required-test-text@android": model(
		"search-field-checks-android",
	),
	"case-search/validations-0-test-text@android": model(
		"search-field-checks-android",
	),
	"case-search/hidden-exclude-with-a-default-value-on-a-prompt-with-no-itemset@android":
		model("hidden-search-field-android"),
	"case-search/the-generated-search-round-trip-remote-request-query-results@android":
		model("search-android"),
	"case-search/workflow-skip-to-default-results-auto-launch-true-default-search@android":
		model("skip-to-results-android"),
	"forms-and-case-writes/post-form-workflow-default@web-apps": model(
		"after-submit-home-web-apps",
	),
	"forms-and-case-writes/post-form-workflow-default@android": model(
		"after-submit-home-android",
	),
	"questions/question-list-unlabelled-when-every-root-field-is-a-section-and@web-apps":
		model("form-one-screen-web-apps"),

	// ── Browser ────────────────────────────────────────────────────────
	"questions/gps-geopoint@web-apps": browser("location-map-web-apps"),
	"questions/barcode-barcode@web-apps": browser("barcode-text-web-apps"),
	"questions/image-capture-upload-image@web-apps": browser(
		"image-attach-web-apps",
	),
	"questions/audio-capture-audio@web-apps": browser("audio-attach-web-apps"),
	"questions/video-capture-video@web-apps": browser("video-attach-web-apps"),
	"questions/question-list-group-appearance-field-list-labelled@web-apps":
		browser("sections-one-screen-web-apps"),
	"questions/groups-nested-in-a-question-list@web-apps": browser(
		"sections-one-screen-web-apps",
	),
	"questions/choice-image@web-apps": browser("choice-media-web-apps"),
	"questions/choice-audio-video@web-apps": browser("choice-media-web-apps"),
	"questions/help-media@web-apps": browser("help-web-apps"),
	"questions/help-text-markdown-form@web-apps": browser("help-web-apps"),
	"questions/help-text-markdown-form@android": browser("help-android"),
	"questions/hint-text@web-apps": browser("hint-markdown-web-apps"),
	"questions/hint-text@android": browser("hint-plain-android"),
	"questions/validation-message-markdown-form@web-apps": browser(
		"validation-plain-web-apps",
	),
	"questions/validation-message-markdown-form@android": browser(
		"validation-plain-android",
	),
	"questions/choice-label-text-markdown@web-apps": browser(
		"choice-label-markdown-web-apps",
	),
	"questions/choice-label-text-markdown@android": browser(
		"choice-label-markdown-android",
	),
	"questions/group-repeat-label-text-markdown@web-apps": browser(
		"group-label-web-apps",
	),
	"questions/group-repeat-label-text-markdown@android": browser(
		"group-label-android",
	),
	"questions/markdown-form-equal-to-the-default-text@android": browser(
		"label-markdown-android",
	),
	"case-search/title-label-lang-non-empty@android": browser(
		"search-screen-text-android",
	),
	"case-search/description-lang-markdown@android": browser(
		"search-screen-text-android",
	),
	"case-search/hint-lang@android": browser("search-screen-text-android"),
	"case-search/appearance-barcode-scan@web-apps": browser(
		"barcode-search-field-web-apps",
	),
	"application-and-settings/logo-refs-hq-logo-web-apps@android":
		browser("logo-android"),

	// ── Stated ─────────────────────────────────────────────────────────
	"expressions-and-data/json-property@web-apps": stated("json-property"),
	"expressions-and-data/json-property@android": stated("json-property"),
	"expressions-and-data/lower-case@web-apps": stated("case-conversion"),
	"expressions-and-data/lower-case@android": stated("case-conversion"),
	"expressions-and-data/upper-case@web-apps": stated("case-conversion"),
	"expressions-and-data/upper-case@android": stated("case-conversion"),
	"expressions-and-data/regex@android": stated("text-pattern"),
	"expressions-and-data/replace@android": stated("text-pattern"),
	"questions/label-image-audio-video-same-asset-every-language@web-apps":
		statedInDocs,
	"questions/label-image-audio-video-same-asset-every-language@android":
		statedInDocs,

	// ── Outside Preview ────────────────────────────────────────────────
	"application-and-settings/translations-lang-code-language-display-names-equal-to-the-label@web-apps":
		outside(
			"The language menu is Nova's own control, not the running app's; Web Apps names languages itself.",
		),
	"application-and-settings/profile-feature-checkoff@web-apps": outside(
		"A profile feature only Android reads; Preview keeps no saved forms on either platform.",
	),
	"application-and-settings/profile-custom-properties-cc-index-case-search-results-equal-to@android":
		outside(
			"A profile property Android doesn't read; Preview reads no profile.",
		),
	"application-and-settings/20-properties-cc-show-saved@web-apps": outside(
		"Web Apps has no saved-forms list; Preview's Android home shows the setting's button.",
	),
	"application-and-settings/21-properties-cc-show-incomplete@web-apps": outside(
		"Web Apps lists unfinished form sessions from its own store; Preview keeps no unfinished forms.",
	),
	"application-and-settings/1-properties-cc-autoup-freq@web-apps":
		PROFILE_PROPERTY_ONLY_ANDROID_READS,
	"application-and-settings/4-properties-cc-days-form-retain@web-apps":
		PROFILE_PROPERTY_ONLY_ANDROID_READS,
	"application-and-settings/5-properties-logenabled@web-apps":
		PROFILE_PROPERTY_ONLY_ANDROID_READS,
	"application-and-settings/17-properties-cc-content-valid@web-apps":
		PROFILE_PROPERTY_ONLY_ANDROID_READS,
	"application-and-settings/18-properties-unsent-number-limit@web-apps":
		PROFILE_PROPERTY_ONLY_ANDROID_READS,
	"application-and-settings/19-properties-unsent-time-limit@web-apps":
		PROFILE_PROPERTY_ONLY_ANDROID_READS,
	"application-and-settings/22-properties-cc-resize-images@web-apps":
		PROFILE_PROPERTY_ONLY_ANDROID_READS,
	"application-and-settings/25-properties-cc-login-duration-seconds@web-apps":
		PROFILE_PROPERTY_ONLY_ANDROID_READS,
	"application-and-settings/26-properties-cc-inflation-target-density@web-apps":
		PROFILE_PROPERTY_ONLY_ANDROID_READS,
	"application-and-settings/27-properties-cc-gps-auto-capture-accuracy@web-apps":
		PROFILE_PROPERTY_ONLY_ANDROID_READS,
	"application-and-settings/28-properties-cc-maps-default-layer@web-apps":
		PROFILE_PROPERTY_ONLY_ANDROID_READS,
	"application-and-settings/29-properties-cc-enable-tts@web-apps":
		PROFILE_PROPERTY_ONLY_ANDROID_READS,
	"application-and-settings/30-properties-cc-label-required-questions-with-asterisk@web-apps":
		PROFILE_PROPERTY_ONLY_ANDROID_READS,
	"forms-and-case-writes/usercase-datum-usercase-id-assertion-case-autoload-usercase-case@web-apps":
		outside(
			"Preview always holds the worker's own record, so the assertion never fails in Preview.",
		),
	"forms-and-case-writes/usercase-datum-usercase-id-assertion-case-autoload-usercase-case@android":
		outside(
			"Preview always holds the worker's own record, so the assertion never fails in Preview.",
		),
	"menus-and-case-lists/19p-enum-image-whose-keys-are-conditions-contain-any-of-each-a@android":
		outside(
			"It differs only in an icon-text-grid tile, which Nova never writes.",
		),
	"menus-and-case-lists/enum-mappingitem-alt-text-lang@android": outside(
		"Nova writes blank alt text, which no runtime shows.",
	),
	"questions/hq-generated-pollsensor@web-apps": outside(
		"The location poll fills the submission's meta location, which Preview does not write; a Connect app's use of it is refused in Web Apps.",
	),
	"questions/hq-generated-meta-deviceid-timestart-timeend-username-userid@web-apps":
		outside(
			"The runtime writes the submission's meta block, which Preview does not write; authored reads of these values go through the session context.",
		),
	"questions/h-title-and-data-name-whatever-their-text@web-apps": outside(
		"A saved form's name on Android's saved list; Preview keeps no saved forms.",
	),
	"questions/plain-label-containing-html-text@web-apps": outside(
		"Nova writes a markdown form for every label, so a label without one never reaches a runtime.",
	),
	"questions/plain-label-containing-html-text@android": outside(
		"Nova writes a markdown form for every label, so a label without one never reaches a runtime.",
	),
};
