import { z } from "zod";
import {
	canonicalProseTemplate,
	type ProsePart,
	type ProseTemplate,
	printProseTemplate,
	prosePartSchema,
} from "@/lib/domain/prose";
import type { XPathExpression } from "@/lib/domain/xpath/ast";
import type { XPathPrintableDoc } from "@/lib/domain/xpath/print";

export const referenceSchema = z.string().min(1);
export const textSchema = z
	.string()
	.describe(
		"Markdown text. {{field_id}} inserts an answer; \\{{ keeps literal braces.",
	);
export const expressionSchema = z
	.union([z.string(), z.boolean()])
	.describe(
		"XPath: #form/age reads an answer; #case/age reads the selected record. Booleans set constant conditions.",
	);

/** Interpolation names a reference, never executable code. Backslash escapes
 * only backslash and opening braces; other text remains byte-exact. */
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
		const end = source.indexOf("}}", cursor + 2);
		if (end === -1)
			throw new Error("An answer reference is missing its closing }}.");
		const name = source.slice(cursor + 2, end).trim();
		parts.push(resolve(name));
		cursor = end + 2;
	}
	if (text.length) parts.push({ kind: "text", text });
	return parts;
}

export function normalizeText(
	source: string,
	parse: (source: string) => XPathExpression,
) {
	return canonicalProseTemplate(
		parseInterpolatedText<ProsePart>(source, (name) => {
			const expression = parse(name.startsWith("#") ? name : `#form/${name}`);
			const [part] = expression.parts;
			if (expression.parts.length !== 1 || !part || part.kind === "text")
				throw new Error(`{{${name}}} must name one answer or record property.`);
			return prosePartSchema.parse(part);
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

export function normalizeExpression(
	value: string | boolean,
	parse: (source: string) => XPathExpression,
) {
	return parse(
		typeof value === "boolean" ? (value ? "true()" : "false()") : value,
	);
}

export function printAuthoringText(
	value: ProseTemplate,
	doc: XPathPrintableDoc,
): string {
	return printInterpolatedText(value.parts, (part) => {
		const reference = printProseTemplate({ parts: [part] }, doc);
		return reference.startsWith("#form/") ? reference.slice(6) : reference;
	});
}
