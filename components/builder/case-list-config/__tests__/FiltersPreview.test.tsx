// @vitest-environment happy-dom
//
// components/builder/case-list-config/__tests__/FiltersPreview.test.tsx
//
// FiltersPreview tests covering:
//
//   - Empty state: action returns empty + filter applied, the
//     "no cases pass this filter" message renders alongside the
//     "0 cases pass" count card.
//   - Empty state without filter: action returns empty + filter
//     undefined, the "no cases to preview" message renders + count
//     surfaces "0 cases (no filter applied)".
//   - Rows: action returns rows + totalCount, the table renders
//     one row per case + the count card surfaces the total.
//   - Paused state: filterValid: false suppresses the action.
//   - Editing the filter retriggers the action: a re-render with
//     a different config triggers a new action call so the count
//     and visible rows reflect the new predicate.
//   - Clearing the filter shows all cases: a re-render with
//     filter: undefined surfaces the "no filter applied" count
//     card text.
//   - invalid-config / invalid-blueprint arms render correctly.

import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CaseRowWithCalculated } from "@/lib/case-store";
import { asUuid } from "@/lib/doc/types";
import { type CaseListConfig, plainColumn } from "@/lib/domain";
import { eq, literal, prop } from "@/lib/domain/predicate";

// Mock the action surface — same shape as DisplayPreview.test.tsx.
vi.mock("@/lib/preview/engine/caseDataBinding", () => ({
	loadCasesAction: vi.fn(),
	loadCaseDataAction: vi.fn(),
	populateSampleCasesAction: vi.fn(),
	submitFormAction: vi.fn(),
	loadCaseListPreviewAction: vi.fn(),
	loadFilterPreviewAction: vi.fn(),
}));

// Stable doc API — see comment in DisplayPreview.test.tsx for the
// identity-guarantee rationale.
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
import { FiltersPreview } from "../FiltersPreview";

// ── Fixtures ──────────────────────────────────────────────────────

const APP_ID = "app-filters-preview-test";

function makeConfig(overrides: Partial<CaseListConfig> = {}): CaseListConfig {
	return {
		columns: [],
		searchInputs: [],
		...overrides,
	};
}

const FIXTURE_COL_NAME_UUID = asUuid("00000000-0000-0000-0000-000000000c01");

/**
 * Build a fixture case row for the preview table assertions.
 * Matches `DisplayPreview.test.tsx`'s `makeRow` shape so the
 * fixtures stay parallel between the two preview tests.
 */
function makeRow(
	caseId: string,
	properties: Record<string, unknown>,
	calculated: Record<string, unknown> = {},
): CaseRowWithCalculated {
	return {
		case_id: caseId,
		case_type: "patient",
		case_name: (properties.name as string) ?? "Unnamed",
		app_id: APP_ID,
		owner_id: "owner-test",
		status: "open",
		opened_on: null,
		modified_on: null,
		closed_on: null,
		parent_case_id: null,
		properties: properties as never,
		calculated: calculated as never,
	} as CaseRowWithCalculated;
}

beforeEach(() => {
	vi.mocked(loadFilterPreviewAction).mockResolvedValue({
		kind: "rows",
		rows: [],
		totalCount: 0,
	});
});

afterEach(() => {
	vi.mocked(loadFilterPreviewAction).mockReset();
});

// ── Paused state ─────────────────────────────────────────────────

describe("FiltersPreview — paused state", () => {
	it("suppresses the action and renders 'preview paused' when filterValid is false", () => {
		const config = makeConfig({
			columns: [plainColumn(FIXTURE_COL_NAME_UUID, "name", "Name")],
		});
		render(
			<FiltersPreview
				appId={APP_ID}
				caseListConfig={config}
				currentCaseType="patient"
				filterValid={false}
			/>,
		);
		expect(screen.getByText(/preview paused/i)).toBeDefined();
		expect(loadFilterPreviewAction).not.toHaveBeenCalled();
	});
});

// ── Empty state ──────────────────────────────────────────────────

