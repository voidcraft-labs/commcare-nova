import { z } from "zod";
import {
	canonicalProseTemplate,
	type ProsePart,
	type ProseTemplate,
	printProseTemplate,
	prosePartSchema,
	proseText,
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

/** Mustache-style interpolation names a reference, never executable code. */
export function normalizeText(
	source: string,
	parse: (source: string) => XPathExpression,
) {
	const parts: ProsePart[] = [];
	let cursor = 0;
	let text = "";
	while (cursor < source.length) {
		if (source.startsWith("\\\\", cursor)) {
			text += "\\";
			cursor += 2;
			continue;
		}
		if (source.startsWith("\\{{", cursor)) {
			text += "{{";
			cursor += 3;
			continue;
		}
		if (!source.startsWith("{{", cursor)) {
			text += source[cursor];
			cursor += 1;
			continue;
		}
		parts.push(...proseText(text).parts);
		text = "";
		const end = source.indexOf("}}", cursor + 2);
		if (end === -1)
			throw new Error("An answer reference is missing its closing }}.");
		const name = source.slice(cursor + 2, end).trim();
		const expression = parse(name.startsWith("#") ? name : `#form/${name}`);
		const [part] = expression.parts;
		if (expression.parts.length !== 1 || !part || part.kind === "text")
			throw new Error(`{{${name}}} must name one answer or record property.`);
		parts.push(prosePartSchema.parse(part));
		cursor = end + 2;
	}
	parts.push(...proseText(text).parts);
	return canonicalProseTemplate(parts);
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
	return value.parts
		.map((part) => {
			if (part.kind === "text")
				return part.text.replaceAll("\\", "\\\\").replaceAll("{{", "\\{{");
			const reference = printProseTemplate({ parts: [part] }, doc);
			return `{{${reference.startsWith("#form/") ? reference.slice(6) : reference}}}`;
		})
		.join("");
}
