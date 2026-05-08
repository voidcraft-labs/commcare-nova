// @vitest-environment happy-dom
//
// components/builder/case-list-config/__tests__/DisplayPreview.test.tsx
//
// DisplayPreview tests covering:
//
//   - Paused state: configValid: false suppresses the action.
//   - Empty state: action returns empty + config has columns,
//     "no cases to preview" message renders.
//   - Rows: action returns rows, the table renders one row per
//     case + one column per visible column. Calculated columns
//     pull their value from `row.calculated[col.uuid]` per the
//     v2 case-store contract.
//   - Visibility filter: columns with `visibleInList: false` do
//     NOT render in the table; columns with absent slot OR
//     explicit `true` do.
//   - Sort indicator: per-column sort directives surface as arrow
//     icons on the matching column header.
//   - invalid-config / invalid-blueprint / error arms render
//     correctly.

import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CaseRowWithCalculated } from "@/lib/case-store";
import { asUuid } from "@/lib/doc/types";
import {
	type CaseListConfig,
	calculatedColumn,
	plainColumn,
} from "@/lib/domain";
import { literal, term } from "@/lib/domain/predicate";

vi.mock("@/lib/preview/engine/caseDataBinding", () => ({
	loadCasesAction: vi.fn(),
	loadCaseDataAction: vi.fn(),
	populateSampleCasesAction: vi.fn(),
	submitFormAction: vi.fn(),
	loadCaseListPreviewAction: vi.fn(),
}));

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
import { DisplayPreview } from "../DisplayPreview";

// ── Fixtures ──────────────────────────────────────────────────────

const APP_ID = "app-display-preview-test";

const COL_NAME_UUID = asUuid("00000000-0000-0000-0000-000000000d01");
const COL_AGE_UUID = asUuid("00000000-0000-0000-0000-000000000d02");
const COL_CALC_UUID = asUuid("00000000-0000-0000-0000-000000000d03");
const COL_HIDDEN_UUID = asUuid("00000000-0000-0000-0000-000000000d04");

function makeConfig(overrides: Partial<CaseListConfig> = {}): CaseListConfig {
	return {
		columns: [],
		searchInputs: [],
		...overrides,
	};
}

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

// ── Paused state ─────────────────────────────────────────────────

describe("DisplayPreview — paused state", () => {
	it("suppresses the action and renders 'preview paused' when configValid is false", () => {
		const config = makeConfig({
			columns: [plainColumn(COL_NAME_UUID, "name", "Name")],
		});
		render(
			<DisplayPreview
				appId={APP_ID}
				caseListConfig={config}
				currentCaseType="patient"
				configValid={false}
			/>,
		);
		expect(screen.getByText(/preview paused/i)).toBeDefined();
		expect(loadCaseListPreviewAction).not.toHaveBeenCalled();
	});
});

// ── Empty state ──────────────────────────────────────────────────

