/**
 * SA wire-schema emission — what the model provider sees for each tool.
 *
 * OpenAI re-renders tool JSON schemas server-side into a TypeScript-like
 * namespace and bills that rendering as input tokens (function-calling
 * guide: functions are "injected into the system message in a syntax the
 * model has been trained on"). How that rendering treats a definition
 * graph is not observable offline, and live step usage showed the billed
 * tool rendering growing far past the emitted content's own token mass
 * while the definitions graph was recursive (Predicate → ValueExpression →
 * TableLookupExpression → Predicate). The wire therefore emits the AST
 * family CYCLE-FREE: each family root is ONE self-contained merged object —
 * the complete `kind` vocabulary, every property name, and every
 * authored-identity slot with its exact pattern — and nested expression
 * slots collapse to `{}`. No definition body references another definition,
 * so no renderer can expand the emission past its literal content. The
 * fully documented grammar lives ONCE in the system prompt ("Filters &
 * expressions", rendered from the same domain schemas by
 * `expressionReference.ts`); the wire teaches the vocabulary and the
 * identity constraints at the slot, and the prompt owns nesting.
 * `__tests__/wireSchemas.test.ts` pins the cycle-free law over every
 * registered tool's emission.
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

/** An `{}` schema — the collapsed spelling for "shape taught in the prompt". */
function isEmptySchema(value: unknown): boolean {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.keys(value).length === 0
	);
}

/**
 * Flatten the AST grammar to one bounded level while keeping the vocabulary.
 *
 * Object structure stays closed and discriminated, and every property remains
 * named exactly as in the canonical schema. Identity slots keep their complete
 * string/pattern schema. Every other slot — nested expressions included —
 * collapses to `{}`: the prompt's "Filters & expressions" grammar owns that
 * detail, and a `$ref` surviving into a projected body is what rebuilt the
 * recursive definitions graph this projection exists to prevent.
 */
function compactAstNode(node: unknown, propertyName?: string): unknown {
	if (Array.isArray(node)) {
		return node.map((entry) => compactAstNode(entry));
	}
	if (node === null || typeof node !== "object") return {};
	const source = node as JsonNode;
	if (typeof source.$ref === "string") return {};

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
				const compactedOthers = otherMembers
					.map((member) => compactAstNode(member))
					.filter((member) => !isEmptySchema(member));
				if (compactedOthers.length === 0) return merged;
				return { [key]: [...compactedOthers, merged] };
			}
			const compactedMembers = members.map((member) => compactAstNode(member));
			/* A wrapper whose every member collapsed (`allOf: [$ref]` at a
			 * property position, a union of pure refs) carries no content —
			 * emit the bare open slot instead of an empty union shell. */
			return compactedMembers.every(isEmptySchema)
				? {}
				: { [key]: compactedMembers };
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

/**
 * Inline a canonical definition's union-arm `$ref`s so the merge in
 * `compactAstNode` sees every discriminated arm as an inline object. Only
 * arm-position refs resolve (a member that is exactly `{ $ref }`); refs at
 * property positions stay for `compactAstNode` to collapse. The `seen` guard
 * cuts a definition that reaches itself through arms, so this terminates on
 * any graph.
 */
function inlineUnionArms(node: unknown, seen: ReadonlySet<string>): unknown {
	if (node === null || typeof node !== "object" || Array.isArray(node)) {
		return node;
	}
	const source = node as JsonNode;
	const refName =
		typeof source.$ref === "string" ? source.$ref.split("/").pop() : undefined;
	if (refName !== undefined) {
		const target = canonicalAstDefinitions[refName];
		if (target === undefined || seen.has(refName)) return {};
		return inlineUnionArms(target, new Set([...seen, refName]));
	}
	for (const key of ["oneOf", "anyOf"] as const) {
		const members = source[key];
		if (!Array.isArray(members)) continue;
		return {
			...source,
			[key]: members.map((member) => inlineUnionArms(member, seen)),
		};
	}
	return source;
}

function compactFamilyRoot(name: string): JsonNode {
	return compactAstNode(
		inlineUnionArms(canonicalAstDefinitions[name], new Set([name])),
	) as JsonNode;
}

const compactPredicate = compactFamilyRoot("Predicate");
const compactValueExpression = compactFamilyRoot("ValueExpression");
const compactTerm = compactFamilyRoot("Term");