describe("FiltersPreview — empty state", () => {
	it("renders the no-filter empty message + count when no filter is applied", async () => {
		const config = makeConfig({
			columns: [plainColumn(FIXTURE_COL_NAME_UUID, "name", "Name")],
			filter: undefined,
		});
		render(
			<FiltersPreview
				appId={APP_ID}
				caseListConfig={config}
				currentCaseType="patient"
				filterValid={true}
			/>,
		);
		await waitFor(() => {
			// Count card surfaces the no-filter copy and 0 total
			// cases.
			expect(screen.getByText(/no filter applied/i)).toBeDefined();
			// Empty-state body message.
			expect(screen.getByText(/no cases to preview/i)).toBeDefined();
		});
	});

	it("renders the filter-applied empty message when no rows pass the filter", async () => {
		const config = makeConfig({
			columns: [plainColumn(FIXTURE_COL_NAME_UUID, "name", "Name")],
			filter: eq(prop("patient", "status"), literal("active")),
		});
		render(
			<FiltersPreview
				appId={APP_ID}
				caseListConfig={config}
				currentCaseType="patient"
				filterValid={true}
			/>,
		);
		await waitFor(() => {
			// Count card surfaces the filter-applied copy. `getAllByText`
			// covers both the count card body ("cases pass this filter")
			// and the empty-state body ("No cases pass this filter") —
			// both substrings match the regex, which is correct
			// behavior; the assertion pins both surfaces existing.
			expect(
				screen.getAllByText(/cases pass this filter/i).length,
			).toBeGreaterThanOrEqual(2);
			// Empty-state body specifically calls out the filter narrowing
			// with the "No" prefix so the user reads "no rows match".
			expect(screen.getByText(/no cases pass this filter/i)).toBeDefined();
		});
	});
});

// ── Rows ─────────────────────────────────────────────────────────

describe("FiltersPreview — rows + count", () => {
	it("renders the row sample + total count when matching cases exist", async () => {
		vi.mocked(loadFilterPreviewAction).mockResolvedValueOnce({
			kind: "rows",
			rows: [
				makeRow("11111111-1111-1111-1111-111111111111", { name: "Alice" }),
				makeRow("22222222-2222-2222-2222-222222222222", { name: "Bob" }),
			],
			totalCount: 5,
		});
		const config = makeConfig({
			columns: [plainColumn(FIXTURE_COL_NAME_UUID, "name", "Name")],
			filter: eq(prop("patient", "status"), literal("active")),
		});
		render(
			<FiltersPreview
				appId={APP_ID}
				caseListConfig={config}
				currentCaseType="patient"
				filterValid={true}
			/>,
		);
		await waitFor(() => {
			// Header
			expect(screen.getByText("Name")).toBeDefined();
			// Per-row cells
			expect(screen.getByText("Alice")).toBeDefined();
			expect(screen.getByText("Bob")).toBeDefined();
			// Count card — total surfaces the full matching count
			// (5), NOT the row sample's length (2).
			expect(screen.getByText("5")).toBeDefined();
			// Footer surfaces "Showing N of M".
			expect(screen.getByText(/Showing 2 of 5 rows\./i)).toBeDefined();
		});
	});
});

// ── Editing the filter retriggers the action ─────────────────────

