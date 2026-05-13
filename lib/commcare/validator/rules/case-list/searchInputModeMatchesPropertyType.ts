/**
 * Rule: every simple `SearchInputDef` with an explicit `mode` declares
 * a mode whose semantics match the targeted property's effective
 * `data_type` — at the input's destination case type (resolved through
 * `via` when the input carries a relation walk).
 *
 * `SearchInputDef` is a discriminated union over `kind: "simple"` and
 * `kind: "advanced"`:
 *
 *   - `kind: "simple"` — the (property, mode, via) shape this rule
 *     gates. `property` is REQUIRED on this arm, so the existence
 *     check + per-mode allow-list both bind directly. `mode` is
 *     optional: omitted → wire layer picks the per-`type` default,
 *     which is always admissible for that type, so the rule short-
 *     circuits.
 *   - `kind: "advanced"` — body is a free-form `predicate: Predicate`
 *     AST. The advanced arm has no `mode` slot at the schema layer;
 *     property resolution lives inside the AST and is type-checked by
 *     the predicate / per-input predicate rules elsewhere. This rule
 *     short-circuits the advanced arm to avoid double-reporting.
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
		// Advanced inputs delegate property resolution to the predicate
		// AST type checker (`filterTypeCheck` / per-input predicate
		// rules); this rule's domain (mode-vs-property compatibility)
		// has no slot to inspect on the advanced arm.
		if (input.kind === "advanced") continue;
		// Simple input without an explicit mode: the wire layer picks
		// the per-`type` default, which is always admissible for that
		// type, so this rule has no decision to make.
		if (!input.mode) continue;

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
					`Search input "${input.label}" (input #${index + 1}, name "${input.name}") on the case list of module "${mod.name}" targets the case property "${input.property}" on case type "${destinationCaseType}", but no case property by that name is declared on that case type, written by any form field via \`case_property_on\`, or part of CommCare's standard set ("case_name", "date_opened", …). Either add "${input.property}" to "${destinationCaseType}"'s properties, point a form field at it via \`case_property_on\`, or change the search input to target an existing property.`,
					{ moduleUuid, moduleName: mod.name },
					{
						index: String(index),
						inputName: input.name,
						inputUuid: input.uuid,
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
				`Search input "${input.label}" (input #${index + 1}, name "${input.name}") on the case list of module "${mod.name}" uses search mode "${input.mode.kind}" against property "${input.property}" on case type "${destinationCaseType}", whose \`data_type\` is "${dataType}". The "${input.mode.kind}" mode only admits properties whose \`data_type\` is one of ${allowed.map((t) => `"${t}"`).join(" / ")} — running it against "${dataType}" wouldn't produce a meaningful match at the wire layer. Either pick a search mode that admits "${dataType}", change the property's \`data_type\` to one the mode supports, or target a different property whose declared type fits.`,
				{ moduleUuid, moduleName: mod.name },
				{
					index: String(index),
					inputName: input.name,
					inputUuid: input.uuid,
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
