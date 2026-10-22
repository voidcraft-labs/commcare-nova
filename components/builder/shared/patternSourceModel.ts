// components/builder/shared/patternSourceModel.ts
//
// Where a pattern comes from: written out ("A pattern") or worked out when
// the rule runs ("Calculated"). `matches-pattern` and `format-date` both
// store `string | Expression`; the schema refuses a calculation that is
// only a fixed piece of text (`computedString` / `computedPattern` in
// `lib/domain/expression/types.ts`), so such a calculation is stored as the
// written pattern, and the two sources never hold the same meaning twice.

import {
	concat,
	type Expression,
	type Literal,
	literal,
	term,
} from "@/lib/domain/expression";
import type { ExpressionChangeAdmission } from "./editorContext";

export type PatternSource = "text" | "calculated";

export const PATTERN_SOURCE_LABELS: Readonly<Record<PatternSource, string>> = {
	text: "A pattern",
	calculated: "Calculated",
};

export function patternSourceOf(pattern: string | Expression): PatternSource {
	return typeof pattern === "string" ? "text" : "calculated";
}

function untypedText(value: Expression): string | undefined {
	if (value.kind !== "term" || value.term.kind !== "literal") return undefined;
	const lit: Literal = value.term;
	return lit.data_type === undefined && typeof lit.value === "string"
		? lit.value
		: undefined;
}

/** A calculation's fixed text, when every piece of it is written out: the
 *  untouched "Calculated" seed, or a combination of written pieces. */
export function fixedPatternText(pattern: Expression): string | undefined {
	const direct = untypedText(pattern);
	if (direct !== undefined) return direct;
	if (pattern.kind !== "concat") return undefined;
	const pieces = pattern.parts.map(untypedText);
	return pieces.every((piece) => piece !== undefined)
		? pieces.join("")
		: undefined;
}

/** "Calculated" starts from the written pattern as its first piece of text,
 *  so the rule keeps its meaning until the person adds to it. */
export function calculatedPatternSeed(text: string): Expression {
	return concat(term(literal(text)));
}

/**
 * Names a written pattern reads as something other than its own text: a
 * `format-date` preset (`"short"` is a preset, while a calculated `'short'`
 * keeps its exact text, `datePattern.ts::fixedDatePattern`). Such text never
 * moves between the two sources.
 */
export interface PatternPresets {
	readonly presetNames?: readonly string[];
}

function writable(text: string, presets: PatternPresets): boolean {
	return !(presets.presetNames ?? []).includes(text);
}

/** What the document stores for an edited calculation: a bare written value
 *  is the written pattern itself. */
export function storedPattern(
	next: Expression,
	presets: PatternPresets = {},
): string | Expression {
	const text = untypedText(next);
	return text !== undefined && writable(text, presets) ? text : next;
}

/**
 * Going back to a written pattern. A calculation of written pieces carries
 * its text; any other calculation would be lost, so the caller asks first,
 * and the written pattern starts from `fallback`.
 */
export function textPatternFor(
	pattern: Expression,
	fallback: string,
	presets: PatternPresets = {},
): { readonly text: string; readonly losesCalculation: boolean } {
	const text = fixedPatternText(pattern);
	if (text === "") return { text: fallback, losesCalculation: false };
	return text === undefined || !writable(text, presets)
		? { text: fallback, losesCalculation: true }
		: { text, losesCalculation: false };
}

/** Each source as the whole rule would hold it, judged by the gate. A
 *  source already in use stays selectable, so a refused saved value can be
 *  repaired. */
export function patternSourceAdmission(
	current: PatternSource,
	candidates: Readonly<Record<PatternSource, Expression>>,
	admit: ((candidate: Expression) => ExpressionChangeAdmission) | undefined,
): Readonly<Record<PatternSource, ExpressionChangeAdmission>> {
	const judge = (source: PatternSource): ExpressionChangeAdmission =>
		source === current || admit === undefined
			? { admitted: true }
			: admit(candidates[source]);
	return { text: judge("text"), calculated: judge("calculated") };
}
