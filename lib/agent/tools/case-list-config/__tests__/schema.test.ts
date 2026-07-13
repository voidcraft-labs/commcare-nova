/**
 * Schema-compilation contract for the case-list-config SA tools.
 *
 * Nova caps tool schemas at 8 optional fields per arm — a hard ceiling
 * inherited from the strictest provider structured-output compiler,
 * kept as a portability bound. Each tool's `inputSchema` carries a
 * typed AST shape lifted from `lib/domain/predicate` +
 * `lib/domain/modules`; this test ensures
 * the compilation survives the Zod 4 → JSON Schema bridge AND stays
 * inside the per-arm ceiling on the column / search-input discriminated
 * unions.
 *
 * Three checks per tool:
 *
 *   1. `z.toJSONSchema(...)` succeeds (the Zod 4 lazy-cycle bridge can
 *      throw on malformed recursive shapes; this asserts none of the
 *      schemas regress into that state).
 *   2. The discriminated-union slot's per-arm shape carries ≤8 optional
 *      fields. Recursive AST cycles expand under nested keys via
 *      `$defs` references in JSON Schema output; we count optionals at
 *      each arm's *immediate* level (the surface a provider compiler
 *      sees) against the standing 8-optional bound every SA tool
 *      surface holds itself to — a schema-bloat guard; the wire itself
 *      imposes no hard ceiling (`scripts/test-schema.ts`).
 *   3. A representative payload `safeParse`s — round-trip smoke test
 *      that the schema is structurally usable from the SA's call site.
 *
 * The `scripts/test-schema.ts` harness covers the live-API
 * verification (it drives `generateText` against the live API and waits
 * for the response). This vitest file is the structural defense — it
 * runs in every CI pipeline without burning API credits.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { SEARCH_INPUT_TYPES } from "@/lib/domain";
import { addCaseListColumnsTool } from "../addCaseListColumns";
import { addSearchInputsTool } from "../addSearchInputs";
import { removeCaseListColumnTool } from "../removeCaseListColumn";
import { removeSearchInputTool } from "../removeSearchInput";
import { reorderCaseListColumnsTool } from "../reorderCaseListColumns";
import { reorderSearchInputsTool } from "../reorderSearchInputs";
import { setCaseListFilterTool } from "../setCaseListFilter";
import { SA_SEARCH_INPUT_TYPES } from "../shared";
import { updateCaseListColumnTool } from "../updateCaseListColumn";
import { updateSearchInputTool } from "../updateSearchInput";

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

/**
 * Walk every arm of a discriminated-union slot and assert each arm's
 * per-arm optional count stays ≤8. The arm walker hits both
 * `oneOf`-shaped (Zod 4 discriminated union) and `anyOf`-shaped
 * (legacy `z.union`) outputs; missing one of the two would silently
 * skip half the union arms. Each arm is resolved through `$ref`
 * before counting so a `lib/domain` reshape that lifts an arm into
 * `$defs` doesn't bypass the check.
 */
function assertArmOptionalCounts(
	toolName: string,
	armsContainer: ObjectJsonSchema,
	root: ObjectJsonSchema,
): void {
	const rawArms = armsContainer.oneOf ?? armsContainer.anyOf ?? [armsContainer];
	let armsChecked = 0;
	for (const rawArm of rawArms) {
		const arm = resolveArm(rawArm, root);
		if (!arm.properties) {
			throw new Error(
				`${toolName}: arm has no \`properties\` after \`$ref\` resolution — refusing to silently skip the optional-count check.`,
			);
		}
		const allKeys = Object.keys(arm.properties);
		const required = new Set(arm.required ?? []);
		const optionalCount = allKeys.filter((k) => !required.has(k)).length;
		expect(
			optionalCount,
			`${toolName}: arm with required=${[...required].join(",")} has ${optionalCount} optional fields`,
		).toBeLessThanOrEqual(8);
		armsChecked++;
	}
	/* Pin a positive lower bound on arms checked — a regression that
	 * wires the test against an `unknown`-typed slot (zero arms) would
	 * otherwise pass vacuously. */
	expect(
		armsChecked,
		`${toolName}: expected ≥1 arm to be checked`,
	).toBeGreaterThan(0);
}

