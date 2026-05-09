/**
 * Rule: every `input("name")` reference inside the case-search-config
 * predicates resolves to a search input declared on the module's
 * `caseListConfig.searchInputs[*].name`.
 *
 * Fires per-module. The case-search screen and the case-list screen
 * share one search-input declaration list — `caseListConfig.searchInputs`
 * is the single source. The case-search-config predicates
 * (`claimCondition`, `searchButtonDisplayCondition`) bind their
 * `input(...)` Term references to that list at the runtime layer; an
 * orphan reference (a name that nothing on the list declares) wires
 * the runtime up to a non-existent input slot, which CCHQ's runtime
 * treats as a permanent no-op against the predicate.
 *
 * The walker visits both `simple` and `advanced` arms of
 * `searchInputs` to build the declared-name set — both arms expose
 * `name` directly. The predicates are walked through the canonical
 * AST visitor (`walkInputRefs`), so every `input(...)` Term reaches
 * this rule regardless of which operator carries it (`when-input-
 * present.input`, an `eq` left/right operand, a `between` bound, an
 * `if.cond` predicate, etc.).
 *
 * Short-circuits cleanly when `caseSearchConfig` is absent — no
 * `<remote-request>` is emitted in that case, and the rule has no
 * authoring concern to gate.
 */

import type { BlueprintDoc, Module, Uuid } from "@/lib/domain";
import { walkInputRefs } from "@/lib/domain/predicate";
import { type ValidationError, validationError } from "../../errors";

/**
 * Authoring slot a predicate lives on inside `caseSearchConfig`.
 * Carries through to the error message verbatim so authors locate
 * the offending predicate without ambiguity when a module has both
 * a `claimCondition` and a `searchButtonDisplayCondition` that each
 * reference an orphan name.
 */
type CaseSearchConfigPredicateSlot =
	| "caseSearchConfig.claimCondition"
	| "caseSearchConfig.searchButtonDisplayCondition";

export function searchInputReferences(
	mod: Module,
	moduleUuid: Uuid,
	_doc: BlueprintDoc,
): ValidationError[] {
	const config = mod.caseSearchConfig;
	if (!config) return [];

	const declaredNames = new Set(
		(mod.caseListConfig?.searchInputs ?? []).map((input) => input.name),
	);

	const errors: ValidationError[] = [];

	// Both predicate slots fire through the same orphan check — the
	// slot path threads through the error message so the editor can
	// land on the right card.
	const slots: ReadonlyArray<{
		path: CaseSearchConfigPredicateSlot;
		predicate: NonNullable<typeof config.claimCondition>;
	}> = [
		...(config.claimCondition !== undefined
			? ([
					{
						path: "caseSearchConfig.claimCondition",
						predicate: config.claimCondition,
					},
				] as const)
			: []),
		...(config.searchButtonDisplayCondition !== undefined
			? ([
					{
						path: "caseSearchConfig.searchButtonDisplayCondition",
						predicate: config.searchButtonDisplayCondition,
					},
				] as const)
			: []),
	];

	for (const { path, predicate } of slots) {
		walkInputRefs(predicate, (ref) => {
			if (declaredNames.has(ref.name)) return;
			errors.push(
				buildOrphanError(mod, moduleUuid, path, ref.name, declaredNames),
			);
		});
	}

	return errors;
}

/**
 * Render the orphan-input-ref error in the project's Elm-style
 * voice. The message threads (1) what was tried + went wrong, (2)
 * the expected condition, (3) what to look at — three components
 * the rule-set-wide error voice locks. The declared-names set is
 * surfaced verbatim when non-empty so the author has a one-glance
 * picture of the candidates; an empty set surfaces a distinct
 * sentence so the author knows the input list itself is empty.
 */
function buildOrphanError(
	mod: Module,
	moduleUuid: Uuid,
	slot: CaseSearchConfigPredicateSlot,
	orphanName: string,
	declaredNames: ReadonlySet<string>,
): ValidationError {
	const declaredList =
		declaredNames.size === 0
			? "no search inputs are declared on this module's `caseListConfig.searchInputs`"
			: `the declared inputs are ${[...declaredNames]
					.map((n) => `"${n}"`)
					.join(", ")}`;
	return validationError(
		"CASE_SEARCH_INPUT_REFERENCE_UNKNOWN",
		"module",
		`Module "${mod.name}" references a search input named "${orphanName}" inside \`${slot}\`, but no search input with that name is declared on \`caseListConfig.searchInputs\` (${declaredList}). Either rename the reference to match a declared input, declare a search input with that name on the case-list config, or remove the reference from the predicate.`,
		{ moduleUuid, moduleName: mod.name },
		{ slot, inputName: orphanName },
	);
}
