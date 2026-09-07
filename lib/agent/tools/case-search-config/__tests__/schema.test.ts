/** Actual input requirements and global-expression refinements. Independent
 * AJV validation covers emitted required/null shapes; no guessed provider
 * optional-count limit or live API acceptance is claimed. */
import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { testUuid } from "@/__tests__/helpers/uuid";
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

const MODULE_UUID = testUuid("case-search-schema-module");

describe("case-search-config author schema boundaries", () => {
	it.each([
		[
			"advanced",
			setCaseSearchAdvancedTool.inputSchema,
			{ moduleUuid: MODULE_UUID, excludedOwnerIds: null, searchFirst: null },
		],
		[
			"display",
			setCaseSearchDisplayTool.inputSchema,
			{
				moduleUuid: MODULE_UUID,
				searchScreenTitle: null,
				searchScreenSubtitle: null,
				searchButtonLabel: null,
				searchButtonDisplayCondition: null,
			},
		],
	])(
		"%s requires explicit choices for every cluster slot in both Zod and emitted JSON Schema",
		(_name, schema, input) => {
			const json = z.toJSONSchema(schema, { target: "draft-7", io: "input" });
			const validate = new Ajv({
				strict: false,
				validateFormats: false,
			}).compile(json);
			expect(schema.safeParse(input).success).toBe(true);
			expect(validate(input)).toBe(true);
			for (const key of Object.keys(input)) {
				const omitted = { ...input };
				Reflect.deleteProperty(omitted, key);
				expect(schema.safeParse(omitted).success, `missing ${key}`).toBe(false);
				expect(validate(omitted), `missing ${key}`).toBe(false);
			}
		},
	);

	// ── Representative-payload smoke tests ────────────────────────────

	it("setCaseSearchAdvanced: parses a representative payload (slot supplied)", () => {
		const result = setCaseSearchAdvancedTool.inputSchema.safeParse({
			moduleUuid: MODULE_UUID,
			excludedOwnerIds: {
				kind: "term",
				term: { kind: "literal", value: "owner-a owner-b" },
			},
			searchFirst: true,
		});
		expect(result.success).toBe(true);
	});

	it("setCaseSearchAdvanced: parses with the slots cleared via null", () => {
		const result = setCaseSearchAdvancedTool.inputSchema.safeParse({
			moduleUuid: MODULE_UUID,
			excludedOwnerIds: null,
			searchFirst: null,
		});
		expect(result.success).toBe(true);
	});

	it("setCaseSearchAdvanced: searchFirst admits only true or null", () => {
		const result = setCaseSearchAdvancedTool.inputSchema.safeParse({
			moduleUuid: MODULE_UUID,
			excludedOwnerIds: null,
			searchFirst: false,
		});
		expect(result.success).toBe(false);
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
	])(
		"setCaseSearchAdvanced: rejects a $name read before tool execution",
		({ expression }) => {
			const result = setCaseSearchAdvancedTool.inputSchema.safeParse({
				moduleUuid: MODULE_UUID,
				excludedOwnerIds: expression,
				searchFirst: null,
			});
			expect(result.success).toBe(false);
			if (result.success) return;
			expect(result.error.issues[0]?.message).toContain(
				"before a case is selected",
			);
		},
	);

	it("setCaseSearchAdvanced: accepts pure calculations over session and Search values", () => {
		const result = setCaseSearchAdvancedTool.inputSchema.safeParse({
			moduleUuid: MODULE_UUID,
			excludedOwnerIds: concat(
				term(sessionContext("userid")),
				term(literal(" ")),
				term(input(testUuid("owner_ids"))),
			),
			searchFirst: null,
		});
		expect(result.success).toBe(true);
	});

	it("setCaseSearchDisplay: parses a representative payload (every slot supplied)", () => {
		const result = setCaseSearchDisplayTool.inputSchema.safeParse({
			moduleUuid: MODULE_UUID,
			searchScreenTitle: "Find a patient",
			searchScreenSubtitle: "Type to filter",
			searchButtonLabel: "Search",
			searchButtonDisplayCondition: { kind: "match-all" },
		});
		expect(result.success).toBe(true);
	});

	it("setCaseSearchDisplay: parses with every slot cleared via null", () => {
		const result = setCaseSearchDisplayTool.inputSchema.safeParse({
			moduleUuid: MODULE_UUID,
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
			moduleUuid: MODULE_UUID,
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
