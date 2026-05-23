// State-model coverage for the SearchInputs editor's pure logic —
// row resolution, type-coupling diagnostics, structural-error
// classification, simple↔advanced conversion seed, per-slot row
// rebuild. No render; the editor's UI is a deterministic projection
// of these functions' outputs.

import { describe, expect, it } from "vitest";
import {
	computeTypeCouplingErrors,
	rebuildRow,
	resolveRows,
	rowHasStructuralError,
	seedAdvancedPredicate,
} from "@/components/builder/case-list-config/SearchInputsSection";
import { asUuid } from "@/lib/doc/types";
import {
	advancedSearchInputDef,
	type CaseType,
	exactMode,
	fuzzyMode,
	type SearchInputDef,
	type SimpleSearchInputDef,
	searchInputDefSchema,
	simpleSearchInputDef,
} from "@/lib/domain";
import {
	literal,
	matchAll,
	predicateSchema,
	prop,
	term,
} from "@/lib/domain/predicate";

const PATIENT: CaseType = {
	name: "patient",
	properties: [
		{ name: "name", label: "Name", data_type: "text" },
		{ name: "age", label: "Age", data_type: "int" },
		{ name: "dob", label: "Date of birth", data_type: "date" },
	],
};

const U_A = asUuid("00000000-0000-0000-0000-000000000e01");
const U_B = asUuid("00000000-0000-0000-0000-000000000e02");
const U_C = asUuid("00000000-0000-0000-0000-000000000e03");

// ── resolveRows ──────────────────────────────────────────────────

describe("resolveRows — name resolution", () => {
	it("returns ok for a single non-empty unique-name row", () => {
		const value = [simpleSearchInputDef(U_A, "name", "Name", "text", "name")];
		const [resolved] = resolveRows(value, [PATIENT], "patient");
		expect(resolved?.nameState).toEqual({ kind: "ok" });
	});

	it("marks an empty-name row as empty", () => {
		const value = [simpleSearchInputDef(U_A, "", "Label", "text", "name")];
		const [resolved] = resolveRows(value, [PATIENT], "patient");
		expect(resolved?.nameState).toEqual({ kind: "empty" });
	});

	it("marks the second occurrence of a duplicate name as duplicate; the first stays ok", () => {
		const value = [
			simpleSearchInputDef(U_A, "shared", "First", "text", "name"),
			simpleSearchInputDef(U_B, "shared", "Second", "text", "age"),
		];
		const resolved = resolveRows(value, [PATIENT], "patient");
		expect(resolved[0]?.nameState).toEqual({ kind: "ok" });
		expect(resolved[1]?.nameState).toEqual({
			kind: "duplicate",
			firstIndex: 0,
		});
	});

	it("flags row.label === '' as labelEmpty", () => {
		const value = [simpleSearchInputDef(U_A, "n", "", "text", "name")];
		const [resolved] = resolveRows(value, [PATIENT], "patient");
		expect(resolved?.labelEmpty).toBe(true);
	});
});

// ── computeTypeCouplingErrors ────────────────────────────────────

describe("computeTypeCouplingErrors — mode × type × property data-type", () => {
	function getProperty(propertyName: string) {
		return PATIENT.properties.find((p) => p.name === propertyName);
	}

	it("returns no errors when (type, mode, property) are all compatible", () => {
		const row: SimpleSearchInputDef = simpleSearchInputDef(
			U_A,
			"q",
			"Q",
			"text",
			"name",
			{ mode: exactMode() },
		);
		expect(computeTypeCouplingErrors(row, getProperty("name"))).toEqual([]);
	});

	it("flags fuzzy mode on a non-text property as inapplicable", () => {
		// `fuzzy` requires text-shaped properties; `age` is int.
		const row: SimpleSearchInputDef = simpleSearchInputDef(
			U_A,
			"q",
			"Q",
			"text",
			"age",
			{ mode: fuzzyMode() },
		);
		const errors = computeTypeCouplingErrors(row, getProperty("age"));
		expect(errors.length).toBeGreaterThan(0);
		expect(errors.join(" ")).toMatch(/fuzzy/i);
	});

	it("returns no errors when the property is unresolved (property === '')", () => {
		// An unresolved property short-circuits property-anchored gates;
		// only the mode-vs-widget-kind gate can fire here, and an
		// applicable default mode (no `mode`) yields no errors.
		const row: SimpleSearchInputDef = simpleSearchInputDef(
			U_A,
			"q",
			"Q",
			"text",
			"",
		);
		expect(computeTypeCouplingErrors(row, undefined)).toEqual([]);
	});
});

