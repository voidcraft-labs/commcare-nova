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
	"case-list-here": [
		"expressions-and-data/here-in-a-case-list-calculated-column-or-sort",
	],
	"search-first": [
		"case-search/inline-search-true-auto-launch-true-on-a-module-with-visible",
		"case-search/inline-search-default-search-on-a-module-without-visible-inputs",
		"menus-and-case-lists/inline-search-in-a-parent-select-module-hq-adds-xpath-query",
		"menus-and-case-lists/case-list-form-on-a-search-first-host-pointing-at-a-registration",
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
	"location-question": ["questions/gps-geopoint"],
	"barcode-question": ["questions/barcode-barcode"],
	"image-question": ["questions/image-capture-upload-image"],
	"audio-question": ["questions/audio-capture-audio"],
	"video-question": ["questions/video-capture-video"],
	"question-pages": [
		"questions/question-list-group-appearance-field-list-labelled",
		"questions/question-list-unlabelled-when-every-root-field-is-a-section-and",
		"questions/groups-nested-in-a-question-list",
	],
	"choice-media": ["questions/choice-image", "questions/choice-audio-video"],
	"help-media": ["questions/help-media"],
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
	"entry-points": [
		"menus-and-case-lists/session-endpoint-id",
		"menus-and-case-lists/case-list-session-endpoint-id",
		"forms-and-case-writes/session-endpoint-id",
	],
	"case-list-menu-item": [
		"menus-and-case-lists/module-case-list-on-a-formless-basic-module-show-true",
	],
	"tile-grouping": [
		"menus-and-case-lists/detail-case-tile-group-index-identifier-header-rows",
	],
	"tile-alignment": ["menus-and-case-lists/horizontal-align-vertical-align"],
	"tile-border-and-shading": ["menus-and-case-lists/show-border-show-shading"],
	"column-hidden-from-results": [
		"menus-and-case-lists/7-invisible-search-only-on-the-case-list-outside-a-custom-tile",
	],
	"link-column": [
		"menus-and-case-lists/10-markdown-any-property-or-expression",
	],
	"search-screen-text": [
		"case-search/title-label-lang-non-empty",
		"case-search/description-lang-markdown",
		"case-search/hint-lang",
	],
	"search-field-checks": [
		"case-search/required-test-text",
		"case-search/validations-0-test-text",
	],
	"barcode-search-field": ["case-search/appearance-barcode-scan"],
	"hidden-search-field": [
		"case-search/hidden-exclude-with-a-default-value-on-a-prompt-with-no-itemset",
	],
	search: [
		"case-search/the-generated-search-round-trip-remote-request-query-results",
	],
	"skip-to-results": [
		"case-search/workflow-skip-to-default-results-auto-launch-true-default-search",
	],
	"after-submit-home": ["forms-and-case-writes/post-form-workflow-default"],
	"app-logo": ["application-and-settings/logo-refs-hq-logo-web-apps"],
	"saved-forms": ["application-and-settings/20-properties-cc-show-saved"],
	"incomplete-forms": [
		"application-and-settings/21-properties-cc-show-incomplete",
	],
	"connect-location-capture": [
		"application-and-settings/45-hq-auto-gps-capture",
		"questions/hq-generated-pollsensor",
	],
} as const satisfies Readonly<
	Record<PlatformFeatureId, readonly [string, ...string[]]>
>;

/** Nova writes the value a device reads when the key is absent; no author
 * choice until `appSettings` holds it. */
const SEEDED_PROFILE_PROPERTY =
	"Nova writes the value a device reads when the key is absent; no author choice until appSettings holds it.";

/** HELD entries that differ by platform and that no author choice reaches, with why. */
export const AMBIENT_PLATFORM_ENTRIES = {
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
	"application-and-settings/1-properties-cc-autoup-freq":
		SEEDED_PROFILE_PROPERTY,
	"application-and-settings/4-properties-cc-days-form-retain":
		SEEDED_PROFILE_PROPERTY,
	"application-and-settings/5-properties-logenabled": SEEDED_PROFILE_PROPERTY,
	"application-and-settings/17-properties-cc-content-valid":
		SEEDED_PROFILE_PROPERTY,
	"application-and-settings/18-properties-unsent-number-limit":
		SEEDED_PROFILE_PROPERTY,
	"application-and-settings/19-properties-unsent-time-limit":
		SEEDED_PROFILE_PROPERTY,
	"application-and-settings/22-properties-cc-resize-images":
		SEEDED_PROFILE_PROPERTY,
	"application-and-settings/25-properties-cc-login-duration-seconds":
		SEEDED_PROFILE_PROPERTY,
	"application-and-settings/26-properties-cc-inflation-target-density":
		SEEDED_PROFILE_PROPERTY,
	"application-and-settings/27-properties-cc-gps-auto-capture-accuracy":
		SEEDED_PROFILE_PROPERTY,
	"application-and-settings/28-properties-cc-maps-default-layer":
		SEEDED_PROFILE_PROPERTY,
	"application-and-settings/29-properties-cc-enable-tts":
		SEEDED_PROFILE_PROPERTY,
	"application-and-settings/30-properties-cc-label-required-questions-with-asterisk":
		SEEDED_PROFILE_PROPERTY,
	"case-search/auto-launch-false-in-an-app-with-cloudcare-enabled-false":
		"The list-first search an Android-only app carries; derived from the declaration.",
	"expressions-and-data/commcaresession-jr-instance-session":
		"The session instance itself; each context field's feature states its difference.",
	"expressions-and-data/lookup-table-rows-in-the-local-archive-suite":
		"The local archive's embedded tables; Web Apps installs no archive.",
	"forms-and-case-writes/usercase-datum-usercase-id-assertion-case-autoload-usercase-case":
		"The missing worker-record notice; no author chooses its screen.",
	"menus-and-case-lists/19p-enum-image-whose-keys-are-conditions-contain-any-of-each-a":
		"Differs only in an icon-text-grid tile, which Nova never writes.",
	"menus-and-case-lists/enum-mappingitem-alt-text-lang":
		"Nova writes blank alt text; no author sets it yet.",
	"questions/hq-generated-meta-deviceid-timestart-timeend-username-userid":
		"The submission's meta block; authored reads go through the session context features.",
	"questions/h-title-and-data-name-whatever-their-text":
		"A saved form's name on Android, derived from the form's name.",
	"questions/markdown-form-equal-to-the-default-text":
		"How each platform renders every label's markdown; stated once in the public docs.",
	"questions/label-image-audio-video-same-asset-every-language":
		"Renderer only.",
	"questions/hint-text":
		"Renderer only: markdown on Web Apps, plain on Android.",
	"questions/help-text-markdown-form": "Renderer only.",
	"questions/validation-message-markdown-form":
		"Neither platform renders markdown there.",
	"questions/choice-label-text-markdown": "Renderer only.",
	"questions/group-repeat-label-text-markdown": "Renderer only.",
	"questions/plain-label-containing-html-text":
		"Nova always writes a markdown form, so tags never render as HTML on either platform.",
} as const satisfies Readonly<Record<string, string>>;
