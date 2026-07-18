// @vitest-environment happy-dom
//
// components/preview/screens/__tests__/FormScreen.test.tsx
//
// Pins the running-app form submit contract:
//
//   1. Validate-pass dispatches `submitFormAction` with the engine-
//      computed `SubmissionMutation`. Each FormType (registration /
//      followup / close / survey) round-trips its own discriminator
//      through the action call and lands the configured post-submit
//      navigation. The Server Action delegates to the case-store's
//      `apply*Mutation` helpers; the screen's contract is that the
//      mutation reaches the action with the matching `kind` —
//      property-level walking is covered by the engine's own unit
//      tests.
//   2. Error arms (`unauthenticated` / `error` / `case-not-found` /
//      `case-properties-validation` / `missing-case-type` /
//      `schema-not-synced`) render an inline error below the submit
//      row. The form stays mounted (no navigation fires) so the user
//      can amend and resubmit. `case-properties-validation`'s per-
//      field failure list renders one line per failure in the
//      `whitespace-pre-line` block.
//   3. Pending UX: while the action is in flight the submit button
//      reads "Submitting...", carries the spinner icon, and is
//      disabled. The Clear button is also disabled so a re-click
//      can't queue a second submission against a still-running one.
//      A controllable deferred holds the action in flight for the
//      assertion, then resolves with the success arm so the pending
//      promise drains before teardown.

import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { xp } from "@/lib/__tests__/docHelpers";
import { BlueprintDocProvider } from "@/lib/doc/provider";
import { asUuid } from "@/lib/doc/types";
import type { SubmissionResult } from "@/lib/preview/engine/caseDataBindingTypes";
import type { Location } from "@/lib/routing/types";

// ── Mocks ────────────────────────────────────────────────────────

const APP_ID = "app-form-screen-test";
const MODULE_UUID = asUuid("00000000-0000-0000-0000-000000000a01");
/* One UUID per FormType — the test suite mounts a different form
 * arm per case under one BlueprintDocProvider seed, and `formUuid` is
 * the URL discriminator the screen reads. Distinct UUIDs keep each
 * test's mounted form independent. */
const REG_FORM_UUID = asUuid("00000000-0000-0000-0000-000000000b01");
const FOLLOWUP_FORM_UUID = asUuid("00000000-0000-0000-0000-000000000b02");
const CLOSE_FORM_UUID = asUuid("00000000-0000-0000-0000-000000000b03");
const SURVEY_FORM_UUID = asUuid("00000000-0000-0000-0000-000000000b04");
/* The validate-fail test mounts this fifth form whose single field
 *  is required. With no user input the engine's `validateAll()`
 *  marks the field invalid and returns `false`, exercising the
 *  short-circuit branch of `handleSubmit` that scrolls to the
 *  first invalid field WITHOUT firing `submitFormAction`. */
const REQUIRED_FORM_UUID = asUuid("00000000-0000-0000-0000-000000000b05");
const FIELD_UUID = asUuid("00000000-0000-0000-0000-000000000c01");
const FIELD_REQUIRED_UUID = asUuid("00000000-0000-0000-0000-000000000c02");

/* The currentLocation is mutated per-test (one shared `Location`
 *  carrier the `useLocation` mock reads from) so each test can pin
 *  the URL to a specific form arm without recreating the provider
 *  stack. The shape mirrors what `useNavigate.openForm` would push:
 *  `{ kind: "form", moduleUuid, formUuid }`. */
let currentLocation: Location = {
	kind: "form",
	moduleUuid: MODULE_UUID,
	formUuid: REG_FORM_UUID,
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
const setPreviewCaseTargetMock = vi.fn();
const setPreviewSelectedCaseMock = vi.fn();

/* Mutable carrier the `useAppId` mock reads from. Most tests run
 *  against the default `APP_ID`; the `!appId` guard test overrides
 *  to `undefined` for a single run. `beforeEach` resets to the
 *  default so test ordering doesn't matter. */
let currentAppId: string | undefined = APP_ID;

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
		useAppId: () => currentAppId,
		/* Preview mode mounts the submit row — every test in this file
		 *  asserts against the row's behavior. Mirroring CaseListScreen's
		 *  hook mocks so the two screens share a session-mode contract.
		 *  `usePreviewing` is mocked alongside because `TextEditable`
		 *  reads it directly (not through `useEditMode`); `true` is the
		 *  underlying source `useEditMode("preview")` derives from. */
		useEditMode: () => "preview" as const,
		usePreviewing: () => true,
		useBuilderIsReady: () => true,
		useSetPreviewCaseTarget: () => setPreviewCaseTargetMock,
		useSetPreviewSelectedCase: () => setPreviewSelectedCaseMock,
	};
});

