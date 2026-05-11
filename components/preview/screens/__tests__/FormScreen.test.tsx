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
//      Wire-level rejections (`new Promise(() => {})` never resolving)
//      keep the pending state until the screen unmounts.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BlueprintDocProvider } from "@/lib/doc/provider";
import { asUuid } from "@/lib/doc/types";
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
const FIELD_UUID = asUuid("00000000-0000-0000-0000-000000000c01");

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
		/* `test` mode mounts the submit row — every test in this file
		 *  asserts against the row's behavior. Mirroring CaseListScreen's
		 *  hook mocks so the two screens share a session-mode contract.
		 *  `useCursorMode` is mocked separately because `FormRenderer`
		 *  reads it directly (not through `useEditMode`) to dispatch
		 *  between virtualized + interactive paths; `pointer` mirrors
		 *  the underlying source `useEditMode("test")` derives from. */
		useEditMode: () => "test" as const,
		useCursorMode: () => "pointer" as const,
		useBuilderIsReady: () => true,
	};
});

/* Server Actions live in a `"use server"` module. Mock both the
 *  case-data load (consumed by `useCaseData` for followup forms) and
 *  the submit action (the unit under test) so the screen renders
 *  synchronously without spinning up auth + Postgres. */
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
	loadCaseDataAction,
	submitFormAction,
} from "@/lib/preview/engine/caseDataBinding";
import { BuilderFormEngineProvider } from "@/lib/preview/engine/provider";
import { FormScreen } from "../FormScreen";

// ── Fixtures ─────────────────────────────────────────────────────

const CASE_TYPE = "patient";
const FOLLOWUP_CASE_ID = "11111111-1111-1111-1111-111111111111";

const onBackMock = vi.fn();

/* Mount FormScreen against a BlueprintDocProvider that carries all
 *  four FormType arms under one module + a single text field per
 *  form. The text field is non-required so `validateAll()` returns
 *  true with empty values — the test asserts the action-call shape,
 *  not the engine's value-walking (which has its own dedicated
 *  formEngine.test.ts coverage). */
function renderFormScreen(opts: {
	formUuid: typeof REG_FORM_UUID;
	caseId?: string;
}) {
	currentLocation = {
		kind: "form",
		moduleUuid: MODULE_UUID,
		formUuid: opts.formUuid,
	};
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
				},
				/* One text field per form, all four bound to the same
				 *  module case type so the engine's `case_property_on` walk
				 *  routes the value into the primary's `properties` bag
				 *  on submit. */
				fields: {
					[FIELD_UUID]: {
						uuid: FIELD_UUID,
						id: "name",
						kind: "text",
						label: "Name",
						case_property_on: CASE_TYPE,
					},
				},
				moduleOrder: [MODULE_UUID],
				formOrder: {
					[MODULE_UUID]: [
						REG_FORM_UUID,
						FOLLOWUP_FORM_UUID,
						CLOSE_FORM_UUID,
						SURVEY_FORM_UUID,
					],
				},
				/* Same field uuid registered against the active form arm
				 *  — the doc's `fieldOrder` map keys per-form lists, so
				 *  only the active form's list needs the entry. */
				fieldOrder: { [opts.formUuid]: [FIELD_UUID] },
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
	/* Default `loadCaseDataAction` to `missing` so followup screens
	 *  in test mode either short-circuit on the no-case empty state
	 *  (when no caseId is supplied) or proceed to render the form
	 *  against engine defaults (when caseId is supplied and the row
	 *  resolves on the test-supplied path). Tests overriding for
	 *  followup mount path set this per-test. */
	vi.mocked(loadCaseDataAction).mockResolvedValue({ kind: "missing" });
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
				parent_case_id: null,
				properties: {},
			},
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
				parent_case_id: null,
				properties: {},
			},
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
				parent_case_id: null,
				properties: {},
			},
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

	it("renders the validation-failure per-field list", async () => {
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

		await waitFor(() => {
			/* The validation block joins the failures one per line; the
			 *  `whitespace-pre-line` wrapper collapses to a single text
			 *  node so the substring match covers both lines. The path's
			 *  leading `/` is stripped for readability; the empty path
			 *  becomes `<root>`. */
			expect(screen.getByText(/age: must be integer/)).toBeDefined();
			expect(
				screen.getByText(/<root>: additional property not allowed/),
			).toBeDefined();
		});
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
		/* `new Promise(() => {})` never resolves — the screen sits in
		 *  the `running` arm long enough for the assertion. Testing
		 *  Library unmounts on test end, dropping the dangling await. */
		vi.mocked(submitFormAction).mockImplementation(() => new Promise(() => {}));

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
	});
});
