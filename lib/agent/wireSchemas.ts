/**
 * SA wire-schema emission — what the model provider sees for each tool.
 *
 * OpenAI re-renders tool JSON schemas server-side into a TypeScript-like
 * namespace and bills that rendering as input tokens (function-calling
 * guide: functions are "injected into the system message in a syntax the
 * model has been trained on"), so schema CONTENT is the only size lever —
 * emission form ($refs, defs, whitespace) is billing-irrelevant, verified
 * by direct measurement. The recursive Predicate / ValueExpression AST is
 * by far the largest content mass and rides nine tools. The wire therefore
 * carries a compact, schema-derived projection for those nodes, and the fully
 * documented grammar lives ONCE in the system prompt ("Filters & expressions",
 * rendered from the same domain schemas by `expressionReference.ts`). The
 * compact projection retains every object key, required set, discriminator,
 * recursive edge, and authored-identity constraint; only non-identity leaf
 * detail already stated in the prompt collapses to `{}`. It is never an open
 * `additionalProperties:true` identity stub.
 *
 * Validation remains canonical: the returned Schema first normalizes the
 * model-only direct-Term shorthand and then parses with the real Zod schema,
 * so malformed predicates still reject with the same teaching messages. MCP
 * registers the Zod schemas directly and never sees this projection or
 * shorthand.
 */

import { jsonSchema, type Schema } from "ai";
import { z } from "zod";
import { normalizeModelAstInput } from "@/lib/agent/modelAstInput";
import { predicateSchema, valueExpressionSchema } from "@/lib/domain/predicate";

type JsonNode = Record<string, unknown>;

const IDENTITY_KEYS = new Set([
	"uuid",
	"userPropertyUuid",
	"searchInputUuid",
	"opUuid",
	"locationUuid",
	"levelUuid",
	"tableId",
	"columnId",
	"resultColumnId",
]);

/**
 * Preserve the recursive AST grammar while removing non-identity leaf detail.
 *
 * Object structure stays closed and discriminated, and every property remains
 * named + required exactly as in the canonical schema. Identity slots keep
 * their complete string/pattern schema. Other scalar leaf constraints are
 * already rendered once in the prompt and collapse to `{}` here.
 */
function compactAstNode(node: unknown, propertyName?: string): unknown {
	if (Array.isArray(node)) {
		return node.map((entry) => compactAstNode(entry));
	}
	if (node === null || typeof node !== "object") return {};
	const source = node as JsonNode;
	if (typeof source.$ref === "string") return { $ref: source.$ref };

	for (const key of ["oneOf", "anyOf", "allOf"] as const) {
		const members = source[key];
		if (Array.isArray(members)) {
			const objectMembers = members.filter((member) => {
				if (member === null || typeof member !== "object") return false;
				const properties = (member as JsonNode).properties;
				return (
					properties !== null &&
					typeof properties === "object" &&
					"kind" in (properties as JsonNode)
				);
			}) as JsonNode[];
			if (objectMembers.length > 1) {
				/* The provider needs the complete discriminator vocabulary and the
				 * exact identity slots, while the prompt owns per-arm teaching.
				 * Merge discriminated arms into one closed object: every legitimate
				 * key remains named, `kind` retains the exact union, and identity
				 * properties retain their patterns. The untouched Zod validator
				 * still enforces each arm's precise required set. */
				const otherMembers = members.filter(
					(member) => !objectMembers.includes(member as JsonNode),
				);
				const propertyVariants = new Map<string, unknown[]>();
				for (const member of objectMembers) {
					for (const [name, value] of Object.entries(
						(member.properties as JsonNode | undefined) ?? {},
					)) {
						const variants = propertyVariants.get(name) ?? [];
						variants.push(value);
						propertyVariants.set(name, variants);
					}
				}
				const mergedProperties: JsonNode = {};
				for (const [name, variants] of propertyVariants) {
					if (name === "kind") {
						const values = new Set<string>();
						for (const variant of variants) {
							if (variant === null || typeof variant !== "object") continue;
							const kind = variant as JsonNode;
							if (typeof kind.const === "string") values.add(kind.const);
							if (Array.isArray(kind.enum)) {
								for (const value of kind.enum) {
									if (typeof value === "string") values.add(value);
								}
							}
						}
						mergedProperties.kind = {
							type: "string",
							enum: [...values],
						};
						continue;
					}
					const compacted = variants.map((variant) =>
						compactAstNode(variant, name),
					);
					const unique = [
						...new Map(
							compacted.map((variant) => [JSON.stringify(variant), variant]),
						).values(),
					];
					mergedProperties[name] =
						unique.length === 1 ? unique[0] : { anyOf: unique };
				}
				const merged: JsonNode = {
					type: "object",
					properties: mergedProperties,
					required: ["kind"],
					additionalProperties: false,
				};
				if (otherMembers.length === 0) return merged;
				return {
					[key]: [
						...otherMembers.map((member) => compactAstNode(member)),
						merged,
					],
				};
			}
			return { [key]: members.map((member) => compactAstNode(member)) };
		}
	}

	const properties = source.properties;
	if (
		source.type === "object" ||
		(properties !== null && typeof properties === "object")
	) {
		const projectedProperties: JsonNode = {};
		for (const [key, value] of Object.entries(
			(properties as JsonNode | undefined) ?? {},
		)) {
			projectedProperties[key] =
				key === "kind" || IDENTITY_KEYS.has(key)
					? value
					: compactAstNode(value, key);
		}
		const projected: JsonNode = {
			type: "object",
			properties: projectedProperties,
			additionalProperties: false,
		};
		if (Array.isArray(source.required)) {
			projected.required = source.required;
		}
		return projected;
	}

	if (source.type === "array" || source.items !== undefined) {
		const projected: JsonNode = { type: "array" };
		if (Array.isArray(source.items)) {
			projected.items = source.items.map((item) => compactAstNode(item));
		} else if (source.items !== undefined) {
			projected.items = compactAstNode(source.items);
		}
		if (source.additionalItems !== undefined) {
			projected.additionalItems = compactAstNode(source.additionalItems);
		}
		return projected;
	}

	return propertyName === "kind" || IDENTITY_KEYS.has(propertyName ?? "")
		? source
		: {};
}

