// lib/commcare/predicate/stringQuoting.ts
//
// Lexical-emission helpers shared across the per-dialect predicate
// emitters. Predicate ASTs originate in `lib/domain/predicate` and
// compile to one of three CommCare wire dialects, each with its own
// operator-coverage rules but a common need to escape string literals,
// emit identifiers, and serialize numeric values. This module owns
// those three lexical concerns; per-dialect operator dispatch lives
// in the per-dialect emitter modules that consume these helpers.
//
// Operator dispatch — the per-mode / per-quantifier branching that
// chooses between `selected()` / `selected-any` / `selected-all`,
// fuzzy / phonetic / starts-with `match` modes, on-device-join vs
// `ancestor-exists` for `exists`, etc. — is intentionally out of
// scope here. This module imports nothing from any operator emitter
// and exposes only string-in / string-out helpers.

/**
 * The three CommCare wire dialects a predicate AST compiles to.
 * Each dialect has a different evaluator and a different operator
 * vocabulary; the dialect is threaded through every helper that
 * branches on it so the callers' type-system surface stays uniform.
 *
 *   - `case-list-filter` — XPath 1.0 evaluated on-device in the
 *     casedb nodeset position
 *     (`instance('casedb')/casedb/case[<this>]`). Standard XPath 1.0
 *     functions including `concat()` are in scope.
 *   - `csql` — the inner predicate inside a CSQL `_xpath_query`
 *     value evaluated by ElasticSearch on the CCHQ server. CSQL's
 *     value-function whitelist excludes `concat()`, so the embedded-
 *     quote escape path cannot fall back to alternating-quote
 *     concat — see `quoteLiteral`'s csql arm for the divergence.
 *   - `search-filter` — XPath 1.0 evaluated on-device after the
 *     ElasticSearch server has narrowed the case-search results.
 *     The same on-device XPath environment as case-list-filter, so
 *     `concat()` is available and the embedded-quote escape mirrors
 *     case-list-filter exactly.
 */
export type WireDialect = "case-list-filter" | "csql" | "search-filter";

/**
 * Whether a compile-time string can be represented as one CSQL string
 * literal without changing its bytes. CSQL accepts either quote delimiter but
 * has no escape syntax (and does not whitelist `concat()` as a value
 * function), so a value containing both delimiters has no faithful wire form.
 *
 * Exported so the authoring validator and the defensive emitter consult the
 * same lexical predicate rather than maintaining parallel quote rules.
 */
export function isCsqlStringLiteralRepresentable(value: string): boolean {
	return !(value.includes("'") && value.includes('"'));
}

/**
 * Compile a string value to its wire-form string literal for the
 * named dialect. Three branches:
 *
 *   - When the value contains no embedded single quote, every dialect
 *     emits `'<value>'` — the common case, with no divergence.
 *   - In `case-list-filter` and `search-filter`, an embedded single
 *     quote falls back to `concat('part', "'", 'part')`. XPath 1.0
 *     has no string-escape syntax, so the alternating-quote concat is
 *     the portable form the grammar at
 *     `lib/commcare/xpath/grammar.lezer.grammar::StringLiteral` admits
 *     (both single- and double-quoted string literals are accepted as
 *     `concat()` arguments). The fallback always emits boundary
 *     segments even when empty (e.g. a value of `"'"` produces
 *     `concat('', "'", '')`) so the segment count tracks the input
 *     quote count predictably as `n + 1` segments for `n` quotes.
 *   - In `csql`, `concat()` is excluded from CCHQ's
 *     `XPATH_VALUE_FUNCTIONS` whitelist (verified on
 *     `corehq/apps/case_search/xpath_functions/__init__.py::XPATH_VALUE_FUNCTIONS`).
 *     Comparison-RHS values pass through
 *     `corehq/apps/case_search/dsl_utils.py::unwrap_value`, which
 *     raises `CaseFilterError` on any function name outside the
 *     whitelist (the `unwrap_value` callsite plus
 *     `XPathFunctionExpression` handling defined in the same module).
 *     CSQL admits both single- and double-quoted string literals
 *     natively (see `docs/case_search_query_language.rst` for the
 *     canonical concat-wrapped CSQL fragment example with double-
 *     quoted property values), so the helper switches to a double-quoted
 *     literal `"<value>"` when the value contains a single quote.
 *     If the value contains BOTH a single and a double quote, no
 *     portable inline escape exists — `concat()` is unavailable and
 *     XPath 1.0 string literals can carry only one of the two quote
 *     styles — and the helper throws with "no portable escape" in
 *     the message rather than emit broken wire output. Authors must
 *     split such values into a different filter shape or strip one
 *     of the quote types upstream.
 *
 * `search-filter` shares case-list-filter's on-device XPath 1.0
 * dialect, so the two dialects route through the same concat-fallback
 * arm.
 */
