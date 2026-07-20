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
//   4. A relevant Search action with authored inputs mounts the form above the
//      rows; its authored button submits the latest input bag and only then
//      re-fires `loadCasesAction`. The action condition gates that whole pane
//      from pre-prompt session context, never from the draft. Clearing reverts
//      the filter-only result set. Zero inputs skips the form entirely so the
//      `<search>` landmark is absent from the DOM.
//   5. Row click opens the case detail in place (detail fields
//      configured → confirm step), and the detail's Continue fires
//      `navigate.openForm` with the module's first form — the same
//      case-select → confirm → form flow the shipped app runs.

import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import {
	BlueprintDocProvider,
	type BlueprintDocStore,
} from "@/lib/doc/provider";
import { asUuid } from "@/lib/doc/types";
import {
	asUuid as asDomainUuid,
	type CaseProperty,
	calculatedColumn,
	phoneColumn,
	plainColumn,
	simpleSearchInputDef,
} from "@/lib/domain";
import type { Predicate, ValueExpression } from "@/lib/domain/predicate";
import {
	dateAdd,
	eq,
	literal,
	prop,
	sessionContext,
	term,
	today,
} from "@/lib/domain/predicate";
import type { CaseRowWithCalculated } from "@/lib/preview/engine/caseDataBindingTypes";
import { invalidateCaseData } from "@/lib/preview/hooks/caseDataInvalidation";
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
const setPreviewSelectedCaseMock = vi.fn();
const signInMock = vi.fn(() => Promise.resolve());
let canEditMock = true;

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
let currentLocation: Location = {
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
		useCanEdit: () => canEditMock,
		usePreviewCaseTarget: () => undefined,
		useSetPreviewCaseTarget: () => setPreviewCaseTargetMock,
		useSetPreviewSelectedCase: () => setPreviewSelectedCaseMock,
	};
});

vi.mock("@/lib/auth/hooks/useAuth", () => ({
	useAuth: () => ({
		user: {
			id: "owner-test",
			name: "Preview Worker",
			email: "preview@example.org",
		},
		signIn: signInMock,
	}),
}));

// Server Actions live in a `"use server"` module. Mock the action
// directly so the screen renders synchronously without spinning up
// auth + Postgres. The `useCases` hook calls `loadCasesAction`;
// each test resolves the mock with the discriminated arm it wants
// to assert against (rows / empty / etc).
vi.mock("@/lib/preview/engine/caseDataBinding", () => ({
	loadCasesAction: vi.fn(),
	loadCaseCountAction: vi.fn(),
	loadCaseDataAction: vi.fn(),
	submitFormAction: vi.fn(),
	loadFilterPreviewAction: vi.fn(),
}));

import {
	loadCaseCountAction,
	loadCaseDataAction,
	loadCasesAction,
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
const COL_PHONE_UUID = asDomainUuid("00000000-0000-0000-0000-000000000c05");

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

let capturedDocStore: BlueprintDocStore | undefined;

function CaptureDocStore() {
	capturedDocStore = useBlueprintDocApi();
	return null;
}

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
	searchScreenTitle?: string;
	searchButtonLabel?: string;
	searchButtonDisplayCondition?: Predicate;
	excludedOwnerIds?: ValueExpression;
	/** Store the explicit zero-input Search marker, or its internal
	 * owner-only provenance marker. Omit to exercise legacy/absent config. */
	searchAction?: "enabled" | "disabled";
	caseProperties?: readonly CaseProperty[];
	moduleName?: string;
	/** Omit the route's module to exercise a stale preview location. */
	omitModule?: boolean;
	/** Point the module at a missing case type to exercise setup guidance. */
	moduleCaseType?: string;
	followupFormName?: string;
	/** Add a second case-loading form (Close Case) to exercise the
	 *  post-selection form menu. */
	secondCaseLoadingForm?: boolean;
	/** Omit every case-loading form so Results is informational only. */
	includeCaseLoadingForm?: boolean;
}) {
	const includeCaseLoadingForm = opts.includeCaseLoadingForm !== false;
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
	const tree = () => (
		<BlueprintDocProvider
			appId={APP_ID}
			initialDoc={{
				appId: APP_ID,
				appName: "Case list screen test app",
				connectType: null,
				caseTypes: [
					{
						name: "patient",
						properties: opts.caseProperties
							? [...opts.caseProperties]
							: [
									{ name: "name", label: "Name", data_type: "text" },
									{ name: "age", label: "Age", data_type: "int" },
								],
					},
				],
				modules: opts.omitModule
					? {}
					: {
							[MODULE_UUID]: {
								uuid: MODULE_UUID,
								id: "patient_module",
								name: opts.moduleName ?? MODULE_NAME,
								caseType: opts.moduleCaseType ?? "patient",
								caseListConfig: {
									columns: opts.columns,
									searchInputs: opts.searchInputs ?? [],
									...(opts.filter !== undefined && { filter: opts.filter }),
								},
								...(opts.searchAction !== undefined ||
								opts.searchScreenTitle !== undefined ||
								opts.searchButtonLabel !== undefined ||
								opts.searchButtonDisplayCondition !== undefined ||
								opts.excludedOwnerIds !== undefined
									? {
											caseSearchConfig: {
												...(opts.searchAction === "disabled" && {
													searchActionEnabled: false as const,
												}),
												...(opts.searchScreenTitle !== undefined && {
													searchScreenTitle: opts.searchScreenTitle,
												}),
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
					...(includeCaseLoadingForm
						? {
								[FOLLOWUP_FORM_UUID]: {
									uuid: FOLLOWUP_FORM_UUID,
									id: "followup_form",
									name: opts.followupFormName ?? "Follow-up Visit",
									type: "followup" as const,
								},
							}
						: {}),
					...extraForms,
				},
				fields: {},
				moduleOrder: opts.omitModule ? [] : [MODULE_UUID],
				formOrder: opts.omitModule
					? {}
					: {
							[MODULE_UUID]: [
								FORM_UUID,
								...(includeCaseLoadingForm ? [FOLLOWUP_FORM_UUID] : []),
								...extraFormOrder,
							],
						},
				fieldOrder: {},
			}}
		>
			<CaptureDocStore />
			<CaseListScreen
				screen={{ type: "caseList", moduleIndex: 0, formIndex: 0 }}
			/>
		</BlueprintDocProvider>
	);
	const result = render(tree());
	return Object.assign(result, {
		rerenderAt(location: Location) {
			currentLocation = location;
			result.rerender(tree());
		},
	});
}

function caseResultRowFor(action: HTMLElement): HTMLElement {
	const row = action.closest<HTMLElement>(
		'[data-case-result-row="interactive"]',
	);
	if (row === null) throw new Error("Case action is not inside a result row");
	return row;
}

beforeEach(() => {
	capturedDocStore = undefined;
	canEditMock = true;
	currentLocation = { kind: "cases", moduleUuid: MODULE_UUID };
	setPreviewSelectedCaseMock.mockClear();
	signInMock.mockClear();
	vi.mocked(loadCasesAction).mockResolvedValue({ kind: "empty" });
	vi.mocked(loadCaseCountAction).mockResolvedValue({ kind: "count", count: 2 });
	vi.mocked(loadCaseDataAction).mockResolvedValue({ kind: "missing" });
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
			expect(
				screen.getByRole("heading", { level: 1, name: MODULE_NAME }),
			).toBeDefined();
		});
		expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
		// Inversion check: the first form's name does NOT surface as
		// the heading, regardless of where it lives in the DOM.
		expect(screen.queryByRole("heading", { name: FIRST_FORM_NAME })).toBeNull();
	});

	it("keeps the Search utility out of the page heading hierarchy", async () => {
		renderCaseListScreen({
			columns: [plainColumn(COL_NAME_UUID, "name", "Name")],
			searchInputs: [
				simpleSearchInputDef(SEARCH_NAME_UUID, "name", "Name", "text", "name"),
			],
		});

		const pageHeading = screen.getByRole("heading", {
			level: 1,
			name: MODULE_NAME,
		});
		expect(screen.getAllByRole("heading")[0]).toBe(pageHeading);
		expect(
			screen.getByText("Search", { selector: "[data-search-pane-title]" })
				.tagName,
		).toBe("DIV");
	});

	it("wraps long module, case, and form names without crowding adjacent UI", async () => {
		const longModuleName =
			"CommunityFollowUpAndMedicationAdministrationResultsForTheNorthernServiceArea";
		const longCaseName =
			"ClientWithAnExtremelyLongImportedCaseNameThatHasNoNaturalWordBreaks";
		const longFormName =
			"CompleteTheCommunityFollowUpAndMedicationReconciliationWorkflow";
		vi.mocked(loadCasesAction).mockResolvedValue({
			kind: "rows",
			rows: [makeRow(SELECTED_CASE_ID, { name: longCaseName })],
		});
		const { container } = renderCaseListScreen({
			columns: [plainColumn(COL_NAME_UUID, "name", "Name")],
			moduleName: longModuleName,
			followupFormName: longFormName,
			secondCaseLoadingForm: true,
		});

		const resultsTitle = await screen.findByRole("heading", {
			level: 1,
			name: longModuleName,
		});
		expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
		expect(resultsTitle.className).toContain("min-w-0");
		expect(resultsTitle.className).toContain("flex-1");
		expect(resultsTitle.className).toContain("whitespace-normal");
		expect(resultsTitle.className).toContain("[overflow-wrap:anywhere]");
		const longCaseValue = await screen.findByText(longCaseName);
		expect(
			container.querySelector<HTMLElement>("[data-results-count]")?.className,
		).toContain("shrink-0");
		const resultValue = longCaseValue
			.closest<HTMLElement>("[data-case-result-field]")
			?.querySelector<HTMLElement>("span:last-child");
		expect(resultValue?.className).toContain("[overflow-wrap:anywhere]");

		fireEvent.click(
			screen.getByRole("button", {
				name: `View details for ${longCaseName}`,
			}),
		);
		const detailTitle = screen.getByRole("heading", {
			level: 1,
			name: longCaseName,
		});
		expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
		expect(detailTitle.className).toContain("whitespace-normal");
		expect(detailTitle.className).toContain("[overflow-wrap:anywhere]");

		fireEvent.click(screen.getByRole("button", { name: "Continue" }));
		const formMenuTitle = screen.getByRole("heading", {
			level: 1,
			name: longCaseName,
		});
		expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
		expect(formMenuTitle.className).toContain("[overflow-wrap:anywhere]");
		const formLabel = screen.getByText(longFormName);
		expect(
			formLabel.getAttribute("data-form-menu-choice-label"),
		).not.toBeNull();
		expect(formLabel.className).toContain("whitespace-normal");
		expect(formLabel.className).toContain("[overflow-wrap:anywhere]");
	});

	it("explains how to add missing Results information", () => {
		const view = renderCaseListScreen({ columns: [] });

		expect(
			screen.getByRole("heading", {
				level: 1,
				name: "Results need information",
			}),
		).toBeDefined();
		expect(
			screen.getByText("Return to edit mode and add information to Results"),
		).toBeDefined();
		// The setup arm has no reason to keep the background data request mounted.
		// Unmount before its mocked action settles so this synchronous copy test
		// does not leak an unrelated post-assertion state update.
		view.unmount();
	});

	it("explains when the module's case type is no longer available", () => {
		renderCaseListScreen({
			columns: [plainColumn(COL_NAME_UUID, "name", "Name")],
			moduleCaseType: "missing_patient_type",
		});

		expect(
			screen.getByRole("heading", {
				level: 1,
				name: "Results need a case type",
			}),
		).toBeDefined();
		expect(
			screen.getByText("Return to edit mode and choose one in module settings"),
		).toBeDefined();
	});

	it("explains when the current module is no longer available", () => {
		renderCaseListScreen({
			columns: [plainColumn(COL_NAME_UUID, "name", "Name")],
			omitModule: true,
		});

		expect(
			screen.getByRole("heading", {
				level: 1,
				name: "This module is no longer available",
			}),
		).toBeDefined();
		expect(
			screen.getByText("Return to edit mode and choose another module"),
		).toBeDefined();
	});
});

