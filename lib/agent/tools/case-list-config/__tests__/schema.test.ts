/**
 * Schema-compilation contract for the case-list-config SA tools.
 *
 * The Anthropic structured-output compiler imposes a hard ceiling of 8
 * `.optional()` fields per array item (per root CLAUDE.md "Structured
 * output constraint"). Each tool's `inputSchema` carries a typed AST
 * shape lifted from `lib/domain/predicate` + `lib/domain/modules`; this
 * test ensures the compilation survives the Zod 4 → JSON Schema bridge
 * AND stays inside the per-array-item ceiling.
 *
 * Three checks per tool:
 *
 *   1. `z.toJSONSchema(...)` succeeds (the Zod 4 lazy-cycle bridge can
 *      throw on malformed recursive shapes; this asserts none of the
 *      schemas regress into that state).
 *   2. The top-level array slot's per-item shape carries ≤8 optional
 *      fields. Recursive AST cycles expand under nested keys via
 *      `$defs` references in JSON Schema output; we count optionals at
 *      the array's *immediate* item level (the surface the Anthropic
 *      compiler sees) per `lib/agent/__tests__/toolSchemaGenerator.test.ts`'s
 *      "8-optional ceiling" precedent.
 *   3. A representative payload `safeParse`s — round-trip smoke test
 *      that the schema is structurally usable from the SA's call site.
 *
 * The `scripts/test-schema.ts` harness covers the live-API
 * verification (it drives `generateText` against Anthropic and waits
 * for the response). This vitest file is the structural defense — it
 * runs in every CI pipeline without burning API credits.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { setCalculatedColumnsTool } from "../setCalculatedColumns";
import { setCaseListColumnsTool } from "../setCaseListColumns";
import { setCaseListFilterTool } from "../setCaseListFilter";
import { setCaseListSearchInputsTool } from "../setCaseListSearchInputs";
import { setCaseListSortTool } from "../setCaseListSort";

/* JSON Schema shape this test introspects. Both `properties` and
 * `required` are present on object-shaped schemas; the `items` slot
 * carries the per-item shape on array slots. The cast is explicit so
 * each property access is typed. */
interface ObjectJsonSchema {
	type?: string;
	properties?: Record<string, ObjectJsonSchema>;
	required?: readonly string[];
	items?: ObjectJsonSchema;
	$ref?: string;
	anyOf?: readonly ObjectJsonSchema[];
}

const TOOLS = [
	{
		name: "setCaseListColumns",
		tool: setCaseListColumnsTool,
		arrayKey: "columns",
	},
	{ name: "setCaseListSort", tool: setCaseListSortTool, arrayKey: "sort" },
	{
		name: "setCalculatedColumns",
		tool: setCalculatedColumnsTool,
		arrayKey: "calculatedColumns",
	},
	{
		name: "setCaseListSearchInputs",
		tool: setCaseListSearchInputsTool,
		arrayKey: "searchInputs",
	},
] as const;

