import { serializeWire } from "../xpath/wire/serialize";
import type { WireExpr } from "../xpath/wire/tree";

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
// final `concat(...)` wire tree, and a downstream package never
// needs to learn two different segment shapes.

/**
 * Two-arm IR carrying one piece of a CSQL value's wire build-up.
 *
 *   - `constant` — a literal CSQL fragment (operator tokens, a
 *     compile-time-known value, a quoted property name). The wrap
 *     layer holds each constant run in a wire string node. The sole
 *     wire serializer chooses the literal spelling, including split
 *     literals when both quote characters occur.
 *   - `runtime` — a wire tree evaluated on-device whose string
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
			readonly xpath: WireExpr;
			/**
			 * The raw on-device value XPath this segment quotes into the CSQL
			 * text with a delimiter chosen at runtime. Present only on segments
			 * produced by `quoteRuntimeCsqlValue`'s double-preferred choose form.
			 * The clause wrap layer uses it to restructure a clause whose ONLY
			 * runtime interpolation is this one string value into the flat
			 * quote cascade (`if(contains(v, '"'), …)`) instead of nesting the
			 * delimiter choice inside a `concat(...)` argument.
			 */
			readonly stringValueXPath?: WireExpr;
			/**
			 * On-device XPath condition that makes this interpolation impossible
			 * to represent as a CSQL value without changing its bytes. The final
			 * wrapper lifts every such condition ahead of the whole CSQL fragment,
			 * so an unrepresentable runtime value cannot accidentally broaden a
			 * negated, not-equal, or OR-composed filter.
			 */
			readonly rejectWhen?: WireExpr;
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
	| "geopoint"
	| "blank-comparand";

export interface RuntimeCsqlRejection {
	readonly condition: WireExpr;
	readonly kind: RuntimeCsqlRejectionKind;
	readonly inputNames?: readonly string[];
}

/**
 * Deduplicate rejection obligations on their complete identity — kind,
 * condition, and blamed prompts. One authored input referenced twice in a
 * clause (or across sibling clauses) produces byte-identical obligations;
 * collapsing them keeps prompt validation from emitting the same `<validation>`
 * test twice. Both the per-clause wrap layer and the multi-clause
 * `_xpath_query` composer run this same collapse so the two levels cannot
 * disagree about obligation identity.
 */
export function dedupeRuntimeRejections(
	rejections: Iterable<RuntimeCsqlRejection>,
): RuntimeCsqlRejection[] {
	const byKey = new Map<string, RuntimeCsqlRejection>();
	for (const rejection of rejections) {
		// NUL separators: prompt names and conditions cannot contain \u0000,
		// so the composite key cannot collide across the three components.
		byKey.set(
			`${rejection.kind}\u0000${serializeWire(rejection.condition, { target: "suite" }).text}\u0000${rejection.inputNames?.join("\u0000") ?? ""}`,
			rejection,
		);
	}
	return [...byKey.values()];
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

/**
 * HQ's eulxml lexer omits COMMA from OPERATOR_FORCERS, so a function
 * immediately after a comma is tokenized as a path name. Group an argument
 * that can contain functions; OPEN_PAREN restores function recognition.
 * This operates on emission segments, never reparses XPath or CSQL strings.
 */
export function groupCsqlArgument(
	segments: readonly CsqlSegment[],
): CsqlSegment[] {
	return [
		{ kind: "constant", text: "(" },
		...segments,
		{ kind: "constant", text: ")" },
	];
}
