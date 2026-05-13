// @vitest-environment happy-dom
//
// components/builder/case-list-config/__tests__/DisplaySection.test.tsx
//
// DisplaySection composition tests covering:
//
//   - **Round-trip:** mount with a populated `CaseListConfig`, verify
//     the column list + sort priority pill stack render. Sort lives
//     on each column's `sort` slot; calculated columns are a
//     `kind: "calculated"` arm of the unified `Column` union.
//   - **Validity aggregation:** the section reports `valid: false`
//     iff any column reports invalid; `valid: true` only when all
//     columns pass.
//   - **Preview validity gate:** when the column list reports
//     invalid, the embedded `DisplayPreview` enters its paused
//     state and the case-store action stops firing once the verdict
//     propagates. Mirrors `FiltersSection`'s preview-paused contract;
//     the structural defense for an invalid calc-arm expression
//     flowing into `compileExpression` at the SQL layer.
//   - **Slot ownership:** edits to the columns slot emit through
//     `onChange` with the other slots (`filter` / `searchInputs`)
//     preserved.
//   - **Reorder + applicability fix propagation:** the inner-
//     validity shadow keys per-column references via WeakMap so the
//     aggregation walks the right verdict slot for each column even
//     after a reorder.
//
// The Server Action `loadCaseListPreviewAction` is mocked at the
// module boundary so the tests don't require a Postgres harness.

import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asUuid } from "@/lib/doc/types";
import {
	type CaseListConfig,
	type CaseType,
	dateColumn,
	plainColumn,
} from "@/lib/domain";

// Mock the Server Action so the tests run without the case-store
// harness.
vi.mock("@/lib/preview/engine/caseDataBinding", () => ({
	loadCasesAction: vi.fn(),
	loadCaseDataAction: vi.fn(),
	populateSampleCasesAction: vi.fn(),
	submitFormAction: vi.fn(),
	loadCaseListPreviewAction: vi.fn(),
}));

// Stable doc-api singleton across renders.
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

import { loadCaseListPreviewAction } from "@/lib/preview/engine/caseDataBinding";
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

const COL_A_UUID = asUuid("00000000-0000-0000-0000-000000000a01");
const COL_B_UUID = asUuid("00000000-0000-0000-0000-000000000a02");
const COL_C_UUID = asUuid("00000000-0000-0000-0000-000000000a03");

