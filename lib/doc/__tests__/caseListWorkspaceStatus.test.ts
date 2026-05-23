// lib/doc/__tests__/caseListWorkspaceStatus.test.ts
//
// State-model coverage for the case-list workspace's section-header
// derivations and empty-state seed builders. Every assertion targets
// a pure function against primitive inputs — no React mount, no DOM
// query. The workspace's UI is a deterministic projection of the
// strings these builders return; testing the strings IS testing the
// section-header copy.

import { describe, expect, it } from "vitest";
import {
	appendPlainColumnSeed,
	appendSearchInputSeed,
	buildDisplayStatus,
	buildFilterStatus,
	buildSearchStatus,
	countConditions,
	describeSortedColumn,
	seedMatchAllFilter,
} from "@/lib/doc/caseListWorkspaceStatus";
import { asUuid } from "@/lib/doc/types";
import {
	type CaseListConfig,
	type Column,
	calculatedColumn,
	plainColumn,
	simpleSearchInputDef,
} from "@/lib/domain";
import {
	and,
	eq,
	isBlank,
	literal,
	matchAll,
	matchNone,
	or,
	prop,
	term,
} from "@/lib/domain/predicate";

const COL_NAME = asUuid("00000000-0000-0000-0000-000000000201");
const COL_AGE = asUuid("00000000-0000-0000-0000-000000000202");
const COL_DOB = asUuid("00000000-0000-0000-0000-000000000203");
const COL_CALC = asUuid("00000000-0000-0000-0000-000000000204");
const INPUT_A = asUuid("00000000-0000-0000-0000-000000000301");
const INPUT_B = asUuid("00000000-0000-0000-0000-000000000302");

// ── Display status ────────────────────────────────────────────────

describe("buildDisplayStatus", () => {
	it("returns the empty-state copy when no columns are configured", () => {
		const status = buildDisplayStatus({
			columnCount: 0,
			sortedColumnCount: 0,
			firstSortedColumn: undefined,
		});
		expect(status).toMatch(/^No columns yet/i);
	});

	it("renders the singular form for one column", () => {
		const col = plainColumn(COL_NAME, "name", "Name");
		const status = buildDisplayStatus({
			columnCount: 1,
			sortedColumnCount: 0,
			firstSortedColumn: undefined,
		});
		expect(status).toContain("1 column");
		expect(status).toContain("no sort");
		// Type guard against the unused-import bias on the fixture column.
		expect(col.kind).toBe("plain");
	});

	it("renders the plural form for many columns + no sort", () => {
		const status = buildDisplayStatus({
			columnCount: 3,
			sortedColumnCount: 0,
			firstSortedColumn: undefined,
		});
		expect(status).toBe("3 columns · no sort");
	});

	it("renders column count + primary sort summary when a sort is set", () => {
		const sortedDob = plainColumn(COL_DOB, "dob", "DOB", {
			sort: { direction: "desc", priority: 0 },
		});
		const status = buildDisplayStatus({
			columnCount: 3,
			sortedColumnCount: 1,
			firstSortedColumn: sortedDob,
		});
		expect(status).toBe("3 columns · sorted by dob ↓");
	});

	it("appends a single tiebreaker suffix when sortedColumnCount is 2", () => {
		const sortedAge = plainColumn(COL_AGE, "age", "Age", {
			sort: { direction: "asc", priority: 0 },
		});
		const status = buildDisplayStatus({
			columnCount: 4,
			sortedColumnCount: 2,
			firstSortedColumn: sortedAge,
		});
		expect(status).toBe("4 columns · sorted by age ↑ (+1 tiebreaker)");
	});

	it("pluralizes the tiebreaker suffix when sortedColumnCount is 3+", () => {
		const sortedAge = plainColumn(COL_AGE, "age", "Age", {
			sort: { direction: "desc", priority: 0 },
		});
		const status = buildDisplayStatus({
			columnCount: 5,
			sortedColumnCount: 3,
			firstSortedColumn: sortedAge,
		});
		expect(status).toBe("5 columns · sorted by age ↓ (+2 tiebreakers)");
	});
});

