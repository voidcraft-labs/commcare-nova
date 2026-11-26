// lib/commcare/surface/platformFeatureEntries.ts
//
// The surface manifest entries each platform feature of
// `lib/domain/platforms.ts` stands for, and the HELD entries that differ by
// platform and that no author choice reaches. Read only by tests:
// `__tests__/platformFeatures.test.ts` holds the table to the manifest's
// per-platform readings through these ids. This module holds entry ids as
// strings and nothing of the manifest JSON, which never ships to the browser.

import type { PlatformFeatureId } from "@/lib/domain/platforms";

/** Each platform feature's manifest entries, in inventory order. */
export const PLATFORM_FEATURE_ENTRIES = {
	"datetime-question": ["questions/date-and-time-xsd-datetime"],
	"worker-distance": ["menus-and-case-lists/9-distance"],
	"sort-by-distance": ["menus-and-case-lists/type-distance"],
	"saved-form-descriptor": [
		"questions/a-question-text-whose-itext-id-is-pragma-form-descriptor-where",
	],
	"web-apps-form-behavior": [
		"questions/a-question-text-label-hint-help-validation-message-repeat-add",
		"questions/a-question-text-whose-itext-id-is-a-web-apps-presence-pragma",
	],
	"case-list-icon-actions": [
		"menus-and-case-lists/16-clickable-icon-endpoint-action-id-on-the-case-list",
	],
	"case-list-here": [
		"expressions-and-data/here-in-a-case-list-calculated-column-or-sort",
	],
	"forms-read-search": [
		"case-search/inline-search-true-auto-launch-true-on-a-module-with-visible",
		"case-search/inline-search-true-auto-launch-true-on-a-module-without-visible",
		"case-search/inline-search-default-search-on-a-module-without-visible-inputs",
		"case-search/inline-search-default-search-on-a-module-with-visible-inputs",
		"menus-and-case-lists/inline-search-in-a-parent-select-module-hq-adds-xpath-query",
		"menus-and-case-lists/case-list-form-on-a-search-first-host-pointing-at-a-registration",
		"expressions-and-data/search-input-read-in-form-expressions-of-an-inline-search-module",
		"expressions-and-data/search-input-read-in-the-forms-of-a-child-menu-of-an-inline-search-menu",
		"expressions-and-data/search-input-results-read-in-the-case-list-of-an-inline-search",
	],
	"search-on-clear": ["case-search/search-on-clear"],
	"list-first": [
		"case-search/list-first-where-web-apps-is-declared",
		"case-search/list-first-with-a-search-that-skips-to-results",
	],
	"form-submit-wording": ["forms-and-case-writes/submit-label-non-default"],
	"auto-select-confirm": [
		"menus-and-case-lists/auto-select-case-on-an-advanced-module",
	],
	"several-cases": [
		"menus-and-case-lists/detail-multi-select",
		"menus-and-case-lists/detail-max-select-value-on-a-multi-select-basic-list",
		"expressions-and-data/selected-cases-search-selected-cases-parent-selected-cases-jr",
	],
	"search-field-single-date": ["case-search/input-date"],
	"search-field-multiple-choice": [
		"case-search/input-select-multi-lookup-itemset",
	],
	"connect-app": [
		"application-and-settings/connect-app-opened-in-the-connect-app",
	],
	"case-list-search-text": ["expressions-and-data/session-data-stringquery"],
	"window-width": [
		"expressions-and-data/session-context-window-width",
		"case-search/runtime-values-read-from-the-session-context-window-width",
	],
	"location-question": ["questions/gps-geopoint"],
	"barcode-question": ["questions/barcode-barcode"],
	"image-size": [
		"questions/jr-imagedimensionscaledmax-250-500-1000px-or-another-positive",
	],
	"image-question": ["questions/image-capture-upload-image"],
	"audio-question": ["questions/audio-capture-audio"],
	"video-question": ["questions/video-capture-video"],
	"question-pages": [
		"questions/question-list-group-appearance-field-list-labelled",
		"questions/question-list-unlabelled-when-every-root-field-is-a-section-and",
		"questions/question-list-unlabelled-anywhere-else",
		"questions/groups-nested-in-a-question-list",
	],
	"choice-grid": [
		"questions/select1-compact-compact-n",
		"questions/select-compact-compact-n",
	],
	"choice-advance": [
		"questions/select1-quick",
		"questions/select1-quick-compact-n",
	],
	"choice-multiword": ["questions/select1-combobox-multiword"],
	"choice-fuzzy": ["questions/select1-combobox-fuzzy"],
	"choice-row": ["questions/select1-list", "questions/select-list"],
	"choice-cycle": ["questions/select1-button-select"],
	"question-receiver": [
		"questions/select1-receive-topic-field",
		"questions/text-receive-topic-field",
		"questions/secret-receive-topic-field",
	],
	"secret-keypad": ["questions/secret-numeric"],
	"android-keypad": ["questions/text-secret-numbers"],
	"short-input": ["questions/short"],
	"medium-input": ["questions/medium"],
	"address-lookup": ["questions/text-address", "questions/secret-address"],
	"question-sender": [
		"questions/broadcast-topic-an-address-entry-under-the-gates-above-and",
	],
	"barcode-text-options": [
		"questions/barcode-numeric-address-or-receive-topic-field",
	],
	"placeholder-hint": [
		"questions/hint-as-placeholder-on-text-other-than-a-secret-without-numeric",
	],
	"hide-web-hint": ["questions/hint-as-placeholder-on-any-other-entry"],
	"auto-scan": ["questions/barcode-quick"],
	"android-calendar": [
		"questions/date-nepali",
		"questions/date-gregorian-gregorian-cancel",
	],
	"twelve-hour-clock": ["questions/time-12-hour"],
	"android-map": ["questions/geopoint-maps"],
	"edit-scan": ["questions/barcode-editable"],
	"camera-only": ["questions/image-acquire", "questions/video-acquire"],
	"face-camera": ["questions/face-capture-image-face"],
	"photo-overlay": ["questions/image-overlay-small"],
	"classic-recorder": ["questions/audio-legacy"],
	"record-or-choose": ["questions/audio-acquire-or-upload"],
	"long-recording": ["questions/audio-long"],
	"select-label-text": ["questions/trigger-selectable"],
	"question-banner": ["questions/floating-good-floating-caution-floating-bad"],
	"hidden-label": [
		"questions/a-label-whose-appearance-string-starts-with-floating-other-than",
	],
	"compact-group": ["questions/group-compact"],
	"collapse-group": [
		"questions/group-group-collapse",
		"questions/group-collapse-open",
	],
	"group-border": ["questions/group-group-border"],
	"questions-across": [
		"questions/n-per-row-any-question-or-group-other-than-a-vellum-repeat-n-one",
	],
	"repeats-across": [
		"questions/n-per-row-repeat-group-with-a-repeat-as-a-direct-child-n-one-or",
	],
	"question-alignment": ["questions/text-align-center-text-align-right"],
	"combined-question-display": [
		"questions/multi-token-strings-e-g-minimal-hint-as-placeholder-signature-2",
	],
	"answer-name-requires-android": [
		"questions/submitted-answer-name-only-android-stores",
	],
	"android-app-question": [
		"questions/android-app-callout-input-appearance-intent-id-bind-type-intent",
	],
	"android-app-answer": [
		"questions/intent-id-on-any-input-other-than-an-intent-typed-one-where-id",
	],
	"number-keypad": ["questions/phone-number-xsd-string-appearance-numeric"],
	"row-starting-value": [
		"questions/hidden-value-with-both-calculate-and-a-default-by-any-expression",
	],
	"plain-text": [
		"questions/plain-label-containing-html-text",
		"questions/choice-label-with-no-markdown-form",
		"questions/help-text-with-no-markdown-form",
	],
	"choice-media": ["questions/choice-image", "questions/choice-audio-video"],
	"help-media": [
		"questions/help-media",
		"questions/help-media-on-a-capture-question-or-a-label",
	],
	"confirm-message": [
		"questions/acknowledge-label-a-trigger-whose-appearance-is-neither-exactly",
	],
	"label-inline-video": ["questions/label-video-inline"],
	"label-qr-code": ["questions/label-qrcode"],
	"label-spoken-text": ["questions/label-tts"],
	now: ["expressions-and-data/now"],
	today: ["expressions-and-data/today"],
	"random-and-unique-id": [
		"expressions-and-data/random",
		"expressions-and-data/uuid",
	],
	pause: ["expressions-and-data/sleep"],
	"date-as-number": [
		"expressions-and-data/int",
		"expressions-and-data/double",
		"expressions-and-data/number",
	],
	"json-property": ["expressions-and-data/json-property"],
	"case-conversion": [
		"expressions-and-data/lower-case",
		"expressions-and-data/upper-case",
	],
	"text-pattern": [
		"expressions-and-data/regex",
		"expressions-and-data/replace",
	],
	"device-id": ["expressions-and-data/session-context-deviceid"],
	"app-version": ["expressions-and-data/session-context-appversion"],
	"clock-drift": [
		"expressions-and-data/session-context-drift",
		"case-search/runtime-values-read-from-the-session-context-drift",
	],
	"app-language": ["expressions-and-data/session-context-applanguage"],
	"entry-points": [
		"menus-and-case-lists/session-endpoint-id",
		"menus-and-case-lists/case-list-session-endpoint-id",
		"forms-and-case-writes/session-endpoint-id",
		"menus-and-case-lists/shadowmodule-form-session-endpoints-non-empty",
	],
	"menu-layout": [
		"application-and-settings/46-hq-use-grid-menus",
		"application-and-settings/47-hq-grid-form-menus-none-all-some",
		"menus-and-case-lists/module-display-style-list-grid-read-when-grid-form-menus-some-on",
	],
	"case-list-menu-item": [
		"menus-and-case-lists/module-case-list-on-a-formless-basic-module-show-true",
		"menus-and-case-lists/module-case-list-show-true-on-a-basic-module-with-forms",
		"menus-and-case-lists/module-case-list-show-true-on-an-advancedmodule",
	],
	"case-list-registration-media": [
		"menus-and-case-lists/case-list-form-media-image-media-audio",
	],
	"menu-badge": [
		"forms-and-case-writes/custom-icons-0",
		"menus-and-case-lists/custom-icons-0-badge-localized-text-or-xpath",
	],
	"named-case-tile": [
		"menus-and-case-lists/detail-case-tile-template-icon-text-grid",
		"menus-and-case-lists/case-tile-field-template-slot-on-icon-text-grid",
		// An image column differs only in a named tile's image position.
		"menus-and-case-lists/19p-enum-image-whose-keys-are-conditions-contain-any-of-each-a",
		"menus-and-case-lists/19-enum-image-whose-keys-are-plain-values",
		"menus-and-case-lists/19pp-enum-image-whose-keys-are-conditions-of-any-other-form-dot",
	],
	"details-tile": [
		"menus-and-case-lists/long-detail-custom-tile-case-detail-laid-out-as-a-tile",
	],
	"raw-custom-tile-field": [
		"menus-and-case-lists/invisible-or-address-column-in-a-custom-tile",
	],
	"tile-grouping": [
		"menus-and-case-lists/detail-case-tile-group-index-identifier-header-rows",
	],
	"case-list-faster-loading": [
		"menus-and-case-lists/module-show-case-list-optimization-options",
		"menus-and-case-lists/optimization-cache-lazy-load-cache-and-lazy-load",
	],
	"case-list-empty-text": [
		"menus-and-case-lists/detail-no-items-text-other-than-hq-s-default-en-list-is-empty",
	],
	"case-list-continue-label": [
		"menus-and-case-lists/detail-select-text-non-default",
	],
	"tile-alignment": ["menus-and-case-lists/horizontal-align-vertical-align"],
	"tile-border-and-shading": ["menus-and-case-lists/show-border-show-shading"],
	"column-hidden-from-results": [
		"menus-and-case-lists/7-invisible-search-only-on-the-case-list-outside-a-custom-tile",
	],
	"case-list-sort-label": [
		"menus-and-case-lists/display-lang-sort-by-label-on-a-sort-only-element",
		"menus-and-case-lists/display-lang-on-a-sort-joined-to-an-invisible-column",
	],
	"case-image-descriptions": [
		"menus-and-case-lists/enum-mappingitem-alt-text-lang",
		"menus-and-case-lists/enum-mappingitem-alt-text-non-blank",
	],
	"case-map-location": ["menus-and-case-lists/8-address"],
	"case-map-fallback-locations": [
		"menus-and-case-lists/more-than-one-address-column-in-a-detail-of-an-advanced-module",
	],
	"case-map-layers": [
		"menus-and-case-lists/11-geo-boundary",
		"menus-and-case-lists/12-geo-boundary-color-on-the-case-list-only-needs-an-address",
		"menus-and-case-lists/13-geo-points-on-the-case-list-only",
		"menus-and-case-lists/14-geo-points-colors-on-the-case-list-only-needs-an-address",
	],
	"formatted-case-text": [
		"menus-and-case-lists/10-markdown-outside-the-link-shape",
	],
	"link-column": [
		"menus-and-case-lists/10-markdown-any-property-or-expression",
	],
	"search-screen-text": [
		"case-search/title-label-lang-non-empty",
		"case-search/title-label-blank-in-some-languages",
		"case-search/description-lang-markdown",
		"case-search/hint-lang",
	],
	"search-field-checks": [
		"case-search/required-test-text",
		"case-search/validations-0-test-text",
		"case-search/a-required-or-validation-test-with-no-message-in-any-language",
	],
	"search-starting-dates": ["case-search/default-value-on-a-date-range-input"],
	"barcode-search-field": ["case-search/appearance-barcode-scan"],
	"search-field-groups": ["case-search/is-group-group-key"],
	"search-for-blank": ["case-search/allow-blank-value"],
	"hidden-search-field": [
		"case-search/hidden-exclude-with-a-default-value-on-a-prompt-with-no-itemset",
		"case-search/hidden-exclude-without-a-default-value-on-a-prompt-with-no",
		"case-search/hidden-without-exclude-on-a-prompt-with-no-itemset-input-type-or",
		"case-search/hidden-on-a-prompt-that-carries-an-itemset-input-type-or",
	],
	"search-first": [
		"case-search/workflow-search-first-auto-launch-true-default-search-false",
	],
	search: [
		"case-search/the-generated-search-round-trip-remote-request-query-results",
	],
	"skip-to-results": [
		"case-search/workflow-skip-to-default-results-auto-launch-true-default-search",
	],
	"first-menu-previous": [
		"forms-and-case-writes/form-link-or-endpoint-through-a-first-menu-that-shares-one-case",
		"menus-and-case-lists/case-list-form-on-a-host-under-a-menu-that-shares-the-first-menu-s-case",
		"forms-and-case-writes/post-form-workflow-previous-screen-on-a-form-listed-on-the-first-menu",
	],
	"after-submit-home": ["forms-and-case-writes/post-form-workflow-default"],
	"after-submit-several-destinations": [
		"forms-and-case-writes/two-or-more-form-links-conditions-true-at-once",
	],
	"app-logo": ["application-and-settings/logo-refs-hq-logo-web-apps"],
	"required-android-apps": [
		"application-and-settings/31-features-dependencies",
	],
	"saved-forms": ["application-and-settings/20-properties-cc-show-saved"],
	"incomplete-forms": [
		"application-and-settings/21-properties-cc-show-incomplete",
	],
	"connect-location-capture": [
		"application-and-settings/45-hq-auto-gps-capture",
		"application-and-settings/45p-hq-auto-gps-capture-on-an-app-that-is-not-a-connect-app",
		"forms-and-case-writes/auto-gps-capture-form",
		"questions/hq-generated-pollsensor",
	],
} as const satisfies Readonly<
	Record<PlatformFeatureId, readonly [string, ...string[]]>
