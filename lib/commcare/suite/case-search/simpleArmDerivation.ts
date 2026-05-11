// lib/commcare/suite/case-search/simpleArmDerivation.ts
//
// Shared derivation pipeline that lifts a simple-arm
// `SearchInputDef` whose mode or `via` walk needs an explicit
// predicate at the wire boundary into an advanced-style Predicate
// AST. Both CCHQ wire surfaces — the suite-XML `_xpath_query`
// composer at `xpathQuery.ts` and the HQ JSON `default_properties`
// composer at `lib/commcare/hqJson/caseList.ts` — route those inputs
// through this helper so the runtime matcher landing in
// `_xpath_query` matches the authored intent, rather than relying on
// CCHQ-side flags or behaviours the prompt slot does not carry.
//
// Why the redirection has two reasons:
//
//   1. CCHQ's `CaseSearchProperty` (the wire shape of one
//      `<prompt>`) has no per-property matcher-strategy slot. The
//      runtime defaults to exact full-string equality on every
//      property unless the domain's `CaseSearchConfig.fuzzy_properties`
//      table opts the property in (a domain-level admin toggle, not
//      something the app's wire payload can set). So `fuzzy`,
//      `phonetic`, `starts-with`, and `fuzzy-date` modes can only
//      reach the runtime by emitting an explicit XPath function call
//      (`fuzzy-match` / `phonetic-match` / `starts-with` /
//      `fuzzy-date`) inside the AND-composed `_xpath_query`. Without
//      this redirection, picking any non-`exact` mode in the editor
//      uploads an app that does exact-match at runtime — the user's
//      intent silently drops.
//
//   2. Each `<prompt key="X">` element binds exactly one user-typed
//      value at runtime via
//      `instance('search-input:results')/input/field[@name='X']` and
//      carries no relation-walk metadata. The relation walk a
//      non-self `via` requires must live in the `_xpath_query`
//      predicate (the on-device wire form expresses "the related
//      case along <via> has <property> matching <input>").
//
// The `exact` mode with self-walk (or absent `via`) is the only
// shape that rides on the bare `<prompt>` slot alone — CCHQ's
// runtime default already does the exact comparison against the
// current case's property. Every other mode + via combination needs
// `_xpath_query` routing.
//
// Mode coverage. The helper handles `exact` / `fuzzy` /
// `starts-with` / `phonetic` / `fuzzy-date` / `range`. The
// validator's `searchInputViaModeCompatibility` rule rejects
// `range` on non-self vias (the two-value wire shape can't ride on
// a single prompt binding) and rejects `multi-select-contains` on
// every simple-arm input (the AST stores the values list as
// literals, so the simple-arm derivation has no operator that
// admits `input(name)` as the membership source — authors who need
// token containment compose `selected(prop, input(name))` on the
// advanced arm). Both rejections fire before this helper runs; the
// helper still names the closed mode set explicitly so a future
// `SearchInputMode` arm surfaces here as a compile-time `never`
// error rather than silently dropping.
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

import {
	DEFAULT_SEARCH_MODE_KIND,
	type SearchInputMode,
	type SimpleSearchInputDef,
} from "@/lib/domain";
import type { Predicate } from "@/lib/domain/predicate";
import { eq, input, match, prop, whenInput } from "@/lib/domain/predicate";

/**
 * Returns `true` if the simple-arm input's `(mode, via)` shape needs
 * an explicit predicate in `_xpath_query` at the wire boundary
 * rather than relying on the bare `<prompt>` slot's runtime
 * default.
 *
 * Three CCHQ-runtime defaults make a wire-shape decision per
 * `(mode, via)`:
 *
 *   - **`exact` (self-walk / absent via)** — bare prompt slot.
 *     CCHQ's runtime defaults a `case_property_query` to full-string
 *     exact match, which IS the authored intent. No routing.
 *
 *   - **`exact` (non-self via)** — `_xpath_query`. The prompt binds
 *     one runtime value but carries no relation-walk metadata; the
 *     relation walk must live in the predicate.
 *
 *   - **`range` (self-walk / absent via)** — bare prompt slot.
 *     CCHQ's `daterange` widget reads two bindings
 *     (`<name>:from` / `<name>:to`) and handles the two-value
 *     semantic internally for the current case. No `_xpath_query`
 *     routing — the AST's `match` operator has no range arm to
 *     route to, and the validator rule
 *     `searchInputViaModeCompatibility` rejects `range` on non-self
 *     vias before this helper runs.
 *
 *   - **`fuzzy` / `starts-with` / `phonetic` / `fuzzy-date`
 *     (regardless of via)** — `_xpath_query`. CCHQ's prompt slot
 *     has no per-input matcher-strategy field; these modes only
 *     reach the runtime through an explicit XPath function call
 *     inside `_xpath_query`.
 *
 *   - **`multi-select-contains`** — rejected upstream by the
 *     validator on every simple-arm input. The helper should never
 *     see this mode kind; reaching it surfaces as a structural
 *     failure in `deriveSimpleArmPredicate`'s defensive throw.
 *
 * In short: `exact` and `range` ride on the bare prompt when
 * `via` is self-walk / absent; everything else routes through
 * `_xpath_query`.
 */