// ── rowHasStructuralError ────────────────────────────────────────

describe("rowHasStructuralError — composition", () => {
	it("returns false for a clean ResolvedRow", () => {
		expect(
			rowHasStructuralError({
				nameState: { kind: "ok" },
				labelEmpty: false,
				typeCouplingErrors: [],
			}),
		).toBe(false);
	});

	it("returns true when name is empty", () => {
		expect(
			rowHasStructuralError({
				nameState: { kind: "empty" },
				labelEmpty: false,
				typeCouplingErrors: [],
			}),
		).toBe(true);
	});

	it("returns true when name is a duplicate", () => {
		expect(
			rowHasStructuralError({
				nameState: { kind: "duplicate", firstIndex: 0 },
				labelEmpty: false,
				typeCouplingErrors: [],
			}),
		).toBe(true);
	});

	it("returns true when label is empty", () => {
		expect(
			rowHasStructuralError({
				nameState: { kind: "ok" },
				labelEmpty: true,
				typeCouplingErrors: [],
			}),
		).toBe(true);
	});

	it("returns true when any type-coupling error is present", () => {
		expect(
			rowHasStructuralError({
				nameState: { kind: "ok" },
				labelEmpty: false,
				typeCouplingErrors: ["some error"],
			}),
		).toBe(true);
	});
});

// ── seedAdvancedPredicate ────────────────────────────────────────

describe("seedAdvancedPredicate — simple → advanced predicate seed", () => {
	it("seeds prop = '' when the simple row carries a property", () => {
		const row: SimpleSearchInputDef = simpleSearchInputDef(
			U_A,
			"q",
			"Q",
			"text",
			"name",
		);
		const seed = seedAdvancedPredicate(row, "patient");
		expect(seed.kind).toBe("eq");
		expect(() => predicateSchema.parse(seed)).not.toThrow();
		// Reads the property reference back out of the seed AST.
		expect(seed).toEqual({
			kind: "eq",
			left: term(prop("patient", "name")),
			right: term(literal("")),
		});
	});

	it("seeds match-all when the simple row has no property", () => {
		const row: SimpleSearchInputDef = simpleSearchInputDef(
			U_A,
			"q",
			"Q",
			"text",
			"",
		);
		const seed = seedAdvancedPredicate(row, "patient");
		expect(seed).toEqual(matchAll());
	});
});

// ── rebuildRow ───────────────────────────────────────────────────

describe("rebuildRow — per-slot patching preserves arm + uuid", () => {
	it("rebuilds a simple-arm row with patched name", () => {
		const row: SearchInputDef = simpleSearchInputDef(
			U_A,
			"old",
			"Label",
			"text",
			"name",
		);
		const next = rebuildRow(row, { name: "new" });
		expect(next.kind).toBe("simple");
		expect(next.uuid).toBe(U_A);
		expect(next.name).toBe("new");
		expect(next.label).toBe("Label");
		expect(() => searchInputDefSchema.parse(next)).not.toThrow();
	});

	it("rebuilds a simple-arm row with patched type and mode", () => {
		const row: SearchInputDef = simpleSearchInputDef(
			U_A,
			"q",
			"Q",
			"text",
			"name",
			{ mode: exactMode() },
		);
		const next = rebuildRow(row, { type: "date", mode: exactMode() });
		expect(next.kind).toBe("simple");
		expect(next.type).toBe("date");
	});

	it("clears optional slots when patch carries explicit undefined", () => {
		const row: SearchInputDef = simpleSearchInputDef(
			U_A,
			"q",
			"Q",
			"text",
			"name",
			{ mode: exactMode() },
		);
		// Explicit-undefined patches drop the slot — the `in patch` check
		// distinguishes "absent key" from "explicit undefined value".
		const next = rebuildRow(row, { mode: undefined });
		expect(next.kind).toBe("simple");
		if (next.kind !== "simple") throw new Error("expected simple");
		expect(next.mode).toBeUndefined();
	});

	it("rebuilds an advanced-arm row preserving its predicate", () => {
		const row: SearchInputDef = advancedSearchInputDef(
			U_C,
			"q",
			"Q",
			"text",
			matchAll(),
		);
		const next = rebuildRow(row, { label: "Renamed" });
		expect(next.kind).toBe("advanced");
		expect(next.label).toBe("Renamed");
		if (next.kind !== "advanced") throw new Error("expected advanced");
		expect(next.predicate).toEqual(matchAll());
	});
});
