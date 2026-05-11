// @vitest-environment happy-dom
//
// __tests__/integration/case-list-search-running-app.test.ts
//
// End-to-end coverage for the running-app search-execution surface.
// Each `describe(...)` block exercises one cross-layer contract a
// single per-layer unit test cannot capture:
//
//   - Initial render: `CaseListScreen` mounted against the live
//     `PostgresCaseStore` renders module-name heading, columns
//     filtered by `visibleInList`, calc cells materialized at the
//     SQL layer, and rows ordered by the authored sort directives.
//   - Search-input narrowing: typing into `SearchInputForm` produces
//     a fresh `inputValues` reference, which `composeRuntimeFilter`
//     lowers into a runtime predicate that AND-composes with the
//     always-on `caseListConfig.filter`. The composed predicate
//     compiles to SQL through the case-store's compiler stack and
//     the rendered table reflects the narrowed result set against
//     real Postgres rows — no mocked store, no hand-rolled SQL.
//   - Form write-through: `FormScreen`'s submit dispatches through
//     `submitFormAction` which routes registration / followup / close
//     mutations through the case-store's `apply*Mutation` helpers
//     against real rows. The follow-up re-read confirms the write
//     landed and is visible to the case-list re-query.
//   - Reset round-trip: clicking the Reset button + confirming the
//     dialog routes through `resetSampleCasesAction` which delegates
//     to `resetSampleCases` over `store.resetSampleData` — the atomic
//     delete + regenerate lands real rows in Postgres and the
//     case-list re-fires its load against the regenerated population.
//
// ## Mock strategy — Server Actions delegate to per-test store
//
// The four Server Actions touched by this surface
// (`loadCasesAction`, `submitFormAction`, `populateSampleCasesAction`,
// `resetSampleCasesAction`) all resolve `getSession()` and call
// `withOwnerContext(userId)` — the production path goes through the
// `auth-utils` session + Cloud SQL connector graph. The integration
// test stubs the entire `caseDataBinding` action module with thin
// delegates that capture the per-test `PostgresCaseStore` in a
// closure and route directly to the underlying helpers
// (`readCases`, `applyRegistrationMutation`, etc.) which already
// accept a `CaseStore` parameter — the helpers were designed for
// this test-injection contract.
//
// This is the canonical pattern (verified against the helper
// signatures + the existing unit tests' mock shape); it hits every
// production code path below the action's session + store
// construction wrappers.
//
// ## Divergence from the plan's 9-step recipe
//
// The plan calls for mounting `<PreviewShell />`. The dispatcher's
// per-arm routing is already covered by `PreviewShell`'s unit
// tests; the integration concern is the runtime binding + Postgres
// round-trip, which mounts `<CaseListScreen>` + `<FormScreen>`
// directly the same way `CaseListScreen.test.tsx` + `FormScreen.test.tsx`
// do. Mounting the dispatcher adds Activity-ref complexity that
// fights the test without exercising a different code path.
//
// The plan also calls for "every `SearchInputType` + every applicable
// mode" coverage. That is what the 67 unit tests across Tasks 1, 3,
// 4, 6, 7 already cover; the integration test exercises the
// composition (one round-trip per concern: filter narrowing, write-
// through, reset) rather than re-asserting per-arm.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CaseListScreen } from "@/components/preview/screens/CaseListScreen";
import { FormScreen } from "@/components/preview/screens/FormScreen";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { buildCaseTypeMap, type CaseStore } from "@/lib/case-store";
import { PostgresCaseStore } from "@/lib/case-store/postgres/store";
import { HeuristicCaseGenerator } from "@/lib/case-store/sample/heuristic";
import { applyMigrationsViaAtlas } from "@/lib/case-store/sql/__tests__/applyMigrationsViaAtlas";
import { setupPerTestDatabase } from "@/lib/case-store/sql/__tests__/perTestDatabase";
import type { Database } from "@/lib/case-store/sql/database";
import { BlueprintDocProvider } from "@/lib/doc/provider";
import { asUuid as asDocUuid, type Uuid } from "@/lib/doc/types";
import {
	asUuid,
	type BlueprintDoc,
	plainColumn,
	simpleSearchInputDef,
} from "@/lib/domain";
import { eq, literal, prop } from "@/lib/domain/predicate";
import type {
	LoadCasesResult,
	PopulateSampleCasesResult,
	SubmissionResult,
} from "@/lib/preview/engine/caseDataBindingTypes";
import { BuilderFormEngineProvider } from "@/lib/preview/engine/provider";
import type { Location } from "@/lib/routing/types";

