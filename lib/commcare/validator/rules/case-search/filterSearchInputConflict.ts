/**
 * Rule: Nova rejects an ambiguous double-binding when
 * `caseSearchConfig` is present (so the module emits a
 * `<remote-request>` carrying `<data key="_xpath_query">`) and the
 * SAME `(destinationCaseType, property)` pair appears in BOTH:
 *
 *   - a `prop(...)` reference inside `caseListConfig.filter` (the
 *     unified always-on filter), AND
 *   - a simple-arm `caseListConfig.searchInputs[i]` (a simple
 *     input's targeted property at its destination case type).
 *
 * CCHQ accepts the double-binding without complaint — it
 * AND-composes both contributions into the same `_xpath_query`
 * clause. The author's runtime experience is what fails: the
 * always-on filter ANDs with the typed-value filter and the user
 * sees an unexpectedly empty result set whenever the two values
 * disagree. Two filters on the same property is rarely the
 * intent; one of them is almost certainly meant to replace the
 * other, and the editor cannot tell which.
 *
 * The dedup key is `(destinationCaseType, property)` — NOT bare
 * property name — because property names with distinct `via` walks
 * resolve to distinct runtime paths and AND-compose fine: a filter
 * `prop("patient", "region", ancestor[parent])` (parent's region)
 * and a simple input `{ property: "region" }` (patient's region)
 * bind to two different cases and the wire layer carries both
 * without an authoring ambiguity.
 *
 * Path resolution mirrors `searchInputModeMatchesPropertyType`'s
 * pattern: route every `(property, via, originCaseType)` triple
 * through `checkRelationPath` to land on the destination case
 * type, then key the conflict set on
 * `<destinationCaseType>.<property>`. Resolution failures (the
 * walk doesn't resolve) skip silently — the type-check rules
 * surface relation-path errors elsewhere, so this rule avoids
 * double-reporting.
 *
 * Advanced-arm inputs are skipped: their authored predicate
 * doesn't bind a single property at the schema layer, so they
 * can't structurally collide with a filter reference. The
 * advanced predicate's own type-check (in
 * `searchInputPredicateTypeCheck`) covers its references.
 *
 * Two short-circuit paths:
 *
 *   - `caseSearchConfig` absent — no `<remote-request>` is
 *     emitted; filter and search inputs may legitimately share
 *     property names without the AND-composition ambiguity.
 *   - `mod.caseType` absent — the originating scope is unknowable,
 *     so destination resolution is impossible. The structural
 *     module rules (`NO_CASE_TYPE`) surface that elsewhere; this
 *     rule passes silently.
 */

import type { BlueprintDoc, Module, Uuid } from "@/lib/domain";
import {
	type CheckError,
	checkRelationPath,
	type PropertyRef,
	type TypeContext,
	walkPropertyRefs,
} from "@/lib/domain/predicate";
import { type ValidationError, validationError } from "../../errors";
import { moduleTypeContext } from "../case-list/shared";