const canonicalAstJson = z.toJSONSchema(
	z.object({
		predicate: predicateSchema,
		valueExpression: valueExpressionSchema,
	}),
	{ target: "draft-7", io: "input" },
) as JsonNode;
const canonicalAstDefinitions =
	(canonicalAstJson.definitions as JsonNode | undefined) ?? {};
const compactAstDefinitions = Object.fromEntries(
	Object.entries(canonicalAstDefinitions).map(([name, schema]) => [
		name,
		compactAstNode(schema),
	]),
) as JsonNode;

/**
 * ValueExpression's provider projection also admits direct Term arms. The
 * runtime validator below normalizes those arms to the canonical `term`
 * wrapper before parsing, so this only removes model-facing ceremony; it does
 * not widen the document AST or the MCP contract.
 */
function addDirectTermShorthand(): void {
	const expression = compactAstDefinitions.ValueExpression;
	const term = compactAstDefinitions.Term;
	if (
		expression === null ||
		typeof expression !== "object" ||
		term === null ||
		typeof term !== "object"
	) {
		return;
	}
	const expressionNode = expression as JsonNode;
	const termNode = term as JsonNode;
	if (Array.isArray(expressionNode.oneOf)) {
		expressionNode.oneOf.push({ $ref: "#/definitions/Term" });
		return;
	}
	const expressionProperties = expressionNode.properties;
	const termProperties = termNode.properties;
	if (
		expressionProperties === null ||
		typeof expressionProperties !== "object" ||
		termProperties === null ||
		typeof termProperties !== "object"
	) {
		return;
	}
	const expressionKind = (expressionProperties as JsonNode).kind as
		| JsonNode
		| undefined;
	const termKind = (termProperties as JsonNode).kind as JsonNode | undefined;
	if (!Array.isArray(expressionKind?.enum) || !Array.isArray(termKind?.enum)) {
		return;
	}
	expressionKind.enum = [
		...new Set([...expressionKind.enum, ...termKind.enum]),
	];
	Object.assign(expressionProperties, termProperties);
}

addDirectTermShorthand();
const AST_PROJECTIONS = new Map<z.ZodType, JsonNode>([
	[predicateSchema, compactAstDefinitions.Predicate as JsonNode],
	[valueExpressionSchema, compactAstDefinitions.ValueExpression as JsonNode],
]);

/**
 * Projection cache. Tool input schemas are module-level singletons
 * (`toolSchemas.ts` materializes the generator output once; the tool
 * modules export theirs at module scope), but the chat factory wraps
 * every tool on every request — uncached, each POST re-walks ~36 Zod
 * trees through `z.toJSONSchema` + pruning for identical output. The
 * projection is a pure function of the (immutable) schema node, so a
 * hit is byte-identical to a rebuild; a non-singleton schema would
 * simply miss.
 */
const projectedSchemas = new WeakMap<z.ZodType, Schema<unknown>>();

/**
 * Emit a tool's compact wire schema while validating with the untouched Zod
 * schema. The projection replaces each AST-family root in place
 * (`z.toJSONSchema`'s `override`) and then replaces its reachable definitions
 * with their compact equivalents. Every use site remains a tiny `$ref`.
 */
export function wireToolSchema<I>(schema: z.ZodType<I>): Schema<I> {
	const hit = projectedSchemas.get(schema as z.ZodType);
	if (hit) return hit as Schema<I>;
	const json = z.toJSONSchema(schema, {
		target: "draft-7",
		io: "input",
		override: (ctx) => {
			const projection = AST_PROJECTIONS.get(
				ctx.zodSchema as unknown as z.ZodType,
			);
			if (projection) {
				for (const key of Object.keys(ctx.jsonSchema)) {
					delete (ctx.jsonSchema as Record<string, unknown>)[key];
				}
				Object.assign(ctx.jsonSchema, projection);
			}
		},
	}) as Record<string, unknown>;
	const definitions = json.definitions as JsonNode | undefined;
	if (definitions !== undefined) {
		for (const name of Object.keys(definitions)) {
			const compact = compactAstDefinitions[name];
			if (compact !== undefined) definitions[name] = compact;
		}
	}
	pruneUnreferencedDefinitions(json);
	const wire = jsonSchema<I>(json as Parameters<typeof jsonSchema<I>>[0], {
		validate: (value) => {
			const result = schema.safeParse(normalizeModelAstInput(value));
			return result.success
				? { success: true, value: result.data }
				: { success: false, error: result.error };
		},
	});
	projectedSchemas.set(schema as z.ZodType, wire as Schema<unknown>);
	return wire;
}

/**
 * Drop definitions nothing references. Compacting a family root can sever
 * non-identity children, but Zod has already hoisted every registered id it
 * reached; unreachable definitions must not ride the provider wire.
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
