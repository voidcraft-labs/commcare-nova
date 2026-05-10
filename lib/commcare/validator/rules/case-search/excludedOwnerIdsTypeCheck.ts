/**
 * Rule: `caseSearchConfig.excludedOwnerIds` (the value
 * expression evaluating to a space-separated list of owner ids
 * excluded from search results) type-checks against the module's
 * case-type schema map AND resolves to a text-typed result.
 *
 * Mirrors the case-list `calculatedColumnTypeCheck` pattern —
 * dispatches `checkValueExpression(expression, ctx, expectedType)`
 * and lifts each `CheckError` into a structured `ValidationError`.
 * The slot is a `ValueExpression` (not a Predicate), so the rule
 * consumes the value-expression entry point rather than
 * `checkPredicate`.
 *
 * The slot's authoring contract is "evaluates to a space-separated
 * list of owner ids" — text-typed by the AST-strict null /
 * representability invariant. The validator enforces that contract
 * at authoring time by passing `expectedType: "text"`. Authors who
 * need a non-text-typed property to seed the excluded-owners list
 * must explicitly coerce — `concat(prop("patient", "owner_id"))`
 * lifts any property to text via the concatenation operator's
 * text-resolution semantics.
 *
 * `typesCompatible` widens `single_select` and `multi_select` to
 * `text`, so select-typed property references resolve cleanly
 * without explicit coercion; `int` / `decimal` / `date` / etc.
 * resolutions surface as authoring errors.
 *
 * Short-circuits cleanly when `caseSearchConfig` is absent OR
 * the `excludedOwnerIds` slot itself is omitted — no expression
 * to check, no error.
 */

import type { BlueprintDoc, Module, Uuid } from "@/lib/domain";
import { checkValueExpression } from "@/lib/domain/predicate";
import { type ValidationError, validationError } from "../../errors";
import { formatPath, moduleTypeContext } from "../case-list/shared";

export function excludedOwnerIdsTypeCheck(
	mod: Module,
	moduleUuid: Uuid,
	doc: BlueprintDoc,
): ValidationError[] {
	const expression = mod.caseSearchConfig?.excludedOwnerIds;
	if (!expression) return [];

	const ctx = moduleTypeContext(mod, doc);
	const result = checkValueExpression(expression, ctx, "text");
	if (result.ok) return [];

	return result.errors.map((err) => {
		const at = formatPath(err.path);
		const suffix = at ? ` (at ${at})` : "";
		return validationError(
			"CASE_SEARCH_EXCLUDED_OWNER_IDS_TYPE_ERROR",
			"module",
			`Module "${mod.name}" case-search excluded owner ids expression has a type error${suffix}: ${err.message}. The slot must resolve to a text-typed value (the runtime parses it as a space-separated list of owner ids). Open \`caseSearchConfig.excludedOwnerIds\` and either pick a property whose \`data_type\` widens to text (\`text\` / \`single_select\` / \`multi_select\`), wrap the existing expression in \`concat(...)\` to coerce to text, or remove the slot entirely (the wire layer omits the excluded-owners filter when absent).`,
			{ moduleUuid, moduleName: mod.name },
			{ path: at },
		);
	});
}
