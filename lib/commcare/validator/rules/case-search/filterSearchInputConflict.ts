/**
 * Rule: when `caseSearchConfig` is present (so the module emits a
 * `<remote-request>` carrying `<data key="_xpath_query">`), no case
 * property may appear in BOTH:
 *
 *   - a `prop(...)` reference inside `caseListConfig.filter` (the
 *     unified always-on filter), AND
 *   - the `property` slot of a simple-arm
 *     `caseListConfig.searchInputs[i]` (a simple input's targeted
 *     property).
 *
 * The two contributions AND-compose into one `<data
 * key="_xpath_query">` at the wire-emission layer. CCHQ's runtime
 * rejects this configuration as a duplicate-binding error, so the
 * validator surfaces it at authoring time before the export hits
 * CCHQ.
 *
 * The simple-arm filter is the gate the wire-emission layer applies:
 * advanced-arm inputs author their own predicate (`predicate` slot)
 * and don't bind a single property at the schema layer, so they
 * can't structurally collide with a filter reference. The rule
 * mirrors that semantic and only inspects the simple-arm
 * `property` set.
 *
 * Short-circuits cleanly when `caseSearchConfig` is absent — the
 * filter and the search inputs may legitimately share property
 * names when no `<remote-request>` is being emitted, so the rule
 * has no authoring concern to gate in that case.
 */

import type { BlueprintDoc, Module, Uuid } from "@/lib/domain";
import { walkPropertyRefs } from "@/lib/domain/predicate";
import { type ValidationError, validationError } from "../../errors";

export function filterSearchInputConflict(
	mod: Module,
	moduleUuid: Uuid,
	_doc: BlueprintDoc,
): ValidationError[] {
	if (!mod.caseSearchConfig) return [];
	const filter = mod.caseListConfig?.filter;
	if (!filter) return [];

	const simpleArmProperties = new Set(
		(mod.caseListConfig?.searchInputs ?? [])
			.filter(
				(input): input is Extract<typeof input, { kind: "simple" }> =>
					input.kind === "simple",
			)
			.map((input) => input.property),
	);
	if (simpleArmProperties.size === 0) return [];

	// `walkPropertyRefs` surfaces every `prop(...)` reference reached
	// anywhere inside the filter — direct comparison operands AND the
	// `property` slot on `within-distance` / `match` /
	// `multi-select-contains`. The walker is the canonical AST
	// visitor; using it here keeps the rule aligned with every other
	// consumer that needs property-ref enumeration (no duplicated
	// recursive descent).
	const reportedConflicts = new Set<string>();
	const errors: ValidationError[] = [];
	walkPropertyRefs(filter, (ref) => {
		if (!simpleArmProperties.has(ref.property)) return;
		// One module's filter may reference the same property multiple
		// times (e.g. an `eq` and a `between` against the same column)
		// — surface one error per conflicting property name so the
		// author isn't drowned in duplicates.
		if (reportedConflicts.has(ref.property)) return;
		reportedConflicts.add(ref.property);
		errors.push(buildConflictError(mod, moduleUuid, ref.property));
	});

	return errors;
}

/**
 * Render the property-conflict error. Voice mirrors the rule-set's
 * Elm-style three-component shape: (1) what was tried + went wrong,
 * (2) the expected condition the author should establish, (3) what
 * to look at to resolve the conflict.
 */
function buildConflictError(
	mod: Module,
	moduleUuid: Uuid,
	propertyName: string,
): ValidationError {
	return validationError(
		"CASE_SEARCH_FILTER_SEARCH_INPUT_CONFLICT",
		"module",
		`Module "${mod.name}" has the property "${propertyName}" declared in both \`caseListConfig.filter\` (the always-on filter) and a simple-arm search input on \`caseListConfig.searchInputs\`. With \`caseSearchConfig\` present, both contributions AND-compose into one wire-layer query and CCHQ's runtime rejects the duplicate binding. Move "${propertyName}" to one of the two surfaces — either remove the reference from the filter predicate or remove the search input that targets it — so the property binds at exactly one site.`,
		{ moduleUuid, moduleName: mod.name },
		{ property: propertyName },
	);
}
