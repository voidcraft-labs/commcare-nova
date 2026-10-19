// lib/domain/valueKindPhrases.ts
//
// How a sentence names a kind of value: one of it with its article, and
// several of it. Every refusal that names a value's kind reads this one
// table, so the validator, the builder's messages and the checker's
// presentation call a kind by one name.

import type { CasePropertyDataType } from "./casePropertyTypes";

/** A case property's data type, or a yes/no result. */
export type ValueKind = CasePropertyDataType | "boolean";

const VALUE_KIND_PHRASES: Readonly<
	Record<ValueKind, { readonly one: string; readonly many: string }>
> = {
	text: { one: "text", many: "text" },
	int: { one: "a whole number", many: "whole numbers" },
	decimal: { one: "a number", many: "numbers" },
	date: { one: "a date", many: "dates" },
	time: { one: "a time", many: "times" },
	datetime: { one: "a date and time", many: "dates and times" },
	single_select: { one: "a choice", many: "choices" },
	multi_select: { one: "several choices", many: "several choices" },
	geopoint: { one: "a location", many: "locations" },
	boolean: { one: "true or false", many: "true-or-false results" },
};

function phrasesOf(
	kind: string | undefined,
): { readonly one: string; readonly many: string } | undefined {
	return kind !== undefined && Object.hasOwn(VALUE_KIND_PHRASES, kind)
		? VALUE_KIND_PHRASES[kind as ValueKind]
		: undefined;
}

/** One value of `kind`, with its article: `a whole number`, `text`. A kind
 *  the table doesn't name reads as `fallback`. */
export function valueKindPhrase(
	kind: string | undefined,
	fallback = "a value",
): string {
	return phrasesOf(kind)?.one ?? fallback;
}

/** Values of `kind`, in the plural: `whole numbers`, `text`. */
export function valueKindPluralPhrase(
	kind: string | undefined,
	fallback = "another kind of value",
): string {
	return phrasesOf(kind)?.many ?? fallback;
}

/** Several kinds as one phrase: `text`, `text or a whole number`,
 *  `a date, a time or text`. */
export function valueKindsPhrase(
	kinds: Iterable<string | undefined>,
	fallback = "a value",
): string {
	const phrases = [
		...new Set([...kinds].map((kind) => valueKindPhrase(kind, fallback))),
	];
	return phrases.length <= 1
		? (phrases[0] ?? fallback)
		: `${phrases.slice(0, -1).join(", ")} or ${phrases[phrases.length - 1]}`;
}
