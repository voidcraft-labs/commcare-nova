// components/builder/shared/literalRebuild.ts
//
// Shared helpers for rebuilding `Literal` AST values without
// destroying their `data_type` qualifier. The `Literal` schema
// admits an optional `data_type` (date / datetime / time / int /
// decimal / single_select / multi_select / geopoint / text) that
// the type checker uses to resolve ordered comparisons and the
// wire emitters consume to pick the right value-function. A naïve
// rebuild via the bare `literal(value)` builder strips the
// qualifier on every edit, silently turning a `dateLiteral(...)`
// into a plain text literal — the data-loss class where blur-
// commit silently strips the `data_type` qualifier from the
// rebuilt AST.
//
// Two helpers cover the patterns the editor needs:
//
//   - `rebuildLiteralPreservingDataType(source, nextValue)` — emits
//     the source's qualifier on the rebuilt literal. Used by every
//     "user typed something different at this slot" commit path.
//   - `literalToInputText(value)` / `parseInputTextToLiteral(text,
//     source)` — symmetric encode / decode for free-text inputs
//     (the switch-case `when` editor is the canonical caller). The
//     decode path heuristically classifies the input as boolean /
//     numeric / string but always preserves the source's
//     `data_type` so the rebuilt value stays semantically aligned
//     with the source's declared type.
//
// Round-trip contract: when the input text is structurally
// identical to the source's serialized form (no user edit), the
// rebuilt value is reference-identical to the source. Callers that
// gate the commit on `text !== initial` get the round-trip
// guarantee for free; callers that don't get the qualifier
// preservation but may still allocate a fresh object.
//
// All AST construction routes through the predicate package's
// builders — `qualifiedLiteral` for qualified shapes, `literal`
// for the unqualified case, plus the temporal specializations
// (`dateLiteral` / `datetimeLiteral` / `timeLiteral`) used by the
// free-text decode path. The editor never hand-rolls a Literal
// shape; the predicate package owns the construction primitive
// so reductions and Zod-validated invariants apply uniformly.

import {
	dateLiteral,
	datetimeLiteral,
	type Literal,
	literal,
	qualifiedLiteral,
	timeLiteral,
} from "@/lib/domain/predicate";

/**
 * Build a literal that carries the source's `data_type` qualifier.
 * Routes through `qualifiedLiteral` when the source declares a
 * qualifier, and through the bare `literal` builder when the source
 * has none. Centralizing on the `qualifiedLiteral` primitive keeps
 * the editor out of direct AST shape construction — adding a new
 * `CasePropertyDataType` to the schema flows through the builder
 * without an editor-side parallel edit.
 *
 * `qualifiedLiteral` accepts `string | number | boolean | null` for
 * the value, mirroring the Literal schema's union; callers don't
 * coerce before passing through this helper.
 */
export function rebuildLiteralPreservingDataType(
	source: Literal,
	nextValue: string | number | boolean | null,
): Literal {
	if (source.data_type === undefined) {
		return literal(nextValue);
	}
	return qualifiedLiteral(nextValue, source.data_type);
}

/**
 * Encode a literal's value as a string suitable for a free-text
 * input's initial value. Mirrors the `SwitchWhenLiteralInput`
 * encoding shape — booleans render as `"true"` / `"false"`, null
 * as the empty string, everything else via `String(...)`.
 *
 * Symmetric with `parseInputTextToLiteral`: encoding a literal then
 * decoding the result against the same source produces a value
 * structurally identical to the source's, modulo the parser's
 * round-trip-stable shapes (e.g. a number literal whose toString
 * round-trips cleanly stays a number; a string literal whose value
 * happens to parse as a number stays a string only if the source's
 * `data_type` qualifier or runtime type is text-shaped).
 */
export function literalToInputText(value: Literal): string {
	if (value.value === null) return "";
	if (typeof value.value === "boolean") return value.value ? "true" : "false";
	return String(value.value);
}

/**
 * Decode a free-text input back into a `Literal`, preserving the
 * source's `data_type` qualifier. Heuristic classification:
 *
 *   - empty string → `null` value (matches the schema's null-as-
 *     universal compatibility rule for "user cleared the slot")
 *   - `"true"` / `"false"` → boolean
 *   - parses cleanly as a number → number
 *   - everything else → string
 *
 * The qualifier wins over the heuristic when set: a source carrying
 * `data_type: "date"` always produces a `dateLiteral(text)` even if
 * `text` happens to parse as a number, because the qualifier
 * declares the author's intent and the wire emitter's contract
 * binds on the qualifier, not the runtime type.
 */
export function parseInputTextToLiteral(
	text: string,
	source: Literal,
): Literal {
	// Qualifier-driven decode: the source declares a typed shape,
	// route through the matching builder. Empty input still emits a
	// typed literal with empty-string value — the type checker's
	// "match value cannot be the empty string" rule fires inline,
	// but the qualifier survives.
	if (source.data_type === "date") return dateLiteral(text);
	if (source.data_type === "datetime") return datetimeLiteral(text);
	if (source.data_type === "time") return timeLiteral(text);

	// Non-temporal qualifier or no qualifier — heuristic shape
	// classification.
	if (text === "") {
		return rebuildLiteralPreservingDataType(source, null);
	}
	if (text === "true") {
		return rebuildLiteralPreservingDataType(source, true);
	}
	if (text === "false") {
		return rebuildLiteralPreservingDataType(source, false);
	}
	// Pure numeric — `Number(text)` returns NaN for non-numeric
	// inputs; the trim-equality check rejects whitespace-padded or
	// empty-looking strings the parser would otherwise coerce.
	const asNumber = Number(text);
	if (!Number.isNaN(asNumber) && text.trim() === text) {
		return rebuildLiteralPreservingDataType(source, asNumber);
	}
	return rebuildLiteralPreservingDataType(source, text);
}
