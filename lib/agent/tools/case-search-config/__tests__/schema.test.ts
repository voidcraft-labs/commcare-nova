/**
 * Schema-compilation contract for the case-search-config SA tools.
 *
 * Two structural defenses on every CI pipeline run:
 *
 *   1. `z.toJSONSchema(...)` succeeds (the Zod 4 lazy-cycle bridge can
 *      throw on malformed recursive shapes; this asserts neither
 *      schema regresses into that state).
 *   2. The flat input shape's optional-field count stays ≤8. Both
 *      tools use the wholesale-with-`null`-clears pattern (every
 *      cluster slot is `*.nullable()` rather than `.optional()`),
 *      so the optional count is structurally zero — the test pins
 *      that invariant against an accidental `.optional()` flip
 *      that would push the schema past the
 *      8-optional ceiling.
 *
 * Plus representative-payload smoke parses for each tool's happy and
 * cleared-everything paths.
 *
 * The `scripts/test-schema.ts` harness covers the live-API
 * verification (it drives `generateText` against the live API and waits
 * for the response). This vitest file is the structural defense — it
 * runs in every CI pipeline without burning API credits.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	concat,
	count,
	input,
	literal,
	prop,
	sessionContext,
	term,
} from "@/lib/domain/predicate";
import { setCaseSearchAdvancedTool } from "../setCaseSearchAdvanced";
import { setCaseSearchDisplayTool } from "../setCaseSearchDisplay";

/* JSON Schema shape this test introspects. `properties` and
 * `required` are present on object-shaped schemas; the cast keeps the
 * test typed against the relevant fields without pulling in a JSON
 * Schema type from the AI SDK. */
interface ObjectJsonSchema {
	type?: string;
	properties?: Record<string, ObjectJsonSchema>;
	required?: readonly string[];
}

/**
 * Both case-search-config tools use a flat input schema (no
 * discriminated-union slot). The 8-optional ceiling check therefore
 * runs against the top-level shape directly — count properties not in
 * `required` and assert ≤8. Because we adopted the
 * required-and-nullable pattern for every cluster slot, the count is
 * structurally zero on both tools.
 */
function countTopLevelOptionals(schema: ObjectJsonSchema): number {
	if (!schema.properties) {
		throw new Error("expected JSON Schema with `properties`");
	}
	const required = new Set(schema.required ?? []);
	return Object.keys(schema.properties).filter((k) => !required.has(k)).length;
}

const TOOLS = [
	{ name: "setCaseSearchAdvanced", tool: setCaseSearchAdvancedTool },
	{ name: "setCaseSearchDisplay", tool: setCaseSearchDisplayTool },
] as const;

describe("case-search-config tool schemas — 8-optional ceiling contract", () => {
	for (const { name, tool } of TOOLS) {
		it(`${name}: \`z.toJSONSchema\` succeeds`, () => {
			const json = z.toJSONSchema(tool.inputSchema) as ObjectJsonSchema;
			expect(json.type).toBe("object");
			expect(json.properties).toBeDefined();
		});

		it(`${name}: top-level optional count ≤8 (8-optional ceiling)`, () => {
			const json = z.toJSONSchema(tool.inputSchema) as ObjectJsonSchema;
			const optionalCount = countTopLevelOptionals(json);
			expect(
				optionalCount,
				`${name}: top-level shape has ${optionalCount} optional fields`,
			).toBeLessThanOrEqual(8);
		});
	}

	// ── Representative-payload smoke tests ────────────────────────────

	it("setCaseSearchAdvanced: parses a representative payload (slot supplied)", () => {
		const result = setCaseSearchAdvancedTool.inputSchema.safeParse({
			moduleIndex: 0,
			excludedOwnerIds: {
				kind: "term",
				term: { kind: "literal", value: "owner-a owner-b" },
			},
		});
		expect(result.success).toBe(true);
	});

	it("setCaseSearchAdvanced: parses with the slot cleared via null", () => {
		const result = setCaseSearchAdvancedTool.inputSchema.safeParse({
			moduleIndex: 0,
			excludedOwnerIds: null,
		});
		expect(result.success).toBe(true);
	});

	it.each([
		{
			name: "case property",
			expression: term(prop("patient", "owner_id")),
		},
		{
			name: "relationship count",
			expression: count({
				kind: "subcase" as const,
				identifier: "parent",
				ofCaseType: "visit",
			}),
		},
	])("setCaseSearchAdvanced: rejects a $name read before tool execution", ({
		expression,
	}) => {
		const result = setCaseSearchAdvancedTool.inputSchema.safeParse({
			moduleIndex: 0,
			excludedOwnerIds: expression,
		});
		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.issues[0]?.message).toContain(
			"before a case is selected",
		);
	});

	it("setCaseSearchAdvanced: accepts pure calculations over session and Search values", () => {
		const result = setCaseSearchAdvancedTool.inputSchema.safeParse({
			moduleIndex: 0,
			excludedOwnerIds: concat(
				term(sessionContext("userid")),
				term(literal(" ")),
				term(input("owner_ids")),
			),
		});
		expect(result.success).toBe(true);
	});

	it("setCaseSearchDisplay: parses a representative payload (every slot supplied)", () => {
		const result = setCaseSearchDisplayTool.inputSchema.safeParse({
			moduleIndex: 0,
			searchScreenTitle: "Find a patient",
			searchScreenSubtitle: "Type to filter",
			searchButtonLabel: "Search",
			searchButtonDisplayCondition: { kind: "match-all" },
		});
		expect(result.success).toBe(true);
	});

	it("setCaseSearchDisplay: parses with every slot cleared via null", () => {
		const result = setCaseSearchDisplayTool.inputSchema.safeParse({
			moduleIndex: 0,
			searchScreenTitle: null,
			searchScreenSubtitle: null,
			searchButtonLabel: null,
			searchButtonDisplayCondition: null,
		});
		expect(result.success).toBe(true);
	});

	it("setCaseSearchDisplay: rejects unknown slot names (strict input boundary)", () => {
		// The body shape is `.strict()` — slot names outside the
		// declared cluster parse-fail rather than land as silent
		// extras. Pins the regression class for stale or invented slot
		// names handed by the SA.
		const result = setCaseSearchDisplayTool.inputSchema.safeParse({
			moduleIndex: 0,
			searchScreenTitle: null,
			searchScreenSubtitle: null,
			searchButtonLabel: null,
			searchButtonDisplayCondition: null,
			unknownSlotA: "stray",
			unknownSlotB: "stray",
		});
		expect(result.success).toBe(false);
	});
});
