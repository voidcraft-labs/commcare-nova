import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	type Predicate,
	predicateSchema,
	valueExpressionSchema,
} from "@/lib/domain/predicate/types";
import { xpathExpressionSchema } from "@/lib/domain/xpath/ast";
import { authoringJsonSchema, authoringSchema } from "../schema";

const jsonOptions = {
	io: "input",
	target: "draft-7",
	reused: "ref",
} as const;

/** This is a canonical-family descendant with deliberately different storage.
 * Its authored position is unchanged; hidden children must never affect refs
 * allocated for the ordinary schemas that follow it. */
function alternateXPathStorage(storage: z.core.$ZodType): z.core.$ZodType {
	return z.core.clone<z.core.$ZodType>(
		xpathExpressionSchema,
		storage._zod.def,
		{
			parent: true,
		},
	);
}

function toolWithExpression(expression: z.core.$ZodType) {
	const repeated = z.strictObject({ name: z.string().min(1) });
	return z.strictObject({ expression, first: repeated, second: repeated });
}

type RecursiveCondition = {
	condition: Predicate;
	children: RecursiveCondition[];
};

function recursiveConditionSchema(): z.ZodType<RecursiveCondition> {
	const node: z.ZodType<RecursiveCondition> = z.lazy(() =>
		z.strictObject({
			condition: predicateSchema,
			children: z.array(node),
		}),
	);
	return node;
}

