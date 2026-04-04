/**
 * App-level validation rules.
 * Each rule receives the full blueprint and returns validation errors.
 */

import type { AppBlueprint } from "@/lib/schemas/blueprint";
import { type ValidationError, validationError } from "../errors";
import { detectFormLinkCycles } from "../../session";

export function emptyAppName(blueprint: AppBlueprint): ValidationError[] {
	if (!blueprint.app_name || !blueprint.app_name.trim()) {
		return [
			validationError(
				"EMPTY_APP_NAME",
				"app",
				`Your app needs a name. CommCare uses this as the display title on devices, so pick something users will recognize.`,
				{},
			),
		];
	}
	return [];
}

export function duplicateModuleNames(
	blueprint: AppBlueprint,
): ValidationError[] {
	const errors: ValidationError[] = [];
	const seen = new Map<string, number>();

	for (let i = 0; i < blueprint.modules.length; i++) {
		const name = blueprint.modules[i].name;
		const prev = seen.get(name);
		if (prev !== undefined) {
			errors.push(
				validationError(
					"DUPLICATE_MODULE_NAME",
					"app",
					`Module "${name}" appears twice (modules ${prev + 1} and ${i + 1}). Each module needs a unique name because CommCare uses it to build the navigation menu — duplicate names would make two menu items indistinguishable.`,
					{ moduleIndex: i, moduleName: name },
				),
			);
		} else {
			seen.set(name, i);
		}
	}
	return errors;
}

export function childCaseTypeMissingModule(
	blueprint: AppBlueprint,
): ValidationError[] {
	if (!blueprint.case_types) return [];
	const errors: ValidationError[] = [];
	const moduleCaseTypes = new Set(
		blueprint.modules.map((m) => m.case_type).filter(Boolean),
	);

	for (const ct of blueprint.case_types) {
		if (ct.parent_type && !moduleCaseTypes.has(ct.name)) {
			errors.push(
				validationError(
					"MISSING_CHILD_CASE_MODULE",
					"app",
					`The child case type "${ct.name}" (child of "${ct.parent_type}") is created by forms but has no module to display it. CommCare requires every case type to have a module — add one with case_type "${ct.name}" and case_list_columns so users can see these cases.`,
					{},
					{ caseType: ct.name },
				),
			);
		}
	}
	return errors;
}

export function circularFormLinks(blueprint: AppBlueprint): ValidationError[] {
	const cycles = detectFormLinkCycles(blueprint);
	return cycles.map(({ chain, formKey }) => {
		const path = chain.join(" → ");
		// Parse formKey to get module/form names for the error message
		const match = formKey.match(/^m(\d+)f(\d+)$/);
		const formName = match
			? (blueprint.modules[+match[1]]?.forms[+match[2]]?.name ?? formKey)
			: formKey;
		return validationError(
			"FORM_LINK_CIRCULAR",
			"app",
			`Circular form link detected: ${path}.\n\n` +
				`"${formName}" eventually links back to itself through a chain of form links. ` +
				`After form submission, CommCare evaluates links in sequence — a cycle means ` +
				`the user would be trapped in an infinite loop of form submissions.\n\n` +
				`Break the cycle by changing one of the links in the chain to target a module menu instead of a form.`,
			{},
		);
	});
}

export const APP_RULES = [
	emptyAppName,
	duplicateModuleNames,
	childCaseTypeMissingModule,
	circularFormLinks,
];