/* Server Actions live in a `"use server"` module. Mock both the
 *  case-data load (consumed by `useCaseData` for followup forms) and
 *  the submit action (the unit under test) so the screen renders
 *  synchronously without spinning up auth + Postgres. */
vi.mock("@/lib/preview/engine/caseDataBinding", () => ({
	loadCasesAction: vi.fn(),
	loadCaseDataAction: vi.fn(),
	submitFormAction: vi.fn(),
	loadFilterPreviewAction: vi.fn(),
}));

import {
	loadCaseDataAction,
	loadCasesAction,
	submitFormAction,
} from "@/lib/preview/engine/caseDataBinding";
import { BuilderFormEngineProvider } from "@/lib/preview/engine/provider";
import { invalidateCaseData } from "@/lib/preview/hooks/caseDataInvalidation";
import { FormScreen } from "../FormScreen";

// ── Fixtures ─────────────────────────────────────────────────────

const CASE_TYPE = "patient";
const FOLLOWUP_CASE_ID = "11111111-1111-1111-1111-111111111111";

const onBackMock = vi.fn();

/* Mount FormScreen against a BlueprintDocProvider that carries
 *  every FormType arm under one module. Each form owns one text
 *  field — the four FormType forms share a non-required `name`
 *  field (so `validateAll()` returns true with empty values, letting
 *  per-FormType tests assert action-call shape without typing in
 *  values), and `REQUIRED_FORM_UUID` owns a required `name` field
 *  so the validate-fail test exercises the `valid === false`
 *  short-circuit. Engine value-walking has dedicated coverage in
 *  `formEngine.test.ts`. */
function renderFormScreen(opts: {
	formUuid: typeof REG_FORM_UUID;
	caseId?: string;
}) {
	currentLocation = {
		kind: "form",
		moduleUuid: MODULE_UUID,
		formUuid: opts.formUuid,
	};
	/* The required-form arm registers `FIELD_REQUIRED_UUID`; every
	 *  other arm registers the non-required `FIELD_UUID`. The active
	 *  form's `fieldOrder` is the only entry the engine reads on
	 *  activation, so only the active form's list needs the entry. */
	const isRequiredForm = opts.formUuid === REQUIRED_FORM_UUID;
	const activeFieldUuid = isRequiredForm ? FIELD_REQUIRED_UUID : FIELD_UUID;
	return render(
		<BlueprintDocProvider
			appId={APP_ID}
			initialDoc={{
				appId: APP_ID,
				appName: "Form screen test app",
				connectType: null,
				caseTypes: [
					{
						name: CASE_TYPE,
						properties: [{ name: "name", label: "Name", data_type: "text" }],
					},
				],
				modules: {
					[MODULE_UUID]: {
						uuid: MODULE_UUID,
						id: "patient_module",
						name: "Patients",
						caseType: CASE_TYPE,
					},
				},
				forms: {
					[REG_FORM_UUID]: {
						uuid: REG_FORM_UUID,
						id: "registration_form",
						name: "Registration",
						type: "registration",
					},
					[FOLLOWUP_FORM_UUID]: {
						uuid: FOLLOWUP_FORM_UUID,
						id: "followup_form",
						name: "Followup",
						type: "followup",
					},
					[CLOSE_FORM_UUID]: {
						uuid: CLOSE_FORM_UUID,
						id: "close_form",
						name: "Close",
						type: "close",
					},
					[SURVEY_FORM_UUID]: {
						uuid: SURVEY_FORM_UUID,
						id: "survey_form",
						name: "Survey",
						type: "survey",
					},
					[REQUIRED_FORM_UUID]: {
						uuid: REQUIRED_FORM_UUID,
						id: "required_form",
						name: "Required form",
						/* `registration` so the screen renders the standard
						 *  submit row with no followup-only empty-state
						 *  guards interfering with the validate-fail
						 *  assertion. */
						type: "registration",
					},
				},
				/* `FIELD_UUID` — non-required text bound to the case type's
				 *  `name` property. `FIELD_REQUIRED_UUID` — same shape with
				 *  `required: "true()"` so the engine marks it invalid when
				 *  the value is empty. */
				fields: {
					[FIELD_UUID]: {
						uuid: FIELD_UUID,
						id: "name",
						kind: "text",
						label: "Name",
						case_property_on: CASE_TYPE,
					},
					[FIELD_REQUIRED_UUID]: {
						uuid: FIELD_REQUIRED_UUID,
						id: "name",
						kind: "text",
						label: "Name",
						case_property_on: CASE_TYPE,
						required: xp("true()"),
					},
				},
				moduleOrder: [MODULE_UUID],
				formOrder: {
					[MODULE_UUID]: [
						REG_FORM_UUID,
						FOLLOWUP_FORM_UUID,
						CLOSE_FORM_UUID,
						SURVEY_FORM_UUID,
						REQUIRED_FORM_UUID,
					],
				},
				fieldOrder: { [opts.formUuid]: [activeFieldUuid] },
			}}
		>
			<BuilderFormEngineProvider>
				<FormScreen
					screen={{
						type: "form",
						moduleIndex: 0,
						formIndex: 0,
						caseId: opts.caseId,
					}}
					onBack={onBackMock}
				/>
			</BuilderFormEngineProvider>
		</BlueprintDocProvider>,
	);
}

