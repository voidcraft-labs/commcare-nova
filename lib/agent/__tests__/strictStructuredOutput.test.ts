/**
 * Offline projection and local validation of the production design schemas.
 * Structural checks cover selected strict-schema requirements; AJV exercises
 * emitted Draft-7 semantics. Neither establishes live provider acceptance or
 * model output quality. Native provider-adapter tests live beside this suite.
 */

import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ids, makeContract } from "@/lib/agent/design/__tests__/fixtures";
import { appDesignContractSchema } from "@/lib/agent/design/contract";
import {
	designReviewSchema,
	designRevisionResultSchemaFor,
} from "@/lib/agent/design/review";
import { designReviewSchemaFor } from "@/lib/agent/design/reviewerSchema";
import type { DesignSourcePackage } from "@/lib/agent/design/sourcePackage";
import {
	strictStructuredSchema,
	strictWireJsonSchema,
	stripNullProperties,
} from "@/lib/agent/strictStructuredOutput";

const CONTRACT = makeContract();

function fixturePackage(): DesignSourcePackage {
	return {
		schemaVersion: 1,
		designSessionId: "00000000-0000-4000-8000-000000000700",
		projectId: "proj-1",
		packageDigest: "b".repeat(64),
		request: {
			blocks: [
				{
					ref: {
						kind: "message",
						threadId: "00000000-0000-4000-8000-999999999999",
						messageId: "m-1",
						partIndex: 0,
					},
					text: "Track CHW visits.",
					truncated: false,
				},
			],
		},
		claims: [],
		attachments: [],
		images: [],
		platformConstraints: [],
		sources: [
			{
				ref: {
					kind: "message",
					threadId: "00000000-0000-4000-8000-999999999999",
					messageId: "m-1",
					partIndex: 0,
				},
			},
		],
	};
}

const REVIEW_BINDINGS = [
	{ handle: "@task_visit", designId: ids.taskVisit as string },
];

/** The pipeline's model-facing schemas, by the names the phases use. */
const PIPELINE_SCHEMAS: ReadonlyArray<[string, z.ZodType]> = [
	["author (appDesignContractSchema)", appDesignContractSchema],
	[
		"review (designReviewSchemaFor)",
		designReviewSchemaFor({
			contract: CONTRACT,
			pkg: fixturePackage(),
			bindings: REVIEW_BINDINGS,
		}),
	],
	["revise (designRevisionResultSchemaFor)", designRevisionResultSchemaFor([])],
];

/** Check the selected projection invariants at JSON Schema positions only. */
function strictViolations(node: unknown, path: string, out: string[]): void {
	if (Array.isArray(node)) {
		node.forEach((entry, i) => {
			strictViolations(entry, `${path}[${i}]`, out);
		});
		return;
	}
	if (typeof node !== "object" || node === null) return;
	const record = node as Record<string, unknown>;
	if ("oneOf" in record) out.push(`${path}: oneOf`);
	if ("default" in record) out.push(`${path}: default`);
	if (record.type === "object") {
		if (record.additionalProperties !== false) {
			out.push(`${path}: additionalProperties must be false`);
		}
		const props = record.properties;
		if (typeof props === "object" && props !== null) {
			const keys = Object.keys(props as object);
			const required = Array.isArray(record.required)
				? (record.required as string[])
				: [];
			for (const key of keys) {
				if (!required.includes(key)) {
					out.push(`${path}.${key}: property not required`);
				}
			}
		}
	}
	for (const key of ["properties", "$defs", "definitions"] as const) {
		const map = record[key];
		if (map !== null && typeof map === "object" && !Array.isArray(map)) {
			for (const [name, schema] of Object.entries(map)) {
				strictViolations(schema, `${path}.${key}.${name}`, out);
			}
		}
	}
	for (const key of [
		"items",
		"prefixItems",
		"additionalItems",
		"anyOf",
		"oneOf",
		"allOf",
		"not",
		"contains",
		"if",
		"then",
		"else",
	] as const) {
		if (record[key] !== undefined)
			strictViolations(record[key], `${path}.${key}`, out);
	}
}

