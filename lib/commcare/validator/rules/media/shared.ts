/**
 * Shared helpers for the three media asset-context rules.
 *
 * Each rule walks every `AssetRef` the doc holds, asserts a per-rule
 * invariant against the resolved manifest, and emits a structured
 * `ValidationError` per violation. The work shared across them:
 *
 *   - `describeLocation(location)` — turns the location's structural
 *     shape into a one-sentence human description the rule's error
 *     message embeds. Single source of truth for "what does the user
 *     read?" so the three rules agree on phrasing for the same
 *     carrier.
 *   - `scopeFor(location)` — projects the location to the validator's
 *     scope enum so the error routes to the right scope bucket (app /
 *     module / form / field).
 *   - `validationLocationFor(location)` — projects the location to
 *     the `ValidationLocation` payload the structured error carries.
 *     Mirrors the project's convention that uuids + display names
 *     travel together so the IDE / UI can deep-link to the carrier.
 *   - `bundleKeyLabel(bundleKey)` — names which message-slot a
 *     `field_media_bundle` reference attaches to, in the user's
 *     vocabulary ("label" / "hint" / "help text" / "validation
 *     message"). Avoids leaking the snake_case schema key into the
 *     error sentence.
 *   - `navigabilityDetailsFor(location)` — extra `details` keys the
 *     `ValidationLocation` shape can't carry. For image-map mapping
 *     refs, surfaces `columnUuid` + `rowIndex` so the UI can deep-link
 *     to the exact row; matches the precedent at
 *     `idMappingValueRequired`. Returns an empty object for locations
 *     that have nothing extra to surface.
 */

import type {
	FieldMediaBundleKey,
	MediaRefLocation,
} from "@/lib/domain/mediaRefs";
import type { ValidationError, ValidationLocation } from "../../errors";

/**
 * Human label for each field-level media bundle key. Used inside the
 * rule's error sentence to read like prose rather than schema.
 */
const FIELD_BUNDLE_LABELS: Record<FieldMediaBundleKey, string> = {
	label_media: "label",
	hint_media: "hint",
	help_media: "help-text",
	validate_msg_media: "validation-message",
};

/**
 * Map a `field_media_bundle` ref's bundle key to its user-facing label.
 */
export function bundleKeyLabel(bundleKey: FieldMediaBundleKey): string {
	return FIELD_BUNDLE_LABELS[bundleKey];
}

/**
 * One-sentence-fragment description of a media reference site,
 * embedded inside a rule's error message after a leading "At" or
 * "The media asset at" preposition. The carrier name uses a bare
 * noun phrase. The leading template at each rule owns the `slot` /
 * `media asset` vocabulary, so a `describeLocation` value never
 * embeds it.
 */
export function describeLocation(location: MediaRefLocation): string {
	switch (location.kind) {
		case "app_logo":
			return "the app logo";
		case "module_icon":
			return `the icon on module "${location.moduleName}"`;
		case "module_audio_label":
			return `the audio label on module "${location.moduleName}"`;
		case "case_list_icon":
			return `the case-list icon on module "${location.moduleName}"`;
		case "case_list_audio_label":
			return `the case-list audio label on module "${location.moduleName}"`;
		case "form_icon":
			return `the icon on form "${location.formName}" in module "${location.moduleName}"`;
		case "form_audio_label":
			return `the audio label on form "${location.formName}" in module "${location.moduleName}"`;
		case "field_media_bundle":
			return `the ${bundleKeyLabel(location.bundleKey)} media on field "${location.fieldId}" in form "${location.formName}"`;
		case "option_media":
			return `the media on option "${location.optionValue}" of field "${location.fieldId}" in form "${location.formName}"`;
		case "image_map_mapping":
			return `row ${location.rowIndex + 1} of the image-map column "${location.columnHeader}" on module "${location.moduleName}"`;
	}
}

/**
 * Validator scope each location reports into. The validator's scope
 * enum is `"app" | "module" | "form" | "field"` — every reference
 * ultimately belongs to one of those buckets. Per-field bundle and
 * per-option references project to `"field"`; menu carriers to
 * `"module"` / `"form"` per their host entity; image-map mappings to
 * `"module"` (their carrier is the case-list config, which sits at
 * module scope); the app logo to `"app"`.
 */
