/**
 * Rule: reject simple-arm `(mode, via, name vs property)`
 * combinations that no CCHQ wire shape can carry faithfully.
 *
 * `range` mode requires self-walk AND `name === property`.
 *     CCHQ's `daterange` widget serializes one encoded
 *     `__range__<start>__<end>` answer, and CCHQ's special runtime matcher
 *     applies that pair to the current-case property named by the prompt key
 *     (the prompt key IS the property name on the wire). Two shapes break
 *     that:
 *
 *       - **Non-self via** — the single `<prompt key="X">` element
 *         binds one runtime value and carries no relation-walk
 *         metadata; the encoded pair's matcher has no equivalent wire form
 *         on a related case.
 *
 *       - **`name !== property`** — the auto-match queries the case
 *         property named by `name`, not the authored target
 *         `property`, and the `_xpath_query` route has no range arm
 *         (`match` only carries text-mode arms; the `between`
 *         predicate would need two synthetic per-bound input refs
 *         the wire layer doesn't synthesize for `range`).
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
	effectiveSimpleSearchModeKind,
	type Module,
	multiSelectSearchInputRefusal,
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
		const modeKind = effectiveSimpleSearchModeKind(input);

		// `range` rejects on two shapes: a non-self via (the two-value
		// wire form can't ride on a single prompt binding when the
		// property lives on a related case) and `name !== property` on
		// any via (CCHQ's auto-match keys on the prompt key, not the
		// authored target; the `_xpath_query` route has no range arm
		// to fall back to). Self-walk + `name === property` is the
		// only `range` shape the bare prompt slot carries faithfully.
		const via = input.via;
		const viaIsCrossWalk = via !== undefined && via.kind !== "self";
		const nameDiverges = input.name !== input.property;
		// A `multi-select` prompt stores every chosen value in one
		// space-separated answer. Only CCHQ's bare-prompt route splits
		// that answer into repeated query parameters (an any-of match on
		// the property named by the prompt key). The `_xpath_query`
		// route compares one string, so every shape that would need it
		// (a related case, a prompt named differently from its property,
		// or an attribute-backed property such as `status`) has no
		// faithful wire form. `multiSelectSearchInputRefusal` is the one home
		// of that decision, so the builder withholds exactly these shapes.
		if (
			input.type === "multi-select" &&
			multiSelectSearchInputRefusal(input) !== undefined
		) {
			errors.push(
				validationError(
					"CASE_LIST_MULTI_SELECT_INPUT_NEEDS_DIRECT_MATCH",
					"module",
					`Search input "${input.label || input.name}" (input #${i + 1}, name "${input.name}") on module "${mod.name}" lets workers pick several values, but it ${
						viaIsCrossWalk
							? `reads a related case's property "${input.property}"`
							: nameDiverges
								? `targets the case property "${input.property}" under a different name`
								: `targets "${input.property}", which CommCare stores as case metadata rather than a case property`
					}. CommCare matches a multiple-choice answer only when the prompt is named after a plain property on the searched case itself, so this shape has no search that honors every chosen value. Name the input "${input.property}" and search the current case, switch it to a single-choice \`select\`, or convert it to the advanced arm and author the predicate.`,
					{ moduleUuid, moduleName: mod.name },
					{
						slot: `caseListConfig.searchInputs[${i}]`,
						inputName: input.name,
						inputUuid: input.uuid,
						viaKind: via?.kind ?? "absent",
						nameDiverges: nameDiverges ? "true" : "false",
					},
				),
			);
			continue;
		}
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
						slot: `caseListConfig.searchInputs[${i}]`,
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
			return `${inputDescriptor} uses the \`range\` mode, walks ${directionLabel}, AND names the prompt "${input.name}" against a different case property "${input.property}". CCHQ's \`daterange\` widget stores one encoded start/end answer, and CCHQ's special runtime matcher applies that pair to the current-case property named by the prompt key; neither half works here, the prompt carries no relation walk, and the prompt key doesn't name the targeted property. ${fixHints}`;
		}
		return `${inputDescriptor} walks ${directionLabel} but uses the \`range\` mode. CCHQ's \`daterange\` widget stores one encoded start/end answer, and its special matcher can apply that pair only to the current-case property named by the prompt key; a \`<prompt>\` carries no relation-walk metadata. ${fixHints}`;
	}
	return `${inputDescriptor} uses the \`range\` mode and names the prompt "${input.name}" against a different case property "${input.property}". CCHQ's runtime auto-matches the typed range against the case property named by the prompt key (the prompt key IS the property name on the wire), and the simple-arm \`_xpath_query\` route has no range arm to fall back to. Rename the prompt to match its targeted property (so the prompt key and the property name agree), pick a single-value mode the explicit-predicate route covers (\`exact\` / \`fuzzy-date\`), or convert the input to the advanced arm so the predicate is fully authored.`;
}

/**
 * Resolve the effective mode kind from a simple-arm input, applying
 * the same default the runtime preview and the wire-emission
 * simple-arm derivation apply. All three surfaces consume the
 * canonical `DEFAULT_SEARCH_MODE_KIND` table at `lib/domain/modules.ts`.
 */
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
