// lib/commcare/suite/case-search/simpleArmDerivation.ts
//
// Shared derivation pipeline that lifts a simple-arm
// `SearchInputDef` with a non-self relation walk into an
// advanced-style Predicate AST. Both CCHQ wire surfaces — the
// suite-XML `_xpath_query` composer at `xpathQuery.ts` and the HQ
// JSON `default_properties` composer at
// `lib/commcare/hqJson/caseList.ts` — route those inputs through
// this helper so the relation walk lands in `_xpath_query` (the
// authoritative slot for cross-case predicates) rather than being
// dropped at the `<prompt>` / `CaseSearchProperty` slot.
//
// Why the redirection. Each `<prompt key="X">` element binds
// exactly one user-typed value at runtime via
// `instance('search-input:results')/input/field[@name='X']`. The
// prompt itself carries no relation-walk metadata — CCHQ's runtime
// has no wire form for "this prompt's value applies to a related
// case." The relation walk MUST live in the AND-composed
// `_xpath_query` predicate, where the on-device wire form expresses
// "the related case along <via> has <property> matching <input>."
// Without this redirection, the wire layer silently emits a
// self-walk comparison even though the author configured a
// cross-walk — the same input gives different result sets in the
// runtime preview and the CCHQ-uploaded app.
//
// Mode coverage. The simple-arm-with-via shape is restricted at the
// validator layer (`searchInputViaModeCompatibility`) to the modes
// that derive cleanly to a single-input-ref predicate: `exact`,
// `fuzzy`, `starts-with`, `phonetic`, `fuzzy-date`. Two-binding
// modes (`range`, `multi-select-contains`) are rejected before
// reaching this helper — their multi-value runtime semantics have
// no equivalent on the single-binding `<prompt>` wire shape.
// The helper still names the closed mode set explicitly so a future
// `SearchInputMode` arm that admits via composition surfaces here as
// a compile-time `never` error rather than silently dropping.
//
// `when-input-present` wrap. CCHQ's CSQL runtime resolves an unset
// input ref to the empty string, not absent. Without the
// `when-input-present` envelope, an empty input would translate to
// `eq(<related-prop>, '')` and silently match cases whose related
// property is absent / cleared / empty — broader than the authored
// intent. The wrap routes through the canonical
// `if(count(<trigger>), <inner-csql>, 'match-all()')` shape the
// CSQL emitter knows to emit, exactly mirroring the contract
// `searchInputRefUsesWhenInputPresent` enforces on advanced-arm
// authoring.

import type { SimpleSearchInputDef } from "@/lib/domain";
import type { Predicate } from "@/lib/domain/predicate";
import { eq, input, match, prop, whenInput } from "@/lib/domain/predicate";

/**
 * Returns `true` if the simple-arm input has a non-self relation
 * walk on its `via` slot — i.e. the input's contribution must
 * route through `_xpath_query` rather than the bare `<prompt>`
 * binding. `self` and absent `via` both stay at the prompt slot:
 * the runtime evaluates the comparison against the current scope's
 * property directly.
 */
export function simpleArmNeedsXPathQueryEmission(
	input: SimpleSearchInputDef,
): boolean {
	const via = input.via;
	if (via === undefined) return false;
	return via.kind !== "self";
}

/**
 * Derive the `_xpath_query`-bound Predicate for a simple-arm input
 * carrying a non-self `via`. The caller's responsibility is to gate
 * on `simpleArmNeedsXPathQueryEmission` first; calling this helper
 * with a self-walk / absent-via input is a contract violation.
 *
 * The current case type is required because Nova's `prop(...)`
 * carries an originating-scope qualifier; the type checker resolves
 * the property name against the module's case type at validation
 * time. The wire emitter doesn't strictly need this qualifier
 * (CSQL resolves names at the destination scope after the
 * via-lift), but keeping the construction symmetric with every
 * other authored `prop` reference keeps the AST shape uniform and
 * downstream consumers (the type checker, the on-device emitter)
 * see the same per-property qualifier on every reference.
 */
export function deriveSimpleArmPredicate(
	authored: SimpleSearchInputDef,
	caseType: string,
): Predicate {
	if (!simpleArmNeedsXPathQueryEmission(authored)) {
		throw new Error(
			`simpleArmDerivation.deriveSimpleArmPredicate received an input with via='${authored.via?.kind ?? "absent"}' — call simpleArmNeedsXPathQueryEmission first to gate.`,
		);
	}
	const modeKind = authored.mode?.kind ?? defaultModeKind(authored.type);
	const propertyRef = prop(caseType, authored.property, authored.via);
	const inputRef = input(authored.name);

	// The `when-input-present` envelope routes through the canonical
	// `if(count(<trigger>), <inner-csql>, 'match-all()')` shape at
	// CSQL emission. An unset input contributes `match-all()` — the
	// AND-identity — so the predicate has no effect until the user
	// types a value.
	switch (modeKind) {
		case "exact":
			return whenInput(inputRef, eq(propertyRef, inputRef));
		case "fuzzy":
			return whenInput(inputRef, match(propertyRef, inputRef, "fuzzy"));
		case "starts-with":
			return whenInput(inputRef, match(propertyRef, inputRef, "starts-with"));
		case "phonetic":
			return whenInput(inputRef, match(propertyRef, inputRef, "phonetic"));
		case "fuzzy-date":
			return whenInput(inputRef, match(propertyRef, inputRef, "fuzzy-date"));
		case "range":
		case "multi-select-contains":
			// Rejected at the validator layer
			// (`searchInputViaModeCompatibility`). Defensive throw so a
			// validator regression surfaces as a structural failure at
			// emission time rather than a silently dropped relation walk.
			throw new Error(
				`simpleArmDerivation: simple-arm input '${authored.name}' has mode='${modeKind}' and a non-self via — the validator rule searchInputViaModeCompatibility should have rejected this combination at authoring time.`,
			);
		default: {
			const _exhaustive: never = modeKind;
			throw new Error(
				`simpleArmDerivation: unhandled mode kind ${String(_exhaustive)}`,
			);
		}
	}
}

/**
 * Default mode kind for a simple-arm input that omits the `mode`
 * slot. Mirrors `DEFAULT_SEARCH_MODE_KIND` in
 * `lib/preview/engine/runtimeBindings.ts` — keeping the two tables
 * in lockstep keeps preview and wire emission honoring the same
 * authoring convention.
 */
function defaultModeKind(
	type: SimpleSearchInputDef["type"],
):
	| "exact"
	| "fuzzy"
	| "starts-with"
	| "phonetic"
	| "fuzzy-date"
	| "range"
	| "multi-select-contains" {
	switch (type) {
		case "text":
		case "select":
		case "date":
		case "barcode":
			return "exact";
		case "date-range":
			return "range";
		default: {
			const _exhaustive: never = type;
			throw new Error(
				`simpleArmDerivation: unhandled search input type ${String(_exhaustive)}`,
			);
		}
	}
}
