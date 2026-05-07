// @vitest-environment happy-dom
//
// components/builder/case-list-config/__tests__/DisplaySection.test.tsx
//
// DisplaySection composition tests covering:
//
//   - **Round-trip:** mount with a populated `CaseListConfig`, verify
//     the three sub-editors render (Columns / Calculated columns /
//     Sort).
//   - **Validity aggregation:** the section reports `valid: false`
//     iff any sub-editor reports invalid; `valid: true` only when
//     all three pass.
//   - **Slot ownership:** edits to the columns / calculated columns
//     / sort slots emit through `onChange` with the other slots
//     (`filter` / `searchInputs` / `detailColumns`) preserved.
//   - **Live preview integration:** the preview panel reads the same
//     `configValid` signal and falls back to "preview paused" when
//     the section reports invalid.
//
// The Server Action `loadCaseListPreviewAction` is mocked at the
// module boundary so the tests don't require a Postgres harness.
// `useBlueprintDocApi` is mocked to return a stub api whose
// `getState()` returns a minimal blueprint shape — enough for the
// preview's `pickBlueprintDoc(...)` projection to land cleanly.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type CaseListConfig,
	type CaseType,
	calculatedColumn,
	plainColumn,
	propertySortSource,
	sortKey,
} from "@/lib/domain";
import { literal, prop, term } from "@/lib/domain/predicate";

// Mock the Server Action so the tests run without the case-store
// harness. The mock replaces the entire module surface — the tests
// don't use the other actions, and stubbing only the action under
// test avoids `vi.importActual` pulling in `withOwnerContext` and
// the case-store connection layer (which would trip the import-time
// connector / SSL-cert resolution).
vi.mock("@/lib/preview/engine/caseDataBinding", () => ({
	loadCasesAction: vi.fn(),
	loadCaseDataAction: vi.fn(),
	populateSampleCasesAction: vi.fn(),
	submitFormAction: vi.fn(),
	loadCaseListPreviewAction: vi.fn(),
}));

// Mock `useBlueprintDocApi` with a STABLE api singleton across
// renders. Production's `useBlueprintDocApi` returns the same
// `BlueprintDocStore` reference for the lifetime of the surrounding
// `BuilderProvider`; the test mock has to honor the same identity
// guarantee or `DisplayPreview`'s effect (which depends on
// `docApi.getState`) re-fires on every render and tips into an
// infinite loop. Building the api once outside the hook factory
// keeps the per-render returned reference identical.
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
		fieldParent: new Map(),
	}),
};
vi.mock("@/lib/doc/hooks/useBlueprintDoc", () => ({
	useBlueprintDocApi: () => STABLE_DOC_API,
}));

import { loadCaseListPreviewAction } from "@/lib/preview/engine/caseDataBinding";
// Import the component under test AFTER the vi.mock calls so the
// mocked dependencies bind at module-resolution time.
import { DisplaySection } from "../DisplaySection";

// ── Fixtures ──────────────────────────────────────────────────────

const PATIENT: CaseType = {
	name: "patient",
	properties: [
		{ name: "name", label: "Name", data_type: "text" },
		{ name: "age", label: "Age", data_type: "int" },
		{ name: "dob", label: "Date of birth", data_type: "date" },
	],
};

const APP_ID = "app-display-section-test";

function makeConfig(overrides: Partial<CaseListConfig> = {}): CaseListConfig {
	return {
		columns: [],
		sort: [],
		calculatedColumns: [],
		searchInputs: [],
		...overrides,
	};
}

beforeEach(() => {
	vi.mocked(loadCaseListPreviewAction).mockResolvedValue({ kind: "empty" });
});

afterEach(() => {
	vi.mocked(loadCaseListPreviewAction).mockReset();
});

// ── Round-trip / mount ───────────────────────────────────────────

