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

export const PLATFORM_CELLS: Readonly<
	Record<`${string}@${Platform}`, PlatformCell>
> = {
	// A visit on each worker exercises the settings that change an entry or its saved answer.
	"questions/select1-compact-compact-n@web-apps": browser(
		"visit-display-web-apps",
	),
	"questions/select1-quick@web-apps": stated("choice-advance"),
	"questions/select1-quick-compact-n@web-apps": browser(
		"visit-display-web-apps",
	),
	"questions/select1-combobox-multiword@web-apps": browser(
		"visit-display-web-apps",
	),
	"questions/select1-combobox-fuzzy@web-apps": browser(
		"visit-display-web-apps",
	),
	"questions/select1-list@web-apps": stated("choice-row"),
	"questions/select1-button-select@android": browser("visit-display-android"),
	"questions/select1-receive-topic-field@android": stated("question-receiver"),
	"questions/select-compact-compact-n@web-apps": stated("choice-grid"),
	"questions/select-list@web-apps": stated("choice-row"),
	"questions/secret-numeric@web-apps": browser("visit-display-web-apps"),
	"questions/text-secret-numbers@web-apps": stated("android-keypad"),
	"questions/short@android": browser("visit-display-android"),
	"questions/medium@android": stated("medium-input"),
	"questions/text-address@android": stated("address-lookup"),
	"questions/secret-address@android": browser("visit-display-android"),
	"questions/broadcast-topic-an-address-entry-under-the-gates-above-and@android":
		stated("question-sender"),
	"questions/text-receive-topic-field@android": stated("question-receiver"),
	"questions/secret-receive-topic-field@android": stated("question-receiver"),
	"questions/barcode-numeric-address-or-receive-topic-field@web-apps": stated(
		"barcode-text-options",
	),
	"questions/barcode-numeric-address-or-receive-topic-field@android": stated(
		"barcode-text-options",
	),
	"questions/hint-as-placeholder-on-text-other-than-a-secret-without-numeric@android":
		browser("visit-display-android"),
	"questions/hint-as-placeholder-on-any-other-entry@web-apps": browser(
		"visit-display-web-apps",
	),
	"questions/hint-as-placeholder-on-any-other-entry@android": browser(
		"visit-display-android",
	),
	"questions/barcode-quick@web-apps": stated("auto-scan"),
	"questions/date-nepali@web-apps": stated("android-calendar"),
	"questions/date-gregorian-gregorian-cancel@web-apps":
		stated("android-calendar"),
	"questions/time-12-hour@android": stated("twelve-hour-clock"),
	"questions/geopoint-maps@web-apps": stated("android-map"),
	"questions/barcode-editable@web-apps": stated("edit-scan"),
	"questions/face-capture-image-face@web-apps": browser("face-photo-web-apps"),
	"questions/image-acquire@web-apps": browser("visit-display-web-apps"),
	"questions/image-overlay-small@web-apps": stated("photo-overlay"),
	"questions/audio-legacy@web-apps": stated("classic-recorder"),
	"questions/audio-acquire-or-upload@web-apps": stated("record-or-choose"),
	"questions/audio-long@web-apps": browser("visit-display-web-apps"),
	"questions/video-acquire@web-apps": browser("visit-display-web-apps"),
	"questions/trigger-selectable@web-apps": stated("select-label-text"),
	"questions/floating-good-floating-caution-floating-bad@web-apps": browser(
		"visit-display-web-apps",
	),
	"questions/a-label-whose-appearance-string-starts-with-floating-other-than@web-apps":
		browser("visit-display-web-apps"),
	"questions/a-label-whose-appearance-string-starts-with-floating-other-than@android":
		browser("visit-display-android"),
	"questions/group-compact@web-apps": stated("compact-group"),
	"questions/group-group-collapse@android": browser("visit-display-android"),
	"questions/group-collapse-open@android": stated("collapse-group"),
	"questions/group-group-border@android": stated("group-border"),
	"questions/n-per-row-any-question-or-group-other-than-a-vellum-repeat-n-one@android":
		stated("questions-across"),
	"questions/n-per-row-repeat-group-with-a-repeat-as-a-direct-child-n-one-or@android":
		stated("repeats-across"),
	"questions/any-other-per-row-token-the-first-token-web-apps-per-row-pattern@android":
		statedInDocs,
	"questions/text-align-center-text-align-right@android":
		stated("question-alignment"),
	"questions/multi-token-strings-e-g-minimal-hint-as-placeholder-signature-2@web-apps":
		browser("visit-display-web-apps"),
	"questions/multi-token-strings-e-g-minimal-hint-as-placeholder-signature-2@android":
		browser("visit-display-android"),
	"questions/a-multi-token-string-holding-tokens-no-runtime-reads-on-that@web-apps":
		statedInDocs,
	"questions/a-multi-token-string-holding-tokens-no-runtime-reads-on-that@android":
		statedInDocs,
	"questions/a-single-string-no-row-names-that-holds-values-android-matches@web-apps":
		statedInDocs,
	"questions/a-case-variant-of-numbers-nepali-or-maps-of-video-acquire-or-of@web-apps":
		statedInDocs,

	"questions/android-app-callout-input-appearance-intent-id-bind-type-intent@web-apps":
		structural("android-app-question"),
	"questions/intent-id-on-any-input-other-than-an-intent-typed-one-where-id@web-apps":
		stated("android-app-answer"),
	// ── Refused, structural ────────────────────────────────────────────
	"questions/date-and-time-xsd-datetime@web-apps":
		structural("datetime-question"),
	"menus-and-case-lists/type-distance@web-apps": structural("sort-by-distance"),
	"menus-and-case-lists/9-distance@web-apps": structural("worker-distance"),
	"case-search/inline-search-true-auto-launch-true-on-a-module-with-visible@android":
		structural("forms-read-search"),
	"case-search/inline-search-default-search-on-a-module-without-visible-inputs@android":
		structural("forms-read-search"),
	"menus-and-case-lists/inline-search-in-a-parent-select-module-hq-adds-xpath-query@android":
		structural("forms-read-search"),
	"menus-and-case-lists/case-list-form-on-a-search-first-host-pointing-at-a-registration@android":
		structural("forms-read-search"),
	/* The read is admitted only in a menu whose forms read the search, which
	 * Android refuses. */
	"expressions-and-data/search-input-read-in-form-expressions-of-an-inline-search-module@android":
		structural("forms-read-search"),
	"expressions-and-data/search-input-read-in-the-forms-of-a-child-menu-of-an-inline-search-menu@android":
		structural("forms-read-search"),
	"expressions-and-data/search-input-results-read-in-the-case-list-of-an-inline-search@android":
		structural("forms-read-search"),
	"case-search/inline-search-true-auto-launch-true-on-a-module-without-visible@android":
		structural("forms-read-search"),
	"case-search/inline-search-default-search-on-a-module-with-visible-inputs@android":
		structural("forms-read-search"),
	"menus-and-case-lists/android-only-value-in-a-grouped-tile-body@web-apps":
		structural("raw-grouped-tile-body-field"),
	"case-search/list-first-where-web-apps-is-declared@web-apps":
		structural("list-first"),
	"case-search/list-first-with-a-search-that-skips-to-results@web-apps":
		structural("list-first"),
	"menus-and-case-lists/detail-multi-select@android":
		structural("several-cases"),
	"menus-and-case-lists/detail-max-select-value-on-a-multi-select-basic-list@android":
		structural("several-cases"),
	"menus-and-case-lists/detail-max-select-value-for-flat-close@android":
		structural("several-cases"),
	"expressions-and-data/selected-cases-search-selected-cases-parent-selected-cases-jr@android":
		structural("several-cases"),
	"menus-and-case-lists/detail-auto-select-multi-select@android":
		structural("several-cases"),
	"case-search/is-group-group-key@android": model("search-headings-android"),
	"case-search/input-date@android": structural("search-field-single-date"),
	"case-search/prompt-key-matching-a-direct-parent-date@android": structural(
		"search-field-single-date",
	),
	"case-search/prompt-key-matching-two-parent-links-for-a-date@android":
		structural("search-field-single-date"),
	/* Web Apps can't go on from a list that chose its one record before a
	 * confirmation screen, so the gate keeps that list off Web Apps. */
	"menus-and-case-lists/auto-select-case-on-an-advanced-module@web-apps":
		structural("auto-select-confirm"),
	"case-search/input-select-multi-lookup-itemset@android": structural(
		"search-field-multiple-choice",
	),
	"application-and-settings/connect-app-opened-in-the-connect-app@web-apps":
		structural("connect-app"),
	/* Its only use is a Connect app's, which Web Apps refuses. */
	"application-and-settings/45-hq-auto-gps-capture@web-apps":
		structural("connect-app"),
	"forms-and-case-writes/advanced-open-connection-unicode-name@web-apps":
		structural("advanced-index-name-requires-android"),
	"questions/submitted-answer-name-only-android-stores@web-apps": structural(
		"answer-name-requires-android",
	),
	"questions/answer-root-with-a-non-ascii-name@web-apps": structural(
		"answer-root-name-requires-android",
	),
	"menus-and-case-lists/lookup-with-text-extras@web-apps": stated(
		"case-list-android-lookup",
	),
	"menus-and-case-lists/lookup-responses-key@web-apps": stated(
		"case-list-android-lookup",
	),
	"menus-and-case-lists/lookup-extras-fixed-text@web-apps": stated(
		"case-list-android-lookup",
	),
	"menus-and-case-lists/lookup-autolaunch@web-apps": stated(
		"case-list-android-lookup",
	),
	"menus-and-case-lists/lookup-image-jr@web-apps": stated(
		"case-list-android-lookup",
	),
	"menus-and-case-lists/lookup-extras-worker-context@web-apps": stated(
		"case-list-android-lookup",
	),
	"menus-and-case-lists/lookup-case-id-confidence@web-apps": stated(
		"case-list-android-lookup",
	),
	"menus-and-case-lists/lookup-case-property-confidence@web-apps": stated(
		"case-list-android-lookup",
	),
	"menus-and-case-lists/lookup-name@web-apps": stated(
		"case-list-android-lookup",
	),
	"menus-and-case-lists/16-clickable-icon-endpoint-action-id-on-the-case-list@android":
		structural("case-list-icon-actions"),

	// ── Refused, expression ────────────────────────────────────────────
	"expressions-and-data/here-in-a-case-list-calculated-column-or-sort@web-apps":
		expression("case-list-here"),
	"expressions-and-data/companion-lookup-count@web-apps": expression(
		"case-list-lookup-count",
	),
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
	// Android reads none of the presence pragmas: a form neither submits on
	// open nor rechecks only changed answers there.
	// The real Postgres opening test checks the same key and title on both devices.
	"questions/a-question-text-label-hint-help-validation-message-repeat-add@android":
		statedInDocs,
	"questions/a-question-text-whose-itext-id-is-a-web-apps-presence-pragma@android":
		model("presence-pragmas-on-web-apps-only"),
	"questions/a-question-text-whose-itext-id-is-pragma-form-descriptor-where@web-apps":
		stated("saved-form-descriptor"),
	"questions/hidden-value-with-both-calculate-and-a-default-by-any-expression@web-apps":
		model("row-starting-value"),
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
	"menus-and-case-lists/shadowmodule-form-session-endpoints-non-empty@web-apps":
		model("entry-point-web-apps"),
	"menus-and-case-lists/shadowmodule-form-session-endpoints-non-empty@android":
		model("entry-point-android"),
	"menus-and-case-lists/module-case-list-on-a-formless-basic-module-show-true@web-apps":
		model("case-list-menu-item-web-apps"),
	"menus-and-case-lists/module-case-list-show-true-on-a-basic-module-with-forms@web-apps":
		model("case-list-menu-item-web-apps"),
	"menus-and-case-lists/module-case-list-show-true-on-an-advancedmodule@web-apps":
		model("case-list-menu-item-web-apps"),
	"menus-and-case-lists/case-list-form-media-image-media-audio@web-apps": model(
		"register-action-media",
	),
	"menus-and-case-lists/custom-icons-0-badge-localized-text-or-xpath@android":
		model("menu-badge-android"),
	"forms-and-case-writes/custom-icons-0@android": model("menu-badge-android"),
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
	"menus-and-case-lists/display-lang-sort-by-label-on-a-sort-only-element@web-apps":
		model("sort-label-web-apps"),
	"menus-and-case-lists/display-lang-on-a-sort-joined-to-an-invisible-column@web-apps":
		model("sort-label-web-apps"),
	"menus-and-case-lists/10-markdown-any-property-or-expression@android": model(
		"link-column-raw-android",
	),
	"case-search/address-picker-on-a-search-screen@android": model(
		"search-address-picker-android",
	),
	"case-search/address-picker-receiver-on-a-search-screen@android": model(
		"search-address-picker-android",
	),
	"case-search/address-receiver-on-an-unmatched-topic-without-a-component@web-apps":
		model("search-unmatched-address-topic"),
	"case-search/address-receiver-on-an-unmatched-topic-without-a-component@android":
		model("search-unmatched-address-topic"),
	"case-search/address-picker-with-a-saved-text-default@web-apps": model(
		"saved-address-default",
	),
	"case-search/address-picker-with-a-saved-text-default@android": model(
		"saved-address-default",
	),
	"case-search/search-on-clear@android": model("desktop-search-on-clear"),
	"case-search/default-value-on-a-date-range-input@android": model(
		"starting-dates-android",
	),
	"case-search/default-value-on-a-date-range-input@web-apps": model(
		"starting-dates-web-apps",
	),
	"case-search/required-test-text@android": model(
		"search-field-checks-android",
	),
	"case-search/required-condition-counts-restored-cases@android": model(
		"search-field-checks-android",
	),
	"case-search/validations-0-test-text@android": model(
		"search-field-checks-android",
	),
	"case-search/a-required-or-validation-test-with-no-message-in-any-language@android":
		model("search-field-checks-android"),
	"case-search/hidden-exclude-with-a-default-value-on-a-prompt-with-no-itemset@android":
		model("hidden-search-field-android"),
	"case-search/hidden-exclude-without-a-default-value-on-a-prompt-with-no@android":
		model("hidden-search-field-android"),
	"case-search/hidden-without-exclude-on-a-prompt-with-no-itemset-input-type-or@android":
		model("hidden-search-field-android"),
	"case-search/hidden-on-a-prompt-that-carries-an-itemset-input-type-or@android":
		model("hidden-search-field-android"),
	"case-search/allow-blank-value@android": model("search-for-blank-android"),
	"case-search/the-generated-search-round-trip-remote-request-query-results@android":
		model("search-android"),
	"case-search/workflow-skip-to-default-results-auto-launch-true-default-search@android":
		model("skip-to-results-android"),
	"case-search/workflow-search-first-auto-launch-true-default-search-false@android":
		model("search-first-android"),
	"forms-and-case-writes/form-link-or-endpoint-through-a-first-menu-that-shares-one-case@web-apps":
		model("first-menu-entry-point-web-apps"),
	"forms-and-case-writes/form-link-or-endpoint-through-a-first-menu-that-shares-one-case@android":
		model("first-menu-entry-point-android"),
	"menus-and-case-lists/case-list-form-on-a-host-under-a-menu-that-shares-the-first-menu-s-case@web-apps":
		model("first-menu-registration-web-apps"),
	"menus-and-case-lists/case-list-form-on-a-host-under-a-menu-that-shares-the-first-menu-s-case@android":
		model("first-menu-registration-android"),
	"forms-and-case-writes/post-form-workflow-previous-screen-on-a-form-listed-on-the-first-menu@web-apps":
		model("first-menu-previous-web-apps"),
	"forms-and-case-writes/post-form-workflow-previous-screen-on-a-form-listed-on-the-first-menu@android":
		model("first-menu-previous-android"),
	"forms-and-case-writes/post-form-workflow-default@web-apps": model(
		"after-submit-home-web-apps",
	),
	"forms-and-case-writes/post-form-workflow-default@android": model(
		"after-submit-home-android",
	),
	"forms-and-case-writes/two-or-more-form-links-conditions-true-at-once@web-apps":
		model("after-submit-top-frame-web-apps"),
	"questions/question-list-unlabelled-when-every-root-field-is-a-section-and@web-apps":
		model("form-one-screen-web-apps"),
	"questions/question-list-unlabelled-anywhere-else@web-apps": model(
		"form-one-screen-web-apps",
	),

	// ── Browser ────────────────────────────────────────────────────────
	"questions/gps-geopoint@web-apps": browser("location-map-web-apps"),
	"questions/barcode-barcode@web-apps": browser("barcode-text-web-apps"),
	"questions/phone-number-xsd-string-appearance-numeric@web-apps": browser(
		"number-keypad-web-apps",
	),
	"questions/jr-imagedimensionscaledmax-250-500-1000px-or-another-positive@web-apps":
		browser("image-size-web-apps"),
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
	"questions/label-qrcode@web-apps": model("label-texts"),
	"questions/label-video-inline@web-apps": model("label-texts"),
	"questions/label-tts@web-apps": model("label-texts"),
	"questions/label-tts@android": model("label-texts"),
	"questions/help-text-markdown-form@web-apps": browser("help-web-apps"),
	"questions/help-text-markdown-form@android": browser("help-android"),
	"questions/help-text-with-no-markdown-form@web-apps": browser(
		"help-plain-web-apps",
	),
	"questions/hint-text@web-apps": browser("hint-markdown-web-apps"),
	"questions/hint-text@android": browser("hint-plain-android"),
	// A message's and a capture question's hint and help render through the
	// question row every kind shares, which these scenarios drive.
	"questions/hint-text-on-a-label@web-apps": browser("hint-markdown-web-apps"),
	"questions/hint-text-on-a-label@android": browser("hint-plain-android"),
	"questions/help-text-on-a-capture-question-or-a-label@web-apps":
		browser("help-web-apps"),
	"questions/help-text-on-a-capture-question-or-a-label@android":
		browser("help-android"),
	"questions/help-media-on-a-capture-question-or-a-label@web-apps":
		browser("help-web-apps"),
	"questions/choice-label-text-markdown@web-apps": browser(
		"choice-label-markdown-web-apps",
	),
	"questions/choice-label-text-markdown@android": browser(
		"choice-label-markdown-android",
	),
	"questions/choice-label-with-no-markdown-form@web-apps": browser(
		"choice-label-plain-web-apps",
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
	// Read as a label with markdown on in every language, the same text Preview plays for the
	// markdown form equal to the default's text.
	"questions/a-markdown-form-in-some-languages-only-each-other-language-holding-the-default-s@android":
		browser("label-markdown-android"),
	"case-search/title-label-lang-non-empty@android": browser(
		"search-screen-text-android",
	),
	"case-search/title-label-blank-in-some-languages@android": browser(
		"search-screen-text-android",
	),
	"case-search/description-lang-markdown@android": browser(
		"search-screen-text-android",
	),
	"case-search/hint-lang@android": browser("search-screen-text-android"),
	"menus-and-case-lists/detail-no-items-text-other-than-hq-s-default-en-list-is-empty@android":
		model("case-list-own-wording"),
	// How soon a value shows and whether it is kept between visits: Preview reads every value
	// from the Project's cases as it draws the list, on either platform.
	"menus-and-case-lists/module-show-case-list-optimization-options@web-apps":
		outside("loading speed and caching on the device"),
	"menus-and-case-lists/optimization-cache-lazy-load-cache-and-lazy-load@web-apps":
		outside("loading speed and caching on the device"),
	"menus-and-case-lists/detail-select-text-non-default@web-apps": model(
		"case-list-own-wording",
	),
	"menus-and-case-lists/detail-select-text-non-default@android": model(
		"case-list-own-wording",
	),
	"case-search/appearance-barcode-scan@web-apps": browser(
		"barcode-search-field-web-apps",
	),
	"application-and-settings/logo-refs-hq-logo-web-apps@android":
		browser("logo-android"),

	// ── Stated ─────────────────────────────────────────────────────────
	"questions/plain-label-containing-html-text@web-apps": stated("plain-text"),
	"forms-and-case-writes/submit-label-non-default@android": stated(
		"form-submit-wording",
	),
	"expressions-and-data/json-property@web-apps": stated("json-property"),
	"menus-and-case-lists/8-address@web-apps": stated("case-map-location"),
	// A named tile's icon positions, a Details tile and a raw field on a
	// custom tile read differently on Android; each feature's note states it
	// where the builder offers the layout.
	"menus-and-case-lists/detail-case-tile-template-icon-text-grid@android":
		stated("named-case-tile"),
	"menus-and-case-lists/case-tile-field-template-slot-on-icon-text-grid@android":
		stated("named-case-tile"),
	"menus-and-case-lists/long-detail-custom-tile-case-detail-laid-out-as-a-tile@android":
		stated("details-tile"),
	"menus-and-case-lists/standalone-search-result-detail-text@android":
		structural("search-result-detail-text"),
	"menus-and-case-lists/inline-search-result-own-text-property@android":
		structural("forms-read-search"),
	"menus-and-case-lists/invisible-or-address-column-in-a-custom-tile@android":
		stated("raw-custom-tile-field"),
	"menus-and-case-lists/11-geo-boundary@web-apps": stated("case-map-layers"),
	"menus-and-case-lists/12-geo-boundary-color-on-the-case-list-only-needs-an-address@web-apps":
		stated("case-map-layers"),
	"menus-and-case-lists/13-geo-points-on-the-case-list-only@web-apps":
		stated("case-map-layers"),
	"menus-and-case-lists/14-geo-points-colors-on-the-case-list-only-needs-an-address@web-apps":
		stated("case-map-layers"),
	"menus-and-case-lists/10-markdown-outside-the-link-shape@android": stated(
		"formatted-case-text",
	),
	"menus-and-case-lists/enum-mappingitem-alt-text-non-blank@android": model(
		"case-image-description-android",
	),
	"menus-and-case-lists/more-than-one-address-column-in-a-detail-of-an-advanced-module@android":
		model("case-map-fallback-android"),
	"expressions-and-data/json-property@android": stated("json-property"),
	"expressions-and-data/lower-case@web-apps": stated("case-conversion"),
	"expressions-and-data/lower-case@android": stated("case-conversion"),
	"expressions-and-data/upper-case@web-apps": stated("case-conversion"),
	"expressions-and-data/upper-case@android": stated("case-conversion"),
	"questions/acknowledge-label-a-trigger-whose-appearance-is-neither-exactly@web-apps":
		stated("confirm-message"),
	"expressions-and-data/regex@android": stated("text-pattern"),
	"expressions-and-data/replace@android": stated("text-pattern"),
	/* An ordinary app's and a form's location request: the builder's note
	 * says forms sent from Web Apps carry no location. */
	"application-and-settings/45p-hq-auto-gps-capture-on-an-app-that-is-not-a-connect-app@web-apps":
		stated("connect-location-capture"),
	"forms-and-case-writes/auto-gps-capture-form@web-apps": stated(
		"connect-location-capture",
	),
	/* The apps a worker needs on Android: the builder's note says workers
	 * can still open the app in a browser. */
	"application-and-settings/31-features-dependencies@web-apps": stated(
		"required-android-apps",
	),
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
	"menus-and-case-lists/19-enum-image-whose-keys-are-plain-values@android":
		outside(
			"It differs only in an icon-text-grid tile, which Nova never writes.",
		),
	"menus-and-case-lists/19pp-enum-image-whose-keys-are-conditions-of-any-other-form-dot@android":
		outside(
			"It differs only in an icon-text-grid tile, which Nova never writes.",
		),
	"menus-and-case-lists/enum-mappingitem-alt-text-lang@android": model(
		"case-image-description-android",
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
};
