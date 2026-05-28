/**
 * Shared helpers for the four media asset-context rules.
 *
 * Each rule walks every `AssetRef` the doc holds, asserts a per-rule
 * invariant against the resolved manifest, and emits a structured
 * `ValidationError` per violation. The work shared across them:
 *
 *   - `describeLocation(location)` — turns the location's structural
 *     shape into a one-sentence human description the rule's error
 *     message embeds. Single source of truth for "what does the user
 *     read?" so the four rules agree on phrasing for the same
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
	help_media: "help text",
	validate_msg_media: "validation message",
};

/**
 * Map a `field_media_bundle` ref's bundle key to its user-facing label.
 */
export function bundleKeyLabel(bundleKey: FieldMediaBundleKey): string {
	return FIELD_BUNDLE_LABELS[bundleKey];
}

/**
 * One-sentence-fragment description of a media reference site, embedded
 * inside a rule's error message after the leading "what failed" clause.
 * Always starts with a lowercase noun phrase so the surrounding
 * sentence reads naturally ("…attached to the label image slot on
 * field 'name'…").
 */
export function describeLocation(location: MediaRefLocation): string {
	switch (location.kind) {
		case "app_logo":
			return "the app logo slot";
		case "module_icon":
			return `the icon slot on module "${location.moduleName}"`;
		case "module_audio_label":
			return `the audio-label slot on module "${location.moduleName}"`;
		case "form_icon":
			return `the icon slot on form "${location.formName}" (module "${location.moduleName}")`;
		case "form_audio_label":
			return `the audio-label slot on form "${location.formName}" (module "${location.moduleName}")`;
		case "field_media_bundle":
			return `the ${bundleKeyLabel(location.bundleKey)} media slot on field "${location.fieldId}" (form "${location.formName}")`;
		case "option_media":
			return `the media slot on option "${location.optionValue}" of field "${location.fieldId}" (form "${location.formName}")`;
		case "image_map_mapping":
			return `row ${location.rowIndex + 1} of image-map column "${location.columnHeader}" (module "${location.moduleName}")`;
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
			return {
				moduleUuid: location.moduleUuid,
				moduleName: location.moduleName,
				field: "caseListConfig.columns.mapping",
			};
	}
}
