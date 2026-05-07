/**
 * Rule: every `SearchInputDef` with both a `property` and a `mode`
 * declares a mode whose semantics match the targeted property's
 * effective `data_type` — at the input's destination case type
 * (resolved through `via` when the input carries a relation walk).
 *
 * The mapping table lives at `SEARCH_MODE_PROPERTY_TYPES` in
 * `lib/domain/modules.ts` (populated in Task 8) — never reinvent it
 * here. Modes whose admit-set is `undefined` (e.g. `exact`) widen to
 * every property type and short-circuit the check; any other mode is
 * compared against the property's effective data type
 * (`effectiveDataType(...)` — `data_type ?? "text"` per the shared
 * convention).
 *
 * **Load-bearing for runtime correctness.** Plan 2's index-DDL
 * emission depends on this rule passing — an unindexed `range` mode
 * on a text property would be undefined behavior at the Postgres
 * runtime. Cross-walk inputs (`via` carrying an `ancestor` /
 * `subcase` / `any-relation` step) resolve the destination case type
 * via `checkRelationPath` so the rule covers the index-DDL boundary
 * regardless of whether the input targets the module's own case type
 * or a related one.
 *
 * Inputs without a `property` (advanced inputs whose predicate is
 * fully expressed via `xpath`) skip this check; the `xpath`
 * predicate is type-checked by the filter / per-input predicate
 * rules elsewhere.
 */

import type { BlueprintDoc, Module, Uuid } from "@/lib/domain";
import { SEARCH_MODE_PROPERTY_TYPES } from "@/lib/domain";
import { effectiveDataType } from "@/lib/domain/casePropertyTypes";
import { type CheckError, checkRelationPath } from "@/lib/domain/predicate";
import { type ValidationError, validationError } from "../../errors";
import { moduleTypeContext } from "./shared";

export function searchInputModeMatchesPropertyType(
	mod: Module,
	moduleUuid: Uuid,
	doc: BlueprintDoc,
): ValidationError[] {
	const inputs = mod.caseListConfig?.searchInputs ?? [];
	if (inputs.length === 0 || !mod.caseType) return [];

	const errors: ValidationError[] = [];
	const caseTypes = doc.caseTypes ?? [];
	const ctx = moduleTypeContext(mod, caseTypes);

	for (let index = 0; index < inputs.length; index++) {
		const input = inputs[index];
		// Skip advanced inputs (no property) and inputs with no explicit
		// mode — both fall outside this rule's scope.
		if (!input.property || !input.mode) continue;

		// Resolve the destination case type — self-walk lands on the
		// module's own case type; cross-walks chase the `via` to its
		// destination via the predicate-AST relation-path resolver.
		// Resolution failures (unknown case type, broken walk) are
		// surfaced by the filter / per-input predicate rules; this rule
		// silently skips them rather than double-reporting.
		const isSelfWalk = !input.via || input.via.kind === "self";
		let destinationCaseType: string | undefined;
		if (isSelfWalk) {
			destinationCaseType = mod.caseType;
		} else if (input.via) {
			// `checkRelationPath` returns `undefined` on unresolvable walks
			// and pushes onto the errors list it's given. Pass a discardable
			// list — the predicate-side rules cover the resolution-failure
			// reporting.
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

		const ct = caseTypes.find((c) => c.name === destinationCaseType);
		if (!ct) continue;

		const property = ct.properties.find((p) => p.name === input.property);
		if (!property) continue; // surfaced by predicate-side rules

		const allowed = SEARCH_MODE_PROPERTY_TYPES[input.mode.kind];
		if (allowed === undefined) continue; // mode admits every type

		const dataType = effectiveDataType(property);
		if (allowed.includes(dataType)) continue;

		errors.push(
			validationError(
				"CASE_LIST_SEARCH_INPUT_MODE_PROPERTY_TYPE_MISMATCH",
				"module",
				`Module "${mod.name}" search input #${index + 1} ("${input.label}", name "${input.name}") uses mode "${input.mode.kind}" against property "${input.property}" on case type "${destinationCaseType}" (data_type "${dataType}"). The "${input.mode.kind}" mode requires a property whose data_type is one of ${allowed.map((t) => `"${t}"`).join(" / ")}. Either pick a different mode, or change the property's data_type.`,
				{ moduleUuid, moduleName: mod.name },
				{
					index: String(index),
					inputName: input.name,
					mode: input.mode.kind,
					property: input.property,
					propertyDataType: dataType,
					destinationCaseType,
				},
			),
		);
	}

	return errors;
}
