/**
 * The strict wire projection — proven against the PRODUCTION design
 * schemas, not toys:
 *
 *  1. every schema the pipeline sends projects into OpenAI's documented
 *     strict subset (no `oneOf`, every property required, boolean
 *     `additionalProperties: false` on every object, no `default`) — the
 *     class that 400'd the author call live can only come back by failing
 *     this suite first;
 *  2. the validation bridge round-trips each schema's real fixture, with
 *     the strict null spelling (`null` in formerly-optional slots) mapped
 *     back to the absence the Zod schemas expect;
 *  3. the projection's soundness precondition holds: no model-facing
 *     design schema uses `.nullable()`, so a `null` can only ever mean
 *     "the wire made me say something".
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
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

/** Walk one projected schema and collect every strict-subset violation. */
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
	for (const [key, value] of Object.entries(record)) {
		strictViolations(value, `${path}.${key}`, out);
	}
}

describe("strictWireJsonSchema over the production pipeline schemas", () => {
	for (const [name, schema] of PIPELINE_SCHEMAS) {
		it(`projects ${name} into the strict subset`, () => {
			const projected = strictWireJsonSchema(schema);
			const violations: string[] = [];
			strictViolations(projected, "$", violations);
			expect(violations).toEqual([]);
			expect(projected.type).toBe("object");
		});
	}

	it("rewrites a discriminated union's oneOf to anyOf and keeps the arms", () => {
		const { z } = require("zod") as typeof import("zod");
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
		const text = JSON.stringify(projected);
		expect(text).not.toContain('"oneOf"');
		expect(text).toContain('"anyOf"');
		// The workflow effect union survives projection.
		for (const kind of ["create", "update", "close", "link"]) {
			expect(text).toContain(`"${kind}"`);
		}
	});

	it("throws on a record-shaped schema instead of emitting one strict rejects", () => {
		const { z } = require("zod") as typeof import("zod");
		expect(() =>
			strictWireJsonSchema(z.object({ bag: z.record(z.string(), z.number()) })),
		).toThrow(/record|dictionary/i);
	});

	it("throws on an untyped slot (z.unknown) instead of emitting one strict rejects", () => {
		// The live validator's answer to an empty schema is a 400 ("schema
		// must have a 'type' key") — observed on the author schema's constant
		// fact value. The projection must catch it offline, path included.
		const { z } = require("zod") as typeof import("zod");
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
					category: "workflow-gap",
					severity: "important",
					basis: "source-supported",
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
		const { z } = require("zod") as typeof import("zod");
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
	it("no model-facing design schema uses .nullable()", () => {
		for (const file of [
			"lib/agent/design/contract.ts",
			"lib/agent/design/evidence.ts",
			"lib/agent/design/review.ts",
			"lib/agent/design/reviewerSchema.ts",
			"lib/agent/design/buildPlan.ts",
		]) {
			expect(
				readFileSync(file, "utf8").includes(".nullable("),
				`${file} uses .nullable(), which breaks the strict bridge's null-strip: null would be a real value there, and the bridge deletes it. Restructure the slot or teach the bridge that path first.`,
			).toBe(false);
		}
	});
});