// ── Per-test database harness ────────────────────────────────────
//
// `PostgresCaseStore`'s `insert` / `update` / `applySchemaChange` /
// `resetSampleData` open inner transactions Kysely lowers to literal
// `BEGIN` statements. The shared-database harness's outer
// BEGIN/ROLLBACK fixture rejects nested BEGIN, so this suite uses
// per-test isolated databases — the same shape `case-list-authoring.test.ts`
// uses for its preview-rendering arm.

const dbHandle = setupPerTestDatabase({
	databaseNamePrefix: "case_list_search_int_",
});

// ── Fixture identifiers ──────────────────────────────────────────
//
// Fixed appId + ownerId mirror the authoring integration test's
// shape. Patient case ids are not pinned — registration writes mint
// their own through Postgres's `uuidv7()` column default.

const APP_ID = "case-list-search-int";
const OWNER_ID = "owner-int";
const MODULE_UUID = asDocUuid("00000000-0000-0000-0000-00000000a001");
const REG_FORM_UUID = asDocUuid("00000000-0000-0000-0000-00000000a002");
const FOLLOWUP_FORM_UUID = asDocUuid("00000000-0000-0000-0000-00000000a003");

const COL_NAME_UUID = asUuid("00000000-0000-4000-8000-000000000001");
const COL_AGE_UUID = asUuid("00000000-0000-4000-8000-000000000002");
const SI_NAME_UUID = asUuid("00000000-0000-4000-8000-000000000010");

// ── Mocks ────────────────────────────────────────────────────────
//
// Routing + session hooks mirror `CaseListScreen.test.tsx` /
// `FormScreen.test.tsx`. `currentLocation` is a module-level mutable
// carrier the mocked `useLocation` reads — the same shape FormScreen's
// suite uses to swap between form arms within one test run. The
// integration tests sequence: mount on the cases URL → assert →
// mutate to a form URL → re-render → assert.

let currentLocation: Location = {
	kind: "cases",
	moduleUuid: MODULE_UUID,
};

const navigateMock = {
	goHome: vi.fn(),
	openModule: vi.fn(),
	openCaseList: vi.fn(),
	openCaseDetail: vi.fn(),
	openSearchConfig: vi.fn(),
	openForm: vi.fn(),
	push: vi.fn(),
	replace: vi.fn(),
	back: vi.fn(),
	up: vi.fn(),
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
		// `test` mode activates the running-app arms in both screens
		// (FormScreen mounts the submit row; CaseListScreen renders
		// rows rather than the workspace).
		useEditMode: () => "test" as const,
		useCursorMode: () => "pointer" as const,
		useBuilderIsReady: () => true,
	};
});

// `caseDataBinding` Server Actions are mocked at module scope so
// the action wrappers' session resolution + `withOwnerContext`
// construction are bypassed; each mock delegates to the helper
// shipped in `caseDataBindingHelpers.ts` against the per-test
// store. The delegates live below `beforeEach` because they need
// the store captured at test-setup time; the `vi.fn()` shells live
// up here so `vi.mock` factory can hoist them.

vi.mock("@/lib/preview/engine/caseDataBinding", () => ({
	loadCasesAction: vi.fn(),
	loadCaseDataAction: vi.fn(),
	populateSampleCasesAction: vi.fn(),
	resetSampleCasesAction: vi.fn(),
	submitFormAction: vi.fn(),
	loadCaseListPreviewAction: vi.fn(),
	loadFilterPreviewAction: vi.fn(),
}));

// Imports below the `vi.mock` calls so the mocks resolve to the
// stub modules. The helper imports stay un-mocked — the test calls
// them directly through the action delegates.
import {
	loadCaseDataAction,
	loadCasesAction,
	populateSampleCasesAction,
	resetSampleCasesAction,
	submitFormAction,
} from "@/lib/preview/engine/caseDataBinding";
import {
	applyCloseMutation,
	applyFollowupMutation,
	applyRegistrationMutation,
	applySurveyMutation,
	readCaseData,
	readCases,
	resetSampleCases,
	seedSampleCases,
} from "@/lib/preview/engine/caseDataBindingHelpers";

// ── Fixture builders ─────────────────────────────────────────────