export function scopeFor(location: MediaRefLocation): ValidationError["scope"] {
	switch (location.kind) {
		case "app_logo":
			return "app";
		case "module_icon":
		case "module_audio_label":
		case "case_list_icon":
		case "case_list_audio_label":
		case "image_map_mapping":
			return "module";
		case "form_icon":
		case "form_audio_label":
			return "form";
		case "field_media_bundle":
		case "option_media":
			return "field";
	}
}

/**
 * Project a `MediaRefLocation` to a `ValidationLocation` payload.
 * Threads every available uuid + display name through so the IDE / UI
 * can route an error to the exact carrier on click. Keys absent from a
 * given variant are simply omitted (the schema marks every key
 * optional). The `field` key — which the validator uses for "what
 * property of the entity is the error about" — names the media slot a
 * reference belongs to where one is applicable.
 */
export function validationLocationFor(
	location: MediaRefLocation,
): ValidationLocation {
	switch (location.kind) {
		case "app_logo":
			return { field: "logo" };
		case "module_icon":
			return {
				moduleUuid: location.moduleUuid,
				moduleName: location.moduleName,
				field: "icon",
			};
		case "module_audio_label":
			return {
				moduleUuid: location.moduleUuid,
				moduleName: location.moduleName,
				field: "audioLabel",
			};
		case "case_list_icon":
			return {
				moduleUuid: location.moduleUuid,
				moduleName: location.moduleName,
				field: "caseListIcon",
			};
		case "case_list_audio_label":
			return {
				moduleUuid: location.moduleUuid,
				moduleName: location.moduleName,
				field: "caseListAudioLabel",
			};
		case "form_icon":
			return {
				moduleUuid: location.moduleUuid,
				moduleName: location.moduleName,
				formUuid: location.formUuid,
				formName: location.formName,
				field: "icon",
			};
		case "form_audio_label":
			return {
				moduleUuid: location.moduleUuid,
				moduleName: location.moduleName,
				formUuid: location.formUuid,
				formName: location.formName,
				field: "audioLabel",
			};
		case "field_media_bundle":
			return {
				moduleUuid: location.moduleUuid,
				moduleName: location.moduleName,
				formUuid: location.formUuid,
				formName: location.formName,
				fieldUuid: location.fieldUuid,
				fieldId: location.fieldId,
				field: location.bundleKey,
			};
		case "option_media":
			return {
				moduleUuid: location.moduleUuid,
				moduleName: location.moduleName,
				formUuid: location.formUuid,
				formName: location.formName,
				fieldUuid: location.fieldUuid,
				fieldId: location.fieldId,
				field: "options",
			};
		case "image_map_mapping":
			// `field` is intentionally absent — mirrors
			// `idMappingValueRequired`, which carries `{ moduleUuid,
			// moduleName }` only. The row coordinates the asset-context
			// rules need (column uuid, row index) flow through `details`
			// via `navigabilityDetailsFor`, not through `field`.
			return {
				moduleUuid: location.moduleUuid,
				moduleName: location.moduleName,
			};
	}
}

/**
 * Per-location `details` keys the structured-error `ValidationLocation`
 * shape can't carry (it covers entity uuids + names + the offending
 * property, not row-level coordinates inside a column). For
 * `image_map_mapping` refs, surface the column uuid and the 0-based
 * row index so the UI / SA can deep-link to the exact row — mirrors
 * the precedent at
 * `lib/commcare/validator/rules/case-list/idMappingValueRequired.ts`'s
 * `details` payload. Other location kinds carry no extra coordinates,
 * so they return an empty object the spread operator drops cleanly.
 *
 * `details` is `Record<string, string>` on `ValidationError`, hence
 * the `String(rowIndex)` projection.
 */
export function navigabilityDetailsFor(
	location: MediaRefLocation,
): Record<string, string> {
	if (location.kind === "image_map_mapping") {
		return {
			columnUuid: location.columnUuid,
			rowIndex: String(location.rowIndex),
		};
	}
	return {};
}
