/**
 * Rule: reject simple-arm `(mode, via, name vs property)`
 * combinations that no CCHQ wire shape can carry faithfully.
 *
 * Three distinct rejections fire here:
 *
 *   - `range` mode requires self-walk AND `name === property`.
 *     CCHQ's `date` / `daterange` widget reads two bindings
 *     (`<name>:from` and `<name>:to`) and CCHQ's runtime auto-matches
 *     the typed range against the case property named by the prompt
 *     key (the prompt key IS the property name on the wire). Two
 *     shapes break that:
 *
 *       - **Non-self via** — the single `<prompt key="X">` element
 *         binds one runtime value and carries no relation-walk
 *         metadata; the daterange's two-bound semantic has no
 *         equivalent wire form on a related case.
 *
 *       - **`name !== property`** — the auto-match queries the case
 *         property named by `name`, not the authored target
 *         `property`, and the `_xpath_query` route has no range arm
 *         (`match` only carries text-mode arms; the `between`
 *         predicate would need two synthetic per-bound input refs
 *         the wire layer doesn't synthesize for `range`).
 *
 *   - `multi-select-contains` mode is rejected on every simple-arm
 *     input, including self-walk. The runtime preview comma-splits
 *     one user-typed value into a token list at evaluation time;
 *     CCHQ's wire side has two failure modes:
 *
 *       - Self-walk: the bare `<prompt key="X">` element binds one
 *         literal string at the search-input slot, and CCHQ's
 *         runtime defaults a `case_property = "<bound value>"`
 *         criteria to full-string exact match
 *         (`commcare-hq/corehq/apps/es/case_search.py::case_property_query`
 *         → `exact_case_property_text_query`). The author's intent
 *         ("does this multi-select property contain this token?")
 *         silently mismatches.
 *
 *       - Cross-walk: the simple-arm derivation lifts to an
 *         advanced-style predicate at wire emission, but
 *         `multi-select-contains` in Nova's AST stores the values
 *         list as literals — no operator in the simple-arm
 *         derivation admits an `input(name)` Term as the
 *         membership source, so the lift has no faithful target.
 *
 *     Authors who need token containment compose the explicit
 *     `selected(prop, input("name"))` predicate on the advanced
 *     arm, where CCHQ's `selected_any` query function gives the
 *     desired space-delimited-token semantic.
 *
 * Modes that ride cleanly on the wire — `exact` (bare prompt for
 * self-walk; predicate in `_xpath_query` for cross-walk) and
 * `fuzzy` / `starts-with` / `phonetic` / `fuzzy-date` (always
 * predicate in `_xpath_query`, regardless of via) — pass through
 * without firing the rule. The wire-emission pipeline in
 * `lib/commcare/suite/case-search/simpleArmDerivation.ts` routes
 * those modes accordingly.
 *
 * Advanced-arm inputs already author the predicate by hand and run
 * through their own type checker; the rule short-circuits on them.
 * Short-circuits cleanly on absent `caseListConfig` or empty
 * `searchInputs`.
 */

import {
	type BlueprintDoc,
	canonicalCasePropertyName,
	DEFAULT_SEARCH_MODE_KIND,
	type Module,
	type SimpleSearchInputDef,
	type Uuid,
} from "@/lib/domain";
import { type ValidationError, validationError } from "../../errors";

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
		// Resolve the effective mode kind, applying the same default
		// the runtime preview applies. The `date-range` type's default
		// resolves to `range`, which trips the cross-walk rejection;
		// gate by the resolved mode kind, not just the authored `mode`
		// slot.
		const modeKind = resolveModeKind(input);

		// `multi-select-contains` rejects on every simple-arm input;
		// see the rule docstring for the wire-shape rationale.
		if (modeKind === "multi-select-contains") {
			errors.push(
				validationError(
					"CASE_LIST_SIMPLE_INPUT_VIA_INCOMPATIBLE_MODE",
					"module",
					`Search input "${input.label || input.name}" (input #${i + 1}, name "${input.name}") on module "${mod.name}" uses the \`multi-select-contains\` mode on the simple arm. CCHQ's runtime treats a bare search-input value as a full-string exact match against the case property, so simple-arm \`multi-select-contains\` silently mismatches — a multi-select case property storing "red green blue" would not match the typed value "green". Convert this input to the advanced arm and author the predicate as \`selected(prop("${mod.caseType ?? "<case-type>"}", "${input.property}"), input("${input.name}"))\`, which CCHQ evaluates as space-delimited token containment via its \`selected_any\` query function.`,
					{ moduleUuid, moduleName: mod.name },
					{
						inputName: input.name,
						inputUuid: input.uuid,
						modeKind,
						viaKind: input.via?.kind ?? "absent",
					},
				),
			);
			continue;
		}

		// `range` rejects on two shapes: a non-self via (the two-value
		// wire form can't ride on a single prompt binding when the
		// property lives on a related case) and `name !== property` on
		// any via (CCHQ's auto-match keys on the prompt key, not the
		// authored target; the `_xpath_query` route has no range arm
		// to fall back to). Self-walk + `name === property` is the
		// only `range` shape the bare prompt slot carries faithfully.
		const via = input.via;
		const viaIsCrossWalk = via !== undefined && via.kind !== "self";
		const nameDiverges =
			input.name !== canonicalCasePropertyName(input.property);
		if (modeKind === "range" && (viaIsCrossWalk || nameDiverges)) {
			errors.push(
				validationError(
					"CASE_LIST_SIMPLE_INPUT_VIA_INCOMPATIBLE_MODE",
					"module",
					buildRangeRejectionMessage({
						mod,
						input,
						index: i,
						viaIsCrossWalk,
						nameDiverges,
						via,
					}),
					{ moduleUuid, moduleName: mod.name },
					{
						inputName: input.name,
						inputUuid: input.uuid,
						modeKind,
						viaKind: via?.kind ?? "absent",
						nameDiverges: nameDiverges ? "true" : "false",
					},
				),
			);
		}
	}
	return errors;
}

