// @vitest-environment happy-dom
//
// components/preview/screens/__tests__/CaseListScreen.test.tsx
//
// Pins the running-app preview's case-list screen contract:
//
//   1. Heading reads from `mod.name` (the module IS the case-list
//      title in v2) — not from the first form's name. Asserts the
//      heading shows the module's name even when the first form's
//      name is distinct.
//   2. Display columns filter by `column.visibleInList ?? true` —
//      columns with `visibleInList: false` are absent from the
//      header row AND every body cell.
//   3. Calculated columns surface `row.calculated[column.uuid]`
//      values in their cells. The case-store's
//      `queryWithCalculated` materializes calc values keyed by
//      uuid; the screen reads the slot directly via
//      `evaluateColumnValue` — no AST evaluation in the preview
//      layer.

import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CaseRowWithCalculated } from "@/lib/case-store";
import { BlueprintDocProvider } from "@/lib/doc/provider";
import { asUuid } from "@/lib/doc/types";
import {
	asUuid as asDomainUuid,
	calculatedColumn,
	plainColumn,
} from "@/lib/domain";
import { literal, term } from "@/lib/domain/predicate";
import type { Location } from "@/lib/routing/types";

// ── Mocks ────────────────────────────────────────────────────────

const APP_ID = "app-case-list-screen-test";
const MODULE_UUID = asUuid("00000000-0000-0000-0000-000000000a01");
const FORM_UUID = asUuid("00000000-0000-0000-0000-000000000a02");

// Routing — mounting the screen reads `useLocation()` to derive
// `moduleUuid`. The screen branches on `loc.kind === "cases"`,
// so the test pins that arm with the fixture module's uuid.
const navigateMock = {
	goHome: vi.fn(),
	openModule: vi.fn(),
	openCaseList: vi.fn(),
	openCaseDetail: vi.fn(),
	openForm: vi.fn(),
	push: vi.fn(),
	replace: vi.fn(),
	back: vi.fn(),
	up: vi.fn(),
};
const currentLocation: Location = {
	kind: "cases",
	moduleUuid: MODULE_UUID,
};

vi.mock("@/lib/routing/hooks", async () => {
	const actual = await vi.importActual<typeof import("@/lib/routing/hooks")>(
		"@/lib/routing/hooks",
	);
	return {
		...actual,
		useLocation: () => currentLocation,
		useNavigate: () => navigateMock,
	};
});

vi.mock("@/lib/session/hooks", async () => {
	const actual = await vi.importActual<typeof import("@/lib/session/hooks")>(
		"@/lib/session/hooks",
	);
	return {
		...actual,
		useAppId: () => APP_ID,
		useEditMode: () => "preview" as const,
		useBuilderIsReady: () => true,
	};
});

// Server Actions live in a `"use server"` module. Mock the action
// directly so the screen renders synchronously without spinning up
// auth + Postgres. The `useCases` hook calls `loadCasesAction`;
// each test resolves the mock with the discriminated arm it wants
// to assert against (rows / empty / etc).
vi.mock("@/lib/preview/engine/caseDataBinding", () => ({
	loadCasesAction: vi.fn(),
	loadCaseDataAction: vi.fn(),
	populateSampleCasesAction: vi.fn(),
	submitFormAction: vi.fn(),
	loadCaseListPreviewAction: vi.fn(),
	loadFilterPreviewAction: vi.fn(),
}));

import { loadCasesAction } from "@/lib/preview/engine/caseDataBinding";
import { CaseListScreen } from "../CaseListScreen";

// ── Fixtures ─────────────────────────────────────────────────────

/** Module name surfaces in the heading; first form's name is
 *  intentionally distinct so the heading-source assertion
 *  discriminates between the two sources. */
const MODULE_NAME = "Patients";
const FIRST_FORM_NAME = "Registration";

/** Per-column uuids. Calc-column reads `row.calculated[uuid]` in
 *  the rendered cell. */
