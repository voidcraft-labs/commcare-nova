/**
 * Rule: every `SearchInputDef` with both a `property` and a `mode`
 * declares a mode whose semantics match the targeted property's
 * effective `data_type` — at the input's destination case type
 * (resolved through `via` when the input carries a relation walk).
 *
 * The mapping table lives at `SEARCH_MODE_PROPERTY_TYPES`
 * (`@/lib/domain/modules`) — never reinvent it here. Modes whose
 * admit-set is `undefined` (e.g. `exact`) widen to every property
 * type and short-circuit the check; any other mode is compared
 * against the property's effective data type.
 *
 * **Load-bearing for runtime correctness.** The case-store's index-
 * DDL emitter depends on this rule passing — an unindexed `range`
 * mode on a text property would be undefined behavior at the
 * Postgres runtime.
 *
 * **Property resolution follows the rule set's shared 3-arm model.**
 * Routes through `resolvePropertyDataType` in `./shared.ts` —
 * declared schema → CommCare standard (typed via
 * `STANDARD_CASE_LIST_PROPERTY_DATA_TYPES`) → writer-derived (text
 * default). `range` against a text-shaped standard property like
 * `case_name` is structurally rejected; `range` against
 * `date_opened` (datetime) passes.
 *
 * Cross-walk inputs (`via` carrying an `ancestor` / `subcase` /
 * `any-relation` step) resolve the destination case type via
 * `checkRelationPath`, then run the same three-arm property
 * resolution against the destination scope.
 *
 * Inputs without a `property` (advanced inputs whose predicate is
 * fully expressed via `xpath`) skip this check; the `xpath`
 * predicate is type-checked by the filter / per-input predicate
 * rules elsewhere.
 */

import type { BlueprintDoc, Module, Uuid } from "@/lib/domain";
import { SEARCH_MODE_PROPERTY_TYPES } from "@/lib/domain";
import { type CheckError, checkRelationPath } from "@/lib/domain/predicate";
import { type ValidationError, validationError } from "../../errors";
import { moduleTypeContext, resolvePropertyDataType } from "./shared";

export function searchInputModeMatchesPropertyType(
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
		// Skip advanced inputs (no property) and inputs with no explicit
		// mode — both fall outside this rule's scope.
		if (!input.property || !input.mode) continue;

		// Resolve the destination case type — self-walk lands on the
		// module's own case type; cross-walks chase the `via` to its
		// destination via the predicate-AST relation-path resolver.
		// `checkRelationPath` pushes its own error onto the supplied
		// list when the walk is unresolvable; the filter / per-input
		// predicate rules surface relation-path failures, so this rule
		// passes a discardable list and silently skips when resolution
		// fails (no double-reporting).
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

		// Resolve the property's data type via the shared 3-arm model
		// — backed by the cached augmented case-type list, so
		// destination lookups (self-walk + cross-walk) all hit memoized
		// state. `undefined` means the property doesn't exist anywhere
		// in the admission set — emit the dedicated unknown-property
		// error so authors get a direct signal rather than a silent
		// pass.
		const dataType = resolvePropertyDataType(
			doc,
			destinationCaseType,
			input.property,
		);
		if (dataType === undefined) {
			errors.push(
				validationError(
					"CASE_LIST_SEARCH_INPUT_UNKNOWN_PROPERTY",
					"module",
					`Module "${mod.name}" search input #${index + 1} ("${input.label}", name "${input.name}") targets property "${input.property}" on case type "${destinationCaseType}", but no such property is declared on the case type, written to by any field via \`case_property_on\`, or part of the standard set ("case_name", "date_opened", …). Add the property to the case type's \`properties[]\`, or pick one that exists.`,
					{ moduleUuid, moduleName: mod.name },
					{
						index: String(index),
						inputName: input.name,
						property: input.property,
						destinationCaseType,
					},
				),
			);
			continue;
		}

		const allowed = SEARCH_MODE_PROPERTY_TYPES[input.mode.kind];
		if (allowed === undefined) continue; // mode admits every type
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
