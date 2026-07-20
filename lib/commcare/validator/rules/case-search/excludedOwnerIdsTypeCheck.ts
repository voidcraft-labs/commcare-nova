/**
 * Rule: `caseSearchConfig.excludedOwnerIds` (the value expression evaluating
 * to a space-separated list of owner ids excluded from Results) is global and
 * text-typed.
 *
 * Mirrors the case-list `calculatedColumnTypeCheck` pattern —
 * dispatches `checkValueExpression(expression, ctx, expectedType)`
 * and lifts each `CheckError` into a structured `ValidationError`.
 * The slot is a `ValueExpression` (not a Predicate), so the rule
 * consumes the value-expression entry point rather than
 * `checkPredicate`.
 *
 * CommCare Search and Nova Preview both resolve this value before a case is
 * selected. The ordinary case-list wire then reuses the resolved global intent
 * while filtering rows. Admitting a case property or relationship read would
 * make that lifecycle context-dependent: Preview has no row and resolves it
 * blank, while a suite nodeset can accidentally evaluate it per row. The
 * shared domain walker therefore rejects property, count, exists, and missing
 * reads at the gate before the ordinary/Search paths can diverge.
 *
 * Row-independent expressions still pass through the normal type checker with
 * `expectedType: "text"`: literals, session/current-user values, Search input
 * refs, and pure calculations over those values remain available.
 *
 * Short-circuits cleanly when `caseSearchConfig` is absent OR
 * the `excludedOwnerIds` slot itself is omitted — no expression
 * to check, no error.
 */

import type { BlueprintDoc, Module, Uuid } from "@/lib/domain";
import {
	checkValueExpression,
	expressionReadsCaseData,
} from "@/lib/domain/predicate";
import { type ValidationError, validationError } from "../../errors";
import { formatPath, moduleTypeContext } from "../case-list/shared";

export function excludedOwnerIdsTypeCheck(
	mod: Module,
	moduleUuid: Uuid,
	doc: BlueprintDoc,
): ValidationError[] {
	const expression = mod.caseSearchConfig?.excludedOwnerIds;
	if (!expression) return [];
	if (expressionReadsCaseData(expression)) {
		return [
			validationError(
				"CASE_SEARCH_EXCLUDED_OWNER_IDS_CASE_DATA_UNAVAILABLE",
				"module",
				`Module "${mod.name}" has an assigned-cases expression that reads a case property or relationship, but \`caseSearchConfig.excludedOwnerIds\` is resolved once before a case is selected. Use a fixed owner-id list, a current-user/session value, a Search answer, or a calculation composed only from those global values; otherwise clear the assigned-cases setting.`,
				{ moduleUuid, moduleName: mod.name },
				{
					slot: "caseSearchConfig.excludedOwnerIds",
					surface: "excluded-owner-ids",
				},
			),
		];
	}

	const ctx = moduleTypeContext(mod, doc);
	const result = checkValueExpression(expression, ctx, "text");
	if (result.ok) return [];

	return result.errors.map((err) => {
		const at = formatPath(err.path);
		const suffix = at ? ` (at ${at})` : "";
		return validationError(
			"CASE_SEARCH_EXCLUDED_OWNER_IDS_TYPE_ERROR",
			"module",
			`Module "${mod.name}" assigned-cases expression has a type error${suffix}: ${err.message}. The value must resolve to text because it is parsed as a space-separated list of owner ids. Open \`caseSearchConfig.excludedOwnerIds\` and use a text literal, current-user/session value, Search answer, or text calculation over those global values; otherwise remove the slot.`,
			{ moduleUuid, moduleName: mod.name },
			{
				path: at,
				slot: "caseSearchConfig.excludedOwnerIds",
				surface: "excluded-owner-ids",
			},
		);
	});
}
