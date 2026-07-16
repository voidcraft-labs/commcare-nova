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
//      values in their cells. The case-store's `query` materializes
//      calc values keyed by uuid (via the optional `calculated`
//      projection arg); the screen reads the slot directly via
//      `evaluateColumnValue` — no AST evaluation in the preview
//      layer.
//   4. Search-input form mounts above the rows when the module's
//      `caseListConfig.searchInputs` is non-empty; its authored button
//      submits the latest input bag and only then re-fires
//      `loadCasesAction`. Clearing reverts the filter-only result set.
//      Zero search inputs skips the form entirely so the `<search>`
//      landmark is absent from the DOM.
//   5. Row click opens the case detail in place (detail fields
//      configured → confirm step), and the detail's Continue fires
//      `navigate.openForm` with the module's first form — the same
//      case-select → confirm → form flow the shipped app runs.

import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BlueprintDocProvider } from "@/lib/doc/provider";
import { asUuid } from "@/lib/doc/types";
import {
	asUuid as asDomainUuid,
	calculatedColumn,
	plainColumn,
	simpleSearchInputDef,
} from "@/lib/domain";
import type { Predicate, ValueExpression } from "@/lib/domain/predicate";
import {
	eq,
	literal,
	prop,
	sessionContext,
	term,
} from "@/lib/domain/predicate";
import type { CaseRowWithCalculated } from "@/lib/preview/engine/caseDataBindingTypes";
import type { Location } from "@/lib/routing/types";

// ── Mocks ────────────────────────────────────────────────────────

const APP_ID = "app-case-list-screen-test";
const MODULE_UUID = asUuid("00000000-0000-0000-0000-000000000a01");
/** The module's registration form — first in order, but NOT a case-loading
 *  form, so selecting a case must never continue into it. */
const FORM_UUID = asUuid("00000000-0000-0000-0000-000000000a02");
/** The followup form — the case-loading form a selected case continues into. */
const FOLLOWUP_FORM_UUID = asUuid("00000000-0000-0000-0000-000000000a03");
const SELECTED_CASE_ID = "11111111-1111-1111-1111-111111111111";

/** Mocked `useSetPreviewCaseTarget` — asserts the selected case datum is
 *  recorded for the form before navigation. */
const setPreviewCaseTargetMock = vi.fn();

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
		usePreviewCaseTarget: () => undefined,
		useSetPreviewCaseTarget: () => setPreviewCaseTargetMock,
		useSetPreviewSelectedCase: () => vi.fn(),
	};
});

vi.mock("@/lib/auth/hooks/useAuth", () => ({
	useAuth: () => ({
		user: {
			id: "owner-test",
			name: "Preview Worker",
			email: "preview@example.org",
		},
	}),
}));

