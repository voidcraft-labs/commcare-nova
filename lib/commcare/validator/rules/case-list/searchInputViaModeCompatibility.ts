/**
 * Rule: simple-arm search inputs whose `via` is a non-self relation
 * walk are restricted to mode kinds that produce a single-input-ref
 * predicate at wire-emit time.
 *
 * Why the restriction. The CCHQ wire shape binds exactly one user-
 * typed value per `<prompt key="X">` element — the runtime reads
 * `instance('search-input:results')/input/field[@name='X']` and
 * substitutes the bound value at predicate-evaluation time. The
 * simple-arm-with-via wire pipeline auto-derives an advanced-style
 * predicate from `(property, mode, via)` at emission and routes the
 * relation walk through `_xpath_query` instead of the bare `<prompt>`
 * (otherwise the relation walk would silently drop on the wire — see
 * the wire emitters at
 * `lib/commcare/suite/case-search/searchPrompts.ts::emitPromptElement`
 * and `lib/commcare/hqJson/caseList.ts::projectSimpleSearchInput`,
 * neither of which encodes `input.via`).
 *
 * Two simple-arm mode kinds break that derivation:
 *
 *   - `range`: the runtime case-list preview reads two separate
 *     bindings, `<name>:from` and `<name>:to`. The wire pipeline
 *     binds exactly one prompt key per input, so there's no
 *     equivalent two-binding shape on the CCHQ side. Self-walk
 *     `range` inputs work because CCHQ's `date` / `daterange` widget
 *     handles the two-bound semantic internally; the relation walk
 *     can't ride on that single binding.
 *
 *   - `multi-select-contains`: the runtime preview comma-splits one
 *     bound value into a token list at evaluation time. CCHQ's
 *     wire-side prompt binds one literal string; the relation-walked
 *     `_xpath_query` predicate would carry a single-token comparison
 *     against the relation-walked property, which is not what the
 *     author meant.
 *
 * For the other mode kinds (`exact` / `fuzzy` / `starts-with` /
 * `phonetic` / `fuzzy-date`), the wire pipeline derives a clean
 * single-input-ref predicate (`eq(prop, input(name))` /
 * `match(prop, input(name), mode)`) that AND-composes into
 * `_xpath_query` cleanly. The author's intent survives the wire
 * round-trip.
 *
 * The rule fires only on simple-arm inputs with a non-self `via`;
 * advanced-arm inputs already author the predicate by hand and have
 * their own type checker. Short-circuits cleanly on absent
 * `caseListConfig` or empty `searchInputs`.
 */

import type { BlueprintDoc, Module, Uuid } from "@/lib/domain";
import { type ValidationError, validationError } from "../../errors";

/** Mode kinds that derive cleanly to a single-input-ref wire predicate. */
const VIA_COMPATIBLE_MODE_KINDS = new Set<string>([
	"exact",
	"fuzzy",
	"starts-with",
	"phonetic",
	"fuzzy-date",
]);

export function searchInputViaModeCompatibility(
	mod: Module,
	moduleUuid: Uuid,
	_doc: BlueprintDoc,
): ValidationError[] {
	const inputs = mod.caseListConfig?.searchInputs ?? [];
	if (inputs.length === 0) return [];

	const errors: ValidationError[] = [];
	for (let i = 0; i < inputs.length; i++) {
		const input = inputs[i];
		if (input.kind !== "simple") continue;
		const via = input.via;
		if (via === undefined || via.kind === "self") continue;
		// The mode defaults at wire-emit time when absent; the default
		// for every `SearchInputType` is `exact`-equivalent (text /
		// select / barcode → `exact`, date → `exact`, date-range →
		// `range`). The `date-range` type's default is `range`, which
		// trips the rule; gate by the resolved mode kind, not just the
		// authored `mode` slot.
		const modeKind = resolveModeKind(input);
		if (VIA_COMPATIBLE_MODE_KINDS.has(modeKind)) continue;

		const directionLabel = relationDirectionLabel(via.kind);
		errors.push(
			validationError(
				"CASE_LIST_SIMPLE_INPUT_VIA_INCOMPATIBLE_MODE",
				"module",
				`Search input "${input.label || input.name}" (input #${i + 1}, name "${input.name}") on module "${mod.name}" walks ${directionLabel} but uses the \`${modeKind}\` mode. The CCHQ wire layer binds exactly one user-typed value per search input, so the wire pipeline derives a single-comparison predicate from \`(property, mode, via)\` at upload time — but \`${modeKind}\` mode reads more than one value at runtime, which the single-binding wire shape can't encode without dropping the relation walk. Open the input editor and either pick a single-value mode (\`exact\` / \`fuzzy\` / \`starts-with\` / \`phonetic\` / \`fuzzy-date\`), drop the relation walk back to the current case, or convert the input to the advanced arm so the predicate is fully authored.`,
				{ moduleUuid, moduleName: mod.name },
				{
					inputName: input.name,
					inputUuid: input.uuid,
					modeKind,
					viaKind: via.kind,
				},
			),
		);
	}
	return errors;
}

/**
 * Resolve the effective mode kind from a simple-arm input, applying
 * the same default the runtime preview applies. The mirror of
 * `defaultModeFor` in `lib/preview/engine/runtimeBindings.ts`.
 */
function resolveModeKind(input: {
	type: string;
	mode?: { kind: string };
}): string {
	if (input.mode !== undefined) return input.mode.kind;
	// Default-mode table mirrors `DEFAULT_SEARCH_MODE_KIND` in
	// `lib/preview/engine/runtimeBindings.ts`.
	if (input.type === "date-range") return "range";
	return "exact";
}

function relationDirectionLabel(
	viaKind: "ancestor" | "subcase" | "any-relation",
): string {
	switch (viaKind) {
		case "ancestor":
			return "up to an ancestor case";
		case "subcase":
			return "down to a child case";
		case "any-relation":
			return "across a related case";
		default: {
			const _exhaustive: never = viaKind;
			throw new Error(
				`searchInputViaModeCompatibility: unhandled via kind ${String(_exhaustive)}`,
			);
		}
	}
}