>;

/** HELD entries that differ by platform and that no author choice reaches, with why. */
export const AMBIENT_PLATFORM_ENTRIES = {
	"questions/any-other-per-row-token-the-first-token-web-apps-per-row-pattern":
		"Nova writes the normalized number of items or repeats per row. The spelling of an equivalent number is determined at export.",
	"questions/a-multi-token-string-holding-tokens-no-runtime-reads-on-that":
		"Nova writes the active settings. An unrecognized word alongside them is never an author choice.",
	"questions/a-single-string-no-row-names-that-holds-values-android-matches":
		"Nova writes the Android control and its parameters using their canonical spelling. An incidental substring is never an author choice.",
	"questions/a-case-variant-of-numbers-nepali-or-maps-of-video-acquire-or-of":
		"Nova writes the calendar, camera, map and keyboard settings using their canonical spelling. Capitalization is outside the document.",
	"application-and-settings/hq-default-app-strings":
		"Every local archive carries HQ's default strings; Web Apps reads HQ's build, not Nova's archive.",
	"application-and-settings/translations-lang-code-language-display-names-equal-to-the-label":
		"Derived from each language's identity; Web Apps names languages itself.",
	"application-and-settings/profile-feature-checkoff":
		"Nova writes it on every app; the saved-forms setting carries the author's choice.",
	"application-and-settings/profile-custom-properties-cc-index-case-search-results-equal-to":
		"Derived from the search configuration; no author sets it.",
	"application-and-settings/40-hq-cloudcare-enabled":
		"The platform declaration's own wire form; Android reads no cloudcare_enabled.",
	"case-search/auto-launch-false-in-an-app-with-cloudcare-enabled-false":
		"The wire form of list first in an app that declares Android only, which no Web App reads; `list-first` states list first's readings.",
	"expressions-and-data/commcaresession-jr-instance-session":
		"The session instance itself; each context field's feature states its difference.",
	"expressions-and-data/lookup-table-rows-in-the-local-archive-suite":
		"The local archive's embedded tables; Web Apps installs no archive.",
	"forms-and-case-writes/usercase-datum-usercase-id-assertion-case-autoload-usercase-case":
		"The missing worker-record notice; no author chooses its screen.",
	"questions/hq-generated-meta-deviceid-timestart-timeend-username-userid":
		"The submission's meta block; authored reads go through the session context features.",
	"questions/h-title-and-data-name-whatever-their-text":
		"A saved form's name on Android, derived from the form's name.",
	"questions/markdown-form-equal-to-the-default-text":
		"How each platform renders every label's markdown; stated once in the public docs.",
	"questions/a-markdown-form-in-some-languages-only-each-other-language-holding-the-default-s":
		"The same markdown text as a copy in every language; renderer only.",
	"questions/label-image-audio-video-same-asset-every-language":
		"Renderer only.",
	"questions/hint-text-on-a-label":
		"The platform renders the message’s hint like any other hint.",
	"questions/help-text-on-a-capture-question-or-a-label":
		"The platform renders help on messages and attachments like any other help text.",
	"questions/hint-text":
		"Renderer only: markdown on Web Apps, plain on Android.",
	"questions/help-text-markdown-form": "Renderer only.",
	"questions/choice-label-text-markdown": "Renderer only.",
	"questions/group-repeat-label-text-markdown": "Renderer only.",
} as const satisfies Readonly<Record<string, string>>;