describe("strictWireJsonSchema over the production pipeline schemas", () => {
	for (const [name, schema] of PIPELINE_SCHEMAS) {
		it(`projects ${name} with closed objects, required properties and supported union spelling`, () => {
			const projected = strictWireJsonSchema(schema);
			const violations: string[] = [];
			strictViolations(projected, "$", violations);
			expect(violations).toEqual([]);
			expect(projected.type).toBe("object");
		});
	}

	it("checks nested schema positions without interpreting annotation data as schemas", () => {
		const violations: string[] = [];
		strictViolations(
			{
				type: "object",
				additionalProperties: false,
				required: ["entry"],
				properties: {
					entry: {
						type: "array",
						items: {
							type: "object",
							properties: { title: { type: "string" } },
						},
					},
				},
				examples: [{ type: "object", oneOf: [], default: "literal" }],
			},
			"$",
			violations,
		);
		expect(violations).toEqual([
			"$.properties.entry.items: additionalProperties must be false",
			"$.properties.entry.items.title: property not required",
		]);
	});

	it("rewrites a discriminated union's oneOf to anyOf and keeps the arms", () => {
		const projected = strictWireJsonSchema(
			z.object({
				effect: z.discriminatedUnion("kind", [
					z.object({ kind: z.literal("create"), name: z.string() }),
					z.object({ kind: z.literal("update"), name: z.string() }),
					z.object({ kind: z.literal("close"), name: z.string() }),
					z.object({ kind: z.literal("link"), name: z.string() }),
				]),
			}),
		);
		const validate = new Ajv({ strict: false }).compile(projected);
		for (const kind of ["create", "update", "close", "link"]) {
			expect(validate({ effect: { kind, name: "Visit" } })).toBe(true);
		}
		for (const effect of [
			{ kind: "invented", name: "Visit" },
			{ kind: "create" },
			{ kind: "create", name: "Visit", extra: true },
		]) {
			expect(validate({ effect })).toBe(false);
		}
		const violations: string[] = [];
		strictViolations(projected, "$", violations);
		expect(violations).toEqual([]);
	});

	it("admits null for optional enum and literal slots in the emitted JSON schema", async () => {
		const schema = z.object({
			mode: z.enum(["fast", "full"]).optional(),
			enabled: z.literal(true).optional(),
		});
		const validate = new Ajv({ strict: false }).compile(
			strictWireJsonSchema(schema),
		);
		const value = { mode: null, enabled: null };
		expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
		expect(await strictStructuredSchema(schema).validate?.(value)).toEqual({
			success: true,
			value: {},
		});
	});

	it("admits null for an optional primitive union as one compact type array", async () => {
		const schema = z.object({
			value: z.union([z.string(), z.number()]).optional(),
		});
		const projected = strictWireJsonSchema(schema);
		const slot = (projected.properties as Record<string, unknown>).value;
		expect(slot).toEqual({ type: ["string", "number", "null"] });
		const validate = new Ajv({ strict: false }).compile(projected);
		for (const value of [{ value: null }, { value: "a" }, { value: 1 }]) {
			expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
		}
		expect(validate({ value: true })).toBe(false);
		expect(
			await strictStructuredSchema(schema).validate?.({ value: null }),
		).toEqual({ success: true, value: {} });
	});

	it("refuses an open-key record at local request construction", () => {
		expect(() =>
			strictWireJsonSchema(z.object({ bag: z.record(z.string(), z.number()) })),
		).toThrow(/record|dictionary/i);
	});

	it("refuses an untyped slot with its path at local request construction", () => {
		// The live validator's answer to an empty schema is a 400 ("schema
		// must have a 'type' key") — observed on the author schema's constant
		// fact value. The projection must catch it offline, path included.
		expect(() =>
			strictWireJsonSchema(z.object({ facts: z.array(z.unknown()) })),
		).toThrow(/facts\.items.*type|admits anything/i);
	});
});

