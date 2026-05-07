// @vitest-environment happy-dom
//
// components/builder/case-list-config/__tests__/DisplayPreview.test.tsx
//
// DisplayPreview tests covering:
//
//   - **Empty state:** the action returns `{ kind: "empty" }`; the
//     preview renders the "no cases to preview" message.
//   - **Rows:** the action returns `{ kind: "rows", rows }`; the
//     preview renders the table with one row per case + columns
//     in declaration order. Calculated columns project from
//     `row.calculated[id]`.
//   - **Sort indicator:** authored sort keys surface ascending /
//     descending icons on the matching column headers.
//   - **Paused state:** `configValid: false` suppresses the action
//     and renders "preview paused — fix errors above".
//   - **Editing a column updates the preview:** a re-render with
//     a different config triggers a new action call.
//   - **Reordering columns reorders the preview:** the preview's
//     column rendering follows the authored order.
//   - **Adding a calculated column shows computed values:** a
//     re-render with a non-empty calculated-columns slot surfaces
//     the calculated header + per-row computed values.

import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CaseRowWithCalculated } from "@/lib/case-store";
import {
	type CaseListConfig,
	calculatedColumn,
	plainColumn,
	propertySortSource,
	sortKey,
} from "@/lib/domain";
import { literal, term } from "@/lib/domain/predicate";

// Mock the Server Action — same shape as DisplaySection's tests.
// Replaces the whole module surface to avoid `vi.importActual`
// pulling in the case-store connection layer at import time.
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
import { DisplayPreview } from "../DisplayPreview";

// ── Fixtures ──────────────────────────────────────────────────────

const APP_ID = "app-display-preview-test";

function makeConfig(overrides: Partial<CaseListConfig> = {}): CaseListConfig {
	return {
		columns: [],
		sort: [],
		calculatedColumns: [],
		searchInputs: [],
		...overrides,
	};
}