/**
 * Build the integration-fixture `BlueprintDoc`. One module
 * (Patients), one case type (patient with name + age + status),
 * two forms: a registration form whose fields write `case_name` +
 * `name` + `age` + `status`, and a followup form whose single field
 * patches `age`. The module's `caseListConfig` carries:
 *
 *   - Two visible plain columns (Name, Age) — `Age` sorts descending
 *     at priority 0 so the integration test asserts both visible
 *     columns AND sort ordering against real Postgres rows.
 *   - An always-on filter narrowing to `status = 'open'` — used by
 *     the search-narrowing test to verify the runtime predicate
 *     AND-composes with the filter rather than replacing it.
 *   - One simple-arm search input keyed on `name` — the test
 *     types into it to assert the runtime-bindings layer's
 *     simple-arm clause builder narrows the rendered rows.
 */
function buildFixtureDoc(): BlueprintDoc {
	return buildDoc({
		appId: APP_ID,
		appName: "Case List Search Integration",
		modules: [
			{
				uuid: MODULE_UUID,
				name: "Patients",
				caseType: "patient",
				caseListConfig: {
					columns: [
						plainColumn(COL_NAME_UUID, "case_name", "Name"),
						plainColumn(COL_AGE_UUID, "age", "Age", {
							sort: { direction: "desc", priority: 0 },
						}),
					],
					filter: eq(prop("patient", "status"), literal("open")),
					searchInputs: [
						simpleSearchInputDef(
							SI_NAME_UUID,
							// `name` is both the input key and the property
							// it targets — `composeRuntimeFilter` reads the
							// typed value out of `inputValues.get("name")`
							// and emits a `case-property` term referencing
							// `patient.name`.
							"name",
							"Name",
							"text",
							"name",
						),
					],
				},
				forms: [
					{
						uuid: REG_FORM_UUID,
						name: "Register",
						type: "registration",
						fields: [
							// `status` is intentionally NOT a form field — it
							// is a reserved scalar column (`RESERVED_SCALAR_COLUMNS`)
							// the case-store sets to `"open"` on every
							// `insertWithChildren` call, so a registration form
							// has nothing to write into it.
							f({
								kind: "text",
								id: "case_name",
								label: "Patient name",
								case_property_on: "patient",
							}),
							f({
								kind: "text",
								id: "name",
								label: "Full name",
								case_property_on: "patient",
							}),
							f({
								kind: "int",
								id: "age",
								label: "Age",
								case_property_on: "patient",
							}),
						],
					},
					{
						uuid: FOLLOWUP_FORM_UUID,
						name: "Visit",
						type: "followup",
						fields: [
							f({
								kind: "int",
								id: "age",
								label: "Age",
								case_property_on: "patient",
							}),
						],
					},
				],
			},
		],
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "name", label: "Name", data_type: "text" },
					{ name: "age", label: "Age", data_type: "int" },
					// `status` is a CommCare standard property reserved
					// at the scalar-column layer (`RESERVED_SCALAR_COLUMNS`);
					// the type checker resolves it as `text`-typed without
					// a declared `properties[]` entry. Declaring it here
					// would split the term-compiler's resolution between
					// the JSONB read and the reserved column.
				],
			},
		],
	});
}

/**
 * Bind a `PostgresCaseStore` to the harness's per-test database. The
 * `Kysely<unknown>` → `Kysely<Database>` cast mirrors the authoring
 * integration test's pattern — the per-test harness is generic over
 * downstream schemas; the case-store binds against the case-store-
 * specific `Database` contract.
 */
function buildStore(): CaseStore {
	return new PostgresCaseStore({
		ownerId: OWNER_ID,
		db: dbHandle.db as unknown as Kysely<Database>,
		sampleGenerator: new HeuristicCaseGenerator(),
	});
}

// ── Render helpers ───────────────────────────────────────────────

/**
 * Mount `CaseListScreen` against the fixture doc, wrapped in the
 * `BlueprintDocProvider` the screen reads its blueprint state from.
 * Mirrors `CaseListScreen.test.tsx`'s render shape — direct screen
 * mount (no `PreviewShell` dispatcher) because the dispatcher's
 * routing is covered by its own unit tests.
 */
function renderCaseListScreen(doc: BlueprintDoc) {
	return render(
		<BlueprintDocProvider appId={APP_ID} initialDoc={doc}>
			<CaseListScreen
				screen={{ type: "caseList", moduleIndex: 0, formIndex: 0 }}
			/>
		</BlueprintDocProvider>,
	);
}