describe("the validation bridge", () => {
	it("round-trips the contract fixture through parse", async () => {
		const schema = strictStructuredSchema(appDesignContractSchema);
		const result = await schema.validate?.(
			JSON.parse(JSON.stringify(CONTRACT)),
		);
		expect(result?.success).toBe(true);
	});

	it("round-trips a wire-shaped review into the persisted UUID vocabulary", async () => {
		const schema = strictStructuredSchema(
			designReviewSchemaFor({
				contract: CONTRACT,
				pkg: fixturePackage(),
				bindings: REVIEW_BINDINGS,
			}),
		);
		const result = await schema.validate?.({
			summary: "Focused review",
			findings: [
				{
					severity: "important",
					dispositionClass: "design-correction",
					claim: "The visit result is not shown after submission.",
					// Handle + raw-contract-id arms, a tag citation with the strict
					// null spelling in its optional slots, and a platform citation.
					evidenceRefs: [
						{ source: "S1", sectionPath: null, figureMarker: null },
						{ platform: "CASE_SEARCH_IS_LIVE_AND_ONLINE" },
					],
					affectedElements: ["@task_visit", ids.taskRegister],
					proposedResolution: null,
				},
			],
		});
		expect(result?.success).toBe(true);
		if (result?.success !== true) return;
		// The resolved value is exactly what the artifact store re-parses.
		const persisted = designReviewSchema.safeParse(result.value);
		expect(persisted.success).toBe(true);
		if (!persisted.success) return;
		const finding = persisted.data.findings[0];
		expect(finding?.affectedElementIds).toEqual([
			ids.taskVisit,
			ids.taskRegister,
		]);
		expect(finding?.evidenceRefs[0]).toEqual({
			kind: "message",
			threadId: "00000000-0000-4000-8000-999999999999",
			messageId: "m-1",
			partIndex: 0,
		});
		expect(finding?.evidenceRefs[1]).toMatchObject({
			kind: "platform-constraint",
			code: "CASE_SEARCH_IS_LIVE_AND_ONLINE",
		});
	});

	it("maps the strict null spelling back to absence", async () => {
		const schema = strictStructuredSchema(
			z.object({ name: z.string(), note: z.string().optional() }),
		);
		const result = await schema.validate?.({ name: "Referral", note: null });
		expect(result?.success).toBe(true);
		if (result?.success) expect(result.value).toEqual({ name: "Referral" });
	});

	it("returns the ZodError itself on a failed parse (the diagnostics carrier)", async () => {
		const schema = strictStructuredSchema(appDesignContractSchema);
		const result = await schema.validate?.({ objective: 42 });
		expect(result?.success).toBe(false);
		if (result?.success === false) {
			expect(result.error.name).toBe("ZodError");
		}
	});
});

describe("stripNullProperties", () => {
	it("removes null properties at every depth and leaves array items alone", () => {
		expect(
			stripNullProperties({
				a: null,
				b: { c: null, d: 1 },
				e: [null, { f: null, g: 2 }],
			}),
		).toEqual({ b: { d: 1 }, e: [null, { g: 2 }] });
	});
});

describe("projection soundness precondition", () => {
	it.each([
		["nullable", z.string().nullable()],
		["optional nullable", z.string().nullable().optional()],
		["explicit union", z.union([z.string(), z.null()])],
		["nested", z.object({ inner: z.string().nullable() })],
		["array member", z.array(z.string().nullable())],
		["tuple member", z.tuple([z.string(), z.null()])],
		["literal null", z.literal(null)],
	])("refuses %s before constructing a provider request", (_name, value) => {
		expect(() => strictStructuredSchema(z.object({ value }))).toThrow(
			/value.*authored null/,
		);
	});
});