beforeEach(() => {
	onBackMock.mockClear();
	navigateMock.goHome.mockClear();
	navigateMock.openModule.mockClear();
	navigateMock.replace.mockClear();
	setPreviewCaseTargetMock.mockClear();
	setPreviewSelectedCaseMock.mockClear();
	/* Reset the appId carrier so the `!appId` guard test's per-run
	 *  override doesn't leak into sibling tests. */
	currentAppId = APP_ID;
	/* Default `loadCaseDataAction` to `missing` so followup screens
	 *  in test mode either short-circuit on the no-case empty state
	 *  (when no caseId is supplied) or proceed to render the form
	 *  against engine defaults (when caseId is supplied and the row
	 *  resolves on the test-supplied path). Tests overriding for
	 *  followup mount path set this per-test. */
	vi.mocked(loadCaseDataAction).mockResolvedValue({ kind: "missing" });
	/* Default the case-list query (used by the auto-select path for a
	 *  directly-previewed case-loading form) to an empty store; tests that
	 *  exercise auto-selection override with rows. */
	vi.mocked(loadCasesAction).mockResolvedValue({ kind: "empty" });
});

describe("FormScreen — destructive case-data replacement", () => {
	it("disables the bound form immediately and replaces it with Results", async () => {
		vi.mocked(loadCaseDataAction).mockResolvedValue({
			kind: "row",
			row: {
				case_id: FOLLOWUP_CASE_ID,
				case_type: CASE_TYPE,
				case_name: "Existing case",
				app_id: APP_ID,
				owner_id: "owner-test",
				status: "open",
				opened_on: null,
				modified_on: null,
				closed_on: null,
				external_id: null,
				parent_case_id: null,
				properties: {},
				calculated: {},
			},
			ancestors: [],
		});
		renderFormScreen({
			formUuid: FOLLOWUP_FORM_UUID,
			caseId: FOLLOWUP_CASE_ID,
		});

		const submit = await screen.findByRole("button", { name: /^submit$/i });
		expect((submit as HTMLButtonElement).disabled).toBe(false);
		act(() => invalidateCaseData(APP_ID, CASE_TYPE, "replacement"));

		await waitFor(() => {
			expect((submit as HTMLButtonElement).disabled).toBe(true);
			expect(navigateMock.replace).toHaveBeenCalledWith({
				kind: "cases",
				moduleUuid: MODULE_UUID,
			});
		});
		expect(setPreviewCaseTargetMock).toHaveBeenCalledWith({
			formUuid: FOLLOWUP_FORM_UUID,
		});
		expect(setPreviewSelectedCaseMock).toHaveBeenCalledWith(undefined);
		fireEvent.click(submit);
		expect(vi.mocked(submitFormAction)).not.toHaveBeenCalled();
	});
});

// ── Validate-pass: per-FormType action dispatch ─────────────────

