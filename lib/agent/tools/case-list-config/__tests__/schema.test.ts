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
 * carries the per-item shape on array slots. The `$defs` map carries
 * shared `$ref` targets emitted for recursive AST cycles (Predicate /
 * ValueExpression). The cast is explicit so each property access is
 * typed. */
interface ObjectJsonSchema {
	type?: string;
	properties?: Record<string, ObjectJsonSchema>;
	required?: readonly string[];
	items?: ObjectJsonSchema;
	$ref?: string;
	$defs?: Record<string, ObjectJsonSchema>;
	/* Zod 4 lowers `z.discriminatedUnion(...)` to `oneOf`. The
	 * legacy `z.union(...)` lowers to `anyOf`. Both arms must be
	 * checked when counting per-item optionals — missing one of
	 * the two would silently skip half the union shapes. */
	oneOf?: readonly ObjectJsonSchema[];
	anyOf?: readonly ObjectJsonSchema[];
}

const DEFS_REF_PREFIX = "#/$defs/";

/**
 * Resolve a single arm of a JSON Schema item shape to its concrete
 * object shape. JSON Schema `$ref` strings encode references as
 * `#/$defs/<name>` against the document root's `$defs` map; this
 * helper follows one hop. Arms without `$ref` are returned as-is.
 *
 * Internally used by the per-item optional-count check below — the
 * cycle-bearing schemas (`searchInputDefSchema`'s `via` / `default`
 * / `xpath` slots) lower to `$ref`-bearing shapes that point into
 * `$defs`, but the per-arm count we care about is the top-level
 * item which is concrete. The helper keeps the test future-proof
 * against a future reshape that lifts the item arm into `$defs`
 * itself.
 */
function resolveArm(
	arm: ObjectJsonSchema,
	root: ObjectJsonSchema,
): ObjectJsonSchema {
	if (arm.$ref === undefined) return arm;
	if (!arm.$ref.startsWith(DEFS_REF_PREFIX)) return arm;
	const name = arm.$ref.slice(DEFS_REF_PREFIX.length);
	const target = root.$defs?.[name];
	return target ?? arm;
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
			/* The array's `items` slot is the per-item schema. Three
			 * shapes the compiler can produce:
			 *
			 *   - Discriminated union (`z.discriminatedUnion`) lowers
			 *     to `oneOf` — every Column / SortKeySource arm is its
			 *     own object shape; we count optionals on each arm.
			 *   - Generic union (`z.union`) lowers to `anyOf` — same
			 *     per-arm counting rule; included for forward-
			 *     compatibility with future tools.
			 *   - Plain object (`z.object`) — single shape; counted
			 *     directly.
			 *
			 * Resolving each arm through `resolveArm` follows a single
			 * `$ref` hop into `$defs`; future reshapes that lift the
			 * item arm into `$defs` won't silently bypass the check.
			 * Arms with no resolvable `properties` after that hop fail
			 * the test loudly — the test must SEE every arm to trust
			 * the ceiling, never silently skip. */
			const items = arrayProp.items;
			if (!items) {
				throw new Error(
					`expected \`${arrayKey}.items\` to be defined on ${name}`,
				);
			}
			const rawArms = items.oneOf ?? items.anyOf ?? [items];
			let armsChecked = 0;
			for (const rawArm of rawArms) {
				const arm = resolveArm(rawArm, json);
				if (!arm.properties) {
					throw new Error(
						`${name}: per-item arm has no \`properties\` after \`$ref\` resolution — refusing to silently skip the optional-count check.`,
					);
				}
				const allKeys = Object.keys(arm.properties);
				const required = new Set(arm.required ?? []);
				const optionalCount = allKeys.filter((k) => !required.has(k)).length;
				expect(
					optionalCount,
					`${name}: arm with required=${[...required].join(",")} has ${optionalCount} optional fields`,
				).toBeLessThanOrEqual(8);
				armsChecked++;
			}
			/* Pin a positive lower bound on arms checked — a
			 * regression that wires the test against an `items` shape
			 * with zero arms (e.g. an `unknown`-typed item) would
			 * otherwise pass vacuously. */
			expect(
				armsChecked,
				`${name}: expected ≥1 arm to be checked`,
			).toBeGreaterThan(0);
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