export function simpleArmNeedsXPathQueryEmission(
	authored: SimpleSearchInputDef,
): boolean {
	const modeKind = authored.mode?.kind ?? defaultModeKind(authored.type);
	const via = authored.via;
	const viaIsSelfOrAbsent = via === undefined || via.kind === "self";
	if (modeKind === "exact" || modeKind === "range") {
		return !viaIsSelfOrAbsent;
	}
	// `fuzzy` / `starts-with` / `phonetic` / `fuzzy-date` always need
	// the explicit XPath function call. `multi-select-contains` is
	// rejected by the validator on every simple-arm input; if it
	// reaches here, the `deriveSimpleArmPredicate` defensive throw
	// surfaces the validator-bypass.
	return true;
}

/**
 * Derive the `_xpath_query`-bound Predicate for a simple-arm input
 * whose `(mode, via)` shape needs explicit-predicate emission at
 * the wire boundary. The caller's responsibility is to gate on
 * `simpleArmNeedsXPathQueryEmission` first; calling this helper
 * with an input that rides on the bare prompt slot is a contract
 * violation.
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
 *
 * A self-walk / absent `via` collapses to an unqualified `prop(...)`
 * (no relation walk in the derived predicate) — the leaf emitter
 * reads the property directly off the current case at runtime.
 */
export function deriveSimpleArmPredicate(
	authored: SimpleSearchInputDef,
	caseType: string,
): Predicate {
	if (!simpleArmNeedsXPathQueryEmission(authored)) {
		throw new Error(
			`simpleArmDerivation.deriveSimpleArmPredicate received an input that rides on the bare prompt slot (mode='${authored.mode?.kind ?? "default"}', via='${authored.via?.kind ?? "absent"}'). Call simpleArmNeedsXPathQueryEmission first to gate.`,
		);
	}
	const modeKind = authored.mode?.kind ?? defaultModeKind(authored.type);
	// Self-walk / absent `via` produces an unqualified `prop(...)` so
	// the on-device emitter reads the property directly off the
	// current case; a non-self `via` threads through as the relation
	// walk the leaf emitter expands into the `instance('casedb')`
	// join nodeset.
	const viaForRef =
		authored.via === undefined || authored.via.kind === "self"
			? undefined
			: authored.via;
	const propertyRef = prop(caseType, authored.property, viaForRef);
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
			// Both modes are rejected at the validator layer
			// (`searchInputViaModeCompatibility`): `range` on non-self
			// vias only, `multi-select-contains` on every simple-arm
			// input. A defensive throw here surfaces a validator regression
			// as a structural failure at emission time rather than a
			// silent runtime mismatch.
			throw new Error(
				`simpleArmDerivation: simple-arm input '${authored.name}' has mode='${modeKind}' which the validator rule searchInputViaModeCompatibility should have rejected at authoring time. Run validation before wire emission and convert the input to the advanced arm (or pick a single-value mode) before re-running the compile pipeline.`,
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
 * slot. Delegates to the canonical `DEFAULT_SEARCH_MODE_KIND`
 * table at `lib/domain/modules.ts` so this surface, the runtime-
 * bindings layer, and the validator all consume one source.
 */
function defaultModeKind(
	type: SimpleSearchInputDef["type"],
): SearchInputMode["kind"] {
	return DEFAULT_SEARCH_MODE_KIND[type];
}