describe("FormScreen — registration submit", () => {
	it("dispatches submitFormAction with a registration-shaped mutation", async () => {
		vi.mocked(submitFormAction).mockResolvedValue({
			kind: "registration",
			caseId: "new-case-id",
			childCaseIds: [],
		});

		renderFormScreen({ formUuid: REG_FORM_UUID });

		const submit = await screen.findByRole("button", { name: /^submit$/i });
		fireEvent.click(submit);

		await waitFor(() => {
			expect(vi.mocked(submitFormAction)).toHaveBeenCalledTimes(1);
		});
		const [mutation, appIdArg] = vi.mocked(submitFormAction).mock.calls[0];
		expect(mutation.kind).toBe("registration");
		expect(appIdArg).toBe(APP_ID);
		/* Registration's default post-submit destination is `app_home`,
		 *  resolved via `defaultPostSubmit("registration")`. The screen
		 *  fires `navigate.goHome` on success. */
		await waitFor(() => {
			expect(navigateMock.goHome).toHaveBeenCalledTimes(1);
		});
	});
});

describe("FormScreen — followup submit", () => {
	it("dispatches submitFormAction with a followup-shaped mutation", async () => {
		/* Followup forms require a bound caseId — the case-loading
		 *  preload runs through `loadCaseDataAction`, so the mock
		 *  resolves to a `row` arm carrying the bound case row. The
		 *  row's `properties` are immaterial here; the test asserts
		 *  the action-call's mutation `kind`. */
		vi.mocked(loadCaseDataAction).mockResolvedValue({
			kind: "row",
			row: {
				case_id: FOLLOWUP_CASE_ID,
				case_type: CASE_TYPE,
				case_name: "Existing case",
				app_id: APP_ID,
				owner_id: "owner-test",
				status: "open",
				opened_on: null,
				modified_on: null,
				closed_on: null,
				external_id: null,
				parent_case_id: null,
				properties: {},
				calculated: {},
			},
			ancestors: [],
		});
		vi.mocked(submitFormAction).mockResolvedValue({
			kind: "followup",
			caseId: FOLLOWUP_CASE_ID,
			childCaseIds: [],
		});

		renderFormScreen({
			formUuid: FOLLOWUP_FORM_UUID,
			caseId: FOLLOWUP_CASE_ID,
		});

		const submit = await screen.findByRole("button", { name: /^submit$/i });
		fireEvent.click(submit);

		await waitFor(() => {
			expect(vi.mocked(submitFormAction)).toHaveBeenCalledTimes(1);
		});
		const [mutation] = vi.mocked(submitFormAction).mock.calls[0];
		expect(mutation.kind).toBe("followup");
		if (mutation.kind === "followup") {
			expect(mutation.caseId).toBe(FOLLOWUP_CASE_ID);
		}
		/* Followup's default post-submit destination is `previous`,
		 *  which routes to `onBack` (the BuilderLayout back-stack
		 *  handler the screen receives as a prop). */
		await waitFor(() => {
			expect(onBackMock).toHaveBeenCalledTimes(1);
		});
	});
});

describe("FormScreen — close submit", () => {
	it("dispatches submitFormAction with a close-shaped mutation", async () => {
		vi.mocked(loadCaseDataAction).mockResolvedValue({
			kind: "row",
			row: {
				case_id: FOLLOWUP_CASE_ID,
				case_type: CASE_TYPE,
				case_name: "Existing case",
				app_id: APP_ID,
				owner_id: "owner-test",
				status: "open",
				opened_on: null,
				modified_on: null,
				closed_on: null,
				external_id: null,
				parent_case_id: null,
				properties: {},
				calculated: {},
			},
			ancestors: [],
		});
		vi.mocked(submitFormAction).mockResolvedValue({
			kind: "close",
			caseId: FOLLOWUP_CASE_ID,
			childCaseIds: [],
		});

		renderFormScreen({
			formUuid: CLOSE_FORM_UUID,
			caseId: FOLLOWUP_CASE_ID,
		});

		const submit = await screen.findByRole("button", { name: /^submit$/i });
		fireEvent.click(submit);

		await waitFor(() => {
			expect(vi.mocked(submitFormAction)).toHaveBeenCalledTimes(1);
		});
		const [mutation] = vi.mocked(submitFormAction).mock.calls[0];
		expect(mutation.kind).toBe("close");
		if (mutation.kind === "close") {
			expect(mutation.caseId).toBe(FOLLOWUP_CASE_ID);
		}
		/* Close inherits followup's `previous` destination — both
		 *  case-loading form types fall through to `onBack`. */
		await waitFor(() => {
			expect(onBackMock).toHaveBeenCalledTimes(1);
		});
	});
});