describe("case-list-config tool schemas — Anthropic compiler contract", () => {
	for (const { name, tool } of TOOLS) {
		it(`${name}: \`z.toJSONSchema\` succeeds`, () => {
			const json = z.toJSONSchema(tool.inputSchema) as ObjectJsonSchema;
			expect(json.type).toBe("object");
			expect(json.properties).toBeDefined();
		});
	}

	it("setCaseListFilter: `z.toJSONSchema` succeeds", () => {
		// Filter accepts a `predicateSchema.nullable()` shape — verifies
		// the recursive Predicate cycle survives JSON Schema lowering.
		const json = z.toJSONSchema(
			setCaseListFilterTool.inputSchema,
		) as ObjectJsonSchema;
		expect(json.type).toBe("object");
		expect(json.properties).toBeDefined();
	});

	for (const { name, tool, arrayKey } of TOOLS) {
		it(`${name}: per-item optional count ≤8 (Anthropic compiler ceiling)`, () => {
			const json = z.toJSONSchema(tool.inputSchema) as ObjectJsonSchema;
			const arrayProp = json.properties?.[arrayKey];
			if (!arrayProp) {
				throw new Error(
					`expected \`${arrayKey}\` to be the array slot on ${name}`,
				);
			}
			/* The array's `items` slot is the per-item schema. For
			 * discriminated unions (the Column shape), Zod lowers each arm
			 * to an `anyOf` entry; the per-arm optional count is what the
			 * compiler sees, so we count optionals across every arm and
			 * assert each stays under the ceiling. For plain object
			 * shapes (`SortKey`, `CalculatedColumn`, `SearchInputDef`),
			 * we count directly on the item shape. */
			const items = arrayProp.items;
			if (!items) {
				throw new Error(
					`expected \`${arrayKey}.items\` to be defined on ${name}`,
				);
			}
			const arms = items.anyOf ?? [items];
			for (const arm of arms) {
				if (!arm.properties) continue;
				const allKeys = Object.keys(arm.properties);
				const required = new Set(arm.required ?? []);
				const optionalCount = allKeys.filter((k) => !required.has(k)).length;
				expect(
					optionalCount,
					`${name}: arm with required=${[...required].join(",")} has ${optionalCount} optional fields`,
				).toBeLessThanOrEqual(8);
			}
		});
	}

	// ── Representative-payload smoke tests ────────────────────────────

	it("setCaseListColumns: parses a representative payload", () => {
		const result = setCaseListColumnsTool.inputSchema.safeParse({
			moduleIndex: 0,
			columns: [
				{ kind: "plain", field: "case_name", header: "Patient" },
				{ kind: "phone", field: "phone", header: "Phone" },
				{
					kind: "date",
					field: "dob",
					header: "DOB",
					pattern: "%Y-%m-%d",
				},
			],
		});
		expect(result.success).toBe(true);
	});

	it("setCaseListSort: parses a representative payload", () => {
		const result = setCaseListSortTool.inputSchema.safeParse({
			moduleIndex: 0,
			sort: [
				{
					source: { kind: "property", property: "case_name" },
					type: "plain",
					direction: "asc",
				},
			],
		});
		expect(result.success).toBe(true);
	});

	it("setCaseListFilter: parses a representative payload (predicate set)", () => {
		const result = setCaseListFilterTool.inputSchema.safeParse({
			moduleIndex: 0,
			filter: {
				kind: "eq",
				left: {
					kind: "term",
					term: { kind: "prop", caseType: "patient", property: "status" },
				},
				right: { kind: "term", term: { kind: "literal", value: "active" } },
			},
		});
		expect(result.success).toBe(true);
	});

	it("setCaseListFilter: parses null (clear)", () => {
		const result = setCaseListFilterTool.inputSchema.safeParse({
			moduleIndex: 0,
			filter: null,
		});
		expect(result.success).toBe(true);
	});

	it("setCalculatedColumns: parses a representative payload", () => {
		const result = setCalculatedColumnsTool.inputSchema.safeParse({
			moduleIndex: 0,
			calculatedColumns: [
				{
					id: "today_str",
					header: "Today",
					expression: { kind: "today" },
				},
			],
		});
		expect(result.success).toBe(true);
	});

	it("setCaseListSearchInputs: parses a representative payload", () => {
		const result = setCaseListSearchInputsTool.inputSchema.safeParse({
			moduleIndex: 0,
			searchInputs: [
				{
					name: "patient_name_input",
					label: "Patient name",
					type: "text",
					property: "name",
				},
			],
		});
		expect(result.success).toBe(true);
	});

	it("setCaseListSearchInputs: parses with full optional-slot coverage", () => {
		// Exercise every optional slot at once to validate the recursive
		// AST cycles (RelationPath, SearchInputMode, ValueExpression,
		// Predicate) all round-trip through the schema.
		const result = setCaseListSearchInputsTool.inputSchema.safeParse({
			moduleIndex: 0,
			searchInputs: [
				{
					name: "household_region",
					label: "Region",
					type: "select",
					property: "region",
					via: {
						kind: "ancestor",
						via: [{ identifier: "parent", throughCaseType: "household" }],
					},
					mode: { kind: "exact" },
					default: { kind: "term", term: { kind: "literal", value: "north" } },
					xpath: { kind: "match-all" },
				},
			],
		});
		expect(result.success).toBe(true);
	});
});