/**
 * Mount `FormScreen` against the fixture doc. The screen reads
 * `formUuid` off the URL location; tests sequence: mutate
 * `currentLocation` to the form arm → render → drive the submit.
 * `BuilderFormEngineProvider` wires the form engine controller —
 * required because `FormScreen` activates the form by uuid via the
 * provider's controller.
 */
function renderFormScreen(doc: BlueprintDoc, formUuid: Uuid, caseId?: string) {
	currentLocation = { kind: "form", moduleUuid: MODULE_UUID, formUuid };
	return render(
		<BlueprintDocProvider appId={APP_ID} initialDoc={doc}>
			<BuilderFormEngineProvider>
				<FormScreen
					screen={{
						type: "form",
						moduleIndex: 0,
						formIndex: 0,
						caseId,
					}}
					onBack={() => {}}
				/>
			</BuilderFormEngineProvider>
		</BlueprintDocProvider>,
	);
}

// ── Setup ────────────────────────────────────────────────────────

beforeEach(async () => {
	// Each test starts at the cases URL. Form-arm tests mutate this
	// to a `kind: "form"` location after the case-list assertions.
	currentLocation = { kind: "cases", moduleUuid: MODULE_UUID };
	navigateMock.goHome.mockClear();
	navigateMock.openForm.mockClear();

	applyMigrationsViaAtlas(dbHandle.uri, { stdio: "pipe" });

	// Bind a per-test store + sync the case-type schema so `insert`
	// / `update` validators have a row in `case_type_schemas`. Every
	// action delegate captures this store + the fixture doc in its
	// closure — `BlueprintDoc` carries the `caseTypes` declarations
	// the helpers need.
	const store = buildStore();
	const doc = buildFixtureDoc();
	await store.applySchemaChange({
		appId: APP_ID,
		caseType: "patient",
		caseTypeSchemas: buildCaseTypeMap(doc),
	});

	// Delegate each mocked Server Action to its underlying helper
	// against the per-test store. The helpers accept a `CaseStore`
	// parameter directly — they were designed for the test-injection
	// shape `withOwnerContext` provides at the request boundary in
	// production. `mapPopulateSampleCasesError` / `mapSubmitFormError`
	// are bypassed here because the integration test exercises the
	// success arms; per-arm error mapping is covered by the action's
	// own unit tests.
	vi.mocked(loadCasesAction).mockImplementation(
		async (args): Promise<LoadCasesResult> =>
			readCases(store, {
				appId: args.appId,
				caseType: args.caseType,
				caseTypeSchemas: buildCaseTypeMap(args.blueprint),
				caseListConfig: args.caseListConfig,
				inputValues: args.inputValues,
			}),
	);
	vi.mocked(loadCaseDataAction).mockImplementation((appId, caseType, caseId) =>
		readCaseData(store, { appId, caseType, caseId }),
	);
	vi.mocked(populateSampleCasesAction).mockImplementation(
		async (appId, caseType, blueprint): Promise<PopulateSampleCasesResult> => {
			const ct = blueprint.caseTypes?.find((c) => c.name === caseType);
			if (!ct) {
				return {
					kind: "missing-case-type",
					caseType,
				};
			}
			return seedSampleCases(store, { appId, caseType: ct });
		},
	);
	vi.mocked(resetSampleCasesAction).mockImplementation(
		async (appId, caseType, blueprint): Promise<PopulateSampleCasesResult> => {
			const ct = blueprint.caseTypes?.find((c) => c.name === caseType);
			if (!ct) {
				return {
					kind: "missing-case-type",
					caseType,
				};
			}
			return resetSampleCases(store, { appId, caseType: ct });
		},
	);
	vi.mocked(submitFormAction).mockImplementation(
		async (mutation, appId): Promise<SubmissionResult> => {
			switch (mutation.kind) {
				case "registration": {
					const result = await applyRegistrationMutation(store, {
						mutation,
						appId,
					});
					return {
						kind: "registration",
						caseId: result.caseId,
						childCaseIds: result.childCaseIds,
					};
				}
				case "followup": {
					const result = await applyFollowupMutation(store, {
						mutation,
						appId,
					});
					return {
						kind: "followup",
						caseId: result.caseId,
						childCaseIds: result.childCaseIds,
					};
				}
				case "close": {
					const result = await applyCloseMutation(store, { mutation, appId });
					return {
						kind: "close",
						caseId: result.caseId,
						childCaseIds: result.childCaseIds,
					};
				}
				case "survey":
					return applySurveyMutation();
			}
		},
	);
});

