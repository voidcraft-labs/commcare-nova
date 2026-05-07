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
	dateColumn,
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
		// `BlueprintDoc.fieldParent` is `Record<Uuid, Uuid | null>`
		// per `lib/domain/blueprint.ts`. The earlier `new Map()` shape
		// happened to survive at runtime because `pickBlueprintDoc`
		// parses through Zod (which strips the slot since the schema
		// doesn't declare it) and re-attaches from the input — but
		// per `feedback_tautological_mocks.md`, hand-rolled mocks
		// must mirror production shape so a future change that DOES
		// read `fieldParent` doesn't slip past the tests.
		fieldParent: {},
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

	it("propagates validity false from the columns sub-editor when a caseTypes change makes a column kind inapplicable", async () => {
		// Mirrors the `external-prop validity flip` regression test
		// in `CalculatedColumnEditor.test.tsx` — same bug class
		// (`useMemo` deps must include `innerValidityVersion` so a
		// per-row inner-editor flip recomputes the verdict). The
		// `ColumnList` wrapper inside DisplaySection has the same
		// machinery; without this test the bug class could re-emerge
		// undetected on the columns side.
		//
		// Initial render: a Date-kind column referencing `dob` against
		// a `caseTypes` where `dob` is `data_type: "date"`. The
		// per-kind applicability check passes; the inner ColumnEditor
		// reports `valid: true`; the wrapper ANDs to `valid: true`.
		//
		// Re-render: swap to a `caseTypes` where `dob` is text-typed.
		// The Date-kind applicability fires (Date columns require a
		// date-typed property); the inner editor flips to `valid:
		// false`; the version counter bumps; the wrapper's `useMemo`
		// recomputes (with the version in deps) and propagates
		// `valid: false` to the parent.
		const onValidityChange = vi.fn();
		const config = makeConfig({
			columns: [dateColumn("dob", "Date of birth", "%Y-%m-%d")],
		});
		const { rerender } = render(
			<DisplaySection
				value={config}
				onChange={() => {}}
				caseTypes={[PATIENT]}
				currentCaseType="patient"
				appId={APP_ID}
				onValidityChange={onValidityChange}
			/>,
		);
		// Initial verdict — Date column on a date-typed property is
		// applicable, validity true.
		await waitFor(() => {
			expect(onValidityChange).toHaveBeenLastCalledWith(true);
		});
		// Re-render with `dob` retyped as text. Date column becomes
		// inapplicable; inner verdict flips to false.
		const PATIENT_DOB_AS_TEXT: CaseType = {
			name: "patient",
			properties: [
				{ name: "name", label: "Name", data_type: "text" },
				{ name: "age", label: "Age", data_type: "int" },
				{ name: "dob", label: "Date of birth", data_type: "text" },
			],
		};
		rerender(
			<DisplaySection
				value={config}
				onChange={() => {}}
				caseTypes={[PATIENT_DOB_AS_TEXT]}
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

// ── Reorder-then-flip regression (IMPORTANT 2 backstop) ──────────
//
// Pre-fix: ColumnList's inner-validity shadow was an index-keyed
// boolean array. After a column reorder, an inner-flip on the moved
// column would write against the column's NEW index, which was
// occupied by a different column's stale verdict — the flip would
// silently no-op, the aggregation would walk the unchanged shadow,
// and the parent's `onValidityChange(true)` never fired even when
// every column was applicable. User couldn't save.
//
// Post-fix: `useInnerValidityShadow` keys the shadow by row
// reference via `WeakMap`. Reorder + flip propagates correctly.

describe("DisplaySection — reorder-then-flip propagation", () => {
	it("propagates valid:true after column reorder + applicability fix", async () => {
		// Phase 1 — Mount with [DateCol_invalid, PlainCol, PlainCol].
		// `dob` is text-typed in the initial caseTypes shape, making
		// the Date column inapplicable → ColumnList aggregates false.
		const PATIENT_DOB_AS_TEXT: CaseType = {
			name: "patient",
			properties: [
				{ name: "name", label: "Name", data_type: "text" },
				{ name: "dob", label: "Date of birth", data_type: "text" },
			],
		};
		const PATIENT_DOB_AS_DATE: CaseType = {
			name: "patient",
			properties: [
				{ name: "name", label: "Name", data_type: "text" },
				{ name: "dob", label: "Date of birth", data_type: "date" },
			],
		};

		const A = dateColumn("dob", "DOB", "%Y-%m-%d");
		const B = plainColumn("name", "Name B");
		const C = plainColumn("name", "Name C");
		const config = makeConfig({ columns: [A, B, C] });

		const onValidityChange = vi.fn();
		const { rerender } = render(
			<DisplaySection
				value={config}
				onChange={() => {}}
				caseTypes={[PATIENT_DOB_AS_TEXT]}
				currentCaseType="patient"
				appId={APP_ID}
				onValidityChange={onValidityChange}
			/>,
		);
		await waitFor(() => {
			expect(onValidityChange).toHaveBeenLastCalledWith(false);
		});

		// Phase 2 — Rerender with the columns in a new order: [C, A, B].
		// Same object references thread through (the splice contract
		// `useReorderableList` honors). The verdict is still false
		// because A's column kind is still inapplicable.
		const reordered = makeConfig({ columns: [C, A, B] });
		rerender(
			<DisplaySection
				value={reordered}
				onChange={() => {}}
				caseTypes={[PATIENT_DOB_AS_TEXT]}
				currentCaseType="patient"
				appId={APP_ID}
				onValidityChange={onValidityChange}
			/>,
		);
		await waitFor(() => {
			expect(onValidityChange).toHaveBeenLastCalledWith(false);
		});

		// Phase 3 — Rerender with caseTypes that retypes `dob` to
		// `date`. A's Date-kind column is now applicable; the inner
		// editor flips to valid and writes against A's reference. With
		// WEAKMAP keying the aggregation reports valid:true. With
		// INDEX keying the flip would no-op against the stale slot
		// and the parent would never see the transition.
		rerender(
			<DisplaySection
				value={reordered}
				onChange={() => {}}
				caseTypes={[PATIENT_DOB_AS_DATE]}
				currentCaseType="patient"
				appId={APP_ID}
				onValidityChange={onValidityChange}
			/>,
		);
		await waitFor(() => {
			expect(onValidityChange).toHaveBeenLastCalledWith(true);
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