function makeConfig(overrides: Partial<CaseListConfig> = {}): CaseListConfig {
	return {
		columns: [],
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
	it("mounts with a populated config and renders the column list", () => {
		const config = makeConfig({
			columns: [plainColumn(COL_A_UUID, "name", "Name")],
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
		expect(screen.getByText(/^Columns$/i)).toBeDefined();
		expect(screen.getByRole("button", { name: /add column/i })).toBeDefined();
	});

	it("renders the sort priority pill stack when at least one column carries a sort directive", () => {
		const config = makeConfig({
			columns: [
				plainColumn(COL_A_UUID, "name", "Name"),
				plainColumn(COL_B_UUID, "dob", "DOB", {
					sort: { direction: "asc", priority: 0 },
				}),
			],
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
		expect(screen.getByText(/^Sort priority$/i)).toBeDefined();
	});

	it("hides the sort priority stack when no column carries a sort directive", () => {
		const config = makeConfig({
			columns: [plainColumn(COL_A_UUID, "name", "Name")],
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
		expect(screen.queryByText(/^Sort priority$/i)).toBeNull();
	});
});

// ── Validity aggregation ─────────────────────────────────────────

describe("DisplaySection — validity aggregation", () => {
	it("reports valid when every column is applicable", async () => {
		const onValidityChange = vi.fn();
		const config = makeConfig({
			columns: [plainColumn(COL_A_UUID, "name", "Name")],
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
			expect(onValidityChange).toHaveBeenLastCalledWith(true);
		});
	});

	it("propagates validity false when a column kind is inapplicable for its property", async () => {
		// Mirrors the regression coverage in the predicate / expression
		// editors — a per-row inner-editor flip must propagate through
		// the wrapper's `useMemo` deps. The `ColumnList` wrapper inside
		// DisplaySection has the same machinery; this test pins it.
		const onValidityChange = vi.fn();
		const config = makeConfig({
			// Date-kind column on a date-typed property — initially
			// applicable, validity true.
			columns: [dateColumn(COL_A_UUID, "dob", "Date of birth", "%Y-%m-%d")],
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

// ── Preview validity gate ────────────────────────────────────────
//
// Pins the gate: an invalid column flips the column-list verdict
// to false; the section threads it into `DisplayPreview` as
// `configValid`; the preview enters its paused state instead of
// firing the action against an invalid expression AST. Mirrors
// `FiltersSection`'s `filterValid={isValid}` shape; the structural
// defense for an invalid calculated-column expression flowing into
// `compileExpression` at the SQL layer (which throws).

describe("DisplaySection — preview validity gate", () => {
	it("threads the column-list verdict into DisplayPreview's configValid", async () => {
		// Date-kind column on a text-typed property → applicability
		// fails → ColumnList aggregates `valid: false` → section
		// threads `false` into `DisplayPreview` → the preview enters
		// its paused state.
		//
		// `vi.useFakeTimers({ shouldAdvanceTime: true })` keeps the
		// real-time queue running for `waitFor`'s internal polling while
		// letting the test advance virtual time deterministically for
		// the post-paused settle window. Without `shouldAdvanceTime`,
		// `waitFor` would hang because `setTimeout`-backed polls never
		// fire. The setting is documented at vitest's `useFakeTimers`
		// API; same shape elsewhere in this repo (see
		// `lib/ui/__tests__/useCommitField.test.tsx` for the canonical
		// fake-timer setup, minus the `shouldAdvanceTime` flag because
		// that test uses `renderHook` rather than `waitFor`).
		vi.useFakeTimers({ shouldAdvanceTime: true });
		try {
			const PATIENT_DOB_AS_TEXT: CaseType = {
				name: "patient",
				properties: [
					{ name: "name", label: "Name", data_type: "text" },
					{ name: "dob", label: "Date of birth", data_type: "text" },
				],
			};
			const config = makeConfig({
				columns: [dateColumn(COL_A_UUID, "dob", "DOB", "%Y-%m-%d")],
			});
			render(
				<DisplaySection
					value={config}
					onChange={() => {}}
					caseTypes={[PATIENT_DOB_AS_TEXT]}
					currentCaseType="patient"
					appId={APP_ID}
				/>,
			);
			// Preview surfaces the paused state once the column-list
			// verdict propagates to `false`. The "preview paused" shape
			// is the gate's tell — without the wire, the preview would
			// stay in a "loading → empty" cycle and never surface the
			// paused branch.
			await waitFor(() => {
				expect(screen.getByText(/preview paused/i)).toBeDefined();
			});
			// The fresh-mount default is `valid: true`; the action may
			// fire once before the column's first verdict flips through.
			// What the gate prevents is REPEATED loads on a stale invalid
			// state — verify by snapshotting the call count after the
			// paused state lands, advancing virtual time, and asserting
			// the count hasn't grown.
			const callsAtPause = vi.mocked(loadCaseListPreviewAction).mock.calls
				.length;
			act(() => {
				vi.advanceTimersByTime(50);
			});
			expect(vi.mocked(loadCaseListPreviewAction).mock.calls.length).toBe(
				callsAtPause,
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it("fires the action and stays out of paused state when every column is valid", async () => {
		const config = makeConfig({
			columns: [plainColumn(COL_A_UUID, "name", "Name")],
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
		await waitFor(() => {
			expect(loadCaseListPreviewAction).toHaveBeenCalled();
		});
		expect(screen.queryByText(/preview paused/i)).toBeNull();
	});
});

// ── Reorder + applicability fix propagation ─────────────────────
//
// Pins ColumnList's inner-validity contract under reorder: each
// row's inner verdict is keyed by the column's reference identity
// (WeakMap), not its array index. A reorder followed by an
// applicability fix writes against the moved column's reference,
// the aggregation walks the right slot, and the flip propagates
// to the parent's `onValidityChange` correctly.

describe("DisplaySection — reorder-then-flip propagation", () => {
	it("propagates valid:true after column reorder + applicability fix", async () => {
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

		const A = dateColumn(COL_A_UUID, "dob", "DOB", "%Y-%m-%d");
		const B = plainColumn(COL_B_UUID, "name", "Name B");
		const C = plainColumn(COL_C_UUID, "name", "Name C");
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
	it("preserves filter / searchInputs when columns change", () => {
		// A populated config with all three slots; the section emits
		// edits via `onChange` carrying the next state. Adding a
		// column shouldn't drop the filter / searchInputs slots even
		// though the Display section doesn't own them.
		const config = makeConfig({
			columns: [],
			filter: { kind: "match-all" },
			searchInputs: [
				{
					uuid: asUuid("00000000-0000-0000-0000-000000000901"),
					kind: "simple",
					name: "q",
					label: "Search",
					type: "text",
					property: "name",
				},
			],
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
		fireEvent.click(screen.getByRole("button", { name: /add column/i }));
		expect(onChange).toHaveBeenCalled();
		const next = onChange.mock.calls.at(-1)?.[0] as CaseListConfig;
		expect(next.columns.length).toBe(1);
		expect(next.filter).toEqual({ kind: "match-all" });
		expect(next.searchInputs).toHaveLength(1);
	});
});
