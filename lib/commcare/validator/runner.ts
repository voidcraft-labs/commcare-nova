/**
 * Validation runner — single entry point for structured blueprint validation.
 *
 * Walks the normalized `BlueprintDoc` once, running scope-appropriate rules
 * at the app, module, form, and field levels, then runs deep XPath
 * validation. Returns structured `ValidationError[]` keyed by uuid.
 *
 * Asset-context media rules (existence / ready / kind-match) need data
 * the doc alone can't carry: the resolved Firestore rows for the assets
 * the doc references. Callers that have those (the SA validation loop)
 * pass a manifest through `RunValidationOptions`; callers that don't
 * (the bulk of tests, the test oracles, the fuzz harness) omit the
 * options and the asset-context group is skipped. Doc-structural rules
 * — including `imageMapValueUnique` — fire either way; they live in
 * MODULE_RULES.
 */

import type { MediaAssetRecord } from "@/lib/db/mediaAssets";
import type { BlueprintDoc } from "@/lib/domain";
import type { ValidationError } from "./errors";
import { validationError } from "./errors";
import {
	type ConnectXPathSlot,
	type ProseSurface,
	validateBlueprintDeep,
	type XPathSurface,
} from "./index";
import { APP_RULES } from "./rules/app";
import { runFieldRules } from "./rules/field";
import { runFormRules } from "./rules/form";
import { MEDIA_ASSET_RULES } from "./rules/media";
import { MODULE_RULES } from "./rules/module";
import type { XPathError } from "./xpathValidator";

/**
 * Optional context the asset-context media rules consume. A single
 * required slot — the resolved media-asset manifest — so "ran the
 * media group" and "didn't" are the only two states. No half-supplied
 * state is representable.
 */
export interface RunValidationOptions {
	/**
	 * Resolved media-asset manifest — every `AssetId` the doc
	 * references that the loader was willing to return, mapped to its
	 * loaded Firestore row. Built by the caller from
	 * `collectAssetRefs(doc)` + `loadAssetsByIds(owner, ...)`. When
	 * supplied, the asset-context media rules run; when omitted, the
	 * rules are skipped silently.
	 */
	readonly mediaAssets: ReadonlyMap<string, MediaAssetRecord>;
}

/**
 * Run all validation rules on a `BlueprintDoc`.
 * Returns structured errors — `errorToString()` renders a human-readable form.
 *
 * When `options.mediaAssets` is supplied, the asset-context media
 * rules run after the doc-structural rules. They surface only the
 * issues the structural rules can't see (a referenced asset doesn't
 * exist, is still uploading, or its kind doesn't match the slot).
 */
export function runValidation(
	doc: BlueprintDoc,
	options?: RunValidationOptions,
): ValidationError[] {
	const errors: ValidationError[] = [];

	for (const rule of APP_RULES) {
		errors.push(...rule(doc));
	}

	for (const moduleUuid of doc.moduleOrder) {
		const mod = doc.modules[moduleUuid];

		for (const rule of MODULE_RULES) {
			errors.push(...rule(mod, moduleUuid, doc));
		}

		for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
			errors.push(...runFormRules(doc, formUuid, moduleUuid));
			const order = doc.fieldOrder[formUuid] ?? [];
			if (order.length > 0) {
				errors.push(
					...runFieldRules(doc, formUuid, {
						formName: doc.forms[formUuid].name,
						moduleName: mod.name,
						moduleUuid,
						formUuid,
					}),
				);
			}
		}
	}

	// Media asset-context rules — single-arm gate on the options
	// payload. The manifest is the only thing the rules need; its
	// presence both gates the group and provides the data.
	if (options?.mediaAssets) {
		for (const rule of MEDIA_ASSET_RULES) {
			errors.push(...rule(doc, options.mediaAssets));
		}
	}

	errors.push(...runDeepValidation(doc));

	return errors;
}

/**
 * Project the TYPED `DeepValidationError`s from `validateBlueprintDeep` into
 * user-facing `ValidationError`s. A `switch` on the discriminant — every
 * code, location, and surface arrives typed, so there is no prose to parse,
 * no code to re-infer from a message, and no name→uuid lookup to redo. (The
 * muddled cycle message this once produced came entirely from regex-decoding
 * our own error strings: the cycle line matched the general form-label
 * pattern first and got humanized as an XPath label error. With a typed
 * union that whole failure mode is unrepresentable.)
 */
