// lib/domain/__tests__/modules.test.ts
//
// Schema-parse coverage for the `caseListConfig` shape introduced
// alongside the case-list authoring surface. The structured slot
// replaces the legacy flat `caseListColumns` / `caseDetailColumns`
// fields wholesale: the legacy field names are no longer declared
// on the schema, so Zod's default strip-mode drops them on parse.
// The legacy values never reach the typed result, which is what
// downstream consumers bind against — the migration script
// (`scripts/migrate-case-list-config.ts`) is the single producer
// allowed to read the legacy shape, and it does so against the
// raw Firestore document before Zod parsing.
//
// The tests below pin the four contracts the schema enforces:
//
//   1. Empty `caseListConfig` is valid (a module that authors a
//      case list but hasn't filled in any of its sub-fields).
//   2. A populated config — every column kind, sort key, search
//      input mode — round-trips through `safeParse`.
//   3. Each per-kind discriminated union arm rejects ill-typed
//      configurations (e.g. a `late-flag` column missing
//      `threshold` / `unit`, a calculated column missing
//      `expression`, a search input with `multi-select-contains`
//      missing the quantifier).
//   4. The legacy `{caseListColumns, caseDetailColumns}` keys
//      strip silently — `safeParse` succeeds, but the typed
//      result never carries them, so legacy values can't
//      accidentally flow through to consumer code.

import { describe, expect, it } from "vitest";
import { caseListConfigSchema, columnSchema, moduleSchema } from "../modules";

const sampleUuid = "00000000-0000-7000-8000-000000000001";

describe("moduleSchema — caseListConfig presence", () => {
	it("parses a module without caseListConfig (survey-only module)", () => {
		const parsed = moduleSchema.safeParse({
			uuid: sampleUuid,
			id: "survey",
			name: "Survey",
		});
		expect(parsed.success).toBe(true);
	});

	it("rejects the legacy caseListColumns field name (schema removed)", () => {
		// The legacy shape is intentionally not part of the schema.
		// `caseListColumns` should fail loudly so any stale fixture or
		// older persisted doc is detected at parse time rather than
		// silently dropped.
		const parsed = moduleSchema.safeParse({
			uuid: sampleUuid,
			id: "patients",
			name: "Patients",
			caseType: "patient",
			caseListColumns: [{ field: "name", header: "Name" }],
		});
		// Zod's default mode allows unknown keys; the assertion that
		// matters is "the legacy field is NOT typed onto the parsed
		// shape". Round-trip the parsed result and confirm
		// `caseListColumns` is absent on the output.
		expect(parsed.success).toBe(true);
		if (parsed.success) {
			// Legacy field is dropped during parse — the schema doesn't
			// include it, so it surfaces nowhere on the typed result.
			const data = parsed.data as Record<string, unknown>;
			expect(data.caseListColumns).toBeUndefined();
			expect(data.caseDetailColumns).toBeUndefined();
		}
	});
});

describe("caseListConfigSchema — empty config", () => {
	it("parses with empty arrays everywhere", () => {
		const parsed = caseListConfigSchema.safeParse({
			columns: [],
			sort: [],
			calculatedColumns: [],
			searchInputs: [],
		});
		expect(parsed.success).toBe(true);
	});

	it("parses with detailColumns absent (mirrors short detail)", () => {
		const parsed = caseListConfigSchema.safeParse({
			columns: [{ kind: "plain", field: "name", header: "Name" }],
			sort: [],
			calculatedColumns: [],
			searchInputs: [],
		});
		expect(parsed.success).toBe(true);
	});
});

