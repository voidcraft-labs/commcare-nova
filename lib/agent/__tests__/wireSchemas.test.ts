import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { normalizeModelAstInput } from "@/lib/agent/modelAstInput";
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

	it("keeps every AST object closed and every discriminator visible", () => {
		let discriminatorCount = 0;
		const discriminatorValues = new Set<string>();
		walkJson(json, (node, path) => {
			expect(node.additionalProperties, path).not.toBe(true);
			const properties = node.properties as JsonNode | undefined;
			const kind = properties?.kind as JsonNode | undefined;
			if (kind === undefined) return;
			discriminatorCount += 1;
			if (typeof kind.const === "string") {
				discriminatorValues.add(kind.const);
			}
			if (Array.isArray(kind.enum)) {
				for (const value of kind.enum) {
					if (typeof value === "string") discriminatorValues.add(value);
				}
			}
			expect(
				typeof kind.const === "string" ||
					(Array.isArray(kind.enum) && kind.enum.length > 0),
				path,
			).toBe(true);
		});
		expect(discriminatorCount).toBeGreaterThan(20);
		expect(discriminatorValues.size).toBeGreaterThan(55);
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