/* Tools whose input schema carries a discriminated-union slot. The
 * `unionKey` names the property whose arms drive the optional-count
 * check; `arrayItems` is true for the list-add tools whose slot is an
 * array of the union (`columns` / `searchInputs`) — there the arms live
 * under the slot's `items`, not the slot itself. */
const UNION_TOOLS = [
	{
		name: "addCaseListColumns",
		tool: addCaseListColumnsTool,
		unionKey: "columns",
		arrayItems: true,
	},
	{
		name: "updateCaseListColumn",
		tool: updateCaseListColumnTool,
		unionKey: "column",
		arrayItems: false,
	},
	{
		name: "addSearchInputs",
		tool: addSearchInputsTool,
		unionKey: "searchInputs",
		arrayItems: true,
	},
	{
		name: "updateSearchInput",
		tool: updateSearchInputTool,
		unionKey: "searchInput",
		arrayItems: false,
	},
] as const;

/* Tools whose input schema is flat (no discriminated-union slot
 * carrying an SA-authored body). Schema-compile success + a
 * representative-payload smoke parse is the full structural contract
 * here. */
const FLAT_TOOLS = [
	{ name: "removeCaseListColumn", tool: removeCaseListColumnTool },
	{ name: "reorderCaseListColumns", tool: reorderCaseListColumnsTool },
	{ name: "removeSearchInput", tool: removeSearchInputTool },
	{ name: "reorderSearchInputs", tool: reorderSearchInputsTool },
	{ name: "setCaseListFilter", tool: setCaseListFilterTool },
] as const;