describe("FormScreen — survey submit", () => {
	it("dispatches navigation without writing case data", async () => {
		vi.mocked(submitFormAction).mockResolvedValue({ kind: "survey" });

		renderFormScreen({ formUuid: SURVEY_FORM_UUID });

		const submit = await screen.findByRole("button", { name: /^submit$/i });
		fireEvent.click(submit);

		/* Survey is structurally a no-op at the case-store
		 *  (`applySurveyMutation` writes nothing), but the action is
		 *  still invoked so the typed-result loop survives the call.
		 *  The mutation's `kind` carries `"survey"`. */
		await waitFor(() => {
			expect(vi.mocked(submitFormAction)).toHaveBeenCalledTimes(1);
		});
		const [mutation] = vi.mocked(submitFormAction).mock.calls[0];
		expect(mutation.kind).toBe("survey");
		/* Survey's default post-submit destination is `app_home`. */
		await waitFor(() => {
			expect(navigateMock.goHome).toHaveBeenCalledTimes(1);
		});
	});
});

// ── Error arms ──────────────────────────────────────────────────

describe("FormScreen — error arms render inline", () => {
	it("renders the unauthenticated message and stays on the form", async () => {
		vi.mocked(submitFormAction).mockResolvedValue({ kind: "unauthenticated" });

		renderFormScreen({ formUuid: REG_FORM_UUID });

		const submit = await screen.findByRole("button", { name: /^submit$/i });
		fireEvent.click(submit);

		await waitFor(() => {
			expect(screen.getByText("Sign in to submit this form.")).toBeDefined();
		});
		/* The form stays mounted — no navigation fires. The Clear button
		 *  is still in the DOM, confirming the submit row didn't unmount. */
		expect(navigateMock.goHome).not.toHaveBeenCalled();
		expect(onBackMock).not.toHaveBeenCalled();
		expect(screen.getByRole("button", { name: /clear form/i })).toBeDefined();
	});

	it("renders the case-not-found message and stays on the form", async () => {
		vi.mocked(loadCaseDataAction).mockResolvedValue({
			kind: "row",
			row: {
				case_id: FOLLOWUP_CASE_ID,
				case_type: CASE_TYPE,
				case_name: "Existing case",
				app_id: APP_ID,
				owner_id: "owner-test",
				status: "open",
				opened_on: null,
				modified_on: null,
				closed_on: null,
				external_id: null,
				parent_case_id: null,
				properties: {},
				calculated: {},
			},
			ancestors: [],
		});
		vi.mocked(submitFormAction).mockResolvedValue({
			kind: "case-not-found",
			caseId: FOLLOWUP_CASE_ID,
		});

		renderFormScreen({
			formUuid: FOLLOWUP_FORM_UUID,
			caseId: FOLLOWUP_CASE_ID,
		});

		const submit = await screen.findByRole("button", { name: /^submit$/i });
		fireEvent.click(submit);

		await waitFor(() => {
			expect(
				screen.getByText(
					/The case you were editing no longer exists\. Refresh and try again\./,
				),
			).toBeDefined();
		});
		expect(onBackMock).not.toHaveBeenCalled();
	});

	it("renders the validation-failure per-field list with the case-type name", async () => {
		vi.mocked(submitFormAction).mockResolvedValue({
			kind: "case-properties-validation",
			caseType: CASE_TYPE,
			failures: [
				{ path: "/age", message: "must be integer" },
				{ path: "", message: "additional property not allowed" },
			],
		});

		renderFormScreen({ formUuid: REG_FORM_UUID });

		const submit = await screen.findByRole("button", { name: /^submit$/i });
		fireEvent.click(submit);

		/* The validation block joins the header + per-field failures
		 *  into one `whitespace-pre-line` text node — reading `alert.textContent`
		 *  gives the full string in one match, letting one assertion
		 *  pin every load-bearing fragment: (1) the header names
		 *  `result.caseType` so multi-case submissions can tell which
		 *  case type rejected, (2) the per-field rows each render with
		 *  the path stripped of its leading slash, and (3) the empty
		 *  path becomes `<root>`. */
		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toMatch(
			new RegExp(`Some fields on case type '${CASE_TYPE}'`),
		);
		expect(alert.textContent).toMatch(/age: must be integer/);
		expect(alert.textContent).toMatch(
			/<root>: additional property not allowed/,
		);
		expect(navigateMock.goHome).not.toHaveBeenCalled();
	});

	it("renders the missing-case-type message", async () => {
		vi.mocked(submitFormAction).mockResolvedValue({
			kind: "missing-case-type",
			caseType: CASE_TYPE,
		});

		renderFormScreen({ formUuid: REG_FORM_UUID });

		const submit = await screen.findByRole("button", { name: /^submit$/i });
		fireEvent.click(submit);

		await waitFor(() => {
			expect(
				screen.getByText(
					new RegExp(`Case type '${CASE_TYPE}' is no longer in the blueprint`),
				),
			).toBeDefined();
		});
	});

	it("renders the schema-not-synced message", async () => {
		vi.mocked(submitFormAction).mockResolvedValue({
			kind: "schema-not-synced",
			caseType: CASE_TYPE,
		});

		renderFormScreen({ formUuid: REG_FORM_UUID });

		const submit = await screen.findByRole("button", { name: /^submit$/i });
		fireEvent.click(submit);

		await waitFor(() => {
			expect(
				screen.getByText(
					new RegExp(`Case type '${CASE_TYPE}' isn't ready yet`),
				),
			).toBeDefined();
		});
	});

	it("renders the generic error arm's message verbatim", async () => {
		vi.mocked(submitFormAction).mockResolvedValue({
			kind: "error",
			message: "Could not reach the case store.",
		});

		renderFormScreen({ formUuid: REG_FORM_UUID });

		const submit = await screen.findByRole("button", { name: /^submit$/i });
		fireEvent.click(submit);

		await waitFor(() => {
			expect(screen.getByText("Could not reach the case store.")).toBeDefined();
		});
	});
});