export function quoteLiteral(value: string, dialect: WireDialect): string {
	const hasSingleQuote = value.includes("'");
	if (!hasSingleQuote) return `'${value}'`;
	if (dialect === "csql") {
		if (!isCsqlStringLiteralRepresentable(value)) {
			throw new Error(
				`stringQuoting: CSQL has no portable escape for a string literal containing both ' and ". Got: ${JSON.stringify(value)}.`,
			);
		}
		return `"${value}"`;
	}
	// case-list-filter and search-filter share the on-device XPath 1.0
	// environment where `concat()` is available. Splitting on `'`
	// produces `n + 1` segments for `n` quotes; each segment is
	// single-quoted and the literal-quote separator `"'"` interleaves
	// between segments. Boundary segments are emitted even when empty
	// so the segment count stays predictable regardless of where the
	// quotes sit in the source string.
	const parts = value.split("'");
	const args: string[] = [];
	for (let i = 0; i < parts.length; i++) {
		args.push(`'${parts[i]}'`);
		if (i < parts.length - 1) args.push(`"'"`);
	}
	return `concat(${args.join(", ")})`;
}

/**
 * Pass through a property name as-is for emission into a wire
 * predicate. Identifier validation happens upstream at the schema
 * layer (XML element-name vocabulary for property names; the schema's
 * regex is the source of truth for which characters are admissible).
 * The `RESERVED_CASE_ATTRIBUTES` membership check that prefixes
 * system attributes with `@` (`case_id`, `case_type`, `owner_id`,
 * `status`) is a property-emission concern that lives in the term
 * emitter, not here — `quoteIdentifier` runs after that prefix
 * decision and is responsible only for the lexical pass-through.
 *
 * Centralizing identifier emission through a single helper keeps the
 * emit rule in one place; per-dialect emitter modules call this
 * helper rather than open-coding the pass-through.
 */
export function quoteIdentifier(name: string): string {
	return name;
}

/**
 * Compile a finite numeric value to its wire-form decimal literal,
 * avoiding scientific notation. CommCare's XPath grammar at
 * `lib/commcare/xpath/grammar.lezer.grammar::NumberLiteral` admits decimal
 * literals only — `digit+ ('.' digit*)? | '.' digit+` — and rejects
 * exponent syntax, so a wire-form value with an `e` or `E` would
 * parse-fail downstream.
 *
 * The function early-returns the canonical `String(n)` for any
 * number whose decimal form is already non-exponent. That preserves
 * the shortest round-trip form (e.g. `String(3.14)` is the literal
 * `"3.14"`, not the `toFixed(20)` artifact `"3.14000000000000012434"`)
 * for every value an author would realistically type. Only when
 * `String(n)` produces exponent form does the function reformat by
 * parsing the mantissa and exponent out of the string and shifting
 * the decimal point manually, producing an exact decimal expansion
 * of the IEEE-754 double's `String(n)` form without `toFixed`'s
 * precision-related truncation at the limits.
 *
 * The schema layer (`z.number()` in `lib/domain/predicate/types.ts`)
 * rejects `NaN` and `±Infinity`, so this helper is only ever called
 * with finite numbers.
 */
export function formatNumeric(n: number): string {
	const s = String(n);
	if (!s.includes("e") && !s.includes("E")) return s;
	// `String(n)` for any finite double in exponent form matches
	// `^(-)?<int>(\.<frac>)?[eE][+-]?<exp>$`. Parse the components
	// and rebuild as a non-exponent decimal by sliding the decimal
	// point `exp` places. The combined `<int><frac>` digit sequence
	// is the significand; the decimal point lands at position
	// `int.length + exp` in that sequence, with leading or trailing
	// zeros filling any positions outside the significand's range.
	const match = s.match(/^(-)?(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/);
	if (!match) return s;
	const sign = match[1] ?? "";
	const intPart = match[2];
	const fracPart = match[3] ?? "";
	const exp = Number.parseInt(match[4], 10);
	const digits = intPart + fracPart;
	const decimalPos = intPart.length + exp;
	if (decimalPos >= digits.length) {
		return `${sign}${digits}${"0".repeat(decimalPos - digits.length)}`;
	}
	if (decimalPos > 0) {
		return `${sign}${digits.slice(0, decimalPos)}.${digits.slice(decimalPos)}`;
	}
	return `${sign}0.${"0".repeat(-decimalPos)}${digits}`;
}
