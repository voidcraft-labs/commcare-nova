/**
 * Validation runner — single entry point for structured blueprint validation.
 *
 * Walks the normalized `BlueprintDoc` once, running scope-appropriate rules
 * at the app, module, form, and field levels, then runs deep XPath
 * validation. Returns structured `ValidationError[]` keyed by uuid.
 */

import type { BlueprintDoc } from "@/lib/domain";
import type { ValidationError } from "./errors";
import { validationError } from "./errors";
import { validateBlueprintDeep } from "./index";
import { APP_RULES } from "./rules/app";
import { runFieldRules } from "./rules/field";
import { runFormRules } from "./rules/form";
import { MODULE_RULES } from "./rules/module";

/**
 * Run all validation rules on a `BlueprintDoc`.
 * Returns structured errors — `errorToString()` renders a human-readable form.
 */
export function runValidation(doc: BlueprintDoc): ValidationError[] {
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

	errors.push(...runDeepValidation(doc));

	return errors;
}

/**
 * Wrap `validateBlueprintDeep` string output into structured
 * `ValidationError`s with human-friendly messages.
 *
 * The regex-driven parser below decodes the three formats emitted by
 * `validateBlueprintDeep`:
 *   - `Question "id" in "formName": field expression error — message`
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
		const questionMatch = errStr.match(
			/^Question "([^"]+)" in "([^"]+)": (\w+) expression error — (.+)$/,
		);
		if (questionMatch) {
			const [, fieldId, formName, field, rawMessage] = questionMatch;
			const code = inferXPathErrorCode(rawMessage);
			const message = humanizeXPathError(
				code,
				rawMessage,
				fieldId,
				formName,
				field,
			);
			errors.push(
				validationError(code, "question", message, {
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
	validation: "validation rule",
	calculate: "calculated value",
	default_value: "default value",
	required: "required condition",
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
			? `Question "${fieldId}" in "${formName}"${field ? ` (${FIELD_NAMES[field] || field})` : ""}`
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
			return `${loc} references "${path}" which doesn't exist in this form. Check for typos in the question ID, or make sure the question hasn't been renamed or removed.`;
		}

		case "INVALID_CASE_REF": {
			const prop = rawMessage.match(/"([^"]+)"/)?.[1] || "";
			return `${loc} references case property "${prop}" which doesn't exist on this case type. Check for typos, or make sure a question saves to this property with case_property_on.`;
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
		message.includes("unknown question path") ||
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