// Server Actions live in a `"use server"` module. Mock the action
// directly so the screen renders synchronously without spinning up
// auth + Postgres. The `useCases` hook calls `loadCasesAction`;
// each test resolves the mock with the discriminated arm it wants
// to assert against (rows / empty / etc).
vi.mock("@/lib/preview/engine/caseDataBinding", () => ({
	loadCasesAction: vi.fn(),
	loadCaseDataAction: vi.fn(),
	populateSampleCasesAction: vi.fn(),
	resetSampleCasesAction: vi.fn(),
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
		external_id: null,
		parent_case_id: null,
		properties: properties as never,
		calculated: calculated as never,
	} as CaseRowWithCalculated;
}

/** Mount the screen against a doc seeded with the fixture
 *  `caseListConfig`. The provider's `initialDoc` shape mirrors the
 *  stored `PersistableDoc` — a fresh module carrying our
 *  fixture columns + a single first-form whose name differs from
 *  the module's. `searchInputs` defaults to the empty array so the
 *  pre-Task-4 test suite keeps its zero-search-input shape; tests
 *  exercising the search form pass the array explicitly. */
/** Second case-loading form's uuid — only added to the fixture when a test
 *  needs the multi-form (form-menu) path. */
const CLOSE_FORM_UUID = asUuid("00000000-0000-0000-0000-000000000a04");

function renderCaseListScreen(opts: {
	columns: NonNullable<
		Parameters<typeof BlueprintDocProvider>[0]["initialDoc"]
	>["modules"][string]["caseListConfig"] extends infer C
		? C extends { columns: infer X }
			? X
			: never
		: never;
	searchInputs?: NonNullable<
		Parameters<typeof BlueprintDocProvider>[0]["initialDoc"]
	>["modules"][string]["caseListConfig"] extends infer C
		? C extends { searchInputs: infer X }
			? X
			: never
		: never;
	filter?: Predicate;
	searchButtonLabel?: string;
	searchButtonDisplayCondition?: Predicate;
	excludedOwnerIds?: ValueExpression;
	/** Add a second case-loading form (Close Case) to exercise the
	 *  post-selection form menu. */
	secondCaseLoadingForm?: boolean;
}) {
	const extraForms = opts.secondCaseLoadingForm
		? {
				[CLOSE_FORM_UUID]: {
					uuid: CLOSE_FORM_UUID,
					id: "close_form",
					name: "Close Case",
					type: "close" as const,
				},
			}
		: {};
	const extraFormOrder = opts.secondCaseLoadingForm ? [CLOSE_FORM_UUID] : [];
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
							searchInputs: opts.searchInputs ?? [],
							...(opts.filter !== undefined && { filter: opts.filter }),
						},
						...(opts.searchButtonLabel !== undefined ||
						opts.searchButtonDisplayCondition !== undefined ||
						opts.excludedOwnerIds !== undefined
							? {
									caseSearchConfig: {
										...(opts.searchButtonLabel !== undefined && {
											searchButtonLabel: opts.searchButtonLabel,
										}),
										...(opts.searchButtonDisplayCondition !== undefined && {
											searchButtonDisplayCondition:
												opts.searchButtonDisplayCondition,
										}),
										...(opts.excludedOwnerIds !== undefined && {
											excludedOwnerIds: opts.excludedOwnerIds,
										}),
									},
								}
							: {}),
					},
				},
				forms: {
					[FORM_UUID]: {
						uuid: FORM_UUID,
						id: "registration_form",
						name: FIRST_FORM_NAME,
						type: "registration",
					},
					[FOLLOWUP_FORM_UUID]: {
						uuid: FOLLOWUP_FORM_UUID,
						id: "followup_form",
						name: "Follow-up Visit",
						type: "followup",
					},
					...extraForms,
				},
				fields: {},
				moduleOrder: [MODULE_UUID],
				formOrder: {
					[MODULE_UUID]: [FORM_UUID, FOLLOWUP_FORM_UUID, ...extraFormOrder],
				},
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

/* No `afterEach(mockReset)` — clearing the action mock's
 *  implementation between tests intermittently raced with effects
 *  scheduled by the just-finished test, leaving the pending
 *  `loadCasesAction(...).then(...)` chain calling an unimplemented
 *  mock. `clearMocks: true` in `vitest.config.ts` already wipes
 *  `mock.calls` between tests; each test's own `mockResolvedValue`
 *  / `mockImplementation` cleanly overrides the carried-over
 *  implementation. */

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
			// The wide header and compact card label both carry the visible
			// field name; the cell carries its value.
			expect(screen.getAllByText("Name").length).toBeGreaterThan(0);
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
			expect(screen.getAllByText("Name").length).toBeGreaterThan(0);
			expect(screen.getAllByText("Age").length).toBeGreaterThan(0);
			expect(screen.getByText("Alice")).toBeDefined();
			expect(screen.getByText("30")).toBeDefined();
		});
	});
});

// ── Independent Results / Details order ─────────────────────────

