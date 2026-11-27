/** Project semantic findings from this saved slot, preserving its owning validation code. */
import type { BlueprintDoc, Module, Uuid } from "@/lib/domain";
import { reachedPropertyType } from "@/lib/domain/columnRelation";
import { checkExpression, slotContext } from "@/lib/domain/expression";
import {
	directHostTextEquality,
	ordinaryHostFilterList,
} from "@/lib/domain/expression/directHostTextEquality";
import { walkPropertyRefs } from "@/lib/domain/expression/walk";
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
		if (errors.length === 0 && slot === "case_list_filter") {
			let readsReached = false;
			walkPropertyRefs(filter, (property) => {
				readsReached ||= property.readReached === true;
			});
			if (readsReached) {
				const host = directHostTextEquality(filter);
				if (
					!ordinaryHostFilterList(doc, moduleUuid) ||
					host?.via?.kind !== "ancestor" ||
					mod.caseType === undefined ||
					reachedPropertyType(
						{ field: host.property, via: host.via.via },
						mod.caseType,
						doc.caseTypes ?? [],
					) !== "text"
				)
					return [
						validationError(
							"CASE_LIST_FILTER_TYPE_ERROR",
							"module",
							"Use one condition that compares the host record's property with text on a top-level device list.",
							{ moduleUuid, moduleName: mod.name },
							{
								slot: path,
								registrySlot: slot,
								checkReason: "host-text-filter",
							},
						),
					];
			}
		}

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