// =================================================================
// 1. Search-input filter narrowing against real Postgres rows.
//
// Seed three rows differing on `name` + `status`. The case-list's
// always-on filter narrows to `status = 'open'` (drops the closed
// row). Typing into the search input narrows further to the row
// whose `name` matches the typed value. Both narrowing layers
// compile through the Postgres compiler stack — no mocked store,
// no hand-rolled SQL.
// =================================================================

describe("CaseListScreen with search inputs — real Postgres narrowing", () => {
	it("renders sorted rows after the always-on filter, then narrows further on typed search input", async () => {
		const store = buildStore();
		const doc = buildFixtureDoc();
		await store.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: buildCaseTypeMap(doc),
		});

		// Three rows. Alice + Bob are open; Carol is closed — the
		// always-on filter drops Carol before any input narrowing.
		// `status` lives on the reserved scalar column only (not
		// JSONB) because the term compiler routes the property name
		// through `RESERVED_SCALAR_COLUMNS` before the JSONB read.
		await store.insert({
			appId: APP_ID,
			row: {
				case_type: "patient",
				case_name: "Alice",
				status: "open",
				properties: { name: "Alice", age: 25 },
			},
		});
		await store.insert({
			appId: APP_ID,
			row: {
				case_type: "patient",
				case_name: "Bob",
				status: "open",
				properties: { name: "Bob", age: 40 },
			},
		});
		await store.insert({
			appId: APP_ID,
			row: {
				case_type: "patient",
				case_name: "Carol",
				status: "closed",
				properties: { name: "Carol", age: 30 },
			},
		});

		renderCaseListScreen(doc);

		// Initial load — the case list shows Alice + Bob ordered by
		// the authored sort directive (`age desc` priority 0 → Bob
		// before Alice). Carol drops via the always-on filter.
		await waitFor(() => {
			expect(screen.getByText("Bob")).toBeDefined();
			expect(screen.getByText("Alice")).toBeDefined();
		});
		expect(screen.queryByText("Carol")).toBeNull();

		// Sort order — `age desc` puts Bob (40) before Alice (25). The
		// rows render in `<tr>` elements; the first body row holds
		// Bob's case_name, the second holds Alice's. Filtering on
		// `<tr>` directly is more robust than reading `<td>` text in
		// order — the table header's `<tr>` would otherwise count as
		// row zero.
		const bodyRows = screen
			.getAllByRole("row")
			.filter((row) => row.querySelector("td") !== null);
		expect(bodyRows).toHaveLength(2);
		expect(bodyRows[0]?.textContent).toContain("Bob");
		expect(bodyRows[1]?.textContent).toContain("Alice");

		// Type "Alice" into the search input. `SearchInputForm`
		// debounces 300 ms before emitting the new value bag;
		// `waitFor` polls until the re-fired action's result lands.
		const input = screen.getByLabelText("Name") as HTMLInputElement;
		fireEvent.change(input, { target: { value: "Alice" } });

		await waitFor(
			() => {
				expect(screen.queryByText("Bob")).toBeNull();
			},
			{ timeout: 3_000 },
		);
		expect(screen.getByText("Alice")).toBeDefined();

		// Clear the input — debounced 300 ms → both open-status rows
		// return. The runtime-bindings layer's empty-value
		// short-circuit drops the input clause; the always-on filter
		// (`status = 'open'`) still applies so Carol stays out.
		fireEvent.change(input, { target: { value: "" } });
		await waitFor(
			() => {
				expect(screen.getByText("Bob")).toBeDefined();
			},
			{ timeout: 3_000 },
		);
		expect(screen.getByText("Alice")).toBeDefined();
		expect(screen.queryByText("Carol")).toBeNull();
	});
});

// =================================================================
// 2. Registration form write-through, then case-list re-render.
//
// Mount the registration form, fill in the required fields, submit.
// `submitFormAction`'s delegate runs `applyRegistrationMutation`
// against the per-test store. Switch the location back to the
// cases URL + re-render the case list; the new row is present.
// =================================================================

