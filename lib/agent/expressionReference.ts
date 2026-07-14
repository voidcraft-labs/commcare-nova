/**
 * Renders the Predicate / ValueExpression / Term grammar ONCE for the
 * system prompt. The tool wire schemas carry one-line stubs pointing here
 * (`wireSchemas.ts`) instead of embedding the recursive AST on every
 * predicate-carrying tool — the single largest schema-content mass.
 *
 * Output is TypeScript-type syntax — the same rendering OpenAI converts
 * tool schemas into, so the model reads one consistent format — generated
 * from the domain schemas' own JSON emission, so the reference can never
 * drift from what validation accepts. Domain `.describe()` docs surface
 * as comments.
 */

import { z } from "zod";
import { predicateSchema, valueExpressionSchema } from "@/lib/domain/predicate";

type JsonNode = Record<string, unknown>;

function commentLines(text: unknown): string[] {
	if (typeof text !== "string" || text.length === 0) return [];
	return text.split("\n").map((line) => `// ${line}`);
}

function refName(ref: string): string {
	return ref.split("/").pop() ?? "unknown";
}

/** JSON-schema node → TypeScript type text. `$ref`s render as their
 *  definition NAME (the named types below), which is what keeps the
 *  recursive grammar finite and readable. */
function tsType(node: JsonNode | undefined, indent: string): string {
	if (!node || typeof node !== "object") return "unknown";
	if (typeof node.$ref === "string") return refName(node.$ref);
	const allOf = node.allOf as JsonNode[] | undefined;
	if (allOf?.length === 1) return tsType(allOf[0], indent);
	const union = (node.anyOf ?? node.oneOf) as JsonNode[] | undefined;
	if (union) {
		const parts = [...new Set(union.map((m) => tsType(m, indent)))];
		return parts.join(" | ");
	}
	if (Array.isArray(node.enum))
		return node.enum.map((v) => JSON.stringify(v)).join(" | ");
	if (node.const !== undefined) return JSON.stringify(node.const);
	switch (node.type) {
		case "string":
			return "string";
		case "number":
		case "integer":
			return "number";
		case "boolean":
			return "boolean";
		case "null":
			return "null";
		case "array": {
			// Zod's non-empty-array idiom emits tuple form (`items: [T]` +
			// `additionalItems: T`); collapse it back to `T[]`.
			const tuple = Array.isArray(node.items)
				? (node.items as JsonNode[])
				: undefined;
			const member = tuple
				? [
						...new Set(
							[...tuple, node.additionalItems as JsonNode]
								.filter(Boolean)
								.map((m) => tsType(m, indent)),
						),
					].join(" | ")
				: tsType(node.items as JsonNode, indent);
			return member.includes(" ") || member.includes("\n")
				? `Array<${member}>`
				: `${member}[]`;
		}
		default:
			break;
	}
	const properties = node.properties as Record<string, JsonNode> | undefined;
	if (properties && Object.keys(properties).length > 0) {
		const required = new Set((node.required as string[]) ?? []);
		const inner = `${indent}  `;
		const lines: string[] = ["{"];
		for (const [key, prop] of Object.entries(properties)) {
			for (const c of commentLines(prop?.description)) lines.push(inner + c);
			const opt = required.has(key) ? "" : "?";
			lines.push(`${inner}${key}${opt}: ${tsType(prop, inner)};`);
		}
		lines.push(`${indent}}`);
		return lines.join("\n");
	}
	return "object";
}

/**
 * The full grammar as named TypeScript types (`type Predicate = …`,
 * `type ValueExpression = …`, `type Term = …`, plus the leaf types they
 * reference), one authoritative statement for the prompt.
 */
export function buildExpressionReference(): string {
	const json = z.toJSONSchema(
		z.object({ p: predicateSchema, v: valueExpressionSchema }),
		{ target: "draft-7", io: "input" },
	) as JsonNode;
	const defs = (json.definitions ?? {}) as Record<string, JsonNode>;
	// Stable presentation order: the two grammar roots first, Term next,
	// then every remaining referenced type in emission order.
	const order = [
		"Predicate",
		"ValueExpression",
		"Term",
		...Object.keys(defs).filter(
			(k) => !["Predicate", "ValueExpression", "Term"].includes(k),
		),
	].filter((k) => defs[k]);
	const blocks = order.map((name) => {
		const def = defs[name] as JsonNode;
		const lines = [...commentLines(def.description)];
		const body = tsType({ ...def, description: undefined }, "");
		lines.push(`type ${name} = ${body};`);
		return lines.join("\n");
	});
	return blocks.join("\n\n");
}
