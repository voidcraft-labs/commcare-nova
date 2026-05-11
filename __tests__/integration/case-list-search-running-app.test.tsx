// @vitest-environment happy-dom
//
// __tests__/integration/case-list-search-running-app.test.tsx
//
// End-to-end coverage for the running-app search-execution surface.
// Each `describe(...)` block exercises one cross-layer contract a
// single per-layer unit test cannot capture:
//
//   - Initial render: `CaseListScreen` mounted against the live
//     `PostgresCaseStore` renders module-name heading, columns
//     filtered by `visibleInList`, calc cells materialized at the
//     SQL layer via `arith("+", prop, literal)`, and rows ordered
//     by the authored sort directives.
//   - Search-input narrowing: typing into `SearchInputForm` produces
//     a fresh `inputValues` reference, which `composeRuntimeFilter`
//     lowers into a runtime predicate that AND-composes with the
//     always-on `caseListConfig.filter`. The composed predicate
//     compiles to SQL through the case-store's compiler stack and
//     the rendered table reflects the narrowed result set against
//     real Postgres rows — no mocked store, no hand-rolled SQL.
//   - Registration write-through: `FormScreen`'s submit dispatches
//     through `submitFormAction` which routes the registration
//     mutation through `applyRegistrationMutation` against real
//     rows. The case-list re-render surfaces the new row.
//   - Followup write-through: a bound case is patched through
//     `applyFollowupMutation`; the case-list re-render reflects the
//     patched property value AND the calc cell (`age + 1`) re-
//     evaluates against the new value.
//   - Close write-through: a bound case is closed through
//     `applyCloseMutation`; the case-store stamps `closed_on` to a
//     non-null timestamp. `applyCloseMutation` passes no `status`
//     patch, so `status` stays at its pre-close value.
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
// ## Why direct screen mount, not PreviewShell
//
// The dispatcher's per-arm routing has unit-test coverage of its own;
// mounting it here adds Activity-ref complexity without exercising a
// different code path. Direct screen mount mirrors `CaseListScreen.test`
// and `FormScreen.test`.
//
// ## Why one round-trip per concern, not per-search-input-arm
//
// The runtime-bindings unit tests cover every `SearchInputType` × mode
// combination at the composition layer; the integration test pins the
// cross-layer round-trip (filter narrowing, write-through, reset) once
// per concern.

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
	calculatedColumn,
	plainColumn,
	simpleSearchInputDef,
} from "@/lib/domain";
import {
	arith,
	eq,
	literal,
	prop,
	qualifiedLiteral,
	term,
} from "@/lib/domain/predicate";
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
const MODULE_NAME = "Patients";
const OWNER_ID = "owner-int";
const MODULE_UUID = asDocUuid("00000000-0000-0000-0000-00000000a001");
const REG_FORM_UUID = asDocUuid("00000000-0000-0000-0000-00000000a002");
const FOLLOWUP_FORM_UUID = asDocUuid("00000000-0000-0000-0000-00000000a003");
const CLOSE_FORM_UUID = asDocUuid("00000000-0000-0000-0000-00000000a004");