// ── Pending UX ──────────────────────────────────────────────────

describe("FormScreen — pending UX", () => {
	it("disables Submit + Clear and swaps the label to Submitting while the action is in flight", async () => {
		/* Stall the action via a controllable deferred so the screen sits
		 *  in the `running` arm long enough to assert the pending UX, then
		 *  resolve it after the assertion. A never-resolving `new Promise`
		 *  is never destroyed — async_hooks reports it as a permanent leak
		 *  under `--detectAsyncLeaks` — so the deferred is resolved before
		 *  teardown to drain the in-flight submission + its awaiters. */
		let resolveSubmit!: (value: SubmissionResult) => void;
		vi.mocked(submitFormAction).mockImplementation(
			() =>
				new Promise<SubmissionResult>((resolve) => {
					resolveSubmit = resolve;
				}),
		);

		renderFormScreen({ formUuid: REG_FORM_UUID });

		const submit = await screen.findByRole("button", { name: /^submit$/i });
		fireEvent.click(submit);

		/* The button's accessible name switches from "Submit" to
		 *  "Submitting..." while the action is in flight. The trailing
		 *  ellipsis matches the screen's label format verbatim. */
		const pending = await screen.findByRole("button", {
			name: /submitting\.\.\./i,
		});
		expect((pending as HTMLButtonElement).disabled).toBe(true);
		/* Clear is also disabled so a re-click can't queue a second
		 *  reset against the still-running submission. */
		const clear = screen.getByRole("button", { name: /clear form/i });
		expect((clear as HTMLButtonElement).disabled).toBe(true);

		/* Settle the action with the registration success arm so the screen
		 *  leaves the `running` state and dispatches its post-submit
		 *  navigation, draining the pending promise inside `act`. */
		await act(async () => {
			resolveSubmit({
				kind: "registration",
				caseId: "new-case-id",
				childCaseIds: [],
			});
		});
		/* Registration's success arm fires `navigate.goHome` — waiting on
		 *  it confirms every follow-on async has flushed. */
		await waitFor(() => {
			expect(navigateMock.goHome).toHaveBeenCalledTimes(1);
		});
	});
});

// ── Validate-fail short-circuit ─────────────────────────────────

describe("FormScreen — validate-fail short-circuit", () => {
	it("does NOT fire submitFormAction when the engine reports an invalid form", async () => {
		/* `REQUIRED_FORM_UUID`'s field is `required: "true()"` and
		 *  starts empty. The engine's `validateAll()` marks the field
		 *  invalid and returns `false`; `handleSubmit` short-circuits
		 *  on the falsy arm, scrolls to the first invalid element, and
		 *  never reaches `submitFormAction`. The carrier check below
		 *  pins the load-bearing contract: the user's first attempt
		 *  with empty required fields stays on the form. */
		renderFormScreen({ formUuid: REQUIRED_FORM_UUID });

		const submit = await screen.findByRole("button", { name: /^submit$/i });
		fireEvent.click(submit);

		/* `waitFor` gives any async work a chance to run; the action
		 *  must remain unfired across the full poll window for the
		 *  assertion to hold. */
		await waitFor(() => {
			expect(vi.mocked(submitFormAction)).not.toHaveBeenCalled();
		});
		/* No inline error renders — the validate-fail branch leaves
		 *  `submitStatus` at `idle`; per-field error UI is owned by
		 *  the field renderers, not by the submit row's alert. */
		expect(screen.queryByRole("alert")).toBeNull();
		expect(navigateMock.goHome).not.toHaveBeenCalled();
		expect(onBackMock).not.toHaveBeenCalled();
	});
});