describe("FiltersPreview — editing the filter updates the result count", () => {
	it("retriggers the action when caseListConfig changes between renders", async () => {
		const baseConfig = makeConfig({
			columns: [plainColumn(FIXTURE_COL_NAME_UUID, "name", "Name")],
			filter: undefined,
		});
		const { rerender } = render(
			<FiltersPreview
				appId={APP_ID}
				caseListConfig={baseConfig}
				currentCaseType="patient"
				filterValid={true}
			/>,
		);
		await waitFor(() => {
			expect(loadFilterPreviewAction).toHaveBeenCalledTimes(1);
		});

		// Add a filter. The action mock's call count must advance so
		// the count + visible rows pair reflects the new predicate
		// — pins the "editing the filter updates the result count
		// and visible rows" contract.
		const filteredConfig = makeConfig({
			columns: [plainColumn(FIXTURE_COL_NAME_UUID, "name", "Name")],
			filter: eq(prop("patient", "status"), literal("active")),
		});
		rerender(
			<FiltersPreview
				appId={APP_ID}
				caseListConfig={filteredConfig}
				currentCaseType="patient"
				filterValid={true}
			/>,
		);
		await waitFor(() => {
			expect(loadFilterPreviewAction).toHaveBeenCalledTimes(2);
		});
	});

	it("retriggers the action when the filter clears (defined → undefined)", async () => {
		// Spec § "clearing the filter shows all cases" — the action
		// must re-fire when the filter slot transitions from
		// defined to undefined so the "all cases" count surfaces.
		const filteredConfig = makeConfig({
			columns: [plainColumn(FIXTURE_COL_NAME_UUID, "name", "Name")],
			filter: eq(prop("patient", "status"), literal("active")),
		});
		const { rerender } = render(
			<FiltersPreview
				appId={APP_ID}
				caseListConfig={filteredConfig}
				currentCaseType="patient"
				filterValid={true}
			/>,
		);
		await waitFor(() => {
			expect(loadFilterPreviewAction).toHaveBeenCalledTimes(1);
		});

		// Mock the all-cases response so the count card surfaces
		// the no-filter copy.
		vi.mocked(loadFilterPreviewAction).mockResolvedValueOnce({
			kind: "rows",
			rows: [
				makeRow("11111111-1111-1111-1111-111111111111", { name: "Alice" }),
				makeRow("22222222-2222-2222-2222-222222222222", { name: "Bob" }),
				makeRow("33333333-3333-3333-3333-333333333333", { name: "Carol" }),
			],
			totalCount: 3,
		});
		const clearedConfig = makeConfig({
			columns: [plainColumn(FIXTURE_COL_NAME_UUID, "name", "Name")],
			filter: undefined,
		});
		rerender(
			<FiltersPreview
				appId={APP_ID}
				caseListConfig={clearedConfig}
				currentCaseType="patient"
				filterValid={true}
			/>,
		);
		await waitFor(() => {
			expect(loadFilterPreviewAction).toHaveBeenCalledTimes(2);
			expect(screen.getByText(/no filter applied/i)).toBeDefined();
		});
	});
});

// ── Invalid-config arm ───────────────────────────────────────────

describe("FiltersPreview — invalid-config arm", () => {
	it("renders 'configuration is malformed' + the parse-failure message", async () => {
		vi.mocked(loadFilterPreviewAction).mockResolvedValueOnce({
			kind: "invalid-config",
			message: "filter: expected predicate, received string",
		});
		const config = makeConfig({
			columns: [plainColumn(FIXTURE_COL_NAME_UUID, "name", "Name")],
		});
		render(
			<FiltersPreview
				appId={APP_ID}
				caseListConfig={config}
				currentCaseType="patient"
				filterValid={true}
			/>,
		);
		await waitFor(() => {
			expect(screen.getByText(/configuration is malformed/i)).toBeDefined();
			expect(
				screen.getByText(/filter: expected predicate, received string/i),
			).toBeDefined();
		});
	});
});

// ── Invalid-blueprint arm ────────────────────────────────────────

describe("FiltersPreview — invalid-blueprint arm", () => {
	it("renders 'blueprint is malformed' + the parse-failure message", async () => {
		vi.mocked(loadFilterPreviewAction).mockResolvedValueOnce({
			kind: "invalid-blueprint",
			message: "appId: expected string, received number",
		});
		const config = makeConfig({
			columns: [plainColumn(FIXTURE_COL_NAME_UUID, "name", "Name")],
		});
		render(
			<FiltersPreview
				appId={APP_ID}
				caseListConfig={config}
				currentCaseType="patient"
				filterValid={true}
			/>,
		);
		await waitFor(() => {
			expect(screen.getByText(/blueprint is malformed/i)).toBeDefined();
			expect(
				screen.getByText(/appId: expected string, received number/i),
			).toBeDefined();
		});
	});
});

// ── Error arm ────────────────────────────────────────────────────

describe("FiltersPreview — error arm", () => {
	it("renders 'couldn't load the preview' + the message", async () => {
		vi.mocked(loadFilterPreviewAction).mockResolvedValueOnce({
			kind: "error",
			message: "connection refused",
		});
		const config = makeConfig({
			columns: [plainColumn(FIXTURE_COL_NAME_UUID, "name", "Name")],
		});
		render(
			<FiltersPreview
				appId={APP_ID}
				caseListConfig={config}
				currentCaseType="patient"
				filterValid={true}
			/>,
		);
		await waitFor(() => {
			expect(screen.getByText(/couldn't load the preview/i)).toBeDefined();
			expect(screen.getByText(/connection refused/i)).toBeDefined();
		});
	});
});