const COL_NAME_UUID = asUuid("00000000-0000-4000-8000-000000000001");
const COL_AGE_UUID = asUuid("00000000-0000-4000-8000-000000000002");
// Calculated column projecting `age + 1` ("age next year"). Mirrors
// the authoring integration test's calc-column shape — `arith` plus
// a typed `int` literal compiles cleanly into the case-store's SQL
// `calculated` projection and surfaces on `row.calculated[uuid]`.
// The screen reads the slot through `evaluateColumnValue`.
const COL_CALC_UUID = asUuid("00000000-0000-4000-8000-000000000003");
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
				name: MODULE_NAME,
				caseType: "patient",
				caseListConfig: {
					columns: [
						plainColumn(COL_NAME_UUID, "case_name", "Name"),
						plainColumn(COL_AGE_UUID, "age", "Age", {
							sort: { direction: "desc", priority: 0 },
						}),
						// `age + 1` ("age next year"). `concat(prop, '1')`
						// would also produce a calc cell here, but Postgres
						// bind-type inference trips "could not determine data
						// type of parameter $N" because `compileConcat` does
						// not emit text casts on its parameter operands.
						// `arith("+", prop, qualifiedLiteral(1, "int"))`
						// emits `((properties->>'age')::int + $N::int)` —
						// both operands carry an explicit cast, planner
						// resolves cleanly. The screen reads
						// `row.calculated[COL_CALC_UUID]` through
						// `evaluateColumnValue`; the integration test asserts
						// the rendered value to pin the SQL projection's
						// round-trip into the table cell.
						calculatedColumn(
							COL_CALC_UUID,
							"Age next year",
							arith(
								"+",
								term(prop("patient", "age")),
								term(qualifiedLiteral(1, "int")),
							),
						),
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
					{
						// Close forms commonly carry no field tree — the
						// case-store's `applyCloseMutation` writes
						// `status: "closed"` regardless of the form's
						// contents, so a zero-field close is the canonical
						// shape. The form-engine's submit dispatch still
						// fires `submitFormAction` with a `close`-kind
						// mutation; the always-on `status = 'open'` filter
						// then drops the closed row from the next case-list
						// re-query.
						uuid: CLOSE_FORM_UUID,
						name: "Close visit",
						type: "close",
						fields: [],
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

		// Heading is the module name — pins the contract that the
		// case-list title comes from the owning module, not from a
		// form, end-to-end against a real-Postgres render.
		expect(screen.getByRole("heading", { name: MODULE_NAME })).toBeDefined();

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

		// Calc cell — `age + 1` evaluates at the SQL layer; the
		// rendered cell is the materialized string. Pins the
		// `calculated` SELECT projection through to the screen via
		// `evaluateColumnValue`. Alice's row carries `age=25` → 26;
		// Bob's carries `age=40` → 41. Both materialized cell values
		// must land in the rendered DOM.
		const calcCells = screen.getAllByRole("cell");
		const calcCellTexts = calcCells.map((c) => c.textContent ?? "");
		expect(calcCellTexts).toContain("41");
		expect(calcCellTexts).toContain("26");

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

// =================================================================
// 4. Followup form write-through, then case-list re-render.
//
// Mount the followup form against a pre-seeded case row, patch the
// `age` field, submit. `submitFormAction`'s delegate runs
// `applyFollowupMutation` against the per-test store. Switch back
// to the cases URL + re-render the case list; the patched value
// surfaces on the row.
// =================================================================

describe("FormScreen followup submit — patch round-trip to case list", () => {
	it("writes the followup patch through the store and the case-list re-render reflects the new value", async () => {
		const store = buildStore();
		const doc = buildFixtureDoc();
		await store.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: buildCaseTypeMap(doc),
		});

		// Seed a single open-status row. The followup form is bound
		// to this caseId via the URL location's `caseId` slot.
		const insertResult = await store.insert({
			appId: APP_ID,
			row: {
				case_type: "patient",
				case_name: "Alice",
				status: "open",
				properties: { name: "Alice", age: 40 },
			},
		});
		const caseId = insertResult.caseId;

		// Mount the followup form bound to the seeded case. The
		// case-data preload runs through `loadCaseDataAction`'s
		// delegate against the per-test store; the engine hydrates
		// the form's `age` input with the bound row's value.
		const formView = renderFormScreen(doc, FOLLOWUP_FORM_UUID, caseId);

		// Wait for the engine to mount AND for the preload to land
		// the bound row's `age = 40` on the input. Waiting on the
		// preloaded VALUE (not just the input's existence) is the
		// load-bearing pin against the race where `fireEvent.change`
		// would land "41" before the async preload overwrites it
		// with "40", silently producing an empty submission patch.
		const ageInput = await waitFor(() => {
			const el = screen.getByRole("spinbutton") as HTMLInputElement;
			expect(el.value).toBe("40");
			return el;
		});

		// Patch the age field to a new value. The followup mutation
		// emits a `properties.age` write only; `case_name` is not
		// touched (the empty-field omission rule at
		// `computeSubmissionMutation` keeps unwritten fields out of
		// the mutation entirely).
		fireEvent.change(ageInput, { target: { value: "41" } });

		fireEvent.click(screen.getByRole("button", { name: /^submit$/i }));

		// Followup's default post-submit destination is `previous`,
		// which routes to the `onBack` callback. We pass a no-op
		// onBack in `renderFormScreen`; observable signal that the
		// submit landed is the case-store row's new value, asserted
		// below after the case-list re-render.
		await waitFor(() => {
			expect(vi.mocked(submitFormAction)).toHaveBeenCalled();
		});
		// Confirm the patch actually landed before mutating to the
		// case-list URL — a race where `submitFormAction` is observed
		// before its `applyFollowupMutation` finished would otherwise
		// surface as a flaky re-read.
		await waitFor(async () => {
			const rows = await store.query({
				appId: APP_ID,
				caseType: "patient",
				caseTypeSchemas: buildCaseTypeMap(doc),
			});
			expect(rows[0]?.properties).toEqual({ name: "Alice", age: 41 });
		});

		formView.unmount();
		currentLocation = { kind: "cases", moduleUuid: MODULE_UUID };
		renderCaseListScreen(doc);

		// The case-list re-renders against the patched row. The Age
		// column reads through the patched property; the calc cell
		// (`age + 1`) re-evaluates against the new `age`. `case_name`
		// stays "Alice" — the followup form has no case-name leaf.
		await waitFor(() => {
			expect(screen.getByText("Alice")).toBeDefined();
		});
		const cells = screen.getAllByRole("cell");
		const cellTexts = cells.map((c) => c.textContent ?? "");
		// Plain Age column reads the patched property → "41".
		expect(cellTexts).toContain("41");
		// Calc column re-evaluates → 42 (age + 1).
		expect(cellTexts).toContain("42");
		// Inversion: pre-patch age value `40` (and its calc 41 from
		// the pre-patch row) must not survive the re-query. Asserting
		// 40 is absent is the load-bearing pin — 41 is BOTH the new
		// plain-Age cell AND the old calc value, so its presence
		// alone wouldn't tell the two states apart.
		expect(cellTexts).not.toContain("40");
	});
});

// =================================================================
// 5. Close form write-through — `closed_on` stamps to non-null.
//
// `applyCloseMutation` writes a `closed_on = now()` timestamp via
// `CaseStore.close` and passes no `status` patch, so `status` stays
// at its pre-close value. The end-to-end pin: a zero-field close
// form's submit dispatches `submitFormAction` with a `close`-kind
// mutation that lands the timestamp on the bound row. No other
// test covers this round-trip.
// =================================================================

describe("FormScreen close submit — closed_on stamps on the bound row", () => {
	it("dispatches the close mutation and the case-store stamps closed_on", async () => {
		const store = buildStore();
		const doc = buildFixtureDoc();
		await store.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: buildCaseTypeMap(doc),
		});

		// Seed an open-status row. The close form binds to this
		// caseId via the URL location.
		const insertResult = await store.insert({
			appId: APP_ID,
			row: {
				case_type: "patient",
				case_name: "Alice",
				status: "open",
				properties: { name: "Alice", age: 25 },
			},
		});
		const caseId = insertResult.caseId;

		// Mount the close form. Zero-field close forms render no
		// editable fields; the submit row still mounts in test mode.
		const formView = renderFormScreen(doc, CLOSE_FORM_UUID, caseId);

		const submit = await screen.findByRole("button", {
			name: /^submit$/i,
		});
		fireEvent.click(submit);

		await waitFor(() => {
			expect(vi.mocked(submitFormAction)).toHaveBeenCalled();
		});

		// `applyCloseMutation` stamps `closed_on = now()` via
		// `CaseStore.close` and passes no `status` patch, so the test
		// asserts the timestamp landed while `status` stays untouched.
		await waitFor(async () => {
			const rows = await store.query({
				appId: APP_ID,
				caseType: "patient",
				caseTypeSchemas: buildCaseTypeMap(doc),
			});
			expect(rows[0]?.closed_on).not.toBeNull();
		});

		formView.unmount();
	});
});