describe("CaseListScreen — per-surface field order", () => {
	it("reorders Results without rearranging the Details screen", async () => {
		vi.mocked(loadCasesAction).mockResolvedValueOnce({
			kind: "rows",
			rows: [
				makeRow(SELECTED_CASE_ID, {
					name: "Alice",
					age: 30,
				}),
			],
		});
		const { container } = renderCaseListScreen({
			columns: [
				plainColumn(COL_NAME_UUID, "name", "Name", {
					listOrder: "b",
					detailOrder: "a",
				}),
				plainColumn(COL_AGE_UUID, "age", "Age", {
					listOrder: "a",
					detailOrder: "b",
				}),
			],
		});

		const row = await screen.findByRole("button", { name: /Alice/ });
		expect(
			Array.from(row.querySelectorAll("[data-case-result-field]")).map((node) =>
				node.getAttribute("data-case-result-field"),
			),
		).toEqual([COL_AGE_UUID, COL_NAME_UUID]);

		fireEvent.click(row);
		await screen.findByRole("heading", { name: "Alice" });
		const detail = container.querySelector('[data-case-detail="responsive"]');
		expect(
			Array.from(
				detail?.querySelectorAll("[data-case-detail-field]") ?? [],
			).map((node) => node.getAttribute("data-case-detail-field")),
		).toEqual([COL_NAME_UUID, COL_AGE_UUID]);
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
			expect(screen.getAllByText("Status").length).toBeGreaterThan(0);
			// The header row carries the calc column's `header`; the
			// body cell carries its materialized `calculated` value.
			expect(screen.getByText("Alice — overdue")).toBeDefined();
		});
	});

	it("renders the placeholder cell when row.calculated[col.uuid] is absent", async () => {
		// Calc map keyed only by the plain column's slot — the calc
		// column's uuid is missing. `renderColumnCell` falls through
		// `renderCalculatedCell(undefined)` → the "—" placeholder, the
		// same shape every authoring-surface preview renders for a
		// never-set value.
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
			expect(screen.getAllByText("Status").length).toBeGreaterThan(0);
			expect(screen.getByText("Alice")).toBeDefined();
		});
		// Plain column's cell rendered "Alice"; the calc cell rendered
		// the "—" placeholder — present in Alice's row, not absent.
		const row = screen.getByRole("button", { name: /Alice/ });
		expect(row.textContent).toContain("—");
	});
});

// ── Responsive result layout ─────────────────────────────────────