// ── !appId guard ───────────────────────────────────────────────

describe("FormScreen — appId guard", () => {
	it("surfaces the unavailable-app message and skips the action when appId is undefined", async () => {
		/* The guard's load-bearing case: the route mounted before the
		 *  builder session finished resolving the app id. Override the
		 *  carrier to `undefined`; `beforeEach` resets after this test
		 *  so siblings keep the default. */
		currentAppId = undefined;

		renderFormScreen({ formUuid: REG_FORM_UUID });

		const submit = await screen.findByRole("button", { name: /^submit$/i });
		fireEvent.click(submit);

		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toMatch(
			/This app isn't fully loaded yet\. Wait a moment and try again\./,
		);
		expect(vi.mocked(submitFormAction)).not.toHaveBeenCalled();
	});
});

// ── Engine-invariant + RSC catch suppression ───────────────────

describe("FormScreen — catch arm hides developer-jargon detail", () => {
	it("collapses thrown errors to the fixed friendly message", async () => {
		/* `submitFormAction` throwing (rather than returning a typed
		 *  error arm) stands in for the engine's `compilerBugMessage`
		 *  invariant throws and any RSC-framework rejection. The
		 *  thrown message carries developer-jargon detail; the inline
		 *  alert must NOT surface it. */
		vi.mocked(submitFormAction).mockRejectedValue(
			new Error(
				"Internal bug — `preview.formEngine.computeSubmissionMutation` invariant violated: developer-jargon detail",
			),
		);

		renderFormScreen({ formUuid: REG_FORM_UUID });

		const submit = await screen.findByRole("button", { name: /^submit$/i });
		fireEvent.click(submit);

		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toMatch(/Could not submit form\. Try again\./);
		/* The thrown message's developer-jargon body must not leak
		 *  into the user-facing alert. Asserting against a distinctive
		 *  substring of the throw's body pins the suppression. */
		expect(alert.textContent).not.toMatch(/developer-jargon/);
		expect(alert.textContent).not.toMatch(/Internal bug/);
	});
});

// ── Case-loading form empty state ──────────────────────────────

describe("FormScreen — case-loading form previewed directly (no nav caseId)", () => {
	it("auto-selects the first available case and renders the form — never blocks", async () => {
		/* Close is a case-loading form. Previewed directly with no bound
		 *  case, it must auto-bind the FIRST available case (so the form is
		 *  usable), not gate on navigation — same stance as the case list.
		 *  The submit row renders against that bound case. */
		vi.mocked(loadCasesAction).mockResolvedValue({
			kind: "rows",
			rows: [
				{
					case_id: FOLLOWUP_CASE_ID,
					case_type: CASE_TYPE,
					case_name: "Existing case",
					app_id: APP_ID,
					owner_id: "owner-test",
					status: "open",
					opened_on: null,
					modified_on: null,
					closed_on: null,
					parent_case_id: null,
					properties: {},
					calculated: {},
					// biome-ignore lint/suspicious/noExplicitAny: minimal CaseRowWithCalculated fixture
				} as any,
			],
		});
		renderFormScreen({ formUuid: CLOSE_FORM_UUID });

		expect(
			await screen.findByRole("button", { name: /^submit$/i }),
		).toBeDefined();
		expect(
			screen.queryByRole("button", { name: /generate sample data/i }),
		).toBeNull();
	});

	it("keeps the form rendered and explains that an existing case must be chosen when the store is empty", async () => {
		/* Empty store → no case to auto-select. The form still renders for
		 *  flipbook continuity, but Preview stays app-pure: it explains the
		 *  normal Results → case-selection journey instead of exposing a
		 *  builder-only sample-data action. */
		vi.mocked(loadCasesAction).mockResolvedValue({ kind: "empty" });
		renderFormScreen({ formUuid: CLOSE_FORM_UUID });

		/* The form itself renders — its field's textbox is present (an
		 *  interstitial would have replaced the whole form). */
		expect((await screen.findAllByRole("textbox")).length).toBeGreaterThan(0);
		expect(
			screen.getByText(
				/this form opens an existing case\. start from results and choose a case before continuing\./i,
			),
		).toBeDefined();
		expect(
			screen.queryByRole("button", { name: /generate sample data/i }),
		).toBeNull();
		/* No case is bound, so the worker cannot submit this form yet. */
		expect(screen.queryByRole("button", { name: /^submit$/i })).toBeNull();
		expect(vi.mocked(submitFormAction)).not.toHaveBeenCalled();
	});
});