// ── App-pure empty state ────────────────────────────────────────

describe("CaseListScreen — empty case type", () => {
	it("shows worker-facing registration guidance without builder data controls", async () => {
		vi.mocked(loadCaseCountAction).mockResolvedValue({
			kind: "count",
			count: 0,
		});
		vi.mocked(loadCasesAction).mockResolvedValue({
			kind: "empty",
			constraintSource: "unconstrained",
		});
		renderCaseListScreen({
			columns: [plainColumn(COL_NAME_UUID, "name", "Name")],
		});

		expect(
			await screen.findByRole("heading", {
				level: 2,
				name: "No cases yet",
			}),
		).toBeDefined();
		expect(
			screen.getByRole("heading", { level: 1, name: MODULE_NAME }),
		).toBeDefined();
		expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
		expect(
			screen.getByText("Create a case or add sample cases in Case data"),
		).toBeDefined();
		expect(
			screen.queryByRole("button", { name: /generate sample data/i }),
		).toBeNull();
	});

	it("gives a viewer permission-safe guidance when the case type is empty", async () => {
		canEditMock = false;
		vi.mocked(loadCasesAction).mockResolvedValue({
			kind: "empty",
			constraintSource: "unconstrained",
		});
		renderCaseListScreen({
			columns: [plainColumn(COL_NAME_UUID, "name", "Name")],
		});

		expect(await screen.findByText("No cases yet")).toBeDefined();
		expect(
			screen.getByText(
				"Ask an app editor to create a case or add sample cases",
			),
		).toBeDefined();
		expect(
			screen.queryByText("Create a case or add sample cases in Case data"),
		).toBeNull();
	});

	it("stays neutral when an older action cannot report whether the query was narrowed", async () => {
		vi.mocked(loadCasesAction).mockResolvedValue({ kind: "empty" });
		renderCaseListScreen({
			columns: [plainColumn(COL_NAME_UUID, "name", "Name")],
			filter: eq(prop("patient", "name"), literal("Nobody")),
		});

		expect(
			await screen.findByText("Cases aren’t available right now"),
		).toBeDefined();
		expect(screen.getByText("Try again to view cases")).toBeDefined();
		expect(screen.getByRole("button", { name: "Try again" })).toBeDefined();
		expect(screen.queryByText("No cases yet")).toBeNull();
		expect(screen.queryByText("No cases are available")).toBeNull();
	});

	it("treats an empty baseline-filter result as constrained, not an empty case type", async () => {
		vi.mocked(loadCasesAction).mockResolvedValue({
			kind: "empty",
			constraintSource: "authored-rules",
		});
		renderCaseListScreen({
			columns: [plainColumn(COL_NAME_UUID, "name", "Name")],
			filter: eq(prop("patient", "name"), literal("Nobody")),
		});

		expect(
			await screen.findByText("Your availability settings hide every case"),
		).toBeDefined();
		expect(
			screen.getByText(
				"To show cases, update Cases available in Results or create a matching case",
			),
		).toBeDefined();
		expect(
			screen.queryByText(
				"Check your spelling, clear a field, or try a broader search",
			),
		).toBeNull();
		expect(screen.queryByText("No cases yet")).toBeNull();
	});

	it("names authored availability neutrally for a viewer", async () => {
		canEditMock = false;
		vi.mocked(loadCasesAction).mockResolvedValue({
			kind: "empty",
			constraintSource: "authored-rules",
		});
		renderCaseListScreen({
			columns: [plainColumn(COL_NAME_UUID, "name", "Name")],
			filter: eq(prop("patient", "name"), literal("Nobody")),
		});

		expect(
			await screen.findByText(
				"No cases match this app’s availability settings",
			),
		).toBeDefined();
		expect(
			screen.getByText(
				"Ask an app editor to review Cases available or create a matching case",
			),
		).toBeDefined();
		expect(
			screen.queryByText("Your availability settings hide every case"),
		).toBeNull();
	});

	it("keeps authored availability as the cause when Search cannot reveal any case", async () => {
		const availabilitySearch = simpleSearchInputDef(
			asDomainUuid("00000000-0000-0000-0000-000000000d91"),
			"name",
			"Name",
			"text",
			"name",
		);
		vi.mocked(loadCaseCountAction).mockResolvedValue({
			kind: "count",
			count: 5,
		});
		vi.mocked(loadCasesAction).mockImplementation((args) =>
			Promise.resolve(
				args.inputValues?.name
					? {
							kind: "empty" as const,
							constraintSource: "worker-search" as const,
							authoredMatchingCount: 0,
						}
					: {
							kind: "empty" as const,
							constraintSource: "authored-rules" as const,
						},
			),
		);
		renderCaseListScreen({
			columns: [plainColumn(COL_NAME_UUID, "name", "Name")],
			searchInputs: [availabilitySearch],
			filter: eq(prop("patient", "name"), literal("Unavailable")),
		});

		expect(
			await screen.findByText("Your availability settings hide every case"),
		).toBeDefined();
		fireEvent.change(screen.getByLabelText("Name"), {
			target: { value: "Alice" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Search" }));

		await waitFor(() =>
			expect(vi.mocked(loadCasesAction)).toHaveBeenLastCalledWith(
				expect.objectContaining({ inputValues: { name: "Alice" } }),
			),
		);
		expect(
			screen.getByText("Your availability settings hide every case"),
		).toBeDefined();
		expect(screen.queryByText("No cases match your search")).toBeNull();
		expect(
			screen.queryByText(
				"Check your spelling, clear a field, or try a broader search",
			),
		).toBeNull();
	});

	it.each([
		[
			true,
			"Try different Search information or review Cases available in Results",
		],
		[
			false,
			"Try different Search information or ask an app editor to review Cases available",
		],
	] as const)(
		"keeps uncertain worker-search guidance permission-aware (canEdit=%s)",
		async (canEdit, expectedDescription) => {
			canEditMock = canEdit;
			vi.mocked(loadCaseCountAction).mockResolvedValue({
				kind: "count",
				count: 3,
			});
			vi.mocked(loadCasesAction).mockResolvedValue({
				kind: "empty",
				constraintSource: "worker-search",
			});
			renderCaseListScreen({
				columns: [plainColumn(COL_NAME_UUID, "name", "Name")],
				searchInputs: [
					simpleSearchInputDef(
						asDomainUuid("00000000-0000-0000-0000-000000000d92"),
						"name",
						"Name",
						"text",
						"name",
					),
				],
			});

			expect(
				await screen.findByText("No cases are available for this search"),
			).toBeDefined();
			expect(screen.getByText(expectedDescription)).toBeDefined();
		},
	);

	it("offers case creation when no underlying cases exist, even with availability conditions", async () => {
		vi.mocked(loadCaseCountAction).mockResolvedValue({
			kind: "count",
			count: 0,
		});
		vi.mocked(loadCasesAction).mockResolvedValue({
			kind: "empty",
			constraintSource: "authored-rules",
		});
		renderCaseListScreen({
			columns: [plainColumn(COL_NAME_UUID, "name", "Name")],
			filter: eq(prop("patient", "name"), literal("Nobody")),
		});

		expect(await screen.findByText("No cases yet")).toBeDefined();
		expect(
			screen.getByText("Create a case or add sample cases in Case data"),
		).toBeDefined();
		expect(screen.queryByText("No cases are available")).toBeNull();
	});

	it("waits for the unfiltered count before explaining a constrained empty result", async () => {
		let resolveCount:
			| ((value: Awaited<ReturnType<typeof loadCaseCountAction>>) => void)
			| undefined;
		vi.mocked(loadCaseCountAction).mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveCount = resolve;
				}),
		);
		vi.mocked(loadCasesAction).mockResolvedValue({
			kind: "empty",
			constraintSource: "authored-rules",
		});
		renderCaseListScreen({
			columns: [plainColumn(COL_NAME_UUID, "name", "Name")],
			filter: eq(prop("patient", "name"), literal("Nobody")),
		});

		const loadingStatus = await screen.findByRole("status");
		expect(loadingStatus.getAttribute("aria-live")).toBe("polite");
		expect(loadingStatus.getAttribute("aria-atomic")).toBe("true");
		expect(loadingStatus.textContent).toBe("Loading cases…");
		expect(loadingStatus.querySelector('[aria-hidden="true"]')).not.toBeNull();
		expect(screen.queryByText("No cases yet")).toBeNull();
		expect(screen.queryByText("No cases are available")).toBeNull();

		act(() => resolveCount?.({ kind: "count", count: 3 }));
		expect(
			await screen.findByText("Your availability settings hide every case"),
		).toBeDefined();
	});

	it("keeps case-load failures friendly and retries through the data hook", async () => {
		let loadSucceeds = false;
		vi.mocked(loadCasesAction).mockImplementation(() =>
			Promise.resolve(
				loadSucceeds
					? {
							kind: "rows",
							rows: [makeRow(SELECTED_CASE_ID, { name: "Alice" })],
						}
					: {
							kind: "error",
							message: "SELECT failed at cases_private_idx",
						},
			),
		);
		renderCaseListScreen({
			columns: [plainColumn(COL_NAME_UUID, "name", "Name")],
		});

		expect(await screen.findByText("This case list didn’t load")).toBeDefined();
		expect(screen.getByText("Try again to view cases")).toBeDefined();
		expect(screen.queryByText(/cases_private_idx/i)).toBeNull();

		loadSucceeds = true;
		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		expect(await screen.findByText("Alice")).toBeDefined();
	});

	it("offers the shared sign-in action when the case session has ended", async () => {
		vi.mocked(loadCasesAction).mockResolvedValue({ kind: "unauthenticated" });
		renderCaseListScreen({
			columns: [plainColumn(COL_NAME_UUID, "name", "Name")],
		});

		expect(await screen.findByText("You’re signed out")).toBeDefined();
		expect(
			screen.getByText("To view these cases, sign in again"),
		).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
		expect(signInMock).toHaveBeenCalledOnce();
	});

	it("explains a failed population check without guessing why Results is empty", async () => {
		let countSucceeds = false;
		vi.mocked(loadCasesAction).mockResolvedValue({
			kind: "empty",
			constraintSource: "authored-rules",
		});
		vi.mocked(loadCaseCountAction).mockImplementation(() =>
			Promise.resolve(
				countSucceeds
					? { kind: "count", count: 3 }
					: { kind: "error", message: "relation cases does not exist" },
			),
		);
		renderCaseListScreen({
			columns: [plainColumn(COL_NAME_UUID, "name", "Name")],
			filter: eq(prop("patient", "name"), literal("Nobody")),
		});

		expect(
			await screen.findByText("Nova couldn’t check why no cases are showing"),
		).toBeDefined();
		expect(
			screen.getByText(
				"Try again to check whether cases need to be created or your availability settings are hiding them",
			),
		).toBeDefined();
		expect(screen.queryByText(/relation cases does not exist/i)).toBeNull();

		countSucceeds = true;
		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		expect(
			await screen.findByText("Your availability settings hide every case"),
		).toBeDefined();
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

describe("CaseListScreen — worker-facing column labels", () => {
	it("uses friendly case-property labels and human fallbacks in Results and Details", async () => {
		vi.mocked(loadCasesAction).mockResolvedValueOnce({
			kind: "rows",
			rows: [
				makeRow(
					SELECTED_CASE_ID,
					{ client_name: "Alice" },
					{ [COL_CALC_UUID]: "Active" },
				),
			],
		});
		const { container } = renderCaseListScreen({
			caseProperties: [
				{
					name: "client_name",
					label: "Client's preferred name",
					data_type: "text",
				},
			],
			columns: [
				plainColumn(COL_NAME_UUID, "client_name", ""),
				calculatedColumn(COL_CALC_UUID, "", term(literal(""))),
			],
		});

		const rowAction = await screen.findByRole("button", { name: /Alice/ });
		const row = caseResultRowFor(rowAction);
		expect(row.textContent).toContain("Client's preferred name");
		expect(row.textContent).toContain("Calculated value");
		expect(container.textContent).not.toContain("client_name");
		expect(container.textContent).not.toContain("Untitled");

		fireEvent.click(rowAction);
		const detail = container.querySelector<HTMLElement>(
			'[data-case-detail="responsive"]',
		);
		expect(detail).not.toBeNull();
		expect(
			within(detail as HTMLElement).getByText("Client's preferred name"),
		).toBeDefined();
		expect(
			within(detail as HTMLElement).getByText("Calculated value"),
		).toBeDefined();
		expect(detail?.textContent).not.toContain("client_name");
		expect(detail?.textContent).not.toContain("Untitled");
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

		const rowAction = await screen.findByRole("button", { name: /Alice/ });
		const row = caseResultRowFor(rowAction);
		expect(
			Array.from(row.querySelectorAll("[data-case-result-field]")).map((node) =>
				node.getAttribute("data-case-result-field"),
			),
		).toEqual([COL_AGE_UUID, COL_NAME_UUID]);

		fireEvent.click(rowAction);
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

	it("shows a clear, accessible missing-value marker for calculated values", async () => {
		// Calc map keyed only by the plain column's slot — the calc
		// column's uuid is missing. `renderColumnCell` falls through to the
		// canonical missing-value treatment: a quiet visual marker with explicit
		// assistive copy, rather than an ambiguous blank space.
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
		// Plain column's cell rendered "Alice"; the calculated cell remains in
		// the row with the same missing-value treatment as every other column.
		const row = caseResultRowFor(screen.getByRole("button", { name: /Alice/ }));
		expect(row.textContent).toContain("No value");
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

		const rowAction = screen.getByRole("button", { name: /Alice/ });
		const row = caseResultRowFor(rowAction);
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
		// The Results shell clips row hover/background paint. Keep keyboard focus
		// inside that clipping boundary so the indicator remains fully visible.
		expect(rowAction.className).toContain("focus-visible:ring-inset");
		expect(rowAction.className).toContain("focus-visible:ring-2");
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
	] as const)(
		"uses the count-aware responsive threshold for %i fields",
		async (count, expectedClass) => {
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

			const row = caseResultRowFor(
				await screen.findByRole("button", { name: /Value 1/ }),
			);
			if (expectedClass === null) {
				expect(row.className).not.toContain("/results:grid");
			} else {
				expect(row.className).toContain(expectedClass);
			}
		},
	);
});

describe("CaseListScreen — bounded result pages", () => {
	const population = Array.from({ length: 55 }, (_, index) =>
		makeRow(`case-${String(index + 1).padStart(3, "0")}`, {
			name: `Case ${index + 1}`,
		}),
	);
	function mockPagedPopulation() {
		vi.mocked(loadCasesAction).mockImplementation((args) => {
			const offset = args.page?.offset ?? 0;
			const limit = args.page?.limit ?? 50;
			return Promise.resolve({
				kind: "rows",
				rows: population.slice(offset, offset + limit),
				totalCount: population.length,
				pageOffset: offset,
				pageSize: limit,
				constraintSource: "unconstrained",
			});
		});
	}

	it("renders one bounded page, keeps the quick filter page-local, and moves focus on paging", async () => {
		mockPagedPopulation();
		renderCaseListScreen({
			columns: [plainColumn(COL_NAME_UUID, "name", "Name")],
		});

		const cases = await screen.findByRole("list", { name: "Cases" });
		await waitFor(() =>
			expect(within(cases).getAllByRole("listitem")).toHaveLength(50),
		);
		expect(screen.getByText("1–50 of 55 cases")).toBeDefined();
		expect(vi.mocked(loadCasesAction)).toHaveBeenLastCalledWith(
			expect.objectContaining({ page: { offset: 0, limit: 50 } }),
		);

		const pageFilter = screen.getByLabelText("Filter this page");
		fireEvent.change(pageFilter, { target: { value: "Case 51" } });
		expect(
			screen.getByText("No cases on this page match your filter"),
		).toBeDefined();
		expect(
			screen.getByText(
				"This filter checks the 50 cases on this page. Go to another page to check more cases.",
			),
		).toBeDefined();

		fireEvent.click(screen.getByRole("button", { name: "Next" }));
		expect(await screen.findByText("Case 51")).toBeDefined();
		expect(screen.getByText("Showing 51–55 of 55 cases")).toBeDefined();
		expect(
			(screen.getByLabelText("Filter this page") as HTMLInputElement).value,
		).toBe("Case 51");
		expect(screen.getAllByText("1 of 5 cases on this page")).toHaveLength(2);
		expect(vi.mocked(loadCasesAction)).toHaveBeenLastCalledWith(
			expect.objectContaining({ page: { offset: 50, limit: 50 } }),
		);
		await waitFor(() =>
			expect(document.activeElement).toBe(
				screen.getByRole("heading", { name: MODULE_NAME }),
			),
		);

		const clearFilter = screen.getByRole("button", {
			name: "Clear the filter",
		});
		clearFilter.focus();
		fireEvent.click(clearFilter);
		await waitFor(() =>
			expect(document.activeElement).toBe(
				screen.getByLabelText("Filter this page"),
			),
		);
		expect(
			within(screen.getByRole("list", { name: "Cases" })).getAllByRole(
				"listitem",
			),
		).toHaveLength(5);
	});

	it("uses a singular case count when filtering a one-row page", async () => {
		vi.mocked(loadCasesAction).mockResolvedValueOnce({
			kind: "rows",
			rows: [makeRow("case-001", { name: "Case 1" })],
			totalCount: 1,
			pageOffset: 0,
			pageSize: 50,
			constraintSource: "unconstrained",
		});
		renderCaseListScreen({
			columns: [plainColumn(COL_NAME_UUID, "name", "Name")],
		});

		await screen.findByText("Case 1");
		fireEvent.change(screen.getByLabelText("Filter results"), {
			target: { value: "Case" },
		});

		expect(screen.getAllByText("1 of 1 case")).toHaveLength(2);
	});

	it("returns to page one when Assigned cases changes the effective population", async () => {
		mockPagedPopulation();
		const originalOwnerRule = term(literal("owner-a"));
		const nextOwnerRule = term(literal("owner-b"));
		renderCaseListScreen({
			columns: [plainColumn(COL_NAME_UUID, "name", "Name")],
			excludedOwnerIds: originalOwnerRule,
		});

		await screen.findByText("Case 1");
		fireEvent.click(screen.getByRole("button", { name: "Next" }));
		expect(await screen.findByText("Case 51")).toBeDefined();
		expect(vi.mocked(loadCasesAction)).toHaveBeenLastCalledWith(
			expect.objectContaining({
				excludedOwnerIdsExpression: originalOwnerRule,
				page: { offset: 50, limit: 50 },
			}),
		);

		const store = capturedDocStore;
		if (store === undefined) throw new Error("doc store was not captured");
		act(() => {
			store.getState().applyMany([
				{
					kind: "updateModule",
					uuid: MODULE_UUID,
					patch: { caseSearchConfig: { excludedOwnerIds: nextOwnerRule } },
				},
			]);
		});

		expect(await screen.findByText("Case 1")).toBeDefined();
		expect(vi.mocked(loadCasesAction)).toHaveBeenLastCalledWith(
			expect.objectContaining({
				excludedOwnerIdsExpression: nextOwnerRule,
				page: { offset: 0, limit: 50 },
			}),
		);
	});

	it("returns to page one after destructive case-data replacement", async () => {
		mockPagedPopulation();
		renderCaseListScreen({
			columns: [plainColumn(COL_NAME_UUID, "name", "Name")],
		});

		await screen.findByText("Case 1");
		fireEvent.click(screen.getByRole("button", { name: "Next" }));
		expect(await screen.findByText("Case 51")).toBeDefined();

		act(() => invalidateCaseData(APP_ID, "patient", "replacement"));

		expect(await screen.findByText("Case 1")).toBeDefined();
		expect(vi.mocked(loadCasesAction)).toHaveBeenLastCalledWith(
			expect.objectContaining({ page: { offset: 0, limit: 50 } }),
		);
	});

	it("accepts the server-clamped final page after ordinary deletion shrinks the population", async () => {
		let populationShrank = false;
		vi.mocked(loadCasesAction).mockImplementation((args) => {
			const currentPopulation = populationShrank
				? population.slice(0, 5)
				: population;
			const requestedOffset = args.page?.offset ?? 0;
			const limit = args.page?.limit ?? 50;
			const pageOffset =
				currentPopulation.length === 0
					? 0
					: Math.min(
							requestedOffset,
							Math.floor((currentPopulation.length - 1) / limit) * limit,
						);
			return Promise.resolve({
				kind: "rows",
				rows: currentPopulation.slice(pageOffset, pageOffset + limit),
				totalCount: currentPopulation.length,
				pageOffset,
				pageSize: limit,
				constraintSource: "unconstrained",
			});
		});
		renderCaseListScreen({
			columns: [plainColumn(COL_NAME_UUID, "name", "Name")],
		});

		await screen.findByText("Case 1");
		fireEvent.click(screen.getByRole("button", { name: "Next" }));
		expect(await screen.findByText("Case 51")).toBeDefined();

		populationShrank = true;
		act(() => invalidateCaseData(APP_ID, "patient", "update"));

		expect(await screen.findByText("Case 1")).toBeDefined();
		expect(screen.getByText("5 cases")).toBeDefined();
		expect(screen.queryByText("No cases yet")).toBeNull();
		expect(screen.queryByText("Cases aren’t available right now")).toBeNull();
		expect(vi.mocked(loadCasesAction)).toHaveBeenLastCalledWith(
			expect.objectContaining({ page: { offset: 50, limit: 50 } }),
		);
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
		return Promise.resolve({
			kind: "rows",
			rows: [ALICE_ROW, BOB_ROW],
			constraintSource: "unconstrained",
		});
	}
	const matched = [ALICE_ROW, BOB_ROW].filter(
		(row) => (row.properties as Record<string, unknown>).name === typed,
	);
	if (matched.length === 0) {
		return Promise.resolve({
			kind: "empty",
			constraintSource: "worker-search",
			authoredMatchingCount: 2,
		});
	}
	return Promise.resolve({
		kind: "rows",
		rows: matched,
		constraintSource: "worker-search",
	});
}

describe("CaseListScreen — search-input form", () => {
	const searchInput = simpleSearchInputDef(
		SEARCH_NAME_UUID,
		"name",
		"Name",
		"text",
		"name",
	);

	it("announces a positive settled result after Search", async () => {
		vi.mocked(loadCasesAction).mockImplementation(filterByNameInputValue);
		renderCaseListScreen({
			columns: [plainColumn(COL_NAME_UUID, "name", "Name")],
			searchInputs: [searchInput],
		});

		await screen.findByText("Bob");
		fireEvent.change(screen.getByLabelText("Name"), {
			target: { value: "Alice" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Search" }));

		await waitFor(() =>
			expect(screen.getByRole("status").textContent).toBe("1 case found"),
		);
		expect(screen.queryByText("Bob")).toBeNull();
	});

	it("shows an input-repairable Search error beside Search without a retry action", async () => {
		vi.mocked(loadCasesAction).mockResolvedValue({
			kind: "invalid-search",
			message: "Choose both a start date and an end date",
			repair: "inputs",
		});
		renderCaseListScreen({
			columns: [plainColumn(COL_NAME_UUID, "name", "Name")],
			searchInputs: [searchInput],
		});

		const alert = await screen.findByRole("alert");
		expect(within(alert).getByText("Search needs attention")).toBeDefined();
		expect(
			within(alert).getByText("Choose both a start date and an end date"),
		).toBeDefined();
		expect(
			within(alert).getByText(
				"Change the Search information, then search again",
			),
		).toBeDefined();
		expect(screen.getByText("Change Search to see Results")).toBeDefined();
		expect(
			screen.getByText("Change the Search information to update Results"),
		).toBeDefined();
		expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
	});

	it("directs a visible settings error to an editor instead of blaming worker input", async () => {
		vi.mocked(loadCasesAction).mockResolvedValue({
			kind: "invalid-search",
			message: "A saved Search calculation needs attention.",
			repair: "settings",
		});
		renderCaseListScreen({
			columns: [plainColumn(COL_NAME_UUID, "name", "Name")],
			searchInputs: [searchInput],
		});

		const alert = await screen.findByRole("alert");
		expect(
			within(alert).getByText("Return to edit mode and review Search settings"),
		).toBeDefined();
		expect(screen.getByText("Search settings need attention")).toBeDefined();
		expect(
			screen.getByText("An app editor needs to review Search settings"),
		).toBeDefined();
		expect(
			screen.queryByText("Change the Search information to update Results"),
		).toBeNull();
		expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
	});

	it("explains a promptless Search settings error without inventing a worker repair", async () => {
		vi.mocked(loadCasesAction).mockResolvedValue({
			kind: "invalid-search",
			message: "A saved Search calculation needs attention.",
			repair: "settings",
		});
		const { container } = renderCaseListScreen({
			columns: [plainColumn(COL_NAME_UUID, "name", "Name")],
			searchInputs: [],
			searchScreenTitle: "Search",
		});

		expect(await screen.findByText("Search needs attention")).toBeDefined();
		expect(
			screen.getByText(
				"A saved Search calculation needs attention. Return to edit mode and review Search settings",
			),
		).toBeDefined();
		expect(container.querySelector("search")).toBeNull();
		expect(screen.queryByText("Search settings need attention")).toBeNull();
		expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
	});

	it("wraps a long Search title without crowding the Clear search action", async () => {
		vi.mocked(loadCasesAction).mockResolvedValue({
			kind: "rows",
			rows: [ALICE_ROW],
		});
		const { container } = renderCaseListScreen({
			columns: [plainColumn(COL_NAME_UUID, "name", "Name")],
			searchInputs: [searchInput],
			searchScreenTitle:
				"Find clients who need a follow-up visit in this community",
		});

		const input = await screen.findByLabelText("Name");
		fireEvent.change(input, { target: { value: "Alice" } });
		fireEvent.click(screen.getByRole("button", { name: "Search" }));
		const title = container.querySelector<HTMLElement>(
			"[data-search-pane-title]",
		);
		expect(title?.className.split(" ")).toEqual(
			expect.arrayContaining([
				"min-w-0",
				"flex-1",
				"whitespace-normal",
				"break-words",
			]),
		);
		expect(
			(await screen.findByRole("button", { name: "Clear search" })).className,
		).toContain("shrink-0");
	});

	it("hides the whole Search pane when its action condition is false", async () => {
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

		await screen.findByText("Alice");
		expect(screen.queryByRole("search")).toBeNull();
		expect(screen.queryByLabelText("Name")).toBeNull();
		expect(screen.queryByRole("button", { name: "Search" })).toBeNull();
		expect(vi.mocked(loadCasesAction)).toHaveBeenLastCalledWith(
			expect.objectContaining({ inputValues: undefined }),
		);
	});

	it("surfaces an on-device-unrepresentable action condition loudly — the state is gate-impossible", () => {
		// The commit gate rejects a months `date-add` in this slot and stored
		// pre-gate documents are migrated rather than tolerated, so this
		// shape reaching render is a Nova bug. No fail-closed legacy
		// fallback: the emitter's tripwire must propagate instead of
		// silently hiding the Search pane.
		vi.mocked(loadCasesAction).mockResolvedValue({
			kind: "rows",
			rows: [ALICE_ROW],
		});
		expect(() =>
			renderCaseListScreen({
				columns: [plainColumn(COL_NAME_UUID, "name", "Name")],
				searchInputs: [searchInput],
				searchButtonDisplayCondition: eq(
					dateAdd(today(), "months", term(literal(1))),
					today(),
				),
			}),
		).toThrow(/date-add interval 'months'/);
	});

	it("keeps the pane's sole submit available while a relevant Search draft changes", async () => {
		vi.mocked(loadCasesAction).mockImplementation(filterByNameInputValue);
		renderCaseListScreen({
			columns: [plainColumn(COL_NAME_UUID, "name", "Name")],
			searchInputs: [searchInput],
			searchButtonDisplayCondition: eq(
				sessionContext("userid"),
				literal("owner-test"),
			),
		});

		const nameInput = await screen.findByLabelText("Name");
		expect(screen.getByRole("button", { name: "Search" })).toBeDefined();

		fireEvent.change(nameInput, { target: { value: "Alice" } });
		expect(screen.getByRole("button", { name: "Search" })).toBeDefined();

		fireEvent.change(nameInput, { target: { value: "Bob" } });
		fireEvent.click(screen.getByRole("button", { name: "Search" }));
		await waitFor(() =>
			expect(vi.mocked(loadCasesAction)).toHaveBeenLastCalledWith(
				expect.objectContaining({ inputValues: { name: "Bob" } }),
			),
		);
		expect(screen.getByRole("button", { name: "Search" })).toBeDefined();
	});

	it("evaluates the whole Search pane condition against the preview worker session", async () => {
		vi.mocked(loadCasesAction).mockResolvedValue({
			kind: "rows",
			rows: [ALICE_ROW],
		});
		renderCaseListScreen({
			columns: [plainColumn(COL_NAME_UUID, "name", "Name")],
			searchInputs: [searchInput],
			searchButtonDisplayCondition: eq(
				sessionContext("userid"),
				literal("owner-test"),
			),
		});

		expect(await screen.findByLabelText("Name")).toBeDefined();
		expect(await screen.findByRole("button", { name: "Search" })).toBeDefined();
	});

	it("hides the whole Search pane when the worker session condition is false", async () => {
		vi.mocked(loadCasesAction).mockResolvedValue({
			kind: "rows",
			rows: [ALICE_ROW],
		});
		renderCaseListScreen({
			columns: [plainColumn(COL_NAME_UUID, "name", "Name")],
			searchInputs: [searchInput],
			searchButtonDisplayCondition: eq(
				sessionContext("userid"),
				literal("another-worker"),
			),
		});

		await screen.findByText("Alice");
		expect(screen.queryByRole("search")).toBeNull();
		expect(screen.queryByLabelText("Name")).toBeNull();
		expect(screen.queryByRole("button", { name: "Search" })).toBeNull();
	});

	it("suspends and restores a retained submission with the action's relevance", async () => {
		vi.mocked(loadCasesAction).mockImplementation(filterByNameInputValue);
		renderCaseListScreen({
			columns: [plainColumn(COL_NAME_UUID, "name", "Name")],
			searchInputs: [searchInput],
			searchButtonDisplayCondition: { kind: "match-all" },
		});

		await screen.findByText("Bob");
		fireEvent.change(screen.getByLabelText("Name"), {
			target: { value: "Alice" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Search" }));
		await waitFor(() => expect(screen.queryByText("Bob")).toBeNull());
		expect(vi.mocked(loadCasesAction)).toHaveBeenLastCalledWith(
			expect.objectContaining({ inputValues: { name: "Alice" } }),
		);

		const store = capturedDocStore;
		if (store === undefined) throw new Error("doc store was not captured");
		act(() => {
			store.getState().applyMany([
				{
					kind: "updateModule",
					uuid: MODULE_UUID,
					patch: {
						caseSearchConfig: {
							searchButtonDisplayCondition: {
								kind: "not",
								clause: { kind: "match-all" },
							},
						},
					},
				},
			]);
		});

		await screen.findByText("Bob");
		expect(screen.queryByRole("search")).toBeNull();
		expect(vi.mocked(loadCasesAction)).toHaveBeenLastCalledWith(
			expect.objectContaining({ inputValues: undefined }),
		);

		act(() => {
			store.getState().applyMany([
				{
					kind: "updateModule",
					uuid: MODULE_UUID,
					patch: {
						caseSearchConfig: {
							searchButtonDisplayCondition: { kind: "match-all" },
						},
					},
				},
			]);
		});

		expect(await screen.findByLabelText("Name")).toBeDefined();
		await waitFor(() => expect(screen.queryByText("Bob")).toBeNull());
		expect(vi.mocked(loadCasesAction)).toHaveBeenLastCalledWith(
			expect.objectContaining({ inputValues: { name: "Alice" } }),
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
		// The input card and Search action share one semantic form, but the action
		// sits outside the bordered input card in the main Search panel.
		const input = screen.getByLabelText("Name");
		const submit = screen.getByRole("button", { name: "Find patients" });
		const inputCard = container.querySelector("[data-search-input-card]");
		expect(inputCard).not.toBeNull();
		expect(inputCard?.contains(input)).toBe(true);
		expect(inputCard?.contains(submit)).toBe(false);
		expect(input.closest("form")).toBe(submit.closest("form"));
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

	it("applies assigned-case exclusions before the worker submits Search", async () => {
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
			expect(args.excludedOwnerIdsExpression).toEqual(excludedOwnerIds);
		}

		// Search adds its own criteria without changing the always-on assigned-case
		// availability rule.
		fireEvent.click(screen.getByRole("button", { name: "Search" }));
		await waitFor(() => {
			expect(vi.mocked(loadCasesAction)).toHaveBeenLastCalledWith(
				expect.objectContaining({
					excludedOwnerIdsExpression: excludedOwnerIds,
				}),
			);
		});
	});

	it("treats assigned-case exclusions as constrained before a Search", async () => {
		const excludedOwnerIds = term(sessionContext("userid"));
		vi.mocked(loadCasesAction).mockImplementation((args) =>
			Promise.resolve(
				args.excludedOwnerIdsExpression === undefined
					? {
							kind: "rows",
							rows: [ALICE_ROW],
							constraintSource: "unconstrained",
						}
					: { kind: "empty", constraintSource: "authored-rules" },
			),
		);
		renderCaseListScreen({
			columns: [plainColumn(COL_NAME_UUID, "name", "Name")],
			searchInputs: [searchInput],
			excludedOwnerIds,
		});

		expect(
			await screen.findByText("Your availability settings hide every case"),
		).toBeDefined();
		expect(
			screen.queryByText(
				"Check your spelling, clear a field, or try a broader search",
			),
		).toBeNull();
		expect(screen.queryByText("No cases yet")).toBeNull();
	});

	it("keeps an all-whitespace no-op search in the truly empty state", async () => {
		vi.mocked(loadCasesAction).mockResolvedValue({
			kind: "empty",
			constraintSource: "unconstrained",
		});
		renderCaseListScreen({
			columns: [plainColumn(COL_NAME_UUID, "name", "Name")],
			searchInputs: [searchInput],
		});

		await screen.findByText("No cases yet");
		fireEvent.change(screen.getByLabelText("Name"), {
			target: { value: "   " },
		});
		fireEvent.click(screen.getByRole("button", { name: "Search" }));

		expect(await screen.findByText("No cases yet")).toBeDefined();
		expect(screen.queryByText("No cases match your search")).toBeNull();
	});

	it("keeps an empty evaluated owner exclusion in the truly empty state", async () => {
		const excludedOwnerIds = term(literal(""));
		vi.mocked(loadCasesAction).mockImplementation((args) =>
			Promise.resolve(
				args.excludedOwnerIdsExpression === undefined
					? {
							kind: "rows",
							rows: [ALICE_ROW],
							constraintSource: "unconstrained",
						}
					: { kind: "empty", constraintSource: "unconstrained" },
			),
		);
		renderCaseListScreen({
			columns: [plainColumn(COL_NAME_UUID, "name", "Name")],
			searchInputs: [searchInput],
			excludedOwnerIds,
		});

		expect(await screen.findByText("No cases yet")).toBeDefined();
		expect(screen.queryByText("No cases are available")).toBeNull();
	});

	it("keeps the list-filter empty copy ahead of authored-rule guidance", async () => {
		vi.mocked(loadCasesAction).mockResolvedValue({
			kind: "rows",
			rows: [ALICE_ROW],
		});
		renderCaseListScreen({
			columns: [plainColumn(COL_NAME_UUID, "name", "Name")],
			searchInputs: [searchInput],
			filter: eq(prop("patient", "name"), literal("Alice")),
		});

		await screen.findByText("Alice");
		const listFilter = screen.getByLabelText("Filter results");
		expect(listFilter.getAttribute("data-slot")).toBe("input");
		expect(listFilter.getAttribute("placeholder")).toBeNull();
		fireEvent.change(listFilter, {
			target: { value: "Ali" },
		});
		expect(screen.getByText("1 case shown")).toBeDefined();
		fireEvent.change(listFilter, {
			target: { value: "Nobody" },
		});

		expect(screen.getByText("No cases match your filter")).toBeDefined();
		expect(
			screen.getByText("Clear the filter or try a different phrase"),
		).toBeDefined();
		expect(screen.queryByText(/shown$/i)).toBeNull();
		expect(screen.queryByText("No cases are available")).toBeNull();
		const clearFilter = screen.getByRole("button", {
			name: "Clear the filter",
		});
		expect(clearFilter.getAttribute("data-slot")).toBe("button");
		expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();
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

	it("applies assigned-case exclusions when they are the only Results rule", async () => {
		vi.mocked(loadCasesAction).mockResolvedValue({
			kind: "rows",
			rows: [ALICE_ROW],
		});
		const excludedOwnerIds = term(sessionContext("userid"));
		renderCaseListScreen({
			columns: [plainColumn(COL_NAME_UUID, "name", "Name")],
			searchInputs: [],
			excludedOwnerIds,
			searchAction: "disabled",
		});

		await waitFor(() => expect(screen.getByText("Alice")).toBeDefined());
		expect(vi.mocked(loadCasesAction)).toHaveBeenCalledWith(
			expect.objectContaining({ excludedOwnerIdsExpression: excludedOwnerIds }),
		);
		expect(screen.queryByRole("search")).toBeNull();
		expect(screen.queryByRole("button", { name: "Search" })).toBeNull();
		expect(vi.mocked(loadCasesAction)).toHaveBeenCalledTimes(1);
	});

	it("keeps assigned-case exclusions when the final Search field is removed", async () => {
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
		fireEvent.click(screen.getByRole("button", { name: "Search" }));
		await waitFor(() =>
			expect(vi.mocked(loadCasesAction)).toHaveBeenLastCalledWith(
				expect.objectContaining({
					excludedOwnerIdsExpression: excludedOwnerIds,
				}),
			),
		);

		const store = capturedDocStore;
		if (store === undefined) throw new Error("doc store was not captured");
		act(() => {
			store.getState().applyMany([
				{
					kind: "removeSearchInput",
					moduleUuid: MODULE_UUID,
					uuid: searchInput.uuid,
				},
			]);
		});

		await waitFor(() =>
			expect(vi.mocked(loadCasesAction)).toHaveBeenLastCalledWith(
				expect.objectContaining({
					excludedOwnerIdsExpression: excludedOwnerIds,
				}),
			),
		);
		expect(screen.queryByRole("search")).toBeNull();
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

	it("keeps stale rows inert while a submitted Search is loading", async () => {
		let resolveSubmitted:
			| ((value: Awaited<ReturnType<typeof loadCasesAction>>) => void)
			| undefined;
		vi.mocked(loadCasesAction).mockImplementation((args) =>
			args.inputValues?.name
				? new Promise((resolve) => {
						resolveSubmitted = resolve;
					})
				: Promise.resolve({
						kind: "rows",
						rows: [ALICE_ROW],
						constraintSource: "unconstrained",
					}),
		);
		const { container } = renderCaseListScreen({
			columns: [plainColumn(COL_NAME_UUID, "name", "Name")],
			searchInputs: [searchInput],
		});

		const caseAction = await screen.findByRole("button", {
			name: /View details for Alice/,
		});
		fireEvent.change(screen.getByLabelText("Name"), {
			target: { value: "Alice" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Search" }));

		const results = container.querySelector<HTMLElement>(
			'[data-case-results="responsive"]',
		);
		await waitFor(() =>
			expect(results?.getAttribute("aria-busy")).toBe("true"),
		);
		expect(results?.hasAttribute("inert")).toBe(true);
		expect(caseAction.hasAttribute("disabled")).toBe(true);
		fireEvent.click(caseAction);
		expect(navigateMock.openCaseDetail).not.toHaveBeenCalled();

		act(() =>
			resolveSubmitted?.({
				kind: "rows",
				rows: [ALICE_ROW],
				constraintSource: "worker-search",
			}),
		);
		await waitFor(() =>
			expect(results?.getAttribute("aria-busy")).toBe("false"),
		);
		expect(results?.hasAttribute("inert")).toBe(false);
	});

	it("keeps zero-result guidance worker-facing and exposes no authoring fixes", async () => {
		vi.mocked(loadCasesAction).mockImplementation(filterByNameInputValue);
		renderCaseListScreen({
			columns: [plainColumn(COL_NAME_UUID, "name", "Name")],
			searchInputs: [searchInput],
		});

		await screen.findByText("Alice");
		fireEvent.change(screen.getByLabelText("Name"), {
			target: { value: "Nobody" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Search" }));

		expect(await screen.findByText("No cases match your search")).toBeDefined();
		expect(
			screen.getByText(
				"Check your spelling, clear a field, or try a broader search",
			),
		).toBeDefined();
		expect(
			screen.queryByRole("button", { name: /switch to fuzzy match/i }),
		).toBeNull();
		expect(
			screen.queryByRole("button", { name: /generate sample data/i }),
		).toBeNull();
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
		fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
		await waitFor(() => {
			expect(screen.getByText("Bob")).toBeDefined();
		});
		expect(screen.getByText("Alice")).toBeDefined();
		await waitFor(() => expect(document.activeElement).toBe(input));
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

	it("offers an explicit zero-input Search as one manual Results action", async () => {
		vi.mocked(loadCasesAction).mockResolvedValue({
			kind: "rows",
			rows: [ALICE_ROW],
		});
		const { container } = renderCaseListScreen({
			columns: [plainColumn(COL_NAME_UUID, "name", "Name")],
			searchInputs: [],
			searchAction: "enabled",
		});

		await screen.findByText("Alice");
		expect(container.querySelector("search")).toBeNull();
		const action = screen.getByRole("button", { name: "Search" });
		expect(action.className).toContain("min-h-11");
		expect(action.className).toContain("whitespace-normal");
		const callsBeforeAction = vi.mocked(loadCasesAction).mock.calls.length;
		fireEvent.click(action);

		await waitFor(() =>
			expect(vi.mocked(loadCasesAction).mock.calls.length).toBeGreaterThan(
				callsBeforeAction,
			),
		);
		expect(vi.mocked(loadCasesAction)).toHaveBeenLastCalledWith(
			expect.objectContaining({ inputValues: {} }),
		);
		await waitFor(() =>
			expect(document.activeElement).toBe(
				screen.getByRole("heading", { name: MODULE_NAME }),
			),
		);
	});

	it("auto-launches a relevant zero-input filtered Search once", async () => {
		vi.mocked(loadCasesAction).mockResolvedValue({
			kind: "rows",
			rows: [ALICE_ROW],
		});
		const { container } = renderCaseListScreen({
			columns: [plainColumn(COL_NAME_UUID, "name", "Name")],
			searchInputs: [],
			searchAction: "enabled",
			filter: eq(prop("patient", "name"), literal("Alice")),
		});

		await screen.findByText("Alice");
		await waitFor(() =>
			expect(vi.mocked(loadCasesAction)).toHaveBeenCalledTimes(2),
		);
		expect(container.querySelector("search")).toBeNull();
		expect(screen.queryByRole("button", { name: "Search" })).toBeNull();
		expect(vi.mocked(loadCasesAction)).toHaveBeenLastCalledWith(
			expect.objectContaining({ inputValues: {} }),
		);
	});

	it("does not launch a zero-input filtered Search while its action is irrelevant", async () => {
		vi.mocked(loadCasesAction).mockResolvedValue({
			kind: "rows",
			rows: [ALICE_ROW],
		});
		const { container } = renderCaseListScreen({
			columns: [plainColumn(COL_NAME_UUID, "name", "Name")],
			searchInputs: [],
			searchAction: "enabled",
			filter: eq(prop("patient", "name"), literal("Alice")),
			searchButtonDisplayCondition: eq(
				sessionContext("userid"),
				literal("another-worker"),
			),
		});

		await screen.findByText("Alice");
		expect(container.querySelector("search")).toBeNull();
		expect(screen.queryByRole("button", { name: "Search" })).toBeNull();
		expect(vi.mocked(loadCasesAction)).toHaveBeenCalledTimes(1);
	});

	it("does not invent a Search action for an always-on Results filter", async () => {
		vi.mocked(loadCasesAction).mockResolvedValue({
			kind: "rows",
			rows: [ALICE_ROW],
		});
		const { container } = renderCaseListScreen({
			columns: [plainColumn(COL_NAME_UUID, "name", "Name")],
			searchInputs: [],
			filter: eq(prop("patient", "name"), literal("Alice")),
		});

		await screen.findByText("Alice");
		expect(container.querySelector("search")).toBeNull();
		expect(screen.queryByRole("button", { name: "Search" })).toBeNull();
		expect(vi.mocked(loadCasesAction)).toHaveBeenCalledTimes(1);
	});
});

// ── Row click → detail → Continue ────────────────────────────────

describe("CaseListScreen — detail confirm step", () => {
	it("renders informational rows as non-interactive content when the module has no destination", async () => {
		vi.mocked(loadCasesAction).mockResolvedValue({
			kind: "rows",
			rows: [makeRow(SELECTED_CASE_ID, { name: "Alice" })],
		});
		const { container } = renderCaseListScreen({
			columns: [
				plainColumn(COL_NAME_UUID, "name", "Name", {
					visibleInDetail: false,
				}),
			],
			includeCaseLoadingForm: false,
		});

		await screen.findByText("Alice");
		expect(screen.queryByRole("button", { name: /Alice/ })).toBeNull();
		const row = container.querySelector<HTMLElement>(
			'[data-case-result-row="informational"]',
		);
		expect(row?.tagName).toBe("LI");
		expect(row?.textContent).toContain("Alice");
	});

	it("keeps phone calls independent from the full-row case action", async () => {
		vi.mocked(loadCasesAction).mockResolvedValue({
			kind: "rows",
			rows: [
				makeRow(SELECTED_CASE_ID, {
					name: "Alice",
					phone: "+1 202 555 0123",
				}),
			],
		});
		renderCaseListScreen({
			caseProperties: [
				{ name: "name", label: "Name", data_type: "text" },
				{ name: "phone", label: "Phone", data_type: "text" },
			],
			columns: [
				plainColumn(COL_NAME_UUID, "name", "Name"),
				phoneColumn(COL_PHONE_UUID, "phone", "Phone"),
			],
		});

		const caseAction = await screen.findByRole("button", {
			name: /View details for Alice/,
		});
		const row = caseResultRowFor(caseAction);
		const phoneAction = within(row).getByRole("link", {
			name: "Call +1 202 555 0123",
		});

		// Both controls are generous, focusable siblings. The visible row remains
		// one cohesive hit area without putting an anchor inside a button.
		expect(row.tagName).toBe("LI");
		expect(caseAction.tagName).toBe("BUTTON");
		expect(phoneAction.tagName).toBe("A");
		expect(caseAction.contains(phoneAction)).toBe(false);
		expect(phoneAction.contains(caseAction)).toBe(false);
		expect(row.querySelector("button a, a button")).toBeNull();
		expect(phoneAction.className).toContain("min-h-11");
		expect(phoneAction.className).toContain("min-w-11");

		// Prevent this DOM-only test from asking the host to handle `tel:` while
		// preserving the real link behavior. Pointer and Enter-generated clicks
		// must both leave case navigation untouched.
		phoneAction.addEventListener("click", (event) => event.preventDefault());
		fireEvent.click(phoneAction, { detail: 1 });
		expect(navigateMock.openCaseDetail).not.toHaveBeenCalled();
		phoneAction.focus();
		expect(document.activeElement).toBe(phoneAction);
		fireEvent.keyDown(phoneAction, { key: "Enter", code: "Enter" });
		fireEvent.click(phoneAction, { detail: 0 });
		expect(navigateMock.openCaseDetail).not.toHaveBeenCalled();

		// The native primary button keeps browser keyboard activation semantics;
		// a detail-zero click is the event browsers synthesize for Enter/Space.
		caseAction.focus();
		expect(document.activeElement).toBe(caseAction);
		fireEvent.click(caseAction, { detail: 0 });
		expect(navigateMock.openCaseDetail).toHaveBeenCalledWith(
			MODULE_UUID,
			SELECTED_CASE_ID,
		);
	});

	it("opens an in-cell value explanation without opening the case", async () => {
		vi.mocked(loadCasesAction).mockResolvedValue({
			kind: "rows",
			rows: [
				makeRow(
					SELECTED_CASE_ID,
					{ name: "Alice" },
					{ [COL_CALC_UUID]: { status: "ready" } },
				),
			],
		});
		renderCaseListScreen({
			columns: [
				plainColumn(COL_NAME_UUID, "name", "Name"),
				calculatedColumn(COL_CALC_UUID, "Status", term(literal(""))),
			],
		});

		const caseAction = await screen.findByRole("button", {
			name: /View details for Alice/,
		});
		const row = caseResultRowFor(caseAction);
		const explanationAction = within(row).getByRole("button", {
			name: "Unavailable. More information",
		});
		expect(caseAction.contains(explanationAction)).toBe(false);
		expect(row.querySelector("button button")).toBeNull();
		expect(explanationAction.className).toContain("min-h-11");
		expect(explanationAction.className).toContain("min-w-11");

		fireEvent.click(explanationAction);
		expect(navigateMock.openCaseDetail).not.toHaveBeenCalled();
		expect(await screen.findByText("Why this value is shown")).toBeDefined();

		// Keyboard activation of the disclosure remains independent as well.
		explanationAction.focus();
		fireEvent.click(explanationAction, { detail: 0 });
		expect(navigateMock.openCaseDetail).not.toHaveBeenCalled();

		fireEvent.click(caseAction, { detail: 0 });
		expect(navigateMock.openCaseDetail).toHaveBeenCalledWith(
			MODULE_UUID,
			SELECTED_CASE_ID,
		);
	});

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

		// Click the row — the detail pane replaces the results and its
		// canonical record URL becomes the navigation source of truth.
		const originalCaseAction = screen.getByRole("button", { name: /Alice/ });
		originalCaseAction.focus();
		fireEvent.click(originalCaseAction);
		expect(navigateMock.openForm).not.toHaveBeenCalled();
		expect(navigateMock.openCaseDetail).toHaveBeenCalledWith(
			MODULE_UUID,
			SELECTED_CASE_ID,
		);
		expect(screen.getByRole("heading", { name: "Alice" })).toBeDefined();
		const detailBack = screen.getByRole("button", { name: /Back to results/ });
		await waitFor(() => expect(document.activeElement).toBe(detailBack));
		const detail = container.querySelector<HTMLElement>(
			'[data-case-detail="responsive"]',
		);
		expect(detail?.tagName).toBe("DL");
		expect(detail?.querySelectorAll("dt")).toHaveLength(2);
		expect(detail?.querySelectorAll("dd")).toHaveLength(2);
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
		fireEvent.click(detailBack);
		expect(navigateMock.openCaseList).toHaveBeenCalledWith(MODULE_UUID);
		expect(
			screen.queryByRole("button", { name: /Back to results/ }),
		).toBeNull();
		await waitFor(() =>
			expect(document.activeElement).toBe(
				screen.getByRole("button", { name: /View details for Alice/ }),
			),
		);

		/* Re-open for the Continue half of the journey. */
		fireEvent.click(screen.getByRole("button", { name: /Alice/ }));

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
			screen.queryByRole("button", { name: /Back to results/ }),
		).toBeNull();
	});

	it("hydrates a canonical /cases/{caseId} deep link even when Results did not return that row", async () => {
		currentLocation = {
			kind: "cases",
			moduleUuid: MODULE_UUID,
			caseId: SELECTED_CASE_ID,
		};
		vi.mocked(loadCasesAction).mockResolvedValue({ kind: "empty" });
		vi.mocked(loadCaseDataAction).mockResolvedValue({
			kind: "row",
			row: {
				...makeRow(SELECTED_CASE_ID, { name: "Deep-link Alice", age: 31 }),
			},
			ancestors: [],
		});
		renderCaseListScreen({
			columns: [
				plainColumn(COL_NAME_UUID, "name", "Name"),
				plainColumn(COL_AGE_UUID, "age", "Age"),
			],
		});

		expect(
			await screen.findByRole("heading", { name: "Deep-link Alice" }),
		).toBeDefined();
		expect(screen.getByText("31")).toBeDefined();
		expect(
			screen.getByRole("button", { name: /Back to results/ }),
		).toBeDefined();
		expect(setPreviewSelectedCaseMock).toHaveBeenCalledWith({
			caseId: SELECTED_CASE_ID,
			caseName: "Deep-link Alice",
		});
	});

	it("keeps an off-page deep link's calculated Details value projected after case-data reload", async () => {
		currentLocation = {
			kind: "cases",
			moduleUuid: MODULE_UUID,
			caseId: SELECTED_CASE_ID,
		};
		// The selected record is outside the current Results page. Details must
		// use the identity read rather than depend on this bounded result window.
		vi.mocked(loadCasesAction).mockResolvedValue({
			kind: "rows",
			rows: [
				makeRow("22222222-2222-2222-2222-222222222222", {
					name: "Another page row",
				}),
			],
			totalCount: 75,
			pageOffset: 0,
			pageSize: 50,
		});
		let identityReadCount = 0;
		vi.mocked(loadCaseDataAction).mockImplementation(() => {
			identityReadCount += 1;
			return Promise.resolve({
				kind: "row",
				row: makeRow(
					SELECTED_CASE_ID,
					{ name: "Deep-link Alice" },
					{
						[COL_CALC_UUID]:
							identityReadCount === 1 ? "Ready for review" : "Review complete",
					},
				),
				ancestors: [],
			});
		});
		const calculated = calculatedColumn(
			COL_CALC_UUID,
			"Review status",
			term(literal("")),
			{ visibleInList: false, visibleInDetail: true },
		);
		renderCaseListScreen({
			columns: [plainColumn(COL_NAME_UUID, "name", "Name"), calculated],
		});

		expect(await screen.findByText("Ready for review")).toBeDefined();
		expect(screen.queryByText("Another page row")).toBeNull();
		await waitFor(() => expect(loadCaseDataAction).toHaveBeenCalledTimes(1));
		const firstIdentityRead = vi.mocked(loadCaseDataAction).mock.calls[0];
		expect(firstIdentityRead?.slice(0, 4)).toEqual([
			APP_ID,
			"patient",
			SELECTED_CASE_ID,
			0,
		]);
		expect(firstIdentityRead?.[4]).toEqual(
			expect.objectContaining({
				columns: expect.arrayContaining([
					expect.objectContaining({
						kind: "calculated",
						uuid: COL_CALC_UUID,
						expression: calculated.expression,
					}),
				]),
			}),
		);
		expect(firstIdentityRead?.[5]).toEqual(
			expect.arrayContaining([expect.objectContaining({ name: "patient" })]),
		);

		act(() => invalidateCaseData(APP_ID, "patient"));
		expect(await screen.findByText("Review complete")).toBeDefined();
		expect(screen.queryByText("Ready for review")).toBeNull();
		expect(loadCaseDataAction).toHaveBeenCalledTimes(2);
		expect(vi.mocked(loadCaseDataAction).mock.calls[1]?.[4]).toEqual(
			expect.objectContaining({
				columns: expect.arrayContaining([
					expect.objectContaining({
						kind: "calculated",
						uuid: COL_CALC_UUID,
						expression: calculated.expression,
					}),
				]),
			}),
		);
	});

	it("transfers focused Back ownership when a deep-linked case finishes loading", async () => {
		currentLocation = {
			kind: "cases",
			moduleUuid: MODULE_UUID,
			caseId: SELECTED_CASE_ID,
		};
		vi.mocked(loadCasesAction).mockResolvedValue({ kind: "empty" });
		let resolveCase:
			| ((value: Awaited<ReturnType<typeof loadCaseDataAction>>) => void)
			| undefined;
		vi.mocked(loadCaseDataAction).mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveCase = resolve;
				}),
		);
		renderCaseListScreen({
			columns: [plainColumn(COL_NAME_UUID, "name", "Name")],
		});

		const loadingBack = screen.getByRole("button", {
			name: "Back to results",
		});
		loadingBack.focus();
		expect(document.activeElement).toBe(loadingBack);
		act(() =>
			resolveCase?.({
				kind: "row",
				row: makeRow(SELECTED_CASE_ID, { name: "Alice" }),
				ancestors: [],
			}),
		);

		expect(await screen.findByRole("heading", { name: "Alice" })).toBeDefined();
		const detailBack = screen.getByRole("button", { name: "Back to results" });
		await waitFor(() => expect(document.activeElement).toBe(detailBack));
	});

	it("keeps a deep-link load failure private and retries it in place", async () => {
		currentLocation = {
			kind: "cases",
			moduleUuid: MODULE_UUID,
			caseId: SELECTED_CASE_ID,
		};
		vi.mocked(loadCasesAction).mockResolvedValue({ kind: "empty" });
		vi.mocked(loadCaseDataAction)
			.mockResolvedValueOnce({
				kind: "error",
				message: "case row decoder failed for tenant_secret_7",
			})
			.mockResolvedValueOnce({
				kind: "row",
				row: makeRow(SELECTED_CASE_ID, { name: "Alice" }),
				ancestors: [],
			});
		renderCaseListScreen({
			columns: [plainColumn(COL_NAME_UUID, "name", "Name")],
		});

		expect(
			await screen.findByRole("heading", {
				level: 1,
				name: "This case didn’t load",
			}),
		).toBeDefined();
		expect(screen.getByText("Try again to view this case")).toBeDefined();
		expect(screen.queryByText(/tenant_secret_7/i)).toBeNull();

		const retry = screen.getByRole("button", { name: "Try again" });
		retry.focus();
		fireEvent.click(retry);
		expect(await screen.findByRole("heading", { name: "Alice" })).toBeDefined();
		expect(loadCaseDataAction).toHaveBeenCalledTimes(2);
		await waitFor(() =>
			expect(document.activeElement).toBe(
				screen.getByRole("button", { name: "Back to results" }),
			),
		);
	});

	it("keeps focus on the renewed retry action after another deep-link failure", async () => {
		currentLocation = {
			kind: "cases",
			moduleUuid: MODULE_UUID,
			caseId: SELECTED_CASE_ID,
		};
		vi.mocked(loadCasesAction).mockResolvedValue({ kind: "empty" });
		vi.mocked(loadCaseDataAction).mockResolvedValue({
			kind: "error",
			message: "private decoder detail",
		});
		renderCaseListScreen({
			columns: [plainColumn(COL_NAME_UUID, "name", "Name")],
		});

		const firstRetry = await screen.findByRole("button", { name: "Try again" });
		firstRetry.focus();
		fireEvent.click(firstRetry);
		await waitFor(() => expect(loadCaseDataAction).toHaveBeenCalledTimes(2));
		const renewedRetry = screen.getByRole("button", { name: "Try again" });
		await waitFor(() => expect(document.activeElement).toBe(renewedRetry));
		expect(screen.queryByText(/private decoder detail/i)).toBeNull();
	});

	it("drops the retained record when a preview exit removes the case id from the URL", async () => {
		vi.mocked(loadCasesAction).mockResolvedValue({
			kind: "rows",
			rows: [makeRow(SELECTED_CASE_ID, { name: "Alice", age: 31 })],
		});
		const view = renderCaseListScreen({
			columns: [
				plainColumn(COL_NAME_UUID, "name", "Name"),
				plainColumn(COL_AGE_UUID, "age", "Age"),
			],
		});

		fireEvent.click(await screen.findByRole("button", { name: /Alice/ }));
		expect(
			screen.getByRole("button", { name: /Back to results/ }),
		).toBeDefined();

		view.rerenderAt({
			kind: "cases",
			moduleUuid: MODULE_UUID,
			caseId: SELECTED_CASE_ID,
		});
		view.rerenderAt({ kind: "cases", moduleUuid: MODULE_UUID });

		// URL ownership wins during this render; the retained local detail cannot
		// flash for one effect frame after the record segment disappears.
		expect(
			screen.queryByRole("button", { name: /Back to results/ }),
		).toBeNull();
		await waitFor(() => {
			expect(
				screen.queryByRole("button", { name: /Back to results/ }),
			).toBeNull();
		});
		expect(screen.getByRole("heading", { name: MODULE_NAME })).toBeDefined();
		await waitFor(() =>
			expect(document.activeElement).toBe(
				screen.getByRole("button", { name: /View details for Alice/ }),
			),
		);
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
		const formMenuBack = screen.getByRole("button", { name: "Back" });
		await waitFor(() => expect(document.activeElement).toBe(formMenuBack));
		fireEvent.click(formMenuBack);
		const detailBack = screen.getByRole("button", { name: "Back to results" });
		await waitFor(() => expect(document.activeElement).toBe(detailBack));
		fireEvent.click(screen.getByRole("button", { name: "Continue" }));
		await waitFor(() =>
			expect(document.activeElement).toBe(
				screen.getByRole("button", { name: "Back" }),
			),
		);
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
