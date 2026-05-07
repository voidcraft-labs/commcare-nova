// @vitest-environment happy-dom
//
// components/builder/case-list-config/__tests__/FiltersSection.test.tsx
//
// FiltersSection composition tests — pin the public contract:
//
//   - Round-trip: mount with a populated filter, edit + clear,
//     AST shape preserved; clearing returns the slot to undefined.
//   - Add filter affordance: undefined → defined initializes a
//     `match-all()` predicate via the builder.
//   - Clear filter affordance: defined → undefined.
//   - Validity aggregation: an invalid filter (type-mismatch
//     comparison) flips `valid: false`; a valid filter restores
//     `valid: true`; clearing the filter resets validity to true
//     even when the prior state was invalid (the slot-presence
//     short-circuit).

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CaseListConfig, type CaseType, plainColumn } from "@/lib/domain";
import {
	eq,
	gt,
	literal,
	matchAll,
	type Predicate,
	prop,
} from "@/lib/domain/predicate";

// Mock the live-preview Server Action surface — the FiltersPreview
// fires the action on mount, and the test runtime has no Postgres /
// session. Replace the whole `caseDataBinding` module so no
// authoring-side effect leaks during these tests. Same shape as
// `DisplayPreview.test.tsx`.
vi.mock("@/lib/preview/engine/caseDataBinding", () => ({
	loadCasesAction: vi.fn(),
	loadCaseDataAction: vi.fn(),
	populateSampleCasesAction: vi.fn(),
	submitFormAction: vi.fn(),
	loadCaseListPreviewAction: vi.fn(),
	loadFilterPreviewAction: vi.fn(),
}));

// Mock `useBlueprintDocApi` with a STABLE api singleton across
// renders. Production's hook returns the same `BlueprintDocStore`
// reference for the lifetime of the surrounding `BuilderProvider`;
// the test mock has to honor the same identity guarantee or the
// preview's effect (which depends on `docApi.getState`) re-fires
// on every render. Same pattern + structural shape as
// `DisplayPreview.test.tsx`.
const STABLE_DOC_API = {
	getState: () => ({
		appId: "fake-app",
		appName: "Fake app",
		connectType: null,
		caseTypes: [],
		modules: {},
		forms: {},
		fields: {},
		moduleOrder: [],
		formOrder: {},
		fieldOrder: {},
		fieldParent: {},
	}),
};
vi.mock("@/lib/doc/hooks/useBlueprintDoc", () => ({
	useBlueprintDocApi: () => STABLE_DOC_API,
}));

import { loadFilterPreviewAction } from "@/lib/preview/engine/caseDataBinding";
import { FiltersSection } from "../FiltersSection";

// ── Fixtures ──────────────────────────────────────────────────────

const APP_ID = "app-filters-section-test";

const PATIENT: CaseType = {
	name: "patient",
	properties: [
		{ name: "name", label: "Name", data_type: "text" },
		{ name: "age", label: "Age", data_type: "int" },
		{ name: "status", label: "Status", data_type: "text" },
	],
};
const CASE_TYPES = [PATIENT];

function makeConfig(overrides: Partial<CaseListConfig> = {}): CaseListConfig {
	return {
		columns: [plainColumn("name", "Name")],
		sort: [],
		calculatedColumns: [],
		searchInputs: [],
		...overrides,
	};
}

beforeEach(() => {
	// Default the action to an empty rows arm so the FiltersPreview
	// renders the no-cases empty body without polluting the
	// FiltersSection assertions.
	vi.mocked(loadFilterPreviewAction).mockResolvedValue({
		kind: "rows",
		rows: [],
		totalCount: 0,
	});
});

afterEach(() => {
	vi.mocked(loadFilterPreviewAction).mockReset();
});

// ── Round-trip ────────────────────────────────────────────────────

describe("FiltersSection — round-trip", () => {
	it("mounts with a populated filter and surfaces the predicate editor", () => {
		const filter: Predicate = eq(prop("patient", "status"), literal("active"));
		const config = makeConfig({ filter });
		render(
			<FiltersSection
				value={config}
				onChange={() => {}}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
				appId={APP_ID}
			/>,
		);
		// The "Add filter" affordance must NOT be in the DOM when the
		// slot is populated.
		expect(screen.queryByLabelText(/^add filter$/i)).toBeNull();
		// The "Clear filter" affordance is the slot-defined surface.
		expect(screen.getByLabelText(/^clear filter$/i)).toBeDefined();
	});
});

// ── Add filter affordance ────────────────────────────────────────

describe("FiltersSection — add filter", () => {
	it("transitions undefined → defined with a `match-all` seed", () => {
		const config = makeConfig({ filter: undefined });
		const onChange = vi.fn<(next: CaseListConfig) => void>();
		render(
			<FiltersSection
				value={config}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
				appId={APP_ID}
			/>,
		);
		// The "Add filter" affordance is present when the slot is
		// undefined.
		const addButton = screen.getByLabelText(/^add filter$/i);
		fireEvent.click(addButton);
		expect(onChange).toHaveBeenCalledTimes(1);
		const next = onChange.mock.calls[0]?.[0];
		expect(next?.filter).toEqual({ kind: "match-all" });
		// Every other slot survives unchanged.
		expect(next?.columns).toEqual(config.columns);
		expect(next?.sort).toEqual(config.sort);
		expect(next?.calculatedColumns).toEqual(config.calculatedColumns);
		expect(next?.searchInputs).toEqual(config.searchInputs);
	});
});

