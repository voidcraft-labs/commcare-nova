/**
 * Rule: every simple-arm `SearchInputDef`'s widget `type` admits the
 * targeted property's effective `data_type` — at the input's
 * destination case type (resolved through `via` when the input
 * carries a relation walk).
 *
 * Mirrors `searchInputModeMatchesPropertyType`'s shape; the gating
 * dimension here is the WIDGET kind (`text` / `select` / `date` /
 * `date-range` / `barcode`), not the predicate's match mode. The two
 * rules cover orthogonal concerns:
 *
 *   - `searchInputModeMatchesPropertyType` — runtime-predicate
 *     compatibility (e.g. `fuzzy` mode on a numeric property).
 *   - this rule — widget-vs-property type compatibility (e.g. a
 *     `date-range` widget on a text property has no semantically-
 *     meaningful UI shape; a `barcode` widget on an `int` property
 *     cannot scan-and-fill).
 *
 * The mapping table lives at `SEARCH_INPUT_TYPE_PROPERTY_TYPES`
 * (`@/lib/domain/modules`) — same constant the editor reads to gate
 * authoring affordances. The validator pulls the same source so a
 * mismatch the editor would reject is also rejected at any other
 * write surface (SA tool calls, MCP API, recovery scripts).
 *
 * Advanced-arm inputs are skipped — the advanced predicate may
 * compose multiple properties of varying types, so a single widget-
 * vs-property gate isn't structurally applicable. The advanced
 * predicate's own type-check (`searchInputPredicateTypeCheck`)
 * covers its property references.
 *
 * Property resolution follows the same 3-arm admission model
 * (declared / standard / writer-derived) the sibling rules use —
 * routed through `resolvePropertyDataType` in `./shared.ts`.
 *
 * Short-circuits cleanly when:
 *   - `caseListConfig` is absent or carries no search inputs.
 *   - the module has no `caseType` (the originating scope is
 *     unknowable; the structural module rule `NO_CASE_TYPE` surfaces
 *     that elsewhere).
 *   - the widget's admit-list is `undefined` (e.g. `text` admits
 *     every property type because every wire shape coerces through
 *     string).
 *   - the property's data type doesn't resolve (the dedicated
 *     `CASE_LIST_SEARCH_INPUT_UNKNOWN_PROPERTY` rule surfaces that).
 */

import {
	type BlueprintDoc,
	type Module,
	SEARCH_INPUT_TYPE_PROPERTY_TYPES,
	type Uuid,
} from "@/lib/domain";
import { type CheckError, checkRelationPath } from "@/lib/domain/predicate";
import { type ValidationError, validationError } from "../../errors";
import { moduleTypeContext, resolvePropertyDataType } from "./shared";

export function searchInputTypeMatchesPropertyType(
	mod: Module,
	moduleUuid: Uuid,
	doc: BlueprintDoc,
): ValidationError[] {
	const inputs = mod.caseListConfig?.searchInputs ?? [];
	if (inputs.length === 0 || !mod.caseType) return [];

	const errors: ValidationError[] = [];
	const ctx = moduleTypeContext(mod, doc);

	for (let index = 0; index < inputs.length; index++) {
		const input = inputs[index];
		// Advanced-arm inputs carry a free predicate — no single widget-
		// vs-property pair to gate. Predicate-type validation lives in
		// `searchInputPredicateTypeCheck`.
		if (input.kind === "advanced") continue;

		const allowed = SEARCH_INPUT_TYPE_PROPERTY_TYPES[input.type];
		// `undefined` admit-list means "every property type works" — the
		// `text` widget falls here because every wire shape coerces
		// through string.
		if (allowed === undefined) continue;

		// Resolve the destination case type for the property lookup —
		// self-walk lands on the module's own case type; cross-walk
		// resolves the destination through the predicate AST's
		// relation-path resolver. The discardable check-error list keeps
		// us from double-reporting relation-walk failures (those surface
		// through the predicate-bearing rules).
		const isSelfWalk = !input.via || input.via.kind === "self";
		let destinationCaseType: string | undefined;
		if (isSelfWalk) {
			destinationCaseType = mod.caseType;
		} else if (input.via) {
			const discard: CheckError[] = [];
			destinationCaseType = checkRelationPath(
				input.via,
				mod.caseType,
				ctx,
				discard,
				[],
			);
		}
		if (!destinationCaseType) continue;

		const dataType = resolvePropertyDataType(
			doc,
			destinationCaseType,
			input.property,
		);
		// Missing property surfaces through the dedicated unknown-property
		// rule; pass silently here to avoid double-reporting.
		if (dataType === undefined) continue;

		if (allowed.includes(dataType)) continue;

		errors.push(
			validationError(
				"CASE_LIST_SEARCH_INPUT_TYPE_PROPERTY_TYPE_MISMATCH",
				"module",
				`Search input "${input.label || input.name}" (input #${index + 1}) on module "${mod.name}" uses a "${input.type}" widget against case property "${input.property}" on case type "${destinationCaseType}" (data type "${dataType}"). The "${input.type}" widget only admits properties of type ${formatAllowedTypes(allowed)}; on a "${dataType}" property the runtime cannot render a meaningful input UI (e.g. a calendar picker against text, a barcode scanner against an integer). Either change the input's \`type\` to one that admits "${dataType}", change the property's \`data_type\` to one the widget admits, or point the input at a different property.`,
				{ moduleUuid, moduleName: mod.name },
				{
					index: String(index),
					inputName: input.name,
					inputUuid: input.uuid,
					inputType: input.type,
					property: input.property,
					destinationCaseType,
					dataType,
				},
			),
		);
	}

	return errors;
}

function formatAllowedTypes(allowed: readonly string[]): string {
	if (allowed.length === 1) return `"${allowed[0]}"`;
	if (allowed.length === 2) return `"${allowed[0]}" or "${allowed[1]}"`;
	return `${allowed
		.slice(0, -1)
		.map((t) => `"${t}"`)
		.join(", ")}, or "${allowed[allowed.length - 1]}"`;
}
