/**
 * SA wire-schema emission — what the model provider sees for each tool.
 *
 * OpenAI re-renders tool JSON schemas server-side into a TypeScript-like
 * namespace and bills that rendering as input tokens (function-calling
 * guide: functions are "injected into the system message in a syntax the
 * model has been trained on"), so schema CONTENT is the only size lever —
 * emission form ($refs, defs, whitespace) is billing-irrelevant, verified
 * by direct measurement. The recursive Predicate / ValueExpression AST is
 * by far the largest content mass and rides nine tools; the wire
 * therefore carries a one-line STUB for those two nodes, and the full
 * grammar lives ONCE in the system prompt ("Filters & expressions",
 * rendered from the same domain schemas by `expressionReference.ts`).
 *
 * Validation is untouched: the returned Schema parses with the real Zod
 * schema, so a malformed predicate rejects exactly as before, with the
 * same teaching messages, on chat and MCP alike (MCP registers the Zod
 * schemas directly and never sees this projection).
 */

import { jsonSchema, type Schema } from "ai";
import { z } from "zod";
import { predicateSchema, valueExpressionSchema } from "@/lib/domain/predicate";

const AST_STUBS = new Map<z.ZodType, Record<string, unknown>>([
	[
		predicateSchema,
		{
			type: "object",
			additionalProperties: true,
			description:
				'Predicate AST node (boolean filter). Shape reference: "Filters & expressions" in your instructions.',
		},
	],
	[
		valueExpressionSchema,
		{
			type: "object",
			additionalProperties: true,
			description:
				'ValueExpression AST node (typed value). Shape reference: "Filters & expressions" in your instructions.',
		},
	],
]);

/**
 * Emit a tool's wire schema with the AST family stubbed, validating with
 * the untouched Zod schema. The stub replaces each node's emitted JSON in
 * place (`z.toJSONSchema`'s `override`), so the registered definition
 * carries the one-liner and every use site is a tiny `$ref`.
 */
export function wireToolSchema<I>(schema: z.ZodType<I>): Schema<I> {
	const json = z.toJSONSchema(schema, {
		target: "draft-7",
		io: "input",
		override: (ctx) => {
			const stub = AST_STUBS.get(ctx.zodSchema as unknown as z.ZodType);
			if (stub) {
				for (const key of Object.keys(ctx.jsonSchema)) {
					delete (ctx.jsonSchema as Record<string, unknown>)[key];
				}
				Object.assign(ctx.jsonSchema, stub);
			}
		},
	}) as Record<string, unknown>;
	pruneUnreferencedDefinitions(json);
	return jsonSchema<I>(json as Parameters<typeof jsonSchema<I>>[0], {
		validate: (value) => {
			const result = schema.safeParse(value);
			return result.success
				? { success: true, value: result.data }
				: { success: false, error: result.error };
		},
	});
}

/**
 * Drop definitions nothing references. Stubbing a family root severs its
 * children, but zod has already hoisted every registered id it reached —
 * the full inner types would otherwise ride the wire as dead weight.
 */
function pruneUnreferencedDefinitions(json: Record<string, unknown>): void {
	const defs = json.definitions as Record<string, unknown> | undefined;
	if (!defs) return;
	const refsOf = (node: unknown, out: Set<string>): void => {
		if (Array.isArray(node)) {
			for (const item of node) refsOf(item, out);
			return;
		}
		if (!node || typeof node !== "object") return;
		for (const [key, value] of Object.entries(node)) {
			if (key === "$ref" && typeof value === "string") {
				out.add(value.split("/").pop() ?? "");
			} else {
				refsOf(value, out);
			}
		}
	};
	const reachable = new Set<string>();
	const { definitions: _defs, ...root } = json;
	let frontier = new Set<string>();
	refsOf(root, frontier);
	while (frontier.size > 0) {
		const next = new Set<string>();
		for (const name of frontier) {
			if (reachable.has(name)) continue;
			reachable.add(name);
			if (defs[name]) refsOf(defs[name], next);
		}
		frontier = next;
	}
	for (const name of Object.keys(defs)) {
		if (!reachable.has(name)) delete defs[name];
	}
	if (Object.keys(defs).length === 0) delete json.definitions;
}