/**
 * Build a fixture case row carrying a `calculated` map. The case-
 * store's `queryWithCalculated` produces this shape per row; the
 * preview's renderer reads each calculated value from the map.
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
	vi.mocked(loadCaseListPreviewAction).mockResolvedValue({ kind: "empty" });
});

afterEach(() => {
	vi.mocked(loadCaseListPreviewAction).mockReset();
});

// ── Empty state ──────────────────────────────────────────────────

describe("DisplayPreview — empty state", () => {
	it("renders the no-cases message when the action returns empty", async () => {
		const config = makeConfig({
			columns: [plainColumn("name", "Name")],
		});
		render(
			<DisplayPreview
				appId={APP_ID}
				caseListConfig={config}
				currentCaseType="patient"
				configValid={true}
			/>,
		);
		await waitFor(() => {
			expect(screen.getByText(/no cases to preview/i)).toBeDefined();
		});
	});
});

// ── Paused state ─────────────────────────────────────────────────

describe("DisplayPreview — paused state (validity gate)", () => {
	it("suppresses the action and renders 'preview paused' when configValid is false", async () => {
		const config = makeConfig({
			columns: [plainColumn("name", "Name")],
		});
		render(
			<DisplayPreview
				appId={APP_ID}
				caseListConfig={config}
				currentCaseType="patient"
				configValid={false}
			/>,
		);
		// The paused message renders synchronously (no action fires).
		expect(screen.getByText(/preview paused/i)).toBeDefined();
		// The action mock should NOT have been called.
		expect(loadCaseListPreviewAction).not.toHaveBeenCalled();
	});
});

// ── Invalid-config state ─────────────────────────────────────────

describe("DisplayPreview — invalid-config arm", () => {
	it("renders 'configuration is malformed' + the parse-failure message when the action returns invalid-config", async () => {
		// The Server Action's wire-boundary parse rejects unparseable
		// `caseListConfig` shapes and surfaces them as the
		// `invalid-config` arm. Mock the action to return that arm
		// and assert the renderer surfaces both the error title and
		// the path-prefixed message.
		vi.mocked(loadCaseListPreviewAction).mockResolvedValueOnce({
			kind: "invalid-config",
			message: "columns: expected array, received string",
		});
		const config = makeConfig({
			columns: [plainColumn("name", "Name")],
		});
		render(
			<DisplayPreview
				appId={APP_ID}
				caseListConfig={config}
				currentCaseType="patient"
				configValid={true}
			/>,
		);
		await waitFor(() => {
			expect(
				screen.getByText(/case-list configuration is malformed/i),
			).toBeDefined();
		});
		expect(
			screen.getByText(/columns: expected array, received string/),
		).toBeDefined();
	});
});

// ── Invalid-blueprint state ──────────────────────────────────────

describe("DisplayPreview — invalid-blueprint arm", () => {
	it("renders 'Blueprint is malformed' + the parse-failure message when the action returns invalid-blueprint", async () => {
		// Symmetric to the `invalid-config` test above. Same trust-
		// boundary shape; the Server Action's
		// `blueprintDocSchema.safeParse(...)` failure surfaces here.
		// Doc-store's `pickBlueprintDoc(...)` projection always
		// produces a parseable shape, so reaching this arm in
		// production means a non-editor caller bypassed the
		// projection — typically a fixture or a programmatic surface.
		vi.mocked(loadCaseListPreviewAction).mockResolvedValueOnce({
			kind: "invalid-blueprint",
			message: "appId: expected string, received number",
		});
		const config = makeConfig({
			columns: [plainColumn("name", "Name")],
		});
		render(
			<DisplayPreview
				appId={APP_ID}
				caseListConfig={config}
				currentCaseType="patient"
				configValid={true}
			/>,
		);
		await waitFor(() => {
			expect(screen.getByText(/blueprint is malformed/i)).toBeDefined();
		});
		expect(
			screen.getByText(/appId: expected string, received number/),
		).toBeDefined();
	});
});

// ── Rows arm ─────────────────────────────────────────────────────

describe("DisplayPreview — rows arm", () => {
	it("renders a table with one row per case and per-column cells", async () => {
		vi.mocked(loadCaseListPreviewAction).mockResolvedValueOnce({
			kind: "rows",
			rows: [
				makeRow("c1", { name: "Alice", age: 30 }),
				makeRow("c2", { name: "Bob", age: 40 }),
			],
		});
		const config = makeConfig({
			columns: [plainColumn("name", "Name"), plainColumn("age", "Age")],
		});
		render(
			<DisplayPreview
				appId={APP_ID}
				caseListConfig={config}
				currentCaseType="patient"
				configValid={true}
			/>,
		);
		await waitFor(() => {
			expect(screen.getByText("Alice")).toBeDefined();
		});
		expect(screen.getByText("Bob")).toBeDefined();
		// Headers render in declaration order.
		const headers = Array.from(document.querySelectorAll("th")).map(
			(th) => th.textContent ?? "",
		);
		// `Name` appears before `Age` (declaration order preserved).
		const nameIndex = headers.findIndex((h) => h.includes("Name"));
		const ageIndex = headers.findIndex((h) => h.includes("Age"));
		expect(nameIndex).toBeGreaterThanOrEqual(0);
		expect(ageIndex).toBeGreaterThanOrEqual(0);
		expect(nameIndex).toBeLessThan(ageIndex);
	});

	it("renders calculated-column cells from the row's `calculated` map", async () => {
		vi.mocked(loadCaseListPreviewAction).mockResolvedValueOnce({
			kind: "rows",
			rows: [
				makeRow("c1", { age: 30 }, { age_next_year: 31 }),
				makeRow("c2", { age: 40 }, { age_next_year: 41 }),
			],
		});
		const config = makeConfig({
			columns: [plainColumn("age", "Age")],
			calculatedColumns: [
				calculatedColumn("age_next_year", "Next year", term(literal(""))),
			],
		});
		render(
			<DisplayPreview
				appId={APP_ID}
				caseListConfig={config}
				currentCaseType="patient"
				configValid={true}
			/>,
		);
		await waitFor(() => {
			expect(screen.getByText("31")).toBeDefined();
		});
		expect(screen.getByText("41")).toBeDefined();
		// The calculated column's header surfaces.
		const headers = Array.from(document.querySelectorAll("th")).map(
			(th) => th.textContent ?? "",
		);
		expect(headers.some((h) => h.includes("Next year"))).toBe(true);
	});

	it("filters out `search-only` columns from the rendered headers", async () => {
		vi.mocked(loadCaseListPreviewAction).mockResolvedValueOnce({
			kind: "rows",
			rows: [makeRow("c1", { name: "Alice" })],
		});
		const config = makeConfig({
			columns: [
				plainColumn("name", "Name"),
				{ kind: "search-only", field: "secret_field", header: "Secret" },
			],
		});
		render(
			<DisplayPreview
				appId={APP_ID}
				caseListConfig={config}
				currentCaseType="patient"
				configValid={true}
			/>,
		);
		await waitFor(() => {
			expect(screen.getByText("Alice")).toBeDefined();
		});
		// Search-only column header should NOT render in the table.
		const headers = Array.from(document.querySelectorAll("th")).map(
			(th) => th.textContent ?? "",
		);
		expect(headers.some((h) => h.includes("Secret"))).toBe(false);
	});
});

// ── Sort indicator ───────────────────────────────────────────────

describe("DisplayPreview — sort indicator", () => {
	it("renders an ascending icon on the column header for an ascending sort key", async () => {
		vi.mocked(loadCaseListPreviewAction).mockResolvedValueOnce({
			kind: "rows",
			rows: [makeRow("c1", { name: "Alice" })],
		});
		const config = makeConfig({
			columns: [plainColumn("name", "Name")],
			sort: [sortKey(propertySortSource("name"), "plain", "asc")],
		});
		render(
			<DisplayPreview
				appId={APP_ID}
				caseListConfig={config}
				currentCaseType="patient"
				configValid={true}
			/>,
		);
		await waitFor(() => {
			expect(screen.getByText("Alice")).toBeDefined();
		});
		// The sort indicator surfaces an aria-label per direction.
		const ascIndicator = screen.getByLabelText(/sorted ascending/i);
		expect(ascIndicator).toBeDefined();
	});

	it("renders a descending icon for a descending sort key", async () => {
		vi.mocked(loadCaseListPreviewAction).mockResolvedValueOnce({
			kind: "rows",
			rows: [makeRow("c1", { name: "Alice" })],
		});
		const config = makeConfig({
			columns: [plainColumn("name", "Name")],
			sort: [sortKey(propertySortSource("name"), "plain", "desc")],
		});
		render(
			<DisplayPreview
				appId={APP_ID}
				caseListConfig={config}
				currentCaseType="patient"
				configValid={true}
			/>,
		);
		await waitFor(() => {
			expect(screen.getByText("Alice")).toBeDefined();
		});
		const descIndicator = screen.getByLabelText(/sorted descending/i);
		expect(descIndicator).toBeDefined();
	});
});

// ── Behaviors: edit / reorder / add calculated ──────────────────

describe("DisplayPreview — config-change re-runs the action", () => {
	it("editing a column triggers a new action call", async () => {
		vi.mocked(loadCaseListPreviewAction).mockResolvedValue({ kind: "empty" });
		const initial = makeConfig({
			columns: [plainColumn("name", "Name")],
		});
		const { rerender } = render(
			<DisplayPreview
				appId={APP_ID}
				caseListConfig={initial}
				currentCaseType="patient"
				configValid={true}
			/>,
		);
		// Wait for the first call to settle.
		await waitFor(() => {
			expect(loadCaseListPreviewAction).toHaveBeenCalledTimes(1);
		});
		// Re-render with a different config — header changed.
		const next = makeConfig({
			columns: [plainColumn("name", "Renamed")],
		});
		rerender(
			<DisplayPreview
				appId={APP_ID}
				caseListConfig={next}
				currentCaseType="patient"
				configValid={true}
			/>,
		);
		// The action fires a second time with the new config.
		await waitFor(() => {
			expect(loadCaseListPreviewAction).toHaveBeenCalledTimes(2);
		});
	});

	it("reordering columns re-renders the table in the new order", async () => {
		// Two reorders' worth of action responses; the preview reads
		// the latest config and renders columns in the authored order.
		vi.mocked(loadCaseListPreviewAction).mockResolvedValue({
			kind: "rows",
			rows: [makeRow("c1", { name: "Alice", age: 30 })],
		});
		const initial = makeConfig({
			columns: [plainColumn("name", "Name"), plainColumn("age", "Age")],
		});
		const { rerender } = render(
			<DisplayPreview
				appId={APP_ID}
				caseListConfig={initial}
				currentCaseType="patient"
				configValid={true}
			/>,
		);
		await waitFor(() => {
			expect(screen.getByText("Alice")).toBeDefined();
		});
		// Headers are in initial order.
		let headers = Array.from(document.querySelectorAll("th")).map(
			(th) => th.textContent ?? "",
		);
		const initialNameIdx = headers.findIndex((h) => h.includes("Name"));
		const initialAgeIdx = headers.findIndex((h) => h.includes("Age"));
		expect(initialNameIdx).toBeLessThan(initialAgeIdx);
		// Reorder: swap.
		const reordered = makeConfig({
			columns: [plainColumn("age", "Age"), plainColumn("name", "Name")],
		});
		rerender(
			<DisplayPreview
				appId={APP_ID}
				caseListConfig={reordered}
				currentCaseType="patient"
				configValid={true}
			/>,
		);
		await waitFor(() => {
			headers = Array.from(document.querySelectorAll("th")).map(
				(th) => th.textContent ?? "",
			);
			const newAgeIdx = headers.findIndex((h) => h.includes("Age"));
			const newNameIdx = headers.findIndex((h) => h.includes("Name"));
			// New order: Age before Name.
			expect(newAgeIdx).toBeLessThan(newNameIdx);
		});
	});

	it("adding a calculated column surfaces the computed values on the next render", async () => {
		// First render: no calculated columns, just the property
		// columns. Second render: a calculated column with values
		// arrives — the preview's table grows the computed column.
		vi.mocked(loadCaseListPreviewAction).mockResolvedValueOnce({
			kind: "rows",
			rows: [makeRow("c1", { age: 30 })],
		});
		const initial = makeConfig({
			columns: [plainColumn("age", "Age")],
		});
		const { rerender } = render(
			<DisplayPreview
				appId={APP_ID}
				caseListConfig={initial}
				currentCaseType="patient"
				configValid={true}
			/>,
		);
		await waitFor(() => {
			expect(screen.getByText("30")).toBeDefined();
		});
		// No "Next year" header in the initial render.
		let headers = Array.from(document.querySelectorAll("th")).map(
			(th) => th.textContent ?? "",
		);
		expect(headers.some((h) => h.includes("Next year"))).toBe(false);

		// Second render: calculated column added. Mock the action to
		// return rows with the new calculated value.
		vi.mocked(loadCaseListPreviewAction).mockResolvedValueOnce({
			kind: "rows",
			rows: [makeRow("c1", { age: 30 }, { age_next_year: 31 })],
		});
		const withCalc = makeConfig({
			columns: [plainColumn("age", "Age")],
			calculatedColumns: [
				calculatedColumn("age_next_year", "Next year", term(literal(""))),
			],
		});
		rerender(
			<DisplayPreview
				appId={APP_ID}
				caseListConfig={withCalc}
				currentCaseType="patient"
				configValid={true}
			/>,
		);
		await waitFor(() => {
			expect(screen.getByText("31")).toBeDefined();
		});
		headers = Array.from(document.querySelectorAll("th")).map(
			(th) => th.textContent ?? "",
		);
		expect(headers.some((h) => h.includes("Next year"))).toBe(true);
	});
});

// ── No-columns state ─────────────────────────────────────────────

describe("DisplayPreview — no columns configured", () => {
	it("renders the 'no columns configured' message when both lists are empty", async () => {
		vi.mocked(loadCaseListPreviewAction).mockResolvedValueOnce({
			kind: "rows",
			rows: [makeRow("c1", { name: "Alice" })],
		});
		const config = makeConfig({});
		render(
			<DisplayPreview
				appId={APP_ID}
				caseListConfig={config}
				currentCaseType="patient"
				configValid={true}
			/>,
		);
		await waitFor(() => {
			expect(screen.getByText(/no columns configured/i)).toBeDefined();
		});
	});
});