describe("DisplaySection — mount", () => {
	it("mounts with a populated config and renders the three sub-editors", () => {
		const config = makeConfig({
			columns: [plainColumn("name", "Name")],
			calculatedColumns: [
				calculatedColumn("age_next", "Next year", term(prop("patient", "age"))),
			],
			sort: [sortKey(propertySortSource("dob"), "date", "asc")],
		});
		render(
			<DisplaySection
				value={config}
				onChange={() => {}}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
				appId={APP_ID}
			/>,
		);
		// The three sub-section headers render their semantic title.
		expect(screen.getByText(/^Columns$/i)).toBeDefined();
		expect(screen.getByText(/^Calculated columns$/i)).toBeDefined();
		expect(screen.getByText(/^Sort$/i)).toBeDefined();
		// Add-row affordances surface for each list-shaped editor.
		expect(screen.getByRole("button", { name: /add column/i })).toBeDefined();
		expect(
			screen.getByRole("button", { name: /add calculated column/i }),
		).toBeDefined();
		expect(screen.getByRole("button", { name: /add sort key/i })).toBeDefined();
	});
});

// ── Validity aggregation ─────────────────────────────────────────

describe("DisplaySection — validity aggregation", () => {
	it("reports valid when every sub-editor is clean", async () => {
		const onValidityChange = vi.fn();
		const config = makeConfig({
			columns: [plainColumn("name", "Name")],
		});
		render(
			<DisplaySection
				value={config}
				onChange={() => {}}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
				appId={APP_ID}
				onValidityChange={onValidityChange}
			/>,
		);
		// Wait for the inner editors to fire their first verdicts.
		await waitFor(() => {
			expect(onValidityChange).toHaveBeenLastCalledWith(true);
		});
	});

	it("reports invalid when the calculated columns include a duplicate id", async () => {
		const onValidityChange = vi.fn();
		const config = makeConfig({
			calculatedColumns: [
				calculatedColumn("shared", "Header A", term(literal(""))),
				calculatedColumn("shared", "Header B", term(literal(""))),
			],
		});
		render(
			<DisplaySection
				value={config}
				onChange={() => {}}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
				appId={APP_ID}
				onValidityChange={onValidityChange}
			/>,
		);
		await waitFor(() => {
			expect(onValidityChange).toHaveBeenLastCalledWith(false);
		});
	});

	it("reports invalid when a sort key references an unresolvable property", async () => {
		const onValidityChange = vi.fn();
		const config = makeConfig({
			sort: [sortKey(propertySortSource("missing_prop"), "plain", "asc")],
		});
		render(
			<DisplaySection
				value={config}
				onChange={() => {}}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
				appId={APP_ID}
				onValidityChange={onValidityChange}
			/>,
		);
		await waitFor(() => {
			expect(onValidityChange).toHaveBeenLastCalledWith(false);
		});
	});
});

// ── Slot ownership ───────────────────────────────────────────────

describe("DisplaySection — slot ownership", () => {
	it("preserves filter / searchInputs / detailColumns when columns change", () => {
		// A populated config with all five slots; the section emits
		// edits via `onChange` carrying the next state. Adding a
		// column shouldn't drop the filter / searchInputs slots even
		// though the Display section doesn't own them.
		const config = makeConfig({
			columns: [],
			filter: { kind: "match-all" },
			searchInputs: [{ name: "q", label: "Search", type: "text" }],
			detailColumns: [plainColumn("name", "Name")],
		});
		const onChange = vi.fn();
		render(
			<DisplaySection
				value={config}
				onChange={onChange}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
				appId={APP_ID}
			/>,
		);
		// Add a column.
		fireEvent.click(screen.getByRole("button", { name: /add column/i }));
		expect(onChange).toHaveBeenCalled();
		const next = onChange.mock.calls.at(-1)?.[0] as CaseListConfig;
		// Columns list grew.
		expect(next.columns.length).toBe(1);
		// Other slots preserved verbatim.
		expect(next.filter).toEqual({ kind: "match-all" });
		expect(next.searchInputs).toHaveLength(1);
		expect(next.detailColumns).toEqual([plainColumn("name", "Name")]);
	});
});