describe("CaseListScreen — responsive results", () => {
	it("keeps every visible field in a labelled card without a horizontal-scroll minimum", async () => {
		vi.mocked(loadCasesAction).mockResolvedValueOnce({
			kind: "rows",
			rows: [
				makeRow(
					SELECTED_CASE_ID,
					{ name: "Alice", age: 30 },
					{ [COL_CALC_UUID]: "Needs follow-up" },
				),
			],
		});
		const { container } = renderCaseListScreen({
			columns: [
				plainColumn(COL_NAME_UUID, "name", "Name"),
				plainColumn(COL_AGE_UUID, "age", "Age"),
				calculatedColumn(COL_CALC_UUID, "Status", term(literal(""))),
			],
		});

		await waitFor(() => {
			expect(screen.getByText("Alice")).toBeDefined();
		});

		const results = container.querySelector<HTMLElement>(
			'[data-case-results="responsive"]',
		);
		expect(results).not.toBeNull();
		expect(results?.className).toContain("@container/results");
		expect(results?.className).not.toContain("overflow-x-auto");
		expect(results?.querySelector('[style*="min-width"]')).toBeNull();

		const row = screen.getByRole("button", { name: /Alice/ });
		const rowQueries = within(row);
		const accessibleNameLabel = rowQueries.getByText("Name");
		expect(accessibleNameLabel.className).toContain("@xl/results:sr-only");
		expect(accessibleNameLabel.className).not.toContain("@xl/results:hidden");
		expect(rowQueries.getByText("Age")).toBeDefined();
		expect(rowQueries.getByText("Status")).toBeDefined();
		expect(rowQueries.getByText("30")).toBeDefined();
		expect(rowQueries.getByText("Needs follow-up")).toBeDefined();
		// Three fields graduate to the aligned presentation only when this
		// result container itself reaches Tailwind's xl container width.
		expect(row.className).toContain("@xl/results:grid");
		expect(
			results
				?.querySelector("[data-case-results-header]")
				?.getAttribute("aria-hidden"),
		).toBe("true");
	});

	it.each([
		[3, "@xl/results:grid"],
		[4, "@2xl/results:grid"],
		[5, "@3xl/results:grid"],
		[6, "@4xl/results:grid"],
		[7, null],
	] as const)("uses the count-aware responsive threshold for %i fields", async (count, expectedClass) => {
		const columns = Array.from({ length: count }, (_, index) =>
			plainColumn(
				asDomainUuid(
					`00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
				),
				`field_${index + 1}`,
				`Field ${index + 1}`,
			),
		);
		const properties = Object.fromEntries(
			columns.map((column, index) => [
				column.kind === "plain" ? column.field : `field_${index + 1}`,
				`Value ${index + 1}`,
			]),
		);
		vi.mocked(loadCasesAction).mockResolvedValueOnce({
			kind: "rows",
			rows: [makeRow(SELECTED_CASE_ID, properties)],
		});
		renderCaseListScreen({ columns });

		const row = await screen.findByRole("button", { name: /Value 1/ });
		if (expectedClass === null) {
			expect(row.className).not.toContain("/results:grid");
		} else {
			expect(row.className).toContain(expectedClass);
		}
	});
});

// ── Search-input form mount ──────────────────────────────────────

/** Per-input uuid used by every search-form test. A single uuid
 *  keeps the fixture readable; the input's `name` slot keys the
 *  emitted value bag and is what `loadCasesAction`'s mock implementation
 *  inspects to decide which rows to return. */
const SEARCH_NAME_UUID = asDomainUuid("00000000-0000-0000-0000-000000000d01");

/** Two-row population used across the typing / clearing tests.
 *  `loadCasesAction`'s mock implementation reads the inbound
 *  `inputValues` map and narrows the return set to rows whose
 *  `name` property matches — the screen's contract is that a
 *  fresh-reference `inputValues` triggers the action's re-fire,
 *  and the test asserts the resulting render reflects the new
 *  row set. The mock stands in for the runtime-bindings predicate
 *  + Postgres execution path; the wire-side filtering is exercised
 *  by the runtime-bindings unit tests. */
const ALICE_ROW = makeRow("11111111-1111-1111-1111-111111111111", {
	name: "Alice",
});
const BOB_ROW = makeRow("22222222-2222-2222-2222-222222222222", {
	name: "Bob",
});

/** Mock implementation for `loadCasesAction` that filters the
 *  two-row population by the `name` input's typed value. Stands
 *  in for the runtime-bindings + Postgres execution path: the
 *  CaseListScreen's contract is that a fresh `inputValues` map
 *  triggers `useCases`'s effect re-fire, and the resulting render
 *  reflects whatever rows the action returns. The wire-side
 *  filtering correctness is covered by the runtime-bindings unit
 *  tests; this mock asserts only the action-call-and-render loop. */
function filterByNameInputValue(
	args: Parameters<typeof loadCasesAction>[0],
): ReturnType<typeof loadCasesAction> {
	// `inputValues` crosses the wire as a plain object bag (not a `Map`)
	// so the Server Action call stays plain JSON rather than multipart.
	const typed = args.inputValues?.name;
	if (typed === undefined || typed === "") {
		return Promise.resolve({ kind: "rows", rows: [ALICE_ROW, BOB_ROW] });
	}
	const matched = [ALICE_ROW, BOB_ROW].filter(
		(row) => (row.properties as Record<string, unknown>).name === typed,
	);
	if (matched.length === 0) return Promise.resolve({ kind: "empty" });
	return Promise.resolve({ kind: "rows", rows: matched });
}

describe("CaseListScreen — search-input form", () => {
	const searchInput = simpleSearchInputDef(
		SEARCH_NAME_UUID,
		"name",
		"Name",
		"text",
		"name",
	);

	it("hides Search when a nested static condition simplifies to false", async () => {
		vi.mocked(loadCasesAction).mockResolvedValue({
			kind: "rows",
			rows: [ALICE_ROW],
		});
		renderCaseListScreen({
			columns: [plainColumn(COL_NAME_UUID, "name", "Name")],
			searchInputs: [searchInput],
			searchButtonDisplayCondition: {
				kind: "not",
				clause: { kind: "match-all" },
			},
		});

		await waitFor(() => expect(screen.getByLabelText("Name")).toBeDefined());
		expect(screen.queryByRole("button", { name: "Search" })).toBeNull();
	});

	it("keeps Search visible for a dynamic condition the preview cannot prove false", async () => {
		vi.mocked(loadCasesAction).mockResolvedValue({
			kind: "rows",
			rows: [ALICE_ROW],
		});
		renderCaseListScreen({
			columns: [plainColumn(COL_NAME_UUID, "name", "Name")],
			searchInputs: [searchInput],
			searchButtonDisplayCondition: eq(
				prop("patient", "case_name"),
				literal("Alice"),
			),
		});

		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Search" })).toBeDefined(),
		);
	});

	it("renders the search landmark when searchInputs.length > 0", async () => {
		// Single text input in the fixture's `searchInputs`. The
		// representative input surfacing via `getByLabelText("Name")`
		// is the structural signal that the form mounted. happy-dom emits the
		// HTML5 element but does not expose its implicit role to ARIA queries.
		vi.mocked(loadCasesAction).mockResolvedValue({
			kind: "rows",
			rows: [ALICE_ROW],
		});
		const { container } = renderCaseListScreen({
			columns: [plainColumn(COL_NAME_UUID, "name", "Name")],
			searchInputs: [
				simpleSearchInputDef(SEARCH_NAME_UUID, "name", "Name", "text", "name"),
			],
			searchButtonLabel: "Find patients",
		});

		await waitFor(() => {
			// One `<search>` landmark wraps every input in the form.
			expect(container.querySelector("search")).not.toBeNull();
		});
		// The representative text input renders inside the landmark.
		expect(screen.getByLabelText("Name")).toBeDefined();
		expect(screen.getByRole("button", { name: "Find patients" })).toBeDefined();
	});

	it("seeds authored literal and session defaults without searching until submit", async () => {
		vi.mocked(loadCasesAction).mockImplementation(filterByNameInputValue);
		const sessionSeed = simpleSearchInputDef(
			asDomainUuid("00000000-0000-4000-8000-000000000e02"),
			"worker",
			"Worker",
			"text",
			"owner_id",
			{ default: term(sessionContext("userid")) },
		);
		const literalSeed = simpleSearchInputDef(
			SEARCH_NAME_UUID,
			"name",
			"Name",
			"text",
			"name",
			{ default: term(literal("Alice")) },
		);

		renderCaseListScreen({
			columns: [plainColumn(COL_NAME_UUID, "name", "Name")],
			searchInputs: [literalSeed, sessionSeed],
		});

		await waitFor(() => {
			expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
				"Alice",
			);
			expect((screen.getByLabelText("Worker") as HTMLInputElement).value).toBe(
				"owner-test",
			);
		});
		// Defaults populate prompts; they become query criteria only when the
		// worker performs the authored Search action.
		expect(screen.getByText("Bob")).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: "Search" }));
		await waitFor(() => expect(screen.queryByText("Bob")).toBeNull());
		expect(vi.mocked(loadCasesAction)).toHaveBeenLastCalledWith(
			expect.objectContaining({
				inputValues: expect.objectContaining({
					name: "Alice",
					worker: "owner-test",
				}),
			}),
		);
	});

	it("applies ownership exclusions only after the worker submits Search", async () => {
		vi.mocked(loadCasesAction).mockResolvedValue({
			kind: "rows",
			rows: [ALICE_ROW],
		});
		const excludedOwnerIds = term(sessionContext("userid"));
		renderCaseListScreen({
			columns: [plainColumn(COL_NAME_UUID, "name", "Name")],
			searchInputs: [searchInput],
			excludedOwnerIds,
		});

		await waitFor(() => expect(screen.getByText("Alice")).toBeDefined());
		expect(vi.mocked(loadCasesAction).mock.calls.length).toBeGreaterThan(0);
		for (const [args] of vi.mocked(loadCasesAction).mock.calls) {
			expect(args.excludedOwnerIdsExpression).toBeUndefined();
		}

		// A blank submit is still an explicit Search action and activates the
		// authored ownership rule even though there are no non-empty criteria.
		fireEvent.click(screen.getByRole("button", { name: "Search" }));
		await waitFor(() => {
			expect(vi.mocked(loadCasesAction)).toHaveBeenLastCalledWith(
				expect.objectContaining({
					excludedOwnerIdsExpression: excludedOwnerIds,
				}),
			);
		});
	});

	it("applies ownership exclusions immediately for genuine filter-only search", async () => {
		vi.mocked(loadCasesAction).mockResolvedValue({
			kind: "rows",
			rows: [ALICE_ROW],
		});
		const excludedOwnerIds = term(sessionContext("userid"));
		renderCaseListScreen({
			columns: [plainColumn(COL_NAME_UUID, "name", "Name")],
			searchInputs: [],
			filter: eq(prop("patient", "name"), literal("Alice")),
			excludedOwnerIds,
		});

		await waitFor(() => expect(screen.getByText("Alice")).toBeDefined());
		expect(vi.mocked(loadCasesAction)).toHaveBeenCalledWith(
			expect.objectContaining({ excludedOwnerIdsExpression: excludedOwnerIds }),
		);
	});

	it("does not treat ownership settings alone as a filter-only launch", async () => {
		vi.mocked(loadCasesAction).mockResolvedValue({
			kind: "rows",
			rows: [ALICE_ROW],
		});
		const excludedOwnerIds = term(sessionContext("userid"));
		renderCaseListScreen({
			columns: [plainColumn(COL_NAME_UUID, "name", "Name")],
			searchInputs: [],
			excludedOwnerIds,
		});

		await waitFor(() => expect(screen.getByText("Alice")).toBeDefined());
		for (const [args] of vi.mocked(loadCasesAction).mock.calls) {
			expect(args.excludedOwnerIdsExpression).toBeUndefined();
		}
	});

	it("re-fires the action with the typed value bag and renders the filtered rows", async () => {
		// `mockImplementation` reads the inbound `inputValues` and
		// narrows the row set — the mock stands in for the actual
		// runtime-bindings + Postgres filtering path. The initial
		// load (no inputValues) returns both rows; the submitted search
		// (inputValues = { name: "Alice" }) returns only Alice.
		vi.mocked(loadCasesAction).mockImplementation(filterByNameInputValue);

		renderCaseListScreen({
			columns: [plainColumn(COL_NAME_UUID, "name", "Name")],
			searchInputs: [
				simpleSearchInputDef(SEARCH_NAME_UUID, "name", "Name", "text", "name"),
			],
		});

		// Initial load completes — both rows visible.
		await waitFor(() => {
			expect(screen.getByText("Alice")).toBeDefined();
			expect(screen.getByText("Bob")).toBeDefined();
		});

		// Typing alone leaves the current results intact. Submitting uses
		// the form's latest local draft immediately, so it cannot lose a
		// final keystroke to the draft-state debounce.
		const input = screen.getByLabelText("Name") as HTMLInputElement;
		fireEvent.change(input, { target: { value: "Alice" } });
		expect(screen.getByText("Bob")).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: "Search" }));

		await waitFor(() => {
			expect(screen.queryByText("Bob")).toBeNull();
		});
		expect(screen.getByText("Alice")).toBeDefined();
	});

	it("reverts to the filter-only result set after the user clears the input", async () => {
		// Same mock implementation as the typing test — the value bag
		// drives row narrowing. Clearing the text input emits an
		// empty value bag, which the implementation maps to the full
		// row population.
		vi.mocked(loadCasesAction).mockImplementation(filterByNameInputValue);

		renderCaseListScreen({
			columns: [plainColumn(COL_NAME_UUID, "name", "Name")],
			searchInputs: [
				simpleSearchInputDef(SEARCH_NAME_UUID, "name", "Name", "text", "name"),
			],
		});

		// Initial load completes — both rows.
		await waitFor(() => {
			expect(screen.getByText("Alice")).toBeDefined();
			expect(screen.getByText("Bob")).toBeDefined();
		});

		const input = screen.getByLabelText("Name") as HTMLInputElement;

		// Type and submit Alice → only Alice visible.
		fireEvent.change(input, { target: { value: "Alice" } });
		fireEvent.click(screen.getByRole("button", { name: "Search" }));
		await waitFor(() => {
			expect(screen.queryByText("Bob")).toBeNull();
		});

		// The contextual Clear action resets both the draft and the submitted
		// query, restoring the filter-only rows in one click.
		fireEvent.click(screen.getByRole("button", { name: "Clear" }));
		await waitFor(() => {
			expect(screen.getByText("Bob")).toBeDefined();
		});
		expect(screen.getByText("Alice")).toBeDefined();
	});

	it("does not render the search landmark when searchInputs is empty", async () => {
		// Zero-input config: the form's empty-list short-circuit
		// returns `null`, AND the screen's mount gate skips the
		// container entirely. Either failure mode would surface a
		// labelled-but-empty `<search>` landmark to assistive tech;
		// the assertion targets the landmark element's absence directly.
		vi.mocked(loadCasesAction).mockResolvedValue({
			kind: "rows",
			rows: [ALICE_ROW],
		});
		const { container } = renderCaseListScreen({
			columns: [plainColumn(COL_NAME_UUID, "name", "Name")],
			searchInputs: [],
		});

		// Wait for the initial load to settle so the absence
		// assertion is meaningful (the screen reached the rows arm,
		// not the pre-mount loading state).
		await waitFor(() => {
			expect(screen.getByText("Alice")).toBeDefined();
		});
		expect(container.querySelector("search")).toBeNull();
	});
});

// ── Row click → detail → Continue ────────────────────────────────

describe("CaseListScreen — detail confirm step", () => {
	it("row click opens the detail in place; Continue fires openForm with the case-loading form and records the selected case", async () => {
		// Both columns default `visibleInDetail` → the detail confirm
		// step is configured, so the row click opens it in place
		// rather than navigating.
		vi.mocked(loadCasesAction).mockResolvedValue({
			kind: "rows",
			rows: [
				makeRow(SELECTED_CASE_ID, {
					name: "Alice",
					age: 30,
				}),
			],
		});
		const { container } = renderCaseListScreen({
			columns: [
				plainColumn(COL_NAME_UUID, "name", "Name"),
				plainColumn(COL_AGE_UUID, "age", "Age"),
			],
		});
		await waitFor(() => {
			expect(screen.getByText("Alice")).toBeDefined();
		});

		// Click the row — the detail pane replaces the results in
		// place (no navigation yet).
		fireEvent.click(screen.getByRole("button", { name: /Alice/ }));
		expect(navigateMock.openForm).not.toHaveBeenCalled();
		expect(screen.getByRole("heading", { name: "Alice" })).toBeDefined();
		expect(
			screen.getByRole("button", { name: /Back to Results/ }),
		).toBeDefined();
		const detail = container.querySelector<HTMLElement>(
			'[data-case-detail="responsive"]',
		);
		expect(detail?.className).toContain("@container/detail");
		const detailValues = detail?.querySelectorAll<HTMLElement>(
			"[data-case-detail-value]",
		);
		expect(detailValues?.length).toBe(2);
		for (const value of detailValues ?? []) {
			expect(value.className).toContain("break-words");
			expect(value.className).not.toContain("whitespace-nowrap");
			expect(value.className).not.toContain("text-ellipsis");
		}

		// Continue — the confirm step ends in the module's case-loading
		// form (the followup, NOT the order-zero registration form), with
		// the selected case datum recorded for preload.
		fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
		expect(setPreviewCaseTargetMock).toHaveBeenCalledWith({
			formUuid: FOLLOWUP_FORM_UUID,
			caseId: SELECTED_CASE_ID,
			caseName: "Alice",
		});
		expect(navigateMock.openForm).toHaveBeenCalledWith(
			MODULE_UUID,
			FOLLOWUP_FORM_UUID,
		);
		/* Continuing collapses the detail-confirm sub-screen — the case list
		 *  is retained across navigation, so it must be back at the list (not
		 *  the stale confirm) when the user navigates back from the form. */
		expect(
			screen.queryByRole("button", { name: /Back to Results/ }),
		).toBeNull();
	});

	it("row click navigates straight to the case-loading form when no detail fields are configured", async () => {
		// Every column opts out of the detail — CommCare skips the
		// confirm step in this shape, so the row click goes straight
		// into the form with the case in hand.
		vi.mocked(loadCasesAction).mockResolvedValue({
			kind: "rows",
			rows: [makeRow(SELECTED_CASE_ID, { name: "Alice" })],
		});
		renderCaseListScreen({
			columns: [
				plainColumn(COL_NAME_UUID, "name", "Name", {
					visibleInDetail: false,
				}),
			],
		});
		await waitFor(() => {
			expect(screen.getByText("Alice")).toBeDefined();
		});

		fireEvent.click(screen.getByRole("button", { name: /Alice/ }));
		expect(setPreviewCaseTargetMock).toHaveBeenCalledWith({
			formUuid: FOLLOWUP_FORM_UUID,
			caseId: SELECTED_CASE_ID,
			caseName: "Alice",
		});
		expect(navigateMock.openForm).toHaveBeenCalledWith(
			MODULE_UUID,
			FOLLOWUP_FORM_UUID,
		);
	});
});

// ── Form menu (case-first, multiple case-loading forms) ───────────

describe("CaseListScreen — post-selection form menu", () => {
	it("shows a form menu after selecting a case when the module has more than one case-loading form, and continues into the chosen form with the case", async () => {
		// Two case-loading forms (Follow-up Visit + Close Case) share the
		// case list. With no specific form seeded (case-first entry), CommCare
		// shows the case list, then a menu of those forms — so selecting a case
		// must NOT silently pick one.
		vi.mocked(loadCasesAction).mockResolvedValue({
			kind: "rows",
			rows: [makeRow(SELECTED_CASE_ID, { name: "Alice", age: 30 })],
		});
		renderCaseListScreen({
			columns: [
				plainColumn(COL_NAME_UUID, "name", "Name"),
				plainColumn(COL_AGE_UUID, "age", "Age"),
			],
			secondCaseLoadingForm: true,
		});
		await waitFor(() => {
			expect(screen.getByText("Alice")).toBeDefined();
		});

		// Row → detail confirm → Continue.
		fireEvent.click(screen.getByRole("button", { name: /Alice/ }));
		fireEvent.click(screen.getByRole("button", { name: /Continue/ }));

		// No navigation yet — the form menu is shown instead.
		expect(navigateMock.openForm).not.toHaveBeenCalled();
		const followupChoice = screen.getByRole("button", {
			name: /Follow-up Visit/,
		});
		const closeChoice = screen.getByRole("button", { name: /Close Case/ });
		expect(followupChoice).toBeDefined();
		expect(closeChoice).toBeDefined();

		// Choosing Close Case carries the selected case into that form.
		fireEvent.click(closeChoice);
		expect(setPreviewCaseTargetMock).toHaveBeenCalledWith({
			formUuid: CLOSE_FORM_UUID,
			caseId: SELECTED_CASE_ID,
			caseName: "Alice",
		});
		expect(navigateMock.openForm).toHaveBeenCalledWith(
			MODULE_UUID,
			CLOSE_FORM_UUID,
		);
	});

	it("skips the menu and goes straight to the form when only one case-loading form exists", async () => {
		// The single-form module: no menu, the case goes straight into the form.
		vi.mocked(loadCasesAction).mockResolvedValue({
			kind: "rows",
			rows: [makeRow(SELECTED_CASE_ID, { name: "Alice" })],
		});
		renderCaseListScreen({
			columns: [
				plainColumn(COL_NAME_UUID, "name", "Name", { visibleInDetail: false }),
			],
		});
		await waitFor(() => {
			expect(screen.getByText("Alice")).toBeDefined();
		});

		fireEvent.click(screen.getByRole("button", { name: /Alice/ }));
		// Straight to the form — no Close Case choice rendered.
		expect(screen.queryByRole("button", { name: /Close Case/ })).toBeNull();
		expect(navigateMock.openForm).toHaveBeenCalledWith(
			MODULE_UUID,
			FOLLOWUP_FORM_UUID,
		);
	});
});