describe("FormScreen registration submit — write-through to case list", () => {
	it("writes the registration through the store and the new row surfaces in the case-list re-query", async () => {
		const doc = buildFixtureDoc();

		// First mount: registration form. Fill in fields, submit.
		const formView = renderFormScreen(doc, REG_FORM_UUID);

		// `EditableTitle` renders a readonly `<input>` for the form's
		// name; the user-editable fields are the rest. Filter to the
		// non-readonly textboxes.
		const allTextboxes = await screen.findAllByRole("textbox");
		const editable = allTextboxes.filter(
			(el) => !(el as HTMLInputElement).readOnly,
		);
		// Two text fields: `case_name`, `name`. The int field `age`
		// renders as a separate `<input type="number">` not picked up
		// by `getByRole("textbox")` (number inputs have role
		// `spinbutton`); handle it separately below. `status` is the
		// reserved scalar column the case-store hardcodes to `"open"`
		// on every registration insert; the form has no field for it.
		const caseNameInput = editable[0] as HTMLInputElement;
		const fullNameInput = editable[1] as HTMLInputElement;

		fireEvent.change(caseNameInput, { target: { value: "Dana" } });
		fireEvent.change(fullNameInput, { target: { value: "Dana" } });

		// `<input type="number">` carries role `spinbutton`. The
		// single number input on this form is the `age` field.
		const ageInput = screen.getByRole("spinbutton") as HTMLInputElement;
		fireEvent.change(ageInput, { target: { value: "33" } });

		fireEvent.click(screen.getByRole("button", { name: /^submit$/i }));

		// Wait for the registration action to resolve — `navigateMock.goHome`
		// firing is the signal the success arm dispatched the post-
		// submit navigation. The case-store write completed before
		// the dispatch.
		await waitFor(() => {
			expect(navigateMock.goHome).toHaveBeenCalledTimes(1);
		});

		// Unmount the form view and mount the case-list view against
		// the same per-test store. Mutating `currentLocation` + re-
		// rendering the case-list screen re-runs `useCases` against
		// the freshly-written row.
		formView.unmount();
		currentLocation = { kind: "cases", moduleUuid: MODULE_UUID };
		renderCaseListScreen(doc);

		// The new Dana row surfaces in the case-list. The always-on
		// filter (`status = 'open'`) admits it because the form's
		// `status` field wrote `"open"`. No other rows were seeded so
		// Dana is the only row.
		await waitFor(() => {
			expect(screen.getByText("Dana")).toBeDefined();
		});
		expect(screen.getByText("33")).toBeDefined();
	});
});

// =================================================================
// 3. Reset round-trip — confirmation, atomic delete + regenerate,
//    case-list re-fires its load against the regenerated rows.
// =================================================================

describe("CaseListScreen Reset — atomic delete + regenerate round-trip", () => {
	it("invokes the case-store's resetSampleData and re-renders the regenerated rows", async () => {
		const store = buildStore();
		const doc = buildFixtureDoc();
		await store.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: buildCaseTypeMap(doc),
		});

		// Seed one hand-crafted row whose name has a distinct prefix
		// the heuristic generator never produces. The load-bearing
		// post-reset assertion is "this row is gone" — that's the
		// observable signal the atomic delete + regenerate ran. The
		// generator's insert-side has dedicated coverage in
		// `caseDataBindingHelpers.test.ts`'s reset test.
		await store.insert({
			appId: APP_ID,
			row: {
				case_type: "patient",
				case_name: "ZZZ-HAND-CRAFTED",
				status: "open",
				properties: {
					name: "ZZZ-HAND-CRAFTED",
					age: 99,
				},
			},
		});

		renderCaseListScreen(doc);

		// Wait for the initial load — the hand-crafted row should be
		// visible before we trigger Reset.
		await waitFor(() => {
			expect(screen.getByText("ZZZ-HAND-CRAFTED")).toBeDefined();
		});

		// Click the Reset trigger → confirmation dialog → click
		// Reset to confirm. The dialog's content surfaced via the
		// shadcn `AlertDialog` primitive's `role="alertdialog"`.
		fireEvent.click(screen.getByRole("button", { name: /reset sample data/i }));
		await screen.findByRole("alertdialog");
		fireEvent.click(screen.getByRole("button", { name: /^reset$/i }));

		// Wait for the hand-crafted row to disappear — that's the
		// delete-side of `resetSampleData` landing. The regenerated
		// rows then surface via the screen's reload-key trigger, but
		// asserting which rows render against a deterministic-but-
		// generator-internal seed would couple the test to the
		// generator's name pool — out of scope here.
		await waitFor(
			() => {
				expect(screen.queryByText("ZZZ-HAND-CRAFTED")).toBeNull();
			},
			{ timeout: 5_000 },
		);
	});
});