/**
 * Compose the per-rejection message body for `range`-mode rejections.
 * Two `(viaIsCrossWalk, nameDiverges)` flag combinations produce
 * three message shapes:
 *
 *   - Cross-walk via only — daterange's two-bound semantic has no
 *     wire form on a related case.
 *   - `name !== property` only — CCHQ's auto-match keys on the
 *     prompt key, so the typed range queries the wrong case property.
 *   - Both — list both reasons.
 *
 * Every arm threads the same three-part Elm-voice shape: what was
 * tried + went wrong, the expected condition, what to look at to
 * resolve the issue.
 */
function buildRangeRejectionMessage(args: {
	readonly mod: Module;
	readonly input: SimpleSearchInputDef;
	readonly index: number;
	readonly viaIsCrossWalk: boolean;
	readonly nameDiverges: boolean;
	readonly via: SimpleSearchInputDef["via"];
}): string {
	const { mod, input, index, viaIsCrossWalk, nameDiverges, via } = args;
	const inputLabel = input.label || input.name;
	const moduleName = mod.name;
	const inputDescriptor = `Search input "${inputLabel}" (input #${index + 1}, name "${input.name}") on module "${moduleName}"`;
	const fixHints = `Either drop the input back to a single \`range\`-compatible shape (current-case property with \`name\` matching \`property\`), pick a single-value mode like \`exact\` or \`fuzzy-date\`, or convert the input to the advanced arm so the predicate is fully authored.`;

	// `viaIsCrossWalk` already guarantees `via.kind !== "self"`. The
	// guard here narrows the type for `relationDirectionLabel`'s
	// exhaustive switch over the cross-walk kinds (`ancestor`,
	// `subcase`, `any-relation`).
	if (viaIsCrossWalk && via !== undefined && via.kind !== "self") {
		const directionLabel = relationDirectionLabel(via.kind);
		if (nameDiverges) {
			return `${inputDescriptor} uses the \`range\` mode, walks ${directionLabel}, AND names the prompt "${input.name}" against a different case property "${input.property}". CCHQ's \`daterange\` widget reads two runtime values per input and CCHQ's runtime auto-matches the typed range against the case property named by the prompt key; neither half works here — the relation walk has no two-bound wire form, and the prompt key doesn't name the targeted property. ${fixHints}`;
		}
		return `${inputDescriptor} walks ${directionLabel} but uses the \`range\` mode. CCHQ's \`daterange\` widget reads two separate values per input (a start and an end), but each \`<prompt>\` element binds only one value on the wire — so a range-mode input only works when the property lives on the current case (the widget handles the two-bound semantic internally). ${fixHints}`;
	}
	return `${inputDescriptor} uses the \`range\` mode and names the prompt "${input.name}" against a different case property "${input.property}". CCHQ's runtime auto-matches the typed range against the case property named by the prompt key (the prompt key IS the property name on the wire), and the simple-arm \`_xpath_query\` route has no range arm to fall back to. Rename the prompt to match its targeted property (so the prompt key and the property name agree), pick a single-value mode the explicit-predicate route covers (\`exact\` / \`fuzzy-date\`), or convert the input to the advanced arm so the predicate is fully authored.`;
}

/**
 * Resolve the effective mode kind from a simple-arm input, applying
 * the same default the runtime preview and the wire-emission
 * simple-arm derivation apply. All three surfaces consume the
 * canonical `DEFAULT_SEARCH_MODE_KIND` table at `lib/domain/modules.ts`.
 */
function resolveModeKind(input: SimpleSearchInputDef): string {
	if (input.mode !== undefined) return input.mode.kind;
	return DEFAULT_SEARCH_MODE_KIND[input.type];
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
