import { serializeWire } from "../xpath/wire/serialize";
import type { WireExpr } from "../xpath/wire/tree";

// lib/commcare/csql/segment.ts
//
// The IR `print.ts::printCsql` yields from a CSQL tree. The CSQL wire
// dialect lives inside an on-device XPath `concat(...)` wrapper that
// builds the `_xpath_query` string at runtime, the canonical CCHQ
// pattern at `case_search_query_language.rst::"Example Query + Tips"`.
// A segment is either constant CSQL text or a runtime value the device
// splices in; the wrapper lifts each segment into one `concat(...)`
// argument without parsing the CSQL text back out (runtime-resolved
// instance paths embed single quotes, and the wrapping CSQL string
// carries both quote kinds, so a string round trip is ambiguous).

/**
 * Two-arm IR carrying one piece of a CSQL value's wire build-up.
 *
 *   - `constant`: printed CSQL text. The wrapper holds each constant run
 *     in a wire string node, and the sole wire serializer chooses its
 *     spelling.
 *   - `runtime`: a wire tree evaluated on-device whose string result
 *     interpolates into the CSQL text, with the value XPath it reads and
 *     the segment key Preview's fold substitutes by. It may carry one
 *     `rejectWhen` obligation; the wrapper lifts every obligation ahead of
 *     the whole clause.
 */
export type CsqlSegment =
	| { readonly kind: "constant"; readonly text: string }
	| {
			readonly kind: "runtime";
			readonly xpath: WireExpr;
			/** The raw on-device read this segment splices in, before quoting.
			 * Absent on a carrier that splices nothing. */
			readonly value?: WireExpr;
			/** The checker path, in the prepared clause, of the subtree this
			 * segment evaluates (`csqlPositionKey`). */
			readonly key?: string;
			/**
			 * The raw on-device value XPath this segment quotes into the CSQL
			 * text with a delimiter chosen at runtime. Present only on a
			 * `quoted` hole's segment.
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
	| "blank-comparand"
	| "decimal-number"
	| "positive-number"
	| "distance-unit"
	| "list-item";

/** The obligations no worker can repair: a blank comparand and a list item
 * that would break its JSON. The search finds nothing, with no message. */
export type SilentRuntimeCsqlRejectionKind = "blank-comparand" | "list-item";

export function isSilentRuntimeCsqlRejection(
	kind: RuntimeCsqlRejectionKind,
): kind is SilentRuntimeCsqlRejectionKind {
	return kind === "blank-comparand" || kind === "list-item";
}

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
