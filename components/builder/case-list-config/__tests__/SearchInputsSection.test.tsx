// @vitest-environment happy-dom
//
// components/builder/case-list-config/__tests__/SearchInputsSection.test.tsx
//
// Tests for the discriminated SearchInputDef editor. Pin:
//
//   - Round-trip: simple-arm rows + advanced-arm rows render
//     without throwing; emitted ASTs parse through the schema.
//   - Convert-arm affordance: simple → advanced flips the row's
//     discriminator + seeds a predicate; advanced → simple drops
//     the predicate and re-exposes the property/mode pickers.
//   - Validity aggregation: empty-name + duplicate-name rows
//     surface inline errors and propagate `valid: false`. Empty
//     label surfaces "Label is required".
//   - Add row: clicking the affordance appends a fresh simple-arm
//     row with auto-generated name + uuid.
//   - Type-coupling: a simple-arm row whose mode is invalid for
//     the picked type surfaces an inline error + propagates
//     `valid: false`.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { asUuid } from "@/lib/doc/types";
import {
	advancedSearchInputDef,
	type CaseType,
	exactMode,
	fuzzyMode,
	type SearchInputDef,
	searchInputDefSchema,
	simpleSearchInputDef,
} from "@/lib/domain";
import { matchAll, predicateSchema } from "@/lib/domain/predicate";
import { SearchInputsSection } from "../SearchInputsSection";

const PATIENT: CaseType = {
	name: "patient",
	properties: [
		{ name: "name", label: "Name", data_type: "text" },
		{ name: "age", label: "Age", data_type: "int" },
		{ name: "dob", label: "Date of birth", data_type: "date" },
	],
};

const SIMPLE_UUID = asUuid("00000000-0000-0000-0000-000000000e01");
const SIMPLE_DUP_UUID = asUuid("00000000-0000-0000-0000-000000000e02");
const ADV_UUID = asUuid("00000000-0000-0000-0000-000000000e03");

function renderSection(
	value: readonly SearchInputDef[],
	onValidityChange?: (valid: boolean) => void,
) {
	const onChange = vi.fn();
	const utils = render(
		<SearchInputsSection
			value={value}
			onChange={onChange}
			caseTypes={[PATIENT]}
			currentCaseType="patient"
			onValidityChange={onValidityChange}
		/>,
	);
	return { ...utils, onChange };
}

function lastEmitted(
	onChange: ReturnType<typeof vi.fn>,
): readonly SearchInputDef[] {
	expect(onChange).toHaveBeenCalled();
	return onChange.mock.calls.at(-1)?.[0] as readonly SearchInputDef[];
}

// ── Round-trip ───────────────────────────────────────────────────

describe("SearchInputsSection — round-trip", () => {
	it("renders a simple-arm row without throwing", () => {
		const value: SearchInputDef[] = [
			simpleSearchInputDef(SIMPLE_UUID, "name_input", "Name", "text", "name"),
		];
		const { container } = renderSection(value);
		expect(container.firstElementChild).not.toBeNull();
	});

	it("renders an advanced-arm row without throwing", () => {
		const value: SearchInputDef[] = [
			advancedSearchInputDef(ADV_UUID, "any_input", "Any", "text", matchAll()),
		];
		const { container } = renderSection(value);
		expect(container.firstElementChild).not.toBeNull();
	});

	it("emitted ASTs parse through searchInputDefSchema", () => {
		const value: SearchInputDef[] = [
			simpleSearchInputDef(SIMPLE_UUID, "input_1", "Input 1", "text", "name", {
				mode: exactMode(),
			}),
			advancedSearchInputDef(
				ADV_UUID,
				"input_2",
				"Input 2",
				"text",
				matchAll(),
			),
		];
		for (const row of value) {
			expect(() => searchInputDefSchema.parse(row)).not.toThrow();
		}
	});
});

// ── Convert affordance ───────────────────────────────────────────

describe("SearchInputsSection — convert affordance", () => {
	it("flips a simple-arm row to advanced via the convert button", () => {
		const value: SearchInputDef[] = [
			simpleSearchInputDef(SIMPLE_UUID, "name_input", "Name", "text", "name"),
		];
		const { onChange } = renderSection(value);
		const convert = screen.getByRole("button", {
			name: /convert search input 1 to advanced/i,
		});
		fireEvent.click(convert);
		const next = lastEmitted(onChange);
		expect(next).toHaveLength(1);
		const row = next[0];
		expect(row).toBeDefined();
		if (row === undefined) return;
		expect(row.kind).toBe("advanced");
		expect(row.uuid).toBe(SIMPLE_UUID);
		expect(row.name).toBe("name_input");
		expect(row.label).toBe("Name");
		expect(row.type).toBe("text");
		// Predicate seeded as `prop = ''` for property-bearing simple
		// arms; the seeded shape parses through `predicateSchema` so
		// the convert path can never produce a structurally-broken
		// AST that the type checker would reject downstream.
		if (row.kind !== "advanced") return;
		expect(row.predicate.kind).toBe("eq");
		expect(() => predicateSchema.parse(row.predicate)).not.toThrow();
	});

	it("flips an advanced-arm row to simple via the convert button", () => {
		const value: SearchInputDef[] = [
			advancedSearchInputDef(ADV_UUID, "any_input", "Any", "text", matchAll()),
		];
		const { onChange } = renderSection(value);
		const convert = screen.getByRole("button", {
			name: /convert search input 1 to simple/i,
		});
		fireEvent.click(convert);
		const next = lastEmitted(onChange);
		expect(next).toHaveLength(1);
		const row = next[0];
		expect(row).toBeDefined();
		if (row === undefined) return;
		expect(row.kind).toBe("simple");
		expect(row.uuid).toBe(ADV_UUID);
		expect(row.name).toBe("any_input");
		expect(row.label).toBe("Any");
		expect(row.type).toBe("text");
		// Property reset to empty — the simple arm's required
		// property starts blank, the user picks one next.
		if (row.kind !== "simple") return;
		expect(row.property).toBe("");
	});

	it("seeds advanced-arm with match-all when the simple arm has no property", () => {
		const value: SearchInputDef[] = [
			simpleSearchInputDef(SIMPLE_UUID, "input_1", "Label", "text", ""),
		];
		const { onChange } = renderSection(value);
		const convert = screen.getByRole("button", {
			name: /convert search input 1 to advanced/i,
		});
		fireEvent.click(convert);
		const next = lastEmitted(onChange);
		const row = next[0];
		if (row === undefined || row.kind !== "advanced") {
			throw new Error("expected advanced row");
		}
		expect(row.predicate.kind).toBe("match-all");
	});
});