describe("authoring schema graph projection", () => {
	it("keeps served bytes independent of reused schemas hidden inside a content family", () => {
		const hiddenShared = z.strictObject({ secret: z.string() });
		const small = alternateXPathStorage(
			z.strictObject({ storageOnly: z.string() }),
		);
		const large = alternateXPathStorage(
			z.strictObject({
				storageOnly: z.array(hiddenShared),
				again: z.tuple([hiddenShared, hiddenShared]),
			}),
		);
		const before = authoringJsonSchema(toolWithExpression(small));
		const after = authoringJsonSchema(toolWithExpression(large));
		expect(JSON.stringify(after)).toBe(JSON.stringify(before));
		const validate = new Ajv({ strict: false }).compile(after);
		expect(
			validate({
				expression: "#form/age + 1",
				first: { name: "A" },
				second: { name: "B" },
			}),
		).toBe(true);
		expect(
			validate({
				expression: { storageOnly: [] },
				first: { name: "A" },
				second: { name: "B" },
			}),
		).toBe(false);
	});

	it("replaces refined and described family descendants before their canonical checks or metadata can escape", () => {
		const condition = predicateSchema
			.refine(() => false, "Canonical-only restriction")
			.describe("Canonical-only AST description");
		const expression = xpathExpressionSchema.describe(
			"Canonical-only XPath parts",
		);
		const source = z.strictObject({ condition, expression });
		const authored = authoringSchema(source);
		expect(
			authored.parse({ condition: true, expression: "#form/age + 1" }),
		).toEqual({
			condition: true,
			expression: "#form/age + 1",
		});
		expect(
			authored.safeParse({
				condition: { kind: "match-all" },
				expression: { parts: [] },
			}).success,
		).toBe(false);
		expect(condition.safeParse({ kind: "match-all" }).success).toBe(false);
		expect(JSON.stringify(authoringJsonSchema(source))).not.toContain(
			"Canonical-only",
		);
	});

	it("projects cold and already parsed recursive lazy graphs to identical authored schemas", () => {
		const cold = z.strictObject({ nodes: z.array(recursiveConditionSchema()) });
		const warm = z.strictObject({ nodes: z.array(recursiveConditionSchema()) });
		const canonical = {
			nodes: [
				{
					condition: { kind: "match-all" },
					children: [{ condition: { kind: "match-none" }, children: [] }],
				},
			],
		};
		expect(warm.parse(canonical)).toEqual(canonical);
		const coldJson = authoringJsonSchema(cold);
		const warmJson = authoringJsonSchema(warm);
		expect(JSON.stringify(warmJson)).toBe(JSON.stringify(coldJson));
		const authored = {
			nodes: [
				{
					condition: true,
					children: [{ condition: "#case/age >= 18", children: [] }],
				},
			],
		};
		for (const schema of [cold, warm]) {
			expect(authoringSchema(schema).parse(authored)).toEqual(authored);
			expect(authoringSchema(schema).safeParse(canonical).success).toBe(false);
			expect(schema.parse(canonical)).toEqual(canonical);
		}
	});

	it("keeps omission, explicit null, and defaults at their original authored positions", () => {
		const source = z.strictObject({
			optionalCondition: predicateSchema.optional(),
			clearableCondition: predicateSchema.nullable(),
			optionalValue: valueExpressionSchema.nullable().optional(),
			enabled: z.boolean().default(true),
		});
		const authored = authoringSchema(source);
		expect(authored.parse({ clearableCondition: null })).toEqual({
			clearableCondition: null,
			enabled: true,
		});
		const explicit = {
			optionalCondition: true,
			clearableCondition: false,
			optionalValue: 3,
			enabled: false,
		};
		expect(authored.parse(explicit)).toEqual(explicit);
		for (const input of [
			{},
			{ clearableCondition: null, optionalCondition: null },
			{ clearableCondition: 3 },
			{ clearableCondition: null, enabled: null },
			{ clearableCondition: null, optionalValue: { kind: "term", term: 3 } },
		])
			expect(authored.safeParse(input).success).toBe(false);
	});

	it("preserves authored admission through recursive containers, wrappers, and shared nodes", () => {
		type Shared = { count: number; condition: Predicate };
		type Node = {
			name: string;
			condition: Predicate;
			enabled: boolean;
			next?: Node | null;
			children?: Node[];
			byName?: Record<string, Node>;
			pair?: [Node, Node];
			left?: Shared;
			right?: Shared;
		};
		const shared = z.strictObject({
			count: z.number().int().min(0),
			condition: predicateSchema,
		});
		const node: z.ZodType<Node> = z.lazy(() =>
			z.strictObject({
				name: z.string().min(1),
				condition: predicateSchema,
				enabled: z.boolean().default(true),
				next: node.nullable().optional(),
				children: z.array(node).optional(),
				byName: z.record(z.string(), node).optional(),
				pair: z.tuple([node, node]).optional(),
				left: shared.optional(),
				right: shared.optional(),
			}),
		);
		const leaf = { name: "Visit", condition: true };
		const valid = {
			...leaf,
			next: null,
			children: [leaf],
			byName: { followup: leaf },
			pair: [leaf, leaf],
			left: { count: 0, condition: "#case/active = 'yes'" },
			right: { count: 1, condition: false },
		};
		const source = z.strictObject({ nodes: z.array(node) });
		const authored = authoringSchema(source);
		const validate = new Ajv({ strict: false }).compile(
			authoringJsonSchema(source),
		);
		expect(validate({ nodes: [valid] })).toBe(true);
		expect(authored.parse({ nodes: [valid] })).toMatchObject({
			nodes: [{ enabled: true, next: null, children: [{ enabled: true }] }],
		});
		const invalid = [
			{ ...valid, name: "" },
			{ ...valid, condition: 1 },
			{ ...valid, next: false },
			{ ...valid, children: [{ ...leaf, condition: { kind: "match-all" } }] },
			{ ...valid, byName: { followup: { ...leaf, name: "" } } },
			{ ...valid, pair: [leaf, leaf, leaf] },
			{ ...valid, left: { ...valid.left, count: -1 } },
			{ ...valid, right: { ...valid.right, count: 1.5 } },
			{ ...valid, extra: "undeclared" },
		];
		for (const input of invalid) {
			expect(validate({ nodes: [input] }), JSON.stringify(input)).toBe(false);
			expect(
				authored.safeParse({ nodes: [input] }).success,
				JSON.stringify(input),
			).toBe(false);
		}
	});

	it("leaves nonfamily parent topology and inherited metadata identical to Zod's own projection", () => {
		const named = z.strictObject({ parts: z.array(z.string()) }).meta({
			id: "AuthoringProjectionMetadataWitness",
			title: "Ordinary authored structure",
			description: "Original description",
		});
		const described = named.describe("A described use of the same structure");
		const source = z.strictObject({
			first: named,
			second: described,
			third: described,
		});
		try {
			const canonicalJson = z.toJSONSchema(source, jsonOptions);
			expect(authoringJsonSchema(source)).toEqual(canonicalJson);
			expect(
				authoringSchema(source).parse({
					first: { parts: ["one"] },
					second: { parts: ["two"] },
					third: { parts: [] },
				}),
			).toEqual({
				first: { parts: ["one"] },
				second: { parts: ["two"] },
				third: { parts: [] },
			});
			expect(z.globalRegistry.get(described)).toEqual({
				title: "Ordinary authored structure",
				description: "A described use of the same structure",
			});
			expect(
				z.globalRegistry._idmap.get("AuthoringProjectionMetadataWitness"),
			).toBe(named);
		} finally {
			z.globalRegistry.remove(described);
			z.globalRegistry.remove(named);
		}
	});

	it("keeps canonical schemas and global names unchanged while retaining authored expression definition names", () => {
		const describedCondition = predicateSchema.describe(
			"Canonical-only condition label",
		);
		const source = z.strictObject({
			condition: predicateSchema,
			otherCondition: predicateSchema,
			describedCondition,
			value: valueExpressionSchema,
			otherValue: valueExpressionSchema,
		});
		const canonicalBefore = z.toJSONSchema(source, jsonOptions);
		const conditionDefinition = predicateSchema._zod.def;
		const valueDefinition = valueExpressionSchema._zod.def;
		const conditionMetadata = structuredClone(
			z.globalRegistry.get(predicateSchema),
		);
		const valueMetadata = structuredClone(
			z.globalRegistry.get(valueExpressionSchema),
		);
		const namesBefore = new Map(z.globalRegistry._idmap);
		const json = authoringJsonSchema(source);
		const definitions = json.definitions as Record<string, unknown>;
		expect(definitions).toHaveProperty("Predicate");
		expect(definitions).toHaveProperty("ValueExpression");
		const valid = {
			condition: true,
			otherCondition: "#case/age > 18",
			describedCondition: false,
			value: 7,
			otherValue: "#case/age + 1",
		};
		expect(new Ajv({ strict: false }).compile(json)(valid)).toBe(true);
		expect(authoringSchema(source).parse(valid)).toEqual(valid);
		expect(z.toJSONSchema(source, jsonOptions)).toEqual(canonicalBefore);
		expect(predicateSchema._zod.def).toBe(conditionDefinition);
		expect(valueExpressionSchema._zod.def).toBe(valueDefinition);
		expect(z.globalRegistry.get(predicateSchema)).toEqual(conditionMetadata);
		expect(z.globalRegistry.get(valueExpressionSchema)).toEqual(valueMetadata);
		expect([...z.globalRegistry._idmap.keys()]).toEqual([
			...namesBefore.keys(),
		]);
		for (const [name, schema] of namesBefore)
			expect(z.globalRegistry._idmap.get(name)).toBe(schema);
	});
});
