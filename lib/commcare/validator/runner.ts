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
import { validateBlueprintDeep } from "./index";
import { APP_RULES } from "./rules/app";
import { runFieldRules } from "./rules/field";
import { runFormRules } from "./rules/form";
import { MEDIA_ASSET_RULES } from "./rules/media";
import { MODULE_RULES } from "./rules/module";

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
 * Wrap `validateBlueprintDeep` string output into structured
 * `ValidationError`s with human-friendly messages.
 *
 * The regex-driven parser below decodes the three formats emitted by
 * `validateBlueprintDeep`:
 *   - `Field "id" in "formName": key expression error — message`
 *   - `"formName" in "moduleName" label: message`
 *   - `"formName" in "moduleName" has a circular dependency: cycle`
 *
 * Any line that doesn't match falls through to a generic `XPATH_SYNTAX`
 * error carrying the raw message.
 */
function runDeepValidation(doc: BlueprintDoc): ValidationError[] {
	const deepErrors = validateBlueprintDeep(doc);
	const errors: ValidationError[] = [];

	for (const errStr of deepErrors) {
		const fieldMatch = errStr.match(
			/^Field "([^"]+)" in "([^"]+)": (\w+) expression error — (.+)$/,
		);
		if (fieldMatch) {
			const [, fieldId, formName, field, rawMessage] = fieldMatch;
			const code = inferXPathErrorCode(rawMessage);
			const message = humanizeXPathError(
				code,
				rawMessage,
				fieldId,
				formName,
				field,
			);
			errors.push(
				validationError(code, "field", message, {
					formName,
					fieldId,
					field,
					...findFormLocation(doc, formName),
				}),
			);
			continue;
		}

		const formLabelMatch = errStr.match(/^"([^"]+)" in "([^"]+)" (.+): (.+)$/);
		if (formLabelMatch) {
			const [, formName, moduleName, label, rawMessage] = formLabelMatch;
			const code = inferXPathErrorCode(rawMessage);
			const message = humanizeXPathError(
				code,
				rawMessage,
				undefined,
				formName,
				undefined,
				label,
			);
			errors.push(
				validationError(code, "form", message, {
					formName,
					moduleName,
					...findFormLocation(doc, formName),
				}),
			);
			continue;
		}

		const cycleMatch = errStr.match(
			/^"([^"]+)" in "([^"]+)" has a circular dependency: (.+)$/,
		);
		if (cycleMatch) {
			const [, formName, moduleName, cycle] = cycleMatch;
			errors.push(
				validationError(
					"CYCLE",
					"form",
					`"${formName}" in "${moduleName}" has a circular dependency: ${cycle}. These calculated fields reference each other in a loop, so none of them can ever finish computing. Break the cycle by removing one of the references.`,
					{ formName, moduleName, ...findFormLocation(doc, formName) },
				),
			);
			continue;
		}

		errors.push(validationError("XPATH_SYNTAX", "app", errStr, {}));
	}

	return errors;
}

const FIELD_NAMES: Record<string, string> = {
	relevant: "display condition",
	validate: "validation rule",
	calculate: "calculated value",
	default_value: "default value",
	required: "required condition",
	// Repeat-mode XPath fields validated by `validateTreeXPath` in
	// `./index.ts`. The deep validator emits flat keys (`repeat_count`,
	// `ids_query`) so the regex decoder above matches; this map
	// translates them back into user-facing labels in the rendered
	// error message.
	repeat_count: "repeat count",
	ids_query: "data source query",
};

/** Convert terse XPath error messages into helpful, human-friendly ones. */
function humanizeXPathError(
	code: ValidationError["code"],
	rawMessage: string,
	fieldId?: string,
	formName?: string,
	field?: string,
	label?: string,
): string {
	const loc =
		fieldId && formName
			? `Field "${fieldId}" in "${formName}"${field ? ` (${FIELD_NAMES[field] || field})` : ""}`
			: formName
				? `"${formName}"${label ? ` ${label}` : ""}`
				: "Expression";

	switch (code) {
		case "XPATH_SYNTAX":
			return `${loc} has a syntax error: ${rawMessage}. Check for unbalanced parentheses, missing operators, or stray characters.`;

		case "UNKNOWN_FUNCTION": {
			const suggestion = rawMessage.match(/did you mean "([^"]+)"/)?.[1];
			if (suggestion) {
				return `${loc} calls a function that doesn't exist. ${rawMessage}. XPath function names are case-sensitive — use the lowercase version.`;
			}
			const funcName =
				rawMessage.match(/Unknown function "([^"]+)"/)?.[1] || "unknown";
			return `${loc} calls "${funcName}" which isn't a recognized CommCare function. Check the function name for typos, or consult the CommCare XPath reference for available functions.`;
		}

		case "WRONG_ARITY":
			return `${loc} is calling a function with the wrong number of arguments. ${rawMessage}.`;

		case "INVALID_REF": {
			const path = rawMessage.match(/"([^"]+)"/)?.[1] || "";
			return `${loc} references "${path}" which doesn't exist in this form. Check for typos in the field ID, or make sure the field hasn't been renamed or removed.`;
		}

		case "INVALID_CASE_REF": {
			const prop = rawMessage.match(/"([^"]+)"/)?.[1] || "";
			return `${loc} references case property "${prop}" which doesn't exist on this case type. Check for typos, or make sure a field saves to this property via \`case_property_on\`.`;
		}

		case "TYPE_ERROR":
			return `${loc} has a type mismatch: ${rawMessage}. This will likely produce unexpected results at runtime.`;

		default:
			return `${loc}: ${rawMessage}`;
	}
}

function inferXPathErrorCode(message: string): ValidationError["code"] {
	if (message.includes("Syntax error")) return "XPATH_SYNTAX";
	if (message.includes("Unknown function")) return "UNKNOWN_FUNCTION";
	if (message.includes("requires") || message.includes("accepts at most"))
		return "WRONG_ARITY";
	if (message.includes("Unknown case property")) return "INVALID_CASE_REF";
	if (
		message.includes("unknown field path") ||
		message.includes("References unknown")
	)
		return "INVALID_REF";
	if (message.includes("Type mismatch")) return "TYPE_ERROR";
	return "XPATH_SYNTAX";
}

/**
 * Resolve a form-name match back to the doc's uuid-indexed location. Used
 * by `runDeepValidation` to enrich string-parsed errors with stable uuids.
 * First-match wins when names collide — collisions produce a separate
 * DUPLICATE validation error that points at both sites.
 */
function findFormLocation(
	doc: BlueprintDoc,
	formName: string,
): {
	moduleUuid?: ValidationError["location"]["moduleUuid"];
	moduleName?: string;
	formUuid?: ValidationError["location"]["formUuid"];
} {
	for (const moduleUuid of doc.moduleOrder) {
		const mod = doc.modules[moduleUuid];
		for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
			const form = doc.forms[formUuid];
			if (form.name === formName) {
				return {
					moduleUuid,
					moduleName: mod.name,
					formUuid,
				};
			}
		}
	}
	return {};
}
