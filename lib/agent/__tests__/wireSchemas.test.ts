import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { normalizeModelAstInput } from "@/lib/agent/modelAstInput";
import { SHARED_TOOL_REGISTRY } from "@/lib/agent/sharedToolRegistry";
import { wireToolSchema } from "@/lib/agent/wireSchemas";
import {
	CANONICAL_UUID_PATTERN,
	proseTemplateSchema,
	xpathExpressionSchema,
} from "@/lib/domain";
import { predicateSchema, valueExpressionSchema } from "@/lib/domain/predicate";

type JsonNode = Record<string, unknown>;

const UUID_PATTERN = CANONICAL_UUID_PATTERN.source;
const UUID_V7_PATTERN =
	"^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const IDENTITY_PATTERNS: Readonly<Record<string, string>> = {
	uuid: UUID_PATTERN,
	userPropertyUuid: UUID_PATTERN,
	searchInputUuid: UUID_PATTERN,
	opUuid: UUID_PATTERN,
	tableId: UUID_V7_PATTERN,
	columnId: UUID_V7_PATTERN,
	resultColumnId: UUID_V7_PATTERN,
};

function walkJson(
	node: unknown,
	visit: (node: JsonNode, path: string) => void,
	path = "",
): void {
	if (Array.isArray(node)) {
		for (const [index, entry] of node.entries()) {
			walkJson(entry, visit, `${path}/${index}`);
		}
		return;
	}
	if (node === null || typeof node !== "object") return;
	const record = node as JsonNode;
	visit(record, path);
	for (const [key, value] of Object.entries(record)) {
		walkJson(value, visit, `${path}/${key}`);
	}
}

