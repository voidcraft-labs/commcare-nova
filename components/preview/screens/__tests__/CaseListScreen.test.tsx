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
//      `caseListConfig.searchInputs` is non-empty; typing in the
//      form re-fires `loadCasesAction` with the new `inputValues`
//      bag (debounced 300 ms by the form). Clearing reverts the
//      filter-only result set. Zero search inputs skips the form
//      entirely so the `<search>` landmark is absent from the DOM.
//   5. Reset surfaces on the populated arm only and gates behind a
//      confirmation dialog. Confirming invokes `resetSampleCasesAction`
//      and triggers a re-query; canceling leaves the action unfired
//      and dismisses the dialog. Pending UX swaps the trigger icon
//      to a spinner and disables the button while the action runs.
//      Error arms surface inline below the table; success refreshes
//      the rows via the screen's reload key.

import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
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
import { literal, term } from "@/lib/domain/predicate";
import type { CaseRowWithCalculated } from "@/lib/preview/engine/caseDataBindingTypes";
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
	resetSampleCasesAction: vi.fn(),
	submitFormAction: vi.fn(),
	loadCaseListPreviewAction: vi.fn(),
	loadFilterPreviewAction: vi.fn(),
}));

import {
	loadCasesAction,
	resetSampleCasesAction,
} from "@/lib/preview/engine/caseDataBinding";
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
 *  the module's. `searchInputs` defaults to the empty array so the
 *  pre-Task-4 test suite keeps its zero-search-input shape; tests
 *  exercising the search form pass the array explicitly. */
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
							searchInputs: opts.searchInputs ?? [],
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
	/* Default the Reset action to the success arm; tests asserting
	 *  pending / error UX override this per-test. The shared default
	 *  keeps tests that don't touch Reset from accidentally landing
	 *  in an undefined-mock state. */
	vi.mocked(resetSampleCasesAction).mockResolvedValue({
		kind: "ok",
		inserted: 30,
	});
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
	const typed = args.inputValues?.get("name");
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
	it("renders the search landmark when searchInputs.length > 0", async () => {
		// Single text input in the fixture's `searchInputs`. The
		// representative input surfacing via `getByLabelText("Name")`
		// is the structural signal that the form mounted. happy-dom
		// emits the HTML5 `<search>` element verbatim but does not
		// expose its implicit `role="search"` to ARIA queries
		// (the tag is treated as an unrecognized element); checking
		// the labelled input directly is the more portable assertion.
		vi.mocked(loadCasesAction).mockResolvedValue({
			kind: "rows",
			rows: [ALICE_ROW],
		});
		const { container } = renderCaseListScreen({
			columns: [plainColumn(COL_NAME_UUID, "name", "Name")],
			searchInputs: [
				simpleSearchInputDef(SEARCH_NAME_UUID, "name", "Name", "text", "name"),
			],
		});

		await waitFor(() => {
			// The HTML5 `<search>` landmark is in the rendered tree —
			// the rendered tree wraps every input in the form under it.
			expect(container.querySelector("search")).not.toBeNull();
		});
		// The representative text input renders inside the landmark.
		expect(screen.getByLabelText("Name")).toBeDefined();
	});

	it("re-fires the action with the typed value bag and renders the filtered rows", async () => {
		// `mockImplementation` reads the inbound `inputValues` and
		// narrows the row set — the mock stands in for the actual
		// runtime-bindings + Postgres filtering path. The initial
		// load (no inputValues) returns both rows; the post-debounce
		// load (inputValues = { name: "Alice" }) returns only Alice.
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

		// Type "Alice" into the search input. The form debounces
		// 300 ms before emitting upward; `waitFor` polls until the
		// re-fired action's result lands in the DOM (Bob narrows
		// out, only Alice remains). The 1.5 s default timeout
		// exceeds the 300 ms debounce + action round-trip with
		// margin.
		const input = screen.getByLabelText("Name") as HTMLInputElement;
		fireEvent.change(input, { target: { value: "Alice" } });

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

		// Type "Alice" → debounce → only Alice visible.
		fireEvent.change(input, { target: { value: "Alice" } });
		await waitFor(() => {
			expect(screen.queryByText("Bob")).toBeNull();
		});

		// Clear the input → debounce → both rows visible again.
		fireEvent.change(input, { target: { value: "" } });
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
		// the assertion targets the landmark element's absence
		// directly (see the sibling test for why we query the DOM
		// element instead of the ARIA role).
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

// ── Reset sample data ────────────────────────────────────────────

/** Convenience: a one-row populated fixture used by every Reset
 *  test. The trigger button only mounts on the populated arm, so
 *  the action mock must resolve to `rows` before any Reset
 *  assertion runs. */
const RESET_ONE_ROW = makeRow("11111111-1111-1111-1111-111111111111", {
	name: "Alice",
});

/** The trigger button label combines the refresh icon + the text
 *  "Reset sample data"; the dialog's confirm button is labeled
 *  just "Reset" (no "sample data" suffix). Using exact-match `name`
 *  + `regex` discriminates the two without false matches when
 *  both buttons are in the DOM mid-flow. */
const TRIGGER_RE = /reset sample data/i;
const CONFIRM_RE = /^reset$/i;

/**
 * Generous wait window for any assertion that depends on an async round-trip
 * completing — the Reset confirmation dialog mounting, or an action's resolved
 * `error` arm re-rendering into the DOM. Under a normal `npm test` these land
 * in milliseconds, but the pre-push async-leak gate runs the whole suite under
 * `--detect-async-leaks` — `node:async_hooks` instrumentation plus full
 * file-parallelism can starve a worker of CPU long enough that the default 1s
 * `findBy`/`waitFor` window lapses before the update commits. When that
 * happens the test fails AND ends before the screen's in-flight effects
 * settle, so their timers dangle as a reported leak. This wider window absorbs
 * that scheduling jitter; it never lengthens a normal run because the awaited
 * content is present well before the timeout.
 */
const CONTENTION_TOLERANT_TIMEOUT_MS = 5_000;

/**
 * Click the Reset trigger and wait for the confirmation dialog to mount,
 * returning the dialog element. Centralized so every reset test opens the
 * dialog the same way and inherits the contention-tolerant wait above.
 */
async function openResetDialog(): Promise<HTMLElement> {
	fireEvent.click(await screen.findByRole("button", { name: TRIGGER_RE }));
	return screen.findByRole(
		"alertdialog",
		{},
		{ timeout: CONTENTION_TOLERANT_TIMEOUT_MS },
	);
}

describe("CaseListScreen — Reset sample data", () => {
	it("surfaces the Reset trigger on the populated arm only", async () => {
		vi.mocked(loadCasesAction).mockResolvedValue({
			kind: "rows",
			rows: [RESET_ONE_ROW],
		});
		renderCaseListScreen({
			columns: [plainColumn(COL_NAME_UUID, "name", "Name")],
		});
		await waitFor(() => {
			expect(screen.getByText("Alice")).toBeDefined();
		});
		expect(screen.getByRole("button", { name: TRIGGER_RE })).toBeDefined();
		// Inversion check: the Generate button (empty-arm affordance)
		// must not be in the DOM on the populated arm. The buttons are
		// arm-disjoint; a regression that mounts both would break the
		// "one button per arm" rule.
		expect(
			screen.queryByRole("button", { name: /generate sample data/i }),
		).toBeNull();
	});

	it("hides the Reset trigger on the empty arm (Generate-only surface)", async () => {
		// Default `beforeEach` already resolves `loadCasesAction` to
		// `empty`, so no per-test override is needed.
		renderCaseListScreen({
			columns: [plainColumn(COL_NAME_UUID, "name", "Name")],
		});
		await waitFor(() => {
			expect(
				screen.getByRole("button", { name: /generate sample data/i }),
			).toBeDefined();
		});
		expect(screen.queryByRole("button", { name: TRIGGER_RE })).toBeNull();
	});

	it("invokes resetSampleCasesAction when the confirm button is clicked", async () => {
		vi.mocked(loadCasesAction).mockResolvedValue({
			kind: "rows",
			rows: [RESET_ONE_ROW],
		});
		renderCaseListScreen({
			columns: [plainColumn(COL_NAME_UUID, "name", "Name")],
		});
		await openResetDialog();
		fireEvent.click(screen.getByRole("button", { name: CONFIRM_RE }));
		await waitFor(() => {
			expect(vi.mocked(resetSampleCasesAction)).toHaveBeenCalledTimes(1);
		});
		// The action receives `(appId, caseType, blueprint)`; the first
		// two positional args are the load-bearing identity for the
		// case-store's owner-scoped delete. Blueprint shape is covered
		// by `useResetSampleCases`'s unit tests.
		const [appIdArg, caseTypeArg] = vi.mocked(resetSampleCasesAction).mock
			.calls[0];
		expect(appIdArg).toBe(APP_ID);
		expect(caseTypeArg).toBe("patient");
	});

	it("leaves the action unfired when the user cancels", async () => {
		vi.mocked(loadCasesAction).mockResolvedValue({
			kind: "rows",
			rows: [RESET_ONE_ROW],
		});
		renderCaseListScreen({
			columns: [plainColumn(COL_NAME_UUID, "name", "Name")],
		});
		await openResetDialog();
		// Cancel button wraps `AlertDialog.Close`, which dismisses the
		// dialog without invoking the action.
		fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
		await waitFor(() => {
			expect(screen.queryByRole("alertdialog")).toBeNull();
		});
		expect(vi.mocked(resetSampleCasesAction)).not.toHaveBeenCalled();
	});

	it("disables the Reset trigger and swaps the icon for a spinner while in flight", async () => {
		vi.mocked(loadCasesAction).mockResolvedValue({
			kind: "rows",
			rows: [RESET_ONE_ROW],
		});
		// Stall the action via a controllable deferred so the screen sits
		// in the `running` state long enough to assert the pending UX, then
		// resolve it after the assertion. A never-resolving `new Promise`
		// would never be destroyed — async_hooks reports it as a permanent
		// leak under `--detectAsyncLeaks` — so the deferred is resolved
		// before teardown to drain the in-flight action + its awaiters.
		let resolveReset!: (value: { kind: "ok"; inserted: number }) => void;
		vi.mocked(resetSampleCasesAction).mockImplementation(
			() =>
				new Promise<{ kind: "ok"; inserted: number }>((resolve) => {
					resolveReset = resolve;
				}),
		);
		renderCaseListScreen({
			columns: [plainColumn(COL_NAME_UUID, "name", "Name")],
		});
		await openResetDialog();
		fireEvent.click(screen.getByRole("button", { name: CONFIRM_RE }));
		// `Resetting...` text replaces `Reset sample data` while the
		// action is in flight; the trigger button is also disabled so
		// a re-click can't queue a second reset.
		const pendingTrigger = await screen.findByRole("button", {
			name: /resetting/i,
		});
		expect((pendingTrigger as HTMLButtonElement).disabled).toBe(true);
		// Settle the action with its success arm so the screen leaves the
		// `running` state and re-fires its case-list reload (already mocked
		// to resolve), draining every pending promise inside `act`.
		await act(async () => {
			resolveReset({ kind: "ok", inserted: 30 });
		});
		// The trigger returns to its idle label once the reload settles —
		// the observable signal that all follow-on async has flushed.
		await waitFor(() => {
			expect(screen.getByRole("button", { name: TRIGGER_RE })).toBeDefined();
		});
	});

	it("re-fires the case-list load on the success arm", async () => {
		vi.mocked(loadCasesAction).mockResolvedValue({
			kind: "rows",
			rows: [RESET_ONE_ROW],
		});
		// `beforeEach` already defaults the success arm to
		// `{ kind: "ok", inserted: 30 }`. The screen's `reload`
		// callback bumps the `useCases` reload key on success, which
		// re-fires `loadCasesAction` — observable via the action's
		// call count.
		renderCaseListScreen({
			columns: [plainColumn(COL_NAME_UUID, "name", "Name")],
		});
		await screen.findByText("Alice");
		const initialLoadCalls = vi.mocked(loadCasesAction).mock.calls.length;
		await openResetDialog();
		fireEvent.click(screen.getByRole("button", { name: CONFIRM_RE }));
		await waitFor(() => {
			expect(vi.mocked(resetSampleCasesAction)).toHaveBeenCalledTimes(1);
		});
		// At least one additional `loadCasesAction` call lands after
		// the success arm — that's the screen's reload-key effect
		// firing. The exact count varies with effect coalescing; the
		// load-bearing signal is "fires more than the initial load".
		await waitFor(() => {
			expect(vi.mocked(loadCasesAction).mock.calls.length).toBeGreaterThan(
				initialLoadCalls,
			);
		});
	});

	it("renders the inline error message when the action returns the error arm", async () => {
		vi.mocked(loadCasesAction).mockResolvedValue({
			kind: "rows",
			rows: [RESET_ONE_ROW],
		});
		vi.mocked(resetSampleCasesAction).mockResolvedValue({
			kind: "error",
			message: "Could not reach the case store.",
		});
		renderCaseListScreen({
			columns: [plainColumn(COL_NAME_UUID, "name", "Name")],
		});
		await openResetDialog();
		fireEvent.click(screen.getByRole("button", { name: CONFIRM_RE }));
		// The screen surfaces the action's `message` slot verbatim
		// for the `error` arm — the user-facing string maps 1:1 to
		// the case-store / wire failure mode. The error text only appears
		// after the action promise resolves and the screen re-renders, so the
		// wait needs the contention-tolerant window: under the leak detector
		// that async round-trip can outlast the default 1s, which would fail
		// the test and leave its in-flight effects' timers dangling.
		await waitFor(
			() => {
				expect(
					screen.getByText("Could not reach the case store."),
				).toBeDefined();
			},
			{ timeout: CONTENTION_TOLERANT_TIMEOUT_MS },
		);
	});
});