describe("describeSortedColumn", () => {
	it("uses the calculated column's header as the source label", () => {
		const col: Column = calculatedColumn(
			COL_CALC,
			"Age next year",
			term(literal(1)),
			{ sort: { direction: "asc", priority: 0 } },
		);
		expect(describeSortedColumn(col)).toBe("Age next year ↑");
	});

	it("falls back to the literal 'calculated' when a calculated column has no header", () => {
		const col: Column = calculatedColumn(COL_CALC, "", term(literal(1)), {
			sort: { direction: "desc", priority: 0 },
		});
		expect(describeSortedColumn(col)).toBe("calculated ↓");
	});

	it("uses the field name as the source label for non-calculated kinds", () => {
		const col = plainColumn(COL_NAME, "name", "Name", {
			sort: { direction: "asc", priority: 0 },
		});
		expect(describeSortedColumn(col)).toBe("name ↑");
	});
});

// ── Filter status + condition count ───────────────────────────────

describe("countConditions", () => {
	it("counts zero when the filter slot is undefined", () => {
		expect(countConditions(undefined)).toBe(0);
	});

	it("counts zero for the match-all sentinel", () => {
		expect(countConditions(matchAll())).toBe(0);
	});

	it("counts zero for the match-none sentinel", () => {
		expect(countConditions(matchNone())).toBe(0);
	});

	it("counts one for a non-sentinel single-operand predicate", () => {
		expect(countConditions(isBlank(prop("patient", "name")))).toBe(1);
	});

	it("counts one for a leaf comparison predicate", () => {
		expect(countConditions(eq(prop("patient", "name"), literal("Ada")))).toBe(
			1,
		);
	});

	it("counts each direct clause of an `and` predicate", () => {
		const filter = and(
			eq(prop("patient", "name"), literal("Ada")),
			eq(prop("patient", "age"), literal(42)),
			eq(prop("patient", "dob"), literal("1815-12-10")),
		);
		expect(countConditions(filter)).toBe(3);
	});

	it("counts each direct clause of an `or` predicate", () => {
		const filter = or(
			eq(prop("patient", "name"), literal("Ada")),
			eq(prop("patient", "name"), literal("Grace")),
		);
		expect(countConditions(filter)).toBe(2);
	});

	it("counts only direct clauses — nested compound predicates stay attributed to their outer clause", () => {
		const filter = and(
			eq(prop("patient", "name"), literal("Ada")),
			or(
				eq(prop("patient", "age"), literal(42)),
				eq(prop("patient", "age"), literal(43)),
			),
		);
		expect(countConditions(filter)).toBe(2);
	});
});

describe("buildFilterStatus", () => {
	it("returns the no-filter copy when the filter slot is absent", () => {
		expect(
			buildFilterStatus({
				hasFilter: false,
				conditionCount: 0,
				filterStats: null,
			}),
		).toMatch(/^No filter/);
	});

	it("renders the in-flight placeholder for match-all before preview resolves", () => {
		expect(
			buildFilterStatus({
				hasFilter: true,
				conditionCount: 0,
				filterStats: null,
			}),
		).toBe("0 conditions · …");
	});

	it("renders the singular condition form for a one-clause filter pre-resolve", () => {
		expect(
			buildFilterStatus({
				hasFilter: true,
				conditionCount: 1,
				filterStats: null,
			}),
		).toBe("1 condition · …");
	});

	it("renders the plural form for an `and` of three clauses post-resolve", () => {
		expect(
			buildFilterStatus({
				hasFilter: true,
				conditionCount: 3,
				filterStats: { totalCount: 47 },
			}),
		).toBe("3 conditions · 47 cases match");
	});

	it("uses singular noun + matching singular verb when totalCount is exactly 1", () => {
		// Subject/verb agreement: "1 case matches" (third-person
		// singular), "47 cases match" (plural). The verb branches
		// alongside the noun.
		expect(
			buildFilterStatus({
				hasFilter: true,
				conditionCount: 1,
				filterStats: { totalCount: 1 },
			}),
		).toBe("1 condition · 1 case matches");
	});

	it("uses zero with the plural verb form", () => {
		expect(
			buildFilterStatus({
				hasFilter: true,
				conditionCount: 2,
				filterStats: { totalCount: 0 },
			}),
		).toBe("2 conditions · 0 cases match");
	});

	it("falls back to the in-flight placeholder when filterStats transitions back to null", () => {
		expect(
			buildFilterStatus({
				hasFilter: true,
				conditionCount: 1,
				filterStats: null,
			}),
		).toBe("1 condition · …");
	});
});

// ── Search status ─────────────────────────────────────────────────