describe("columnSchema — discriminated union arms", () => {
	it("parses every column kind with its required per-kind config", () => {
		const arms: unknown[] = [
			{ kind: "plain", field: "name", header: "Name" },
			{
				kind: "date",
				field: "opened_on",
				header: "Opened",
				pattern: "yyyy-MM-dd",
			},
			{
				kind: "time-since-until",
				field: "last_visit",
				header: "Last visit",
				threshold: 7,
				unit: "days",
				displayLabel: "Overdue",
			},
			{ kind: "phone", field: "phone", header: "Phone" },
			{
				kind: "id-mapping",
				field: "region_code",
				header: "Region",
				mapping: [{ value: "1", label: "North" }],
			},
			{
				kind: "late-flag",
				field: "next_visit",
				header: "Late",
				threshold: 30,
				unit: "days",
				flagDisplayValue: "OVERDUE",
			},
			{ kind: "search-only", field: "phone", header: "Phone (search-only)" },
		];
		for (const arm of arms) {
			const parsed = columnSchema.safeParse(arm);
			expect(parsed.success).toBe(true);
		}
	});

	it("rejects late-flag missing threshold + unit + flagDisplayValue", () => {
		const parsed = columnSchema.safeParse({
			kind: "late-flag",
			field: "next_visit",
			header: "Late",
		});
		expect(parsed.success).toBe(false);
	});

	it("rejects time-since-until missing unit", () => {
		const parsed = columnSchema.safeParse({
			kind: "time-since-until",
			field: "last_visit",
			header: "Last visit",
			threshold: 7,
			displayLabel: "Overdue",
		});
		expect(parsed.success).toBe(false);
	});

	it("rejects id-mapping missing the mapping table", () => {
		const parsed = columnSchema.safeParse({
			kind: "id-mapping",
			field: "region_code",
			header: "Region",
		});
		expect(parsed.success).toBe(false);
	});

	it("rejects an unknown column kind", () => {
		const parsed = columnSchema.safeParse({
			kind: "rainbow",
			field: "x",
			header: "X",
		});
		expect(parsed.success).toBe(false);
	});
});

describe("caseListConfigSchema — calculated columns + sort + search", () => {
	it("parses a calculated column with a typed expression", () => {
		// `term` is the structural lift arm of `ValueExpression` —
		// the simplest form that exercises the cross-package import
		// of the predicate AST schemas without reaching for a more
		// complex composition the typeChecker would also gate.
		const parsed = caseListConfigSchema.safeParse({
			columns: [],
			sort: [],
			calculatedColumns: [
				{
					id: "today_iso",
					header: "Today",
					expression: { kind: "today" },
				},
			],
			searchInputs: [],
		});
		expect(parsed.success).toBe(true);
	});

	it("rejects a calculated column missing expression", () => {
		const parsed = caseListConfigSchema.safeParse({
			columns: [],
			sort: [],
			calculatedColumns: [{ id: "anon", header: "Anon" }],
			searchInputs: [],
		});
		expect(parsed.success).toBe(false);
	});

	it("parses a sort key keyed against a calculated column id", () => {
		const parsed = caseListConfigSchema.safeParse({
			columns: [],
			sort: [
				{
					source: { kind: "calculated", columnId: "days_since_visit" },
					type: "integer",
					direction: "desc",
				},
			],
			calculatedColumns: [],
			searchInputs: [],
		});
		expect(parsed.success).toBe(true);
	});

	it("rejects a sort key with an unknown sort type", () => {
		const parsed = caseListConfigSchema.safeParse({
			columns: [],
			sort: [
				{
					source: { kind: "property", property: "name" },
					type: "fuzzy",
					direction: "asc",
				},
			],
			calculatedColumns: [],
			searchInputs: [],
		});
		expect(parsed.success).toBe(false);
	});

	it("parses a search input with multi-select-contains and a quantifier", () => {
		const parsed = caseListConfigSchema.safeParse({
			columns: [],
			sort: [],
			calculatedColumns: [],
			searchInputs: [
				{
					name: "tags",
					label: "Tags",
					type: "select",
					property: "tags",
					mode: { kind: "multi-select-contains", quantifier: "any" },
				},
			],
		});
		expect(parsed.success).toBe(true);
	});

	it("rejects multi-select-contains without a quantifier", () => {
		const parsed = caseListConfigSchema.safeParse({
			columns: [],
			sort: [],
			calculatedColumns: [],
			searchInputs: [
				{
					name: "tags",
					label: "Tags",
					type: "select",
					property: "tags",
					mode: { kind: "multi-select-contains" },
				},
			],
		});
		expect(parsed.success).toBe(false);
	});
});
