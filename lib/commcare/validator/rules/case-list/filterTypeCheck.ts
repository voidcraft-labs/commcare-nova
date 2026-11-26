/** Project semantic findings from this saved slot, preserving its owning validation code. */
import type { BlueprintDoc, Module, Uuid } from "@/lib/domain";
import { checkExpression, slotContext } from "@/lib/domain/expression";
import { type ValidationError, validationError } from "../../errors";
import {
	checkErrorDetails,
	type LookupTypeIndex,
	semanticCheckErrors,
} from "../../lookupTypeContext";
import { formatPath } from "./shared";

export function filterTypeCheck(
	mod: Module,
	moduleUuid: Uuid,
	doc: BlueprintDoc,
	lookupTables?: LookupTypeIndex,
): ValidationError[] {
	const conditions = [
		{
			filter: mod.caseListConfig?.filter,
			slot: "case_list_filter",
			path: "caseListConfig.filter",
			label: "case-list filter",
		},
		{
			filter: mod.caseListConfig?.searchCondition,
			slot: "case_search_filter",
			path: "caseListConfig.searchCondition",
			label: "search condition",
		},
	] as const;
	return conditions.flatMap(({ filter, slot, path, label }) => {
		if (!filter) return [];

		const ctx = slotContext(
			doc,
			{ entity: "module", uuid: moduleUuid, slot },
			lookupTables ?? new Map(),
		);
		if (ctx === undefined) return [];
		const errors = semanticCheckErrors(checkExpression(filter, ctx));
		if (errors.length === 0) return [];

		return errors.map((err) => {
			const at = formatPath(err.path);
			// Suffix the AST path when present — the path locates the
			// offending node inside the predicate (e.g. `eq.left` for the
			// left operand of a top-level equality). The leading "at" reads
			// as a sentence fragment when concatenated to the human-readable
			// per-rule message.
			const suffix = at ? ` (at ${at})` : "";
			return validationError(
				"CASE_LIST_FILTER_TYPE_ERROR",
				"module",
				`Module "${mod.name}" ${label} has a type error${suffix}: ${err.message}`,
				{ moduleUuid, moduleName: mod.name },
				{
					...checkErrorDetails(err),
					slot: path,
					registrySlot: slot,
				},
			);
		});
	});
}
