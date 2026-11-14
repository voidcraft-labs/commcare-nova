import { z } from "zod";
import {
	canonicalProseTemplate,
	type ProseAtomPart,
	type ProsePart,
	type ProseTemplate,
	type ProseValuePart,
	printProseTemplate,
	prosePartSchema,
} from "@/lib/domain/prose";
import type { ReferenceNamesDoc } from "@/lib/domain/referenceNames";
import { AuthoringInputError } from "./errors";

export const referenceSchema = z.string().min(1);
export const expressionSchema = z
	.union([z.string(), z.boolean()])
	.describe(
		"XPath: #form/age reads an answer; #case/age reads the selected record; #household/region reads its household ancestor by record type. Booleans set constant conditions.",
	);

/** How many characters of an unclosed formula its refusal quotes. */
const UNCLOSED_FORMULA_QUOTE = 40;

/** Where the `}}` closing a `{{= formula}}` insertion starts: the first one
 * outside a quoted string. A string literal of the form grammar is a quote,
 * any characters but that quote, and the quote, with no escape
 * (`grammar.lezer.grammar::StringLiteral`), and `}` is no token of the
 * grammar outside one, so this scan and the parser agree on where a formula
 * ends. It reads no XPath structure: the formula goes whole to the parser.
 * -1 where none closes it. */
function formulaEnd(source: string, from: number): number {
	let cursor = from;
	while (cursor < source.length) {
		const char = source[cursor];
		if (char === "'" || char === '"') {
			const close = source.indexOf(char, cursor + 1);
			if (close === -1) return -1;
			cursor = close + 1;
			continue;
		}
		if (source.startsWith("}}", cursor)) return cursor;
		cursor += 1;
	}
	return -1;
}

/** Interpolation names a reference or, after `=`, a formula; it is never
 * executable code. Backslash escapes only backslash and opening braces in
 * literal text; other text, and every formula, remains byte-exact. */
export function parseInterpolatedText<Reference>(
	source: string,
	resolve: (name: string) => Reference,
) {
	const parts: ({ kind: "text"; text: string } | Reference)[] = [];
	let cursor = 0;
	let text = "";
	while (cursor < source.length) {
		if (source.startsWith("\\\\", cursor)) {
			text += "\\";
			cursor += 2;
			continue;
		}
		if (source.startsWith("\\{", cursor)) {
			text += "{";
			cursor += 2;
			continue;
		}
		if (!source.startsWith("{{", cursor)) {
			text += source[cursor];
			cursor += 1;
			continue;
		}
		if (text.length) parts.push({ kind: "text", text });
		text = "";
		const inner = cursor + 2;
		const formula = source.slice(inner).trimStart().startsWith("=");
		const end = formula
			? formulaEnd(source, inner)
			: source.indexOf("}}", inner);
		if (end === -1) {
			if (formula) {
				const start = source.indexOf("=", inner) + 1;
				const quoted = source
					.slice(start)
					.trimStart()
					.slice(0, UNCLOSED_FORMULA_QUOTE);
				throw new AuthoringInputError(
					`The calculated value that starts {{= ${quoted} has no closing }}. A quote mark inside it may be unclosed.`,
				);
			}
			throw new AuthoringInputError(
				"An answer reference is missing its closing }}.",
			);
		}
		const name = source.slice(inner, end).trim();
		parts.push(resolve(name));
		cursor = end + 2;
	}
	if (text.length) parts.push({ kind: "text", text });
	return parts;
}

/** A text's parts, each insertion parsed by `parse`: a reference by its name,
 * a calculated value by `=` and its formula (`parseProseAtom`). */
export function normalizeText(
	source: string,
	parse: (name: string) => ProseAtomPart,
) {
	return canonicalProseTemplate(
		parseInterpolatedText<ProsePart>(source, (name) => {
			return prosePartSchema.parse(parse(name));
		}),
	);
}

export function printInterpolatedText<Reference>(
	parts: readonly ({ kind: "text"; text: string } | Reference)[],
	reference: (value: Reference) => string,
): string {
	return parts
		.map((part) => {
			if (
				part !== null &&
				typeof part === "object" &&
				"kind" in part &&
				part.kind === "text" &&
				"text" in part &&
				typeof part.text === "string"
			)
				return part.text.replaceAll("\\", "\\\\").replaceAll("{", "\\{");
			return `{{${reference(part as Reference)}}}`;
		})
		.join("");
}

/** A text as an author writes it. A calculated value prints as `{{= ` and
 * what `printValue` gives; a caller that passes none and meets one throws
 * `ProseProjectionError`, since only a text a form evaluates holds one. The
 * formula needs no escape: its insertion ends at the first `}}` outside a
 * quoted string, and a printed formula holds none. */
export function printAuthoringText(
	value: ProseTemplate,
	doc: ReferenceNamesDoc,
	printValue?: (part: ProseValuePart) => string,
): string {
	return printInterpolatedText(value.parts, (part) => {
		if (part.kind === "value")
			return `= ${printProseTemplate({ parts: [part] }, doc, printValue === undefined ? undefined : { value: printValue })}`;
		const reference = printProseTemplate({ parts: [part] }, doc);
		return part.kind === "field-ref" && reference.startsWith("#form/")
			? reference.slice(6)
			: reference;
	});
}