// ── Clear filter affordance ──────────────────────────────────────

describe("FiltersSection — clear filter", () => {
	it("transitions defined → undefined preserving every other slot", () => {
		const filter: Predicate = eq(prop("patient", "status"), literal("active"));
		const config = makeConfig({ filter });
		const onChange = vi.fn<(next: CaseListConfig) => void>();
		render(
			<FiltersSection
				value={config}
				onChange={onChange}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
				appId={APP_ID}
			/>,
		);
		const clearButton = screen.getByLabelText(/^clear filter$/i);
		fireEvent.click(clearButton);
		expect(onChange).toHaveBeenCalledTimes(1);
		const next = onChange.mock.calls[0]?.[0];
		expect(next?.filter).toBeUndefined();
		expect(next?.columns).toEqual(config.columns);
		expect(next?.sort).toEqual(config.sort);
	});
});

// ── Validity aggregation ─────────────────────────────────────────

describe("FiltersSection — validity propagation", () => {
	it("reports valid: true when the filter slot is undefined", () => {
		const config = makeConfig({ filter: undefined });
		const onValidityChange = vi.fn<(valid: boolean) => void>();
		render(
			<FiltersSection
				value={config}
				onChange={() => {}}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
				appId={APP_ID}
				onValidityChange={onValidityChange}
			/>,
		);
		expect(onValidityChange).toHaveBeenCalledWith(true);
	});

	it("reports valid: true when the active filter type-checks", () => {
		const filter: Predicate = eq(prop("patient", "status"), literal("active"));
		const config = makeConfig({ filter });
		const onValidityChange = vi.fn<(valid: boolean) => void>();
		render(
			<FiltersSection
				value={config}
				onChange={() => {}}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
				appId={APP_ID}
				onValidityChange={onValidityChange}
			/>,
		);
		expect(onValidityChange).toHaveBeenLastCalledWith(true);
	});

	it("reports valid: false when the active filter has a type-mismatch comparison", () => {
		// `gt(int, "string")` is rejected by the type checker — the
		// editor's onValidityChange flows the verdict to the
		// FiltersSection, which forwards to its parent.
		const filter: Predicate = gt(prop("patient", "age"), literal("string"));
		const config = makeConfig({ filter });
		const onValidityChange = vi.fn<(valid: boolean) => void>();
		render(
			<FiltersSection
				value={config}
				onChange={() => {}}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
				appId={APP_ID}
				onValidityChange={onValidityChange}
			/>,
		);
		expect(onValidityChange).toHaveBeenLastCalledWith(false);
	});

	it("reports valid: true when a `match-all` sentinel filter is active (always-true predicate)", () => {
		const config = makeConfig({ filter: matchAll() });
		const onValidityChange = vi.fn<(valid: boolean) => void>();
		render(
			<FiltersSection
				value={config}
				onChange={() => {}}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
				appId={APP_ID}
				onValidityChange={onValidityChange}
			/>,
		);
		expect(onValidityChange).toHaveBeenLastCalledWith(true);
	});

	it("flips back to valid: true on transition from defined-invalid to undefined", () => {
		// Pins the slot-presence short-circuit in `isValid`: when an
		// invalid filter is cleared, the section MUST flip back to
		// `valid: true` even though the inner `predicateValid` shadow
		// still carries the pre-clear `false`. Without the slot-
		// presence guard, the cleared state would leak the inner
		// `false` until the (unmounted) editor's first verdict
		// landed — which never happens because the editor isn't
		// mounted on the cleared state.
		const invalidFilter: Predicate = gt(
			prop("patient", "age"),
			literal("string"),
		);
		const onValidityChange = vi.fn<(valid: boolean) => void>();
		const { rerender } = render(
			<FiltersSection
				value={makeConfig({ filter: invalidFilter })}
				onChange={() => {}}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
				appId={APP_ID}
				onValidityChange={onValidityChange}
			/>,
		);
		// Initial mount with an invalid filter — verdict is false.
		expect(onValidityChange).toHaveBeenLastCalledWith(false);

		// Transition to the cleared state via prop change — same shape
		// the parent's `clearFilter` handler emits via onChange.
		rerender(
			<FiltersSection
				value={makeConfig({ filter: undefined })}
				onChange={() => {}}
				caseTypes={CASE_TYPES}
				currentCaseType="patient"
				appId={APP_ID}
				onValidityChange={onValidityChange}
			/>,
		);
		// The slot-presence short-circuit flips the verdict back to
		// true even though the inner `predicateValid` shadow may still
		// carry the pre-clear `false`.
		expect(onValidityChange).toHaveBeenLastCalledWith(true);
	});
});