// ── Stale server-error reset on re-submit ──────────────────────

describe("FormScreen — submit re-entry clears stale server error", () => {
	it("hides the prior alert when the validate-fail short-circuit fires on re-submit", async () => {
		/* Sequence — pins the invariant the handler enforces:
		 *   1. Render the required-field form, populate the field so
		 *      the first submit passes validate. The action mock
		 *      resolves to a server validation failure → alert renders.
		 *   2. Re-empty the required field, click Submit again. The
		 *      engine reports invalid; the handler short-circuits
		 *      BEFORE the action call. The alert must disappear — the
		 *      surface now reflects the per-field required indicator,
		 *      not a stale server-side failure that no longer applies.
		 *
		 * This test pins that `handleSubmit` clears `submitStatus`
		 * before validating — the alert from step 1 must disappear
		 * when step 2's validate-fail short-circuit fires. */
		vi.mocked(submitFormAction).mockResolvedValue({
			kind: "case-properties-validation",
			caseType: CASE_TYPE,
			failures: [{ path: "/age", message: "must be integer" }],
		});

		renderFormScreen({ formUuid: REQUIRED_FORM_UUID });

		/* The screen renders two `<input>`s — a readonly title input
		 *  (the form's `EditableTitle`) and the field's editable text
		 *  input. The non-readonly one is the field; filter to
		 *  disambiguate `getByRole("textbox")`. */
		const allTextboxes = await screen.findAllByRole("textbox");
		const input = allTextboxes.find(
			(el) => !(el as HTMLInputElement).readOnly,
		) as HTMLInputElement;
		const submit = screen.getByRole("button", { name: /^submit$/i });

		/* Populate the required field → engine validate-pass → action
		 *  call resolves to the server validation-failure alert. */
		fireEvent.change(input, { target: { value: "Alice" } });
		fireEvent.click(submit);
		const firstAlert = await screen.findByRole("alert");
		expect(firstAlert.textContent).toMatch(/age: must be integer/);

		/* Empty the required field, click Submit a second time. Engine
		 *  validate-fail short-circuits; the stale server alert must
		 *  clear so the user sees the actual problem. */
		fireEvent.change(input, { target: { value: "" } });
		const submitCallCountBefore = vi.mocked(submitFormAction).mock.calls.length;
		fireEvent.click(submit);

		await waitFor(() => {
			expect(screen.queryByRole("alert")).toBeNull();
		});
		/* The action MUST NOT have re-fired — the validate-fail branch
		 *  short-circuits before reaching the action call. Confirms the
		 *  validate-fail short-circuit fired (the action call count is
		 *  unchanged across the re-submit). */
		expect(vi.mocked(submitFormAction).mock.calls.length).toBe(
			submitCallCountBefore,
		);
	});
});

// ── Clear-form clears stale server error ───────────────────────

describe("FormScreen — Clear form clears stale server error", () => {
	it("removes the inline alert when the user clicks Clear after a server error", async () => {
		vi.mocked(submitFormAction).mockResolvedValue({
			kind: "error",
			message: "Could not reach the case store.",
		});

		renderFormScreen({ formUuid: REG_FORM_UUID });

		const submit = await screen.findByRole("button", { name: /^submit$/i });
		fireEvent.click(submit);

		/* The alert renders first — the user sees the error and decides
		 *  to start over via Clear. */
		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toMatch(/Could not reach the case store\./);

		const clear = screen.getByRole("button", { name: /clear form/i });
		fireEvent.click(clear);

		/* "Start fresh" means the surface returns to idle — the alert
		 *  must disappear. Leaving it visible while the form fields
		 *  reset contradicts the user's mental model. */
		await waitFor(() => {
			expect(screen.queryByRole("alert")).toBeNull();
		});
	});
});
