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
	const filter = mod.caseListConfig?.filter;
	if (!filter) return [];

	const ctx = slotContext(
		doc,
		{ entity: "module", uuid: moduleUuid, slot: "case_list_filter" },
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
			`Module "${mod.name}" case-list filter has a type error${suffix}: ${err.message}`,
			{ moduleUuid, moduleName: mod.name },
			{
				...checkErrorDetails(err),
				slot: "caseListConfig.filter",
				registrySlot: "case_list_filter",
			},
		);
	});
}