describe("compact provider expression schemas", () => {
	const localSchema = z
		.object({
			predicate: predicateSchema,
			valueExpression: valueExpressionSchema,
			xpath: xpathExpressionSchema,
			prose: proseTemplateSchema,
		})
		.strict();
	const wire = wireToolSchema(localSchema);
	const json = wire.jsonSchema as JsonNode;

	it("keeps every AST object closed and the family roots' complete kind vocabulary visible", () => {
		/* The wire contract: each family root's own arm vocabulary survives the
		 * projection. Deeper structural vocabulary (RelationPath arms, switch
		 * cases) is taught by the prompt's generated grammar and enforced by
		 * the untouched Zod validation. */
		const canonicalJson = z.toJSONSchema(
			z.object({
				predicate: predicateSchema,
				valueExpression: valueExpressionSchema,
			}),
			{ target: "draft-7", io: "input" },
		) as JsonNode;
		const canonicalDefs = (canonicalJson.definitions ?? {}) as JsonNode;
		const armKinds = (defName: string): Set<string> => {
			const values = new Set<string>();
			const def = canonicalDefs[defName] as JsonNode | undefined;
			const arms = (def?.oneOf ?? def?.anyOf ?? [def]) as unknown[];
			for (const arm of arms) {
				if (arm === null || typeof arm !== "object") continue;
				const node = arm as JsonNode;
				if (typeof node.$ref === "string") {
					for (const kind of armKinds(node.$ref.split("/").pop() ?? "")) {
						values.add(kind);
					}
					continue;
				}
				const kind = (node.properties as JsonNode | undefined)?.kind as
					| JsonNode
					| undefined;
				if (typeof kind?.const === "string") values.add(kind.const);
				if (Array.isArray(kind?.enum)) {
					for (const value of kind.enum) {
						if (typeof value === "string") values.add(value);
					}
				}
			}
			return values;
		};
		const canonicalRootKinds = new Set(
			["Predicate", "ValueExpression", "Term"].flatMap((name) => [
				...armKinds(name),
			]),
		);
		const projectedKinds = new Set<string>();
		walkJson(json, (node) => {
			const kind = (node.properties as JsonNode | undefined)?.kind as
				| JsonNode
				| undefined;
			if (typeof kind?.const === "string") projectedKinds.add(kind.const);
			if (Array.isArray(kind?.enum)) {
				for (const value of kind.enum) {
					if (typeof value === "string") projectedKinds.add(value);
				}
			}
		});
		expect(canonicalRootKinds.size).toBeGreaterThan(40);
		for (const kind of canonicalRootKinds) {
			expect(projectedKinds.has(kind), `kind ${kind} lost in projection`).toBe(
				true,
			);
		}
		walkJson(json, (node, path) => {
			expect(node.additionalProperties, path).not.toBe(true);
		});
	});

	it("emits a cycle-free definitions graph with ref-free AST bodies on every registered tool", () => {
		const astDefNames = new Set(
			Object.keys(
				(
					z.toJSONSchema(
						z.object({
							predicate: predicateSchema,
							valueExpression: valueExpressionSchema,
						}),
						{ target: "draft-7", io: "input" },
					) as JsonNode
				).definitions as JsonNode,
			),
		);
		const refsOf = (node: unknown, out: Set<string>): void => {
			if (Array.isArray(node)) {
				for (const item of node) refsOf(item, out);
				return;
			}
			if (node === null || typeof node !== "object") return;
			for (const [key, value] of Object.entries(node as JsonNode)) {
				if (key === "$ref" && typeof value === "string") {
					out.add(value.split("/").pop() ?? "");
				} else {
					refsOf(value, out);
				}
			}
		};
		let total = 0;
		for (const { saName, tool } of SHARED_TOOL_REGISTRY) {
			const toolJson = wireToolSchema(tool.inputSchema as z.ZodType)
				.jsonSchema as JsonNode;
			total += JSON.stringify(toolJson).length;
			const defs = (toolJson.definitions ?? {}) as JsonNode;
			const edges = new Map<string, Set<string>>();
			for (const [name, body] of Object.entries(defs)) {
				const out = new Set<string>();
				refsOf(body, out);
				edges.set(name, out);
				if (astDefNames.has(name)) {
					expect(
						out.size,
						`${saName} AST definition ${name} references ${[...out].join(", ")} — the AST projection must stay self-contained`,
					).toBe(0);
				}
			}
			/* No definition may reach itself: a cyclic graph hands the provider's
			 * schema renderer unbounded expansion, the regression behind the
			 * ~540k-token SA requests this projection retired. */
			for (const start of edges.keys()) {
				const seen = new Set<string>();
				const frontier = [...(edges.get(start) ?? [])];
				while (frontier.length > 0) {
					const name = frontier.pop();
					if (name === undefined || seen.has(name)) continue;
					seen.add(name);
					expect(name, `${saName} definitions cycle through ${start}`).not.toBe(
						start,
					);
					frontier.push(...(edges.get(name) ?? []));
				}
			}
		}
		/* The whole registry's emission stays inside a hard content budget, so
		 * tool growth is a deliberate, visible spend (396k chars when set). */
		expect(total).toBeLessThan(450_000);
	});

	it("keeps the exact UUID pattern on every identity-bearing AST property", () => {
		const found = new Set<string>();
		walkJson(json, (node, path) => {
			const properties = node.properties as JsonNode | undefined;
			if (properties === undefined) return;
			for (const [key, expectedPattern] of Object.entries(IDENTITY_PATTERNS)) {
				const property = properties[key] as JsonNode | undefined;
				if (property === undefined) continue;
				found.add(key);
				expect(property.pattern, `${path}/properties/${key}`).toBe(
					expectedPattern,
				);
			}
		});
		expect(found).toEqual(new Set(Object.keys(IDENTITY_PATTERNS)));
	});

	it("remains a compact valid Draft-7 schema that admits canonical examples", () => {
		expect(JSON.stringify(json).length).toBeLessThan(11_000);
		const validate = new Ajv({ strict: false }).compile(json);
		const canonicalUuid = "01890f45-0000-7000-8000-000000000001";
		expect(
			validate({
				predicate: {
					kind: "eq",
					left: {
						kind: "term",
						term: { kind: "field", uuid: canonicalUuid },
					},
					right: { kind: "term", term: { kind: "literal", value: "yes" } },
				},
				valueExpression: {
					kind: "id-of",
					opUuid: canonicalUuid,
				},
				xpath: {
					parts: [{ kind: "field-ref", uuid: canonicalUuid }],
				},
				prose: {
					parts: [
						{ kind: "user-property-ref", userPropertyUuid: canonicalUuid },
					],
				},
			}),
			JSON.stringify(validate.errors),
		).toBe(true);
	});

	it("admits direct Term operands and normalizes them before canonical parsing", async () => {
		const shorthandSchema = z.object({ predicate: predicateSchema }).strict();
		const shorthandWire = wireToolSchema(shorthandSchema);
		const input = {
			predicate: {
				kind: "eq",
				left: { kind: "prop", caseType: "patient", property: "status" },
				right: { kind: "literal", value: "open" },
			},
		};
		const validateJson = new Ajv({ strict: false }).compile(
			shorthandWire.jsonSchema as JsonNode,
		);
		expect(validateJson(input), JSON.stringify(validateJson.errors)).toBe(true);

		const result = await shorthandWire.validate?.(input);
		expect(result).toEqual({
			success: true,
			value: {
				predicate: {
					kind: "eq",
					left: {
						kind: "term",
						term: { kind: "prop", caseType: "patient", property: "status" },
					},
					right: {
						kind: "term",
						term: { kind: "literal", value: "open" },
					},
				},
			},
		});
	});

	it("does not reinterpret non-expression literal objects", () => {
		const automation = {
			automation: {
				updates: [
					{
						target: { caseType: "patient", property: "state" },
						value: { kind: "literal", value: "resolved" },
					},
				],
			},
		};
		expect(normalizeModelAstInput(automation)).toEqual(automation);
	});

	it("preserves discriminator-only nodes and normalizes match values", () => {
		expect(
			normalizeModelAstInput({
				filter: { kind: "match-all" },
				expression: { kind: "today" },
				predicate: {
					kind: "match",
					property: { caseType: "patient", property: "case_name" },
					value: { kind: "literal", value: "Ada" },
					mode: "exact",
				},
			}),
		).toEqual({
			filter: { kind: "match-all" },
			expression: { kind: "today" },
			predicate: {
				kind: "match",
				property: { caseType: "patient", property: "case_name" },
				value: {
					kind: "term",
					term: { kind: "literal", value: "Ada" },
				},
				mode: "exact",
			},
		});
	});
});