function runDeepValidation(doc: BlueprintDoc): ValidationError[] {
	return validateBlueprintDeep(doc).map((deep): ValidationError => {
		switch (deep.kind) {
			case "field-xpath":
				return validationError(
					deep.error.code,
					"field",
					humanizeXPathError(
						deep.error,
						`Field "${deep.fieldId}" in "${deep.formName}" (${SURFACE_LABELS[deep.surface]})`,
					),
					{
						moduleUuid: deep.moduleUuid,
						moduleName: deep.moduleName,
						formUuid: deep.formUuid,
						formName: deep.formName,
						fieldUuid: deep.fieldUuid,
						fieldId: deep.fieldId,
						field: deep.surface,
					},
				);

			case "field-prose":
				return validationError(
					deep.error.code,
					"field",
					humanizeXPathError(
						deep.error,
						`Field "${deep.fieldId}" in "${deep.formName}" (${PROSE_SURFACE_LABELS[deep.surface]})`,
					),
					{
						moduleUuid: deep.moduleUuid,
						moduleName: deep.moduleName,
						formUuid: deep.formUuid,
						formName: deep.formName,
						fieldUuid: deep.fieldUuid,
						fieldId: deep.fieldId,
						field: deep.surface,
					},
				);

			case "connect-xpath":
				return validationError(
					deep.error.code,
					"form",
					humanizeXPathError(
						deep.error,
						`"${deep.formName}" in "${deep.moduleName}" (${CONNECT_SLOT_LABELS[deep.slot]})`,
					),
					{
						moduleUuid: deep.moduleUuid,
						moduleName: deep.moduleName,
						formUuid: deep.formUuid,
						formName: deep.formName,
					},
				);

			case "cycle":
				return validationError(
					"CYCLE",
					"form",
					`"${deep.formName}" in "${deep.moduleName}" has a circular dependency: ${deep.cycle.join(" → ")}. These calculated fields reference each other in a loop, so none of them can ever finish computing. Break the cycle by removing one of the references.`,
					{
						moduleUuid: deep.moduleUuid,
						moduleName: deep.moduleName,
						formUuid: deep.formUuid,
						formName: deep.formName,
					},
				);

			default: {
				// Exhaustiveness tripwire: if a new `DeepValidationError` kind is
				// added, `deep` is no longer `never` here and this fails to
				// compile — forcing a matching projection above.
				const unreachable: never = deep;
				throw new Error(
					`Unhandled deep validation error: ${JSON.stringify(unreachable)}`,
				);
			}
		}
	});
}

/**
 * User-facing label for each XPath surface a field can carry. Typed as a
 * total `Record<XPathSurface, …>`, so adding a surface to the deep walk
 * forces a label here — the compiler is the reminder.
 */
const SURFACE_LABELS: Record<XPathSurface, string> = {
	relevant: "display condition",
	validate: "validation rule",
	calculate: "calculated value",
	default_value: "default value",
	required: "required condition",
	repeat_count: "repeat count",
	ids_query: "data source query",
};

/**
 * User-facing label for each PROSE surface a field can carry. Typed as a
 * total `Record<ProseSurface, …>`, so adding a prose surface to the deep
 * scan forces a label here — the compiler is the reminder.
 */
const PROSE_SURFACE_LABELS: Record<ProseSurface, string> = {
	label: "label",
	hint: "hint",
	help: "help text",
	validate_msg: "validation message",
	option_label: "answer option label",
};

/** User-facing label for each Connect-block XPath slot. */
const CONNECT_SLOT_LABELS: Record<ConnectXPathSlot, string> = {
	assessment_user_score: "Connect assessment user_score",
	deliver_entity_id: "Connect deliver entity_id",
	deliver_entity_name: "Connect deliver entity_name",
};

/**
 * Build the "did you mean" clause for an INVALID_REF that has leaf-matched
 * suggestions. The validator resolves field paths as `/data/...`; the SA
 * authors them as `#form/...`, so we present the suggestions in that
 * vocabulary — directly copy-pasteable. One match reads as a single
 * suggestion; several (cousins sharing a leaf id across groups) list all so
 * the SA picks the right one. Returns `undefined` when there's nothing to
 * suggest, so the caller falls back to the generic typo guidance.
 */
function suggestionHint(
	suggestions: readonly string[] | undefined,
): string | undefined {
	if (!suggestions || suggestions.length === 0) return undefined;
	const formPaths = suggestions.map(
		(p) => `\`#form/${p.replace(/^\/data\//, "")}\``,
	);
	if (formPaths.length === 1) {
		return `A field with that id exists at ${formPaths[0]} — did you mean that? A \`#form/...\` reference must include every group the field is nested in, not just the field's id.`;
	}
	return `Fields with that id exist at ${formPaths.join(", ")} — did you mean one of these? A \`#form/...\` reference must include every group the field is nested in, not just the field's id.`;
}

/**
 * Render a typed `XPathError` into a helpful, human-friendly message.
 * Dispatch is on the typed `code` — never on parsing `error.message`. The
 * terse `error.message` already carries the specific identifier (the bad
 * path, the unknown function name), so embedding it as the detail keeps the
 * message specific without re-extracting anything. `where` is the
 * caller-built location prefix (`Field "x" in "Form" (display condition)`).
 */
function humanizeXPathError(error: XPathError, where: string): string {
	switch (error.code) {
		case "XPATH_SYNTAX":
			return `${where} has a syntax error: ${error.message}. Check for unbalanced parentheses, missing operators, or stray characters.`;

		case "UNKNOWN_FUNCTION":
			return `${where} calls a function that isn't a recognized CommCare function: ${error.message}. Function names are case-sensitive — check for a typo or the wrong case.`;

		case "WRONG_ARITY":
			return `${where} calls a function with the wrong number of arguments: ${error.message}.`;

		case "INVALID_REF": {
			// When an existing field shares the unknown ref's leaf id, the SA
			// almost certainly wrote the bare id and dropped the field's group
			// path — point at the real path(s) in the SA's own `#form/...`
			// vocabulary (the validator resolved them as `/data/...`). This is
			// the dominant authoring mistake: `#form/consent` for a field that
			// lives at `#form/consent_grp/consent`.
			const hint = suggestionHint(error.suggestions);
			if (hint) {
				return `${where} has a reference that doesn't exist in this form: ${error.message}. ${hint}`;
			}
			return `${where} has a reference that doesn't exist in this form: ${error.message}. Check for a typo in the field id, or whether the field was renamed or removed.`;
		}

		case "INVALID_CASE_REF":
			return `${where} references a case property that doesn't exist on this case type: ${error.message}. Check for a typo, or make sure a field saves to that property via \`case_property_on\`.`;

		case "TYPE_ERROR":
			return `${where} has a type mismatch: ${error.message}. This will likely produce unexpected results at runtime.`;
	}
}