describe("case-list-config tool schemas — 8-optional ceiling contract", () => {
	for (const { name, tool } of [...UNION_TOOLS, ...FLAT_TOOLS]) {
		it(`${name}: \`z.toJSONSchema\` succeeds`, () => {
			const json = z.toJSONSchema(tool.inputSchema) as ObjectJsonSchema;
			expect(json.type).toBe("object");
			expect(json.properties).toBeDefined();
		});
	}

	for (const { name, tool, unionKey, arrayItems } of UNION_TOOLS) {
		it(`${name}: per-arm optional count ≤8 (8-optional ceiling)`, () => {
			const json = z.toJSONSchema(tool.inputSchema) as ObjectJsonSchema;
			const slot = json.properties?.[unionKey];
			if (!slot) {
				throw new Error(
					`expected \`${unionKey}\` to be a property on ${name}'s input schema`,
				);
			}
			// List-add tools wrap the union in an array — the discriminated-union
			// arms live under the slot's `items`. Descend before counting.
			const armsContainer = arrayItems ? slot.items : slot;
			if (!armsContainer) {
				throw new Error(
					`expected \`${unionKey}.items\` on ${name}'s array slot`,
				);
			}
			assertArmOptionalCounts(name, armsContainer, json);
		});
	}

	// ── Representative-payload smoke tests ────────────────────────────

	it("addCaseListColumns: parses a representative payload", () => {
		const result = addCaseListColumnsTool.inputSchema.safeParse({
			moduleIndex: 0,
			columns: [
				{ kind: "plain", field: "case_name", header: "Patient" },
				{ kind: "phone", field: "phone", header: "Phone" },
			],
		});
		expect(result.success).toBe(true);
	});

	it("updateCaseListColumn: parses a representative payload", () => {
		const result = updateCaseListColumnTool.inputSchema.safeParse({
			moduleIndex: 0,
			columnUuid: "11111111-1111-1111-1111-111111111111",
			column: {
				kind: "date",
				field: "dob",
				header: "DOB",
				pattern: "%Y-%m-%d",
			},
		});
		expect(result.success).toBe(true);
	});

	it("updateCaseListColumn: parses an interval column with full optional-slot coverage", () => {
		// Exercise every common optional slot (`sort`, `visibleInList`,
		// `visibleInDetail`) at once on the most slot-heavy arm — the
		// test pins that the per-arm optional count stays under the
		// 8-optional ceiling even with every common slot supplied.
		const result = updateCaseListColumnTool.inputSchema.safeParse({
			moduleIndex: 0,
			columnUuid: "11111111-1111-1111-1111-111111111111",
			column: {
				kind: "interval",
				field: "last_visit",
				header: "Last visit",
				threshold: 30,
				unit: "days",
				display: "flag",
				text: "Overdue",
				sort: { direction: "desc", priority: 0 },
				visibleInList: true,
				visibleInDetail: false,
			},
		});
		expect(result.success).toBe(true);
	});

	it("removeCaseListColumn: parses a representative payload", () => {
		const result = removeCaseListColumnTool.inputSchema.safeParse({
			moduleIndex: 0,
			columnUuid: "11111111-1111-1111-1111-111111111111",
		});
		expect(result.success).toBe(true);
	});

	it("reorderCaseListColumns: parses a representative payload", () => {
		const result = reorderCaseListColumnsTool.inputSchema.safeParse({
			moduleIndex: 0,
			columnUuids: [
				"22222222-2222-2222-2222-222222222222",
				"11111111-1111-1111-1111-111111111111",
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

	it("addSearchInputs: parses a representative simple payload", () => {
		const result = addSearchInputsTool.inputSchema.safeParse({
			moduleIndex: 0,
			searchInputs: [
				{
					kind: "simple",
					name: "patient_name_input",
					label: "Patient name",
					type: "text",
					property: "name",
				},
			],
		});
		expect(result.success).toBe(true);
	});

	it("addSearchInputs: parses a representative advanced payload", () => {
		const result = addSearchInputsTool.inputSchema.safeParse({
			moduleIndex: 0,
			searchInputs: [
				{
					kind: "advanced",
					name: "active_only",
					label: "Active only",
					type: "text",
					predicate: { kind: "match-all" },
				},
			],
		});
		expect(result.success).toBe(true);
	});

	it("rejects the `select` widget type on both arms at parse time", () => {
		// Nova's wire prompt carries no itemset slot, so a `select` prompt
		// renders as plain text at runtime — the simple arm is
		// gate-rejected (`searchInputSelectWidgetNotSupported`) and the
		// advanced arm silently degrades. The SA boundary narrows the enum
		// so neither state is expressible (this run's trap: a build
		// authored status-queue filters as `select` and burned a
		// rejection + retry step per module).
		const simple = addSearchInputsTool.inputSchema.safeParse({
			moduleIndex: 0,
			searchInputs: [
				{
					kind: "simple",
					name: "referral_status",
					label: "Status",
					type: "select",
					property: "referral_status",
				},
			],
		});
		expect(simple.success).toBe(false);
		const advanced = updateSearchInputTool.inputSchema.safeParse({
			moduleIndex: 0,
			searchInputUuid: "11111111-1111-1111-1111-111111111111",
			searchInput: {
				kind: "advanced",
				name: "active_only",
				label: "Active only",
				type: "select",
				predicate: { kind: "match-all" },
			},
		});
		expect(advanced.success).toBe(false);
	});

	it("SA widget enum tracks the domain enum minus `select`", () => {
		// Tripwire: adding a member to `SEARCH_INPUT_TYPES` must be a
		// deliberate decision at the SA boundary too — this fails until
		// `SA_SEARCH_INPUT_TYPES` names the new member (or documents its
		// exclusion beside `select`'s).
		expect([...SA_SEARCH_INPUT_TYPES]).toEqual(
			SEARCH_INPUT_TYPES.filter((t) => t !== "select"),
		);
	});

	it("updateSearchInput: parses with full simple-arm optional coverage", () => {
		const result = updateSearchInputTool.inputSchema.safeParse({
			moduleIndex: 0,
			searchInputUuid: "11111111-1111-1111-1111-111111111111",
			searchInput: {
				kind: "simple",
				name: "household_region",
				label: "Region",
				type: "text",
				property: "region",
				via: {
					kind: "ancestor",
					via: [{ identifier: "parent", throughCaseType: "household" }],
				},
				mode: { kind: "exact" },
				default: { kind: "term", term: { kind: "literal", value: "north" } },
			},
		});
		expect(result.success).toBe(true);
	});

	it("removeSearchInput: parses a representative payload", () => {
		const result = removeSearchInputTool.inputSchema.safeParse({
			moduleIndex: 0,
			searchInputUuid: "11111111-1111-1111-1111-111111111111",
		});
		expect(result.success).toBe(true);
	});

	it("reorderSearchInputs: parses a representative payload", () => {
		const result = reorderSearchInputsTool.inputSchema.safeParse({
			moduleIndex: 0,
			searchInputUuids: [
				"22222222-2222-2222-2222-222222222222",
				"11111111-1111-1111-1111-111111111111",
			],
		});
		expect(result.success).toBe(true);
	});
});