describe("buildSearchStatus", () => {
	it("returns the empty-state copy when no search inputs are configured", () => {
		expect(
			buildSearchStatus({
				searchInputCount: 0,
				searchInputDefaultCount: 0,
			}),
		).toMatch(/^No search inputs/i);
	});

	it("renders the singular form for one input with no defaults", () => {
		expect(
			buildSearchStatus({
				searchInputCount: 1,
				searchInputDefaultCount: 0,
			}),
		).toBe("1 input");
	});

	it("renders the plural form for many inputs with no defaults", () => {
		expect(
			buildSearchStatus({
				searchInputCount: 3,
				searchInputDefaultCount: 0,
			}),
		).toBe("3 inputs");
	});

	it("appends a default-values tally with singular value when one input carries a default", () => {
		expect(
			buildSearchStatus({
				searchInputCount: 2,
				searchInputDefaultCount: 1,
			}),
		).toBe("2 inputs · 1 with default value");
	});

	it("pluralizes the default-values tally when multiple inputs carry defaults", () => {
		expect(
			buildSearchStatus({
				searchInputCount: 4,
				searchInputDefaultCount: 2,
			}),
		).toBe("4 inputs · 2 with default values");
	});
});

// ── Empty-state seed builders ─────────────────────────────────────

const EMPTY_CONFIG: CaseListConfig = { columns: [], searchInputs: [] };

describe("appendPlainColumnSeed", () => {
	it("appends a plain column carrying the case type's first property and an empty header", () => {
		const next = appendPlainColumnSeed(EMPTY_CONFIG, "name", COL_NAME);
		expect(next.columns).toHaveLength(1);
		const seeded = next.columns[0];
		expect(seeded.kind).toBe("plain");
		expect(seeded.uuid).toBe(COL_NAME);
		// The seed is plain — narrow before reading the kind-specific
		// `field` slot.
		if (seeded.kind !== "plain") throw new Error("Expected plain kind");
		expect(seeded.field).toBe("name");
		expect(seeded.header).toBe("");
	});

	it("preserves existing columns and pushes the seed at the end", () => {
		const existing = plainColumn(COL_AGE, "age", "Age");
		const next = appendPlainColumnSeed(
			{ columns: [existing], searchInputs: [] },
			"name",
			COL_NAME,
		);
		expect(next.columns).toHaveLength(2);
		expect(next.columns[0]).toBe(existing);
		expect(next.columns[1].uuid).toBe(COL_NAME);
	});

	it("does not mutate the input config object", () => {
		const before = { columns: [], searchInputs: [] };
		const next = appendPlainColumnSeed(before, "name", COL_NAME);
		expect(next).not.toBe(before);
		expect(before.columns).toHaveLength(0);
	});
});

describe("seedMatchAllFilter", () => {
	it("sets the filter slot to a match-all sentinel", () => {
		const next = seedMatchAllFilter(EMPTY_CONFIG);
		expect(next.filter).toBeDefined();
		expect(next.filter?.kind).toBe("match-all");
	});

	it("preserves other slots", () => {
		const existing = plainColumn(COL_NAME, "name", "Name");
		const next = seedMatchAllFilter({
			columns: [existing],
			searchInputs: [],
		});
		expect(next.columns).toEqual([existing]);
		expect(next.searchInputs).toEqual([]);
	});
});

describe("appendSearchInputSeed", () => {
	it("appends a text-typed simple input bound to the case type's first property", () => {
		const next = appendSearchInputSeed(EMPTY_CONFIG, "name", INPUT_A);
		expect(next.searchInputs).toHaveLength(1);
		const seeded = next.searchInputs[0];
		expect(seeded.kind).toBe("simple");
		expect(seeded.uuid).toBe(INPUT_A);
		expect(seeded.name).toBe("input_1");
		if (seeded.kind !== "simple") throw new Error("Expected simple kind");
		expect(seeded.type).toBe("text");
		expect(seeded.property).toBe("name");
	});

	it("preserves existing inputs and appends the seed at the end", () => {
		const existing = simpleSearchInputDef(
			INPUT_B,
			"input_0",
			"Age",
			"text",
			"age",
		);
		const next = appendSearchInputSeed(
			{ columns: [], searchInputs: [existing] },
			"name",
			INPUT_A,
		);
		expect(next.searchInputs).toHaveLength(2);
		expect(next.searchInputs[0]).toBe(existing);
		expect(next.searchInputs[1].uuid).toBe(INPUT_A);
	});
});