export function filterSearchInputConflict(
	mod: Module,
	moduleUuid: Uuid,
	doc: BlueprintDoc,
): ValidationError[] {
	if (!mod.caseSearchConfig) return [];
	const filter = mod.caseListConfig?.filter;
	if (!filter) return [];
	if (!mod.caseType) return [];

	const ctx = moduleTypeContext(mod, doc);
	const moduleCaseType = mod.caseType;

	// Build the simple-arm input set keyed by their resolved
	// destination case type. Inputs whose `via` walk doesn't resolve
	// drop out — the per-input rules surface relation-path errors
	// against the input's `via` slot directly, and feeding an
	// unresolvable simple input into the conflict set would compare
	// against `undefined` and silently miss real conflicts on
	// resolved inputs.
	const simpleInputKeys = new Set<string>();
	for (const input of mod.caseListConfig?.searchInputs ?? []) {
		if (input.kind !== "simple") continue;
		const destination = resolveDestination(ctx, moduleCaseType, input.via);
		if (destination === undefined) continue;
		simpleInputKeys.add(conflictKey(destination, input.property));
	}
	if (simpleInputKeys.size === 0) return [];

	// Walk the filter for every `prop(...)` reference. The walker
	// surfaces direct comparison operands AND the `property` slot on
	// `within-distance` / `match` / `multi-select-contains` (which
	// carry `PropertyRef` directly, not a `prop`-Term wrapper). For
	// each filter ref, resolve its destination through its OWN
	// `caseType` slot (not `mod.caseType`) — inside `exists` /
	// `missing` `where` clauses, `ref.caseType` carries the
	// surrounding via's destination, not the module's case type.
	const reportedConflicts = new Set<string>();
	const errors: ValidationError[] = [];
	walkPropertyRefs(filter, (ref) => {
		const destination = resolveDestination(ctx, ref.caseType, ref.via);
		if (destination === undefined) return;
		const key = conflictKey(destination, ref.property);
		if (!simpleInputKeys.has(key)) return;
		// Multiple `prop(...)` references against the same
		// `(destinationCaseType, property)` pair (e.g. an `eq` and a
		// `between` against the same column) emit one error so the
		// author isn't drowned in duplicates.
		if (reportedConflicts.has(key)) return;
		reportedConflicts.add(key);
		errors.push(buildConflictError(mod, moduleUuid, destination, ref.property));
	});

	return errors;
}

/**
 * Compose the conflict-set lookup key. Destination case type comes
 * first so the key sorts grouped-by-case-type when surfaced in the
 * editor; the property name is the in-group identifier. The shape
 * is private to this module — callers never decompose it.
 */
function conflictKey(destinationCaseType: string, property: string): string {
	return `${destinationCaseType}.${property}`;
}

/**
 * Resolve a `(originCaseType, via)` walk to its destination case
 * type. Returns `undefined` on resolution failure so the caller
 * can skip the contribution silently — the predicate / value-
 * expression type-check rules surface every relation-path error
 * with full provenance; double-reporting them here would crowd
 * the editor.
 *
 * Self-walk (`via` absent or `kind === "self"`) lands on the
 * origin directly — no relation-path call needed.
 *
 * Cross-walk routes through `checkRelationPath` against a
 * discardable `errors` list: the walk's destination is the
 * function's return value; per-step errors belong to the rules
 * that own the slot being walked, not to this conflict-detection
 * rule.
 */
function resolveDestination(
	ctx: TypeContext,
	originCaseType: string,
	via: PropertyRef["via"] | undefined,
): string | undefined {
	if (!via || via.kind === "self") return originCaseType;
	const discard: CheckError[] = [];
	return checkRelationPath(via, originCaseType, ctx, discard, []);
}

/**
 * Render the property-conflict error in the project's Elm-style
 * voice. Names the resolved destination case type so the author
 * sees exactly which runtime path Nova flagged, threading the
 * three-component shape: (1) what was tried + ambiguous, (2) why
 * Nova surfaces this as an authoring choice rather than a runtime
 * outcome, (3) what to look at to disambiguate.
 */
function buildConflictError(
	mod: Module,
	moduleUuid: Uuid,
	destinationCaseType: string,
	propertyName: string,
): ValidationError {
	return validationError(
		"CASE_SEARCH_FILTER_SEARCH_INPUT_CONFLICT",
		"module",
		`Module "${mod.name}" binds the property "${propertyName}" on case type "${destinationCaseType}" in both \`caseListConfig.filter\` (the always-on filter) and a simple-arm search input on \`caseListConfig.searchInputs\`. The two clauses AND-compose into one wire-layer query — at runtime the always-on filter narrows the search results before the typed value is matched, and the two filters rarely agree, so the user sees an unexpectedly empty result set whenever the always-on value and the typed value disagree. One of the two clauses is likely meant to replace the other. Either remove "${propertyName}" from the filter predicate (and let the typed search drive the comparison) or remove the search input that targets "${propertyName}" (and let the always-on filter pin the value) so the runtime path "${destinationCaseType}.${propertyName}" binds at exactly one site.`,
		{ moduleUuid, moduleName: mod.name },
		{ destinationCaseType, property: propertyName },
	);
}