describe("DisplayPreview — empty state", () => {
	it("renders 'no cases to preview' when the action returns empty", async () => {
		const config = makeConfig({
			columns: [plainColumn(COL_NAME_UUID, "name", "Name")],
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

// ── Rows ─────────────────────────────────────────────────────────

describe("DisplayPreview — rows", () => {
	it("renders one row per case + one column per visible column", async () => {
		vi.mocked(loadCaseListPreviewAction).mockResolvedValueOnce({
			kind: "rows",
			rows: [
				makeRow("11111111-1111-1111-1111-111111111111", {
					name: "Alice",
					age: 30,
				}),
				makeRow("22222222-2222-2222-2222-222222222222", {
					name: "Bob",
					age: 42,
				}),
			],
		});
		const config = makeConfig({
			columns: [
				plainColumn(COL_NAME_UUID, "name", "Name"),
				plainColumn(COL_AGE_UUID, "age", "Age"),
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
			expect(screen.getByText("Name")).toBeDefined();
			expect(screen.getByText("Age")).toBeDefined();
			expect(screen.getByText("Alice")).toBeDefined();
			expect(screen.getByText("Bob")).toBeDefined();
		});
	});

	it("renders calculated column values from row.calculated[col.uuid]", async () => {
		vi.mocked(loadCaseListPreviewAction).mockResolvedValueOnce({
			kind: "rows",
			rows: [
				makeRow(
					"11111111-1111-1111-1111-111111111111",
					{ name: "Alice", age: 30 },
					{ [COL_CALC_UUID]: "Alice (30)" },
				),
			],
		});
		const config = makeConfig({
			columns: [
				plainColumn(COL_NAME_UUID, "name", "Name"),
				calculatedColumn(COL_CALC_UUID, "Greeting", term(literal(""))),
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
			expect(screen.getByText("Greeting")).toBeDefined();
			expect(screen.getByText("Alice (30)")).toBeDefined();
		});
	});
});

// ── Visibility filter ────────────────────────────────────────────

describe("DisplayPreview — visibleInList filter", () => {
	it("hides columns with visibleInList: false from the rendered headers", async () => {
		vi.mocked(loadCaseListPreviewAction).mockResolvedValueOnce({
			kind: "rows",
			rows: [
				makeRow("11111111-1111-1111-1111-111111111111", {
					name: "Alice",
					secret_field: "hidden value",
				}),
			],
		});
		const config = makeConfig({
			columns: [
				plainColumn(COL_NAME_UUID, "name", "Name"),
				plainColumn(COL_HIDDEN_UUID, "secret_field", "Secret", {
					visibleInList: false,
				}),
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
			expect(screen.getByText("Name")).toBeDefined();
			expect(screen.queryByText("Secret")).toBeNull();
			expect(screen.queryByText("hidden value")).toBeNull();
		});
	});

	it("renders columns with absent visibility slots (default visible)", async () => {
		vi.mocked(loadCaseListPreviewAction).mockResolvedValueOnce({
			kind: "rows",
			rows: [
				makeRow("11111111-1111-1111-1111-111111111111", { name: "Alice" }),
			],
		});
		const config = makeConfig({
			columns: [plainColumn(COL_NAME_UUID, "name", "Name")],
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
			expect(screen.getByText("Name")).toBeDefined();
			expect(screen.getByText("Alice")).toBeDefined();
		});
	});
});

// ── Sort indicator ───────────────────────────────────────────────

describe("DisplayPreview — sort indicator", () => {
	it("renders the asc-arrow icon on the column with sort.direction = asc", async () => {
		vi.mocked(loadCaseListPreviewAction).mockResolvedValueOnce({
			kind: "rows",
			rows: [
				makeRow("11111111-1111-1111-1111-111111111111", { name: "Alice" }),
			],
		});
		const config = makeConfig({
			columns: [
				plainColumn(COL_NAME_UUID, "name", "Name", {
					sort: { direction: "asc", priority: 0 },
				}),
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
			expect(screen.getByLabelText(/sorted ascending/i)).toBeDefined();
		});
	});

	it("renders the desc-arrow icon on the column with sort.direction = desc", async () => {
		vi.mocked(loadCaseListPreviewAction).mockResolvedValueOnce({
			kind: "rows",
			rows: [
				makeRow("11111111-1111-1111-1111-111111111111", { name: "Alice" }),
			],
		});
		const config = makeConfig({
			columns: [
				plainColumn(COL_NAME_UUID, "name", "Name", {
					sort: { direction: "desc", priority: 0 },
				}),
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
			expect(screen.getByLabelText(/sorted descending/i)).toBeDefined();
		});
	});
});

// ── Trust-boundary arms ──────────────────────────────────────────

describe("DisplayPreview — invalid-config / invalid-blueprint / error", () => {
	it("renders 'configuration is malformed' for the invalid-config arm", async () => {
		vi.mocked(loadCaseListPreviewAction).mockResolvedValueOnce({
			kind: "invalid-config",
			message: "columns: expected array, received object",
		});
		const config = makeConfig({
			columns: [plainColumn(COL_NAME_UUID, "name", "Name")],
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
			expect(screen.getByText(/configuration is malformed/i)).toBeDefined();
			expect(
				screen.getByText(/columns: expected array, received object/i),
			).toBeDefined();
		});
	});

	it("renders 'blueprint is malformed' for the invalid-blueprint arm", async () => {
		vi.mocked(loadCaseListPreviewAction).mockResolvedValueOnce({
			kind: "invalid-blueprint",
			message: "appId: expected string, received number",
		});
		const config = makeConfig({
			columns: [plainColumn(COL_NAME_UUID, "name", "Name")],
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
	});

	it("renders 'couldn't load the preview' for the error arm", async () => {
		vi.mocked(loadCaseListPreviewAction).mockResolvedValueOnce({
			kind: "error",
			message: "connection refused",
		});
		const config = makeConfig({
			columns: [plainColumn(COL_NAME_UUID, "name", "Name")],
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
			expect(screen.getByText(/couldn't load the preview/i)).toBeDefined();
			expect(screen.getByText(/connection refused/i)).toBeDefined();
		});
	});
});
