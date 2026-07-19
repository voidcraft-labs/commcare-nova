// lib/commcare/predicate/csqlSegment.ts
//
// Shared segment-list IR for the CSQL emitter family. The CSQL wire
// dialect lives inside an on-device XPath `concat(...)` wrapper that
// builds the `_xpath_query` string at runtime — the canonical CCHQ
// pattern at `case_search_query_language.rst::"Example Query + Tips"`.
// Each emitter (predicate-side `csqlEmitter.ts`, value-expression-side
// `lib/commcare/expression/csqlEmitter.ts`) walks a sub-AST and emits
// a `CsqlSegment[]`. The wrap layer composes the lists from every
// surface, merges adjacent constants, and lifts each segment into one
// `concat(...)` argument.
//
// The two-arm shape lets the wrap layer emit each segment as a
// separate `concat(...)` argument without parsing the emitted CSQL
// string back out — runtime-resolved instance paths embed single
// quotes, and the wrapping CSQL string carries both single and double
// quotes interchangeably, so a string-only round trip is ambiguous.
//
// Owning this IR in a shared module rather than in either of the two
// emitter files keeps the predicate ↔ expression composition surface
// uniform: both emitters return the same `CsqlSegment[]` type, the
// wrap layer is the only place that converts segment lists to the
// final `concat(...)` XPath string, and a downstream package never
// needs to learn two different segment shapes.

/**
 * Two-arm IR carrying one piece of a CSQL value's wire build-up.
 *
 *   - `constant` — a literal CSQL fragment (operator tokens, a
 *     compile-time-known value, a quoted property name). The wrap
 *     layer encloses each constant run in an XPath string literal,
 *     splitting on embedded quotes via the alternating-quote concat
 *     idiom when both `'` and `"` appear in the same constant.
 *   - `runtime` — an XPath expression evaluated on-device whose string
 *     result interpolates into the CSQL fragment. Runtime value segments
 *     may also carry a `rejectWhen` proof obligation when no CSQL literal
 *     can represent the resolved bytes. Runtime segments pass through as
 *     their own concat argument; the wrap layer never parses or splits them.
 *
 * The discriminator field is `kind`, matching the predicate AST's
 * own discriminator pattern so a reader scanning either surface sees
 * the same dispatch shape.
 */
export type CsqlSegment =
	| { readonly kind: "constant"; readonly text: string }
	| {
			readonly kind: "runtime";
			readonly xpath: string;
			/**
			 * On-device XPath condition that makes this interpolation impossible
			 * to represent as a CSQL value without changing its bytes. The final
			 * wrapper lifts every such condition ahead of the whole CSQL fragment,
			 * so an unrepresentable runtime value cannot accidentally broaden a
			 * negated, not-equal, or OR-composed filter.
			 */
			readonly rejectWhen?: string;
			/**
			 * Why the runtime interpolation is rejected. Quote safety remains the
			 * default for older callers; numeric constraints opt into their exact
			 * kind so prompt validation can give the worker an actionable message
			 * while the final CSQL wrapper still fail-closes every obligation.
			 */
			readonly rejectionKind?: RuntimeCsqlRejectionKind;
			/**
			 * Search prompts whose entered bytes contribute to this exact runtime
			 * obligation. This stays attached to the obligation instead of being
			 * reconstructed from the whole predicate so two independent computed
			 * values cannot blame one another's prompts.
			 */
			readonly rejectionInputNames?: readonly string[];
	  };

export type RuntimeCsqlRejectionKind =
	| "quote"
	| "whole-number"
	| "nonnegative-whole-number"
	| "geopoint";

export interface RuntimeCsqlRejection {
	readonly condition: string;
	readonly kind: RuntimeCsqlRejectionKind;
	readonly inputNames?: readonly string[];
}

/**
 * Compile a constant CSQL fragment to a sequence of one or more XPath
 * string literals. XPath 1.0 string literals admit either `'` or `"`
 * as the bracketing character but never both within one literal — see
 * the grammar at `lib/commcare/xpath/grammar.lezer.grammar::StringLiteral`.
 * The wrap layer must emit each constant's content faithfully; when
 * the content contains both quote styles, we split it into sub-runs
 * of "no embedded `'`" (wrap in `'...'`) and "embedded `'` only" (wrap
 * in `"..."`) and concatenate via additional `concat(...)` arguments.
 *
 * The split rule:
 *
 *   - No `'` in the value → single-quoted XPath literal. The common
 *     case.
 *   - No `"` in the value → double-quoted XPath literal.
 *   - Both quote styles present → split on `'`. Each fragment becomes
 *     a single-quoted literal `'<frag>'`; between fragments, emit
 *     `"'"` (the literal-quote separator). Boundary fragments that
 *     are empty still emit so the output's segment count tracks the
 *     input's quote count predictably.
 *
 * The both-styles split path mirrors `stringQuoting.ts`'s
 * case-list-filter alternating-quote idiom — the pattern is XPath
 * 1.0's only portable form for embedding a `'` in a string literal.
 */
export function quoteConstantSegmentForXPath(value: string): string[] {
	const hasSingleQuote = value.includes("'");
	const hasDoubleQuote = value.includes('"');
	if (!hasSingleQuote) return [`'${value}'`];
	if (!hasDoubleQuote) return [`"${value}"`];
	// Both quote styles. Split the value on `'` and emit alternating
	// single-quoted runs and `"'"` separators, matching XPath's
	// concat-of-alternating-quotes idiom.
	const parts = value.split("'");
	const args: string[] = [];
	for (let i = 0; i < parts.length; i += 1) {
		args.push(`'${parts[i]}'`);
		if (i < parts.length - 1) args.push(`"'"`);
	}
	return args;
}

/**
 * Coalesce adjacent constant segments into one. Centralised here so
 * per-arm emitters across both predicate and expression surfaces
 * produce raw segment lists without needing their own merge passes.
 *
 * Without this pass, an emitted predicate composes its operator
 * tokens and operand emissions as separate constant segments — for
 * example, an `eq(prop, literal)` reaches the wrap layer as
 * `[const "name", const " = ", const "'Alice'"]` rather than the
 * single constant `name = 'Alice'`. The merge keeps the segment list
 * to one constant per contiguous constant run, which produces shorter
 * `concat(...)` argument lists at the wrap boundary.
 *
 * Runtime segments pass through untouched — they always sit as their
 * own segment because `concat(...)` argument boundaries are the one
 * place a constant↔runtime transition is authoritative.
 */
export function mergeAdjacentConstants(
	segments: readonly CsqlSegment[],
): CsqlSegment[] {
	const merged: CsqlSegment[] = [];
	for (const seg of segments) {
		const last = merged[merged.length - 1];
		if (
			seg.kind === "constant" &&
			last !== undefined &&
			last.kind === "constant"
		) {
			merged[merged.length - 1] = {
				kind: "constant",
				text: last.text + seg.text,
			};
			continue;
		}
		merged.push(seg);
	}
	return merged;
}