/**
 * ValueExpression's provider projection also admits direct Term arms. The
 * runtime validator below normalizes those arms to the canonical `term`
 * wrapper before parsing, so this only removes model-facing ceremony; it does
 * not widen the document AST or the MCP contract.
 */
function addDirectTermShorthand(): void {
	const expressionProperties = compactValueExpression.properties;
	const termProperties = compactTerm.properties;
	if (
		expressionProperties === null ||
		typeof expressionProperties !== "object" ||
		termProperties === null ||
		typeof termProperties !== "object"
	) {
		throw new Error(
			"The compact ValueExpression and Term projections must each merge into one object so the direct-Term shorthand can combine them. A family root that no longer merges means the canonical union lost its inline discriminated arms — check the domain predicate schemas.",
		);
	}
	const expressionKind = (expressionProperties as JsonNode).kind as
		| JsonNode
		| undefined;
	const termKind = (termProperties as JsonNode).kind as JsonNode | undefined;
	if (!Array.isArray(expressionKind?.enum) || !Array.isArray(termKind?.enum)) {
		throw new Error(
			"The compact ValueExpression and Term projections must each carry a merged `kind` enum for the direct-Term shorthand. A missing enum means the merge in compactAstNode no longer ran — check the domain predicate schemas.",
		);
	}
	expressionKind.enum = [
		...new Set([...expressionKind.enum, ...termKind.enum]),
	];
	/* Term's `kind` node must not ride along: assigning it would replace the
	 * combined enum just built with Term's own arm list. */
	const { kind: _termKindNode, ...termRest } = termProperties as JsonNode;
	Object.assign(expressionProperties, termRest);
}

addDirectTermShorthand();
/**
 * Every canonical AST definition's cycle-free replacement. The three family
 * roots carry their merged objects; a leaf definition a tool references
 * directly (a true Term slot, a bare PropertyRef) compacts to its own
 * ref-free shell. Definitions nothing references are pruned per tool, so a
 * name appearing here does not put it on the wire.
 */
const compactAstDefinitions: JsonNode = {
	...Object.fromEntries(
		Object.keys(canonicalAstDefinitions).map((name) => [
			name,
			compactFamilyRoot(name),
		]),
	),
	Predicate: compactPredicate,
	ValueExpression: compactValueExpression,
	Term: compactTerm,
};
const AST_PROJECTIONS = new Map<z.ZodType, JsonNode>([
	[predicateSchema, compactPredicate],
	[valueExpressionSchema, compactValueExpression],
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
	breakDefinitionCycles(json);
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
 * Cut every cycle in the emitted definitions graph, so no renderer can expand
 * the emission past its literal content. A recursive Zod schema outside the
 * AST family (`createLocation`'s descendant tree) hoists as a self-referencing
 * definition; the cycle-closing `$ref` collapses to `{}` — one full level of
 * the shape stays on the wire, deeper nesting is taught by the tool's own
 * documentation and enforced by the untouched Zod validation. Acyclic refs
 * stay: their expansion is bounded by the emission itself. The AST projections
 * are already ref-free and shared across tools; this walk never mutates a body
 * with no cycle-closing ref, so the shared objects stay untouched.
 */
function breakDefinitionCycles(json: Record<string, unknown>): void {
	const defs = json.definitions as Record<string, unknown> | undefined;
	if (!defs) return;
	const cutRefNode = (node: JsonNode): void => {
		for (const key of Object.keys(node)) delete node[key];
	};
	const walk = (node: unknown, stack: ReadonlySet<string>): void => {
		if (Array.isArray(node)) {
			for (const item of node) walk(item, stack);
			return;
		}
		if (!node || typeof node !== "object") return;
		const record = node as JsonNode;
		if (typeof record.$ref === "string") {
			const name = record.$ref.split("/").pop() ?? "";
			if (stack.has(name)) {
				cutRefNode(record);
				return;
			}
			const target = defs[name];
			if (target !== undefined) walk(target, new Set([...stack, name]));
			return;
		}
		for (const value of Object.values(record)) walk(value, stack);
	};
	const { definitions: _defs, ...root } = json;
	walk(root, new Set());
	/* A definition only reachable through another cycle's cut edge still must
	 * not carry a cycle of its own once something references it again. */
	for (const name of Object.keys(defs)) {
		walk(defs[name], new Set([name]));
	}
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
