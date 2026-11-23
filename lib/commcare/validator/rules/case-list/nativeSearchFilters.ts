import type { BlueprintDoc, Module, Uuid } from "@/lib/domain";
import { checkExpression, slotContext } from "@/lib/domain/expression";
import {
	readSearchFilterTarget,
	searchFilterKey,
} from "../../../suite/case-search/nativeFilters";
import { type ValidationError, validationError } from "../../errors";
import {
	checkErrorDetails,
	type LookupTypeIndex,
	semanticCheckErrors,
} from "../../lookupTypeContext";

export function nativeSearchFilters(
	mod: Module,
	moduleUuid: Uuid,
	doc: BlueprintDoc,
	lookups?: LookupTypeIndex,
): ValidationError[] {
	const errors: ValidationError[] = [];
	const filters = mod.caseListConfig?.searchFilters ?? [];
	const names = new Set(
		mod.caseListConfig?.searchInputs.map((input) => input.name),
	);
	for (const [index, filter] of filters.entries()) {
		const key = searchFilterKey(filter.target);
		const parsed = readSearchFilterTarget(key);
		const reject = (message: string, details: Record<string, string>) =>
			errors.push(
				validationError(
					"CASE_SEARCH_FILTER_INVALID",
					"module",
					message,
					{ moduleUuid, moduleName: mod.name },
					{ index: String(index), filterUuid: filter.uuid, ...details },
				),
			);
		if (names.has(key))
			reject(
				`Search filter ${index + 1} on "${mod.name}" sends "${key}", which a search field there already sends.`,
				{ reason: "key-taken", key },
			);
		if (parsed?.kind !== filter.target.kind)
			reject(
				`Search filter ${index + 1} on "${mod.name}" names record information its key "${key}" does not read back as.`,
				{ reason: "target", key },
			);
		const scope = slotContext(
			doc,
			{
				entity: "module",
				uuid: moduleUuid,
				slot: "search_filter_value",
				member: { filterUuid: filter.uuid },
			},
			lookups ?? new Map(),
		);
		if (scope) {
			for (const issue of semanticCheckErrors(
				checkExpression(filter.value, scope),
			))
				reject(
					`Search filter ${index + 1} on "${mod.name}" has a value the search screen can't work out: ${issue.message}`,
					{ reason: "value", ...checkErrorDetails(issue, scope) },
				);
		}
	}
	for (const input of mod.caseListConfig?.searchInputs ?? []) {
		if (input.kind !== "simple" || input.matching !== "project-space") continue;
		if (
			(input.name === "name" ? "case_name" : input.name) === input.property &&
			(!input.via || input.via.kind === "self") &&
			(!input.mode ||
				input.mode.kind === "exact" ||
				(input.type === "date-range" && input.mode.kind === "range"))
		)
			continue;
		errors.push(
			validationError(
				"CASE_SEARCH_FILTER_INVALID",
				"module",
				`Search field "${input.name}" on "${mod.name}" uses the project space's matching rule, which matches only the field's own property with no separate matching rule.`,
				{ moduleUuid, moduleName: mod.name },
				{
					inputUuid: input.uuid,
					reason: "project-space-matching",
					field: input.name,
				},
			),
		);
	}
	return errors;
}