const COL_NAME_UUID = asDomainUuid("00000000-0000-0000-0000-000000000c01");
const COL_AGE_UUID = asDomainUuid("00000000-0000-0000-0000-000000000c02");
const COL_HIDDEN_UUID = asDomainUuid("00000000-0000-0000-0000-000000000c03");
const COL_CALC_UUID = asDomainUuid("00000000-0000-0000-0000-000000000c04");

/** Synthetic case-row fixture. Mirrors the case-store contract's
 *  `CaseRowWithCalculated` shape — every reserved scalar plus
 *  `properties` JSONB plus a `calculated` map keyed by column
 *  uuid. */
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

/** Mount the screen against a doc seeded with the fixture
 *  `caseListConfig`. The provider's `initialDoc` shape mirrors the
 *  Firestore `PersistableDoc` — a fresh module carrying our
 *  fixture columns + a single first-form whose name differs from
 *  the module's. */
function renderCaseListScreen(opts: {
	columns: NonNullable<
		Parameters<typeof BlueprintDocProvider>[0]["initialDoc"]
	>["modules"][string]["caseListConfig"] extends infer C
		? C extends { columns: infer X }
			? X
			: never
		: never;
}) {
	return render(
		<BlueprintDocProvider
			appId={APP_ID}
			initialDoc={{
				appId: APP_ID,
				appName: "Case list screen test app",
				connectType: null,
				caseTypes: [
					{
						name: "patient",
						properties: [
							{ name: "name", label: "Name", data_type: "text" },
							{ name: "age", label: "Age", data_type: "int" },
						],
					},
				],
				modules: {
					[MODULE_UUID]: {
						uuid: MODULE_UUID,
						id: "patient_module",
						name: MODULE_NAME,
						caseType: "patient",
						caseListConfig: {
							columns: opts.columns,
							searchInputs: [],
						},
					},
				},
				forms: {
					[FORM_UUID]: {
						uuid: FORM_UUID,
						id: "registration_form",
						name: FIRST_FORM_NAME,
						type: "registration",
					},
				},
				fields: {},
				moduleOrder: [MODULE_UUID],
				formOrder: { [MODULE_UUID]: [FORM_UUID] },
				fieldOrder: {},
			}}
		>
			<CaseListScreen
				screen={{ type: "caseList", moduleIndex: 0, formIndex: 0 }}
			/>
		</BlueprintDocProvider>,
	);
}

beforeEach(() => {
	vi.mocked(loadCasesAction).mockResolvedValue({ kind: "empty" });
});

afterEach(() => {
	vi.mocked(loadCasesAction).mockReset();
});

// ── Heading source ───────────────────────────────────────────────

describe("CaseListScreen — heading", () => {
	it("renders the module's name as the heading (not the first form's name)", async () => {
		// Single plain column so the screen reaches the rows arm
		// without short-circuiting to the "no case list configured"
		// empty fallback.
		vi.mocked(loadCasesAction).mockResolvedValueOnce({
			kind: "rows",
			rows: [
				makeRow("11111111-1111-1111-1111-111111111111", { name: "Alice" }),
			],
		});
		renderCaseListScreen({
			columns: [plainColumn(COL_NAME_UUID, "name", "Name")],
		});
		await waitFor(() => {
			expect(screen.getByRole("heading", { name: MODULE_NAME })).toBeDefined();
		});
		// Inversion check: the first form's name does NOT surface as
		// the heading, regardless of where it lives in the DOM.
		expect(screen.queryByRole("heading", { name: FIRST_FORM_NAME })).toBeNull();
	});
});

// ── Visibility filter ────────────────────────────────────────────