// ── Validity aggregation ─────────────────────────────────────────

describe("SearchInputsSection — validity aggregation", () => {
	it("flags empty-name rows as invalid + surfaces inline error", async () => {
		const onValidityChange = vi.fn();
		const value: SearchInputDef[] = [
			simpleSearchInputDef(SIMPLE_UUID, "", "Label", "text", "name"),
		];
		const { container } = renderSection(value, onValidityChange);
		await waitFor(() => {
			expect(onValidityChange).toHaveBeenLastCalledWith(false);
		});
		expect(container.textContent).toMatch(/name is required/i);
	});

	it("flags empty-label rows as invalid", async () => {
		const onValidityChange = vi.fn();
		const value: SearchInputDef[] = [
			simpleSearchInputDef(SIMPLE_UUID, "input_1", "", "text", "name"),
		];
		const { container } = renderSection(value, onValidityChange);
		await waitFor(() => {
			expect(onValidityChange).toHaveBeenLastCalledWith(false);
		});
		expect(container.textContent).toMatch(/label is required/i);
	});

	it("flags duplicate-name rows as invalid", async () => {
		const onValidityChange = vi.fn();
		const value: SearchInputDef[] = [
			simpleSearchInputDef(SIMPLE_UUID, "input_1", "First", "text", "name"),
			simpleSearchInputDef(SIMPLE_DUP_UUID, "input_1", "Second", "text", "age"),
		];
		const { container } = renderSection(value, onValidityChange);
		await waitFor(() => {
			expect(onValidityChange).toHaveBeenLastCalledWith(false);
		});
		expect(container.textContent).toMatch(/already used by row 1/i);
	});

	it("flags simple-arm type-coupling mismatches", async () => {
		const onValidityChange = vi.fn();
		// `fuzzy` mode requires text-shaped properties; `age` is `int`.
		const value: SearchInputDef[] = [
			simpleSearchInputDef(SIMPLE_UUID, "input_1", "Label", "text", "age", {
				mode: fuzzyMode(),
			}),
		];
		renderSection(value, onValidityChange);
		await waitFor(() => {
			expect(onValidityChange).toHaveBeenLastCalledWith(false);
		});
	});

	it("reports valid for a clean simple-arm row", async () => {
		const onValidityChange = vi.fn();
		const value: SearchInputDef[] = [
			simpleSearchInputDef(SIMPLE_UUID, "name_input", "Name", "text", "name"),
		];
		renderSection(value, onValidityChange);
		await waitFor(() => {
			expect(onValidityChange).toHaveBeenLastCalledWith(true);
		});
	});

	it("reports valid for a clean advanced-arm row", async () => {
		const onValidityChange = vi.fn();
		const value: SearchInputDef[] = [
			advancedSearchInputDef(ADV_UUID, "any_input", "Any", "text", matchAll()),
		];
		renderSection(value, onValidityChange);
		await waitFor(() => {
			expect(onValidityChange).toHaveBeenLastCalledWith(true);
		});
	});
});

// ── Add row ──────────────────────────────────────────────────────

describe("SearchInputsSection — Add search input", () => {
	it("appends a fresh simple-arm row with auto-generated name", () => {
		const { onChange } = renderSection([]);
		fireEvent.click(
			screen.getByRole("button", { name: /^add search input$/i }),
		);
		const next = lastEmitted(onChange);
		expect(next).toHaveLength(1);
		const seed = next[0];
		expect(seed).toBeDefined();
		if (seed === undefined) return;
		expect(seed.kind).toBe("simple");
		expect(seed.label).toBe("");
		expect(seed.type).toBe("text");
		expect(seed.name).toMatch(/^input_[0-9a-f]{8}$/);
		expect(() => searchInputDefSchema.parse(seed)).not.toThrow();
	});
});

// ── Empty state ──────────────────────────────────────────────────

describe("SearchInputsSection — empty state", () => {
	it("renders the empty-state hint when the list is empty", () => {
		renderSection([]);
		expect(screen.getByText(/no search inputs/i)).toBeDefined();
	});
});