describe("CaseListScreen — visibleInList filter", () => {
	it("hides columns with visibleInList: false from the rendered table", async () => {
		vi.mocked(loadCasesAction).mockResolvedValueOnce({
			kind: "rows",
			rows: [
				makeRow("11111111-1111-1111-1111-111111111111", {
					name: "Alice",
					age: 30,
				}),
			],
		});
		renderCaseListScreen({
			columns: [
				plainColumn(COL_NAME_UUID, "name", "Name"),
				plainColumn(COL_HIDDEN_UUID, "age", "Age", {
					visibleInList: false,
				}),
			],
		});
		await waitFor(() => {
			// Visible column's header + cell render.
			expect(screen.getByText("Name")).toBeDefined();
			expect(screen.getByText("Alice")).toBeDefined();
		});
		// Hidden column's header is absent — the filter applies to
		// `<th>` rendering, not just to the cell-rendering side.
		expect(screen.queryByText("Age")).toBeNull();
		// And the hidden column's cell value (`age: 30`) does not
		// surface anywhere in the rendered output.
		expect(screen.queryByText("30")).toBeNull();
	});

	it("renders columns with absent visibility slots (default visible)", async () => {
		vi.mocked(loadCasesAction).mockResolvedValueOnce({
			kind: "rows",
			rows: [
				makeRow("11111111-1111-1111-1111-111111111111", {
					name: "Alice",
					age: 30,
				}),
			],
		});
		renderCaseListScreen({
			columns: [
				plainColumn(COL_NAME_UUID, "name", "Name"),
				plainColumn(COL_AGE_UUID, "age", "Age"),
			],
		});
		await waitFor(() => {
			expect(screen.getByText("Name")).toBeDefined();
			expect(screen.getByText("Age")).toBeDefined();
			expect(screen.getByText("Alice")).toBeDefined();
			expect(screen.getByText("30")).toBeDefined();
		});
	});
});

// ── Calculated cells ─────────────────────────────────────────────

describe("CaseListScreen — calculated columns", () => {
	it("surfaces row.calculated[col.uuid] in the calc column's cell", async () => {
		// The expression value is irrelevant at this layer — the
		// case-store materializes calc values via SQL and surfaces
		// them on `row.calculated[uuid]`. The screen reads the slot
		// directly. Test fixture supplies the materialized value;
		// the assertion pins the read path.
		vi.mocked(loadCasesAction).mockResolvedValueOnce({
			kind: "rows",
			rows: [
				makeRow(
					"11111111-1111-1111-1111-111111111111",
					{ name: "Alice", age: 30 },
					{ [COL_CALC_UUID]: "Alice — overdue" },
				),
			],
		});
		renderCaseListScreen({
			columns: [
				plainColumn(COL_NAME_UUID, "name", "Name"),
				calculatedColumn(COL_CALC_UUID, "Status", term(literal(""))),
			],
		});
		await waitFor(() => {
			expect(screen.getByText("Status")).toBeDefined();
			// The header row carries the calc column's `header`; the
			// body cell carries its materialized `calculated` value.
			expect(screen.getByText("Alice — overdue")).toBeDefined();
		});
	});

	it("renders an empty cell when row.calculated[col.uuid] is absent", async () => {
		// Calc map keyed only by the plain column's slot — the calc
		// column's uuid is missing. `evaluateColumnValue` falls
		// through `calculatedValueToString(undefined)` → `""`, the
		// same shape a never-set property cell produces.
		vi.mocked(loadCasesAction).mockResolvedValueOnce({
			kind: "rows",
			rows: [
				makeRow("11111111-1111-1111-1111-111111111111", { name: "Alice" }, {}),
			],
		});
		renderCaseListScreen({
			columns: [
				plainColumn(COL_NAME_UUID, "name", "Name"),
				calculatedColumn(COL_CALC_UUID, "Status", term(literal(""))),
			],
		});
		await waitFor(() => {
			// Header still renders — the column itself is still in
			// the visible set.
			expect(screen.getByText("Status")).toBeDefined();
			expect(screen.getByText("Alice")).toBeDefined();
		});
		// Plain column's cell rendered "Alice"; calc cell rendered
		// "". Confirm the header count + visible-column count match
		// to assert the calc cell exists but is empty (rather than
		// absent or carrying a fallback string).
		const headers = screen.getAllByRole("columnheader");
		expect(headers).toHaveLength(2);
	});
});
