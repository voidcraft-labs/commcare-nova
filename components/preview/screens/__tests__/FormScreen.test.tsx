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
//      navigation. The Server Action lands the mutation through the
//      case-store's atomic submission envelope; the screen's contract
//      is that the mutation reaches the action with the matching
//      `kind`: property-level walking is covered by the engine's own
//      unit tests.
//   2. Error arms (`unauthenticated` / `error` / `case-not-found` /
//      `case-properties-validation` / `missing-case-type` /
//      `schema-not-synced`) render an inline error below the submit
//      row. The form stays mounted (no navigation fires) so the user
//      can amend and resubmit. `case-properties-validation`'s per-
//      field failure list renders one line per failure in the
//      `whitespace-pre-line` block.
//   3. Pending UX: while the action is in flight the submit button
//      reads "Submitting", carries the spinner icon, and is
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { BuilderLocalizationProvider } from "@/components/builder/localization/BuilderLocalizationProvider";
import { xp } from "@/lib/__tests__/docHelpers";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { BlueprintDocProvider } from "@/lib/doc/provider";
import type { Uuid } from "@/lib/doc/types";
import { plainColumn } from "@/lib/domain/modules";
import { proseText } from "@/lib/domain/prose";
import type {
	CaseRowWithCalculated,
	SubmissionResult,
} from "@/lib/preview/engine/caseDataBindingTypes";
import type { EngineController } from "@/lib/preview/engine/engineController";
import { useBuilderFormEngine } from "@/lib/preview/engine/provider";
import type { Location } from "@/lib/routing/types";
import {
	BuilderSessionProvider,
	type BuilderSessionStoreApi,
	useBuilderSessionApi,
} from "@/lib/session/provider";
import type { PreviewMenuCaseSelection } from "@/lib/session/types";

// ── Mocks ────────────────────────────────────────────────────────

const APP_ID = "app-form-screen-test";
const MODULE_UUID = testUuid("00000000-0000-0000-0000-000000000a01");
/* One UUID per FormType: the test suite mounts a different form
 * arm per case under one BlueprintDocProvider seed, and `formUuid` is
 * the URL discriminator the screen reads. Distinct UUIDs keep each
 * test's mounted form independent. */
const REG_FORM_UUID = testUuid("00000000-0000-0000-0000-000000000b01");
const FOLLOWUP_FORM_UUID = testUuid("00000000-0000-0000-0000-000000000b02");
const CLOSE_FORM_UUID = testUuid("00000000-0000-0000-0000-000000000b03");
const SURVEY_FORM_UUID = testUuid("00000000-0000-0000-0000-000000000b04");
/* The validate-fail test mounts this fifth form whose single field
 *  is required. With no user input the engine's `validateAll()`
 *  marks the field invalid and returns `false`, exercising the
 *  short-circuit branch of `handleSubmit` that scrolls to the
 *  first invalid field WITHOUT firing `submitFormAction`. */
const REQUIRED_FORM_UUID = testUuid("00000000-0000-0000-0000-000000000b05");
const STRUCTURE_FORM_UUID = testUuid("00000000-0000-0000-0000-000000000b06");
const CAPTURE_REQUIRED_FORM_UUID = testUuid(
	"00000000-0000-0000-0000-000000000b07",
);
const CASE_NAME_COLUMN_UUID = testUuid("00000000-0000-0000-0000-000000000b08");
const FIELD_UUID = testUuid("00000000-0000-0000-0000-000000000c01");
const FIELD_REQUIRED_UUID = testUuid("00000000-0000-0000-0000-000000000c02");
const FOLLOWUP_FIELD_UUID = testUuid("00000000-0000-0000-0000-000000000c03");
const CLOSE_FIELD_UUID = testUuid("00000000-0000-0000-0000-000000000c04");
const SURVEY_FIELD_UUID = testUuid("00000000-0000-0000-0000-000000000c05");
const GROUP_ONE_UUID = testUuid("00000000-0000-0000-0000-000000000c11");
const GROUP_TWO_UUID = testUuid("00000000-0000-0000-0000-000000000c12");
const REPEAT_UUID = testUuid("00000000-0000-0000-0000-000000000c13");
const GROUP_ONE_PHOTO_UUID = testUuid("00000000-0000-0000-0000-000000000c21");
const GROUP_TWO_PHOTO_UUID = testUuid("00000000-0000-0000-0000-000000000c22");
const REPEAT_PHOTO_UUID = testUuid("00000000-0000-0000-0000-000000000c23");
const GROUP_TWO_SIGNATURE_UUID = testUuid(
	"00000000-0000-0000-0000-000000000c24",
);
const REQUIRED_PHOTO_UUID = testUuid("00000000-0000-0000-0000-000000000c31");
const REQUIRED_SIGNATURE_UUID = testUuid(
	"00000000-0000-0000-0000-000000000c32",
);
const PERSONA_UUID = testUuid("00000000-0000-0000-0000-000000000d01");
const PERSONA_REGION_UUID = testUuid("00000000-0000-0000-0000-000000000d02");
const MENU_CASE_PARENT_MODULE_UUID = testUuid(
	"00000000-0000-0000-0000-000000000d03",
);
const MENU_CASE_PARENT_FORM_UUID = testUuid(
	"00000000-0000-0000-0000-000000000d04",
);
const NESTED_TARGET_MODULE_UUID = testUuid(
	"00000000-0000-0000-0000-000000000d05",
);
const NESTED_TARGET_FORM_UUID = testUuid(
	"00000000-0000-0000-0000-000000000d06",
);
const NESTED_CHILD_FIELD_UUID = testUuid(
	"00000000-0000-0000-0000-000000000d07",
);
const NESTED_LINK_UUID = testUuid("00000000-0000-0000-0000-000000000d08");

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
const setPreviewMenuCaseSelectionMock = vi.fn();
const setPreviewSelectedCaseMock = vi.fn();

/* Mutable carrier the `useAppId` mock reads from. Most tests run
 *  against the default `APP_ID`; the `!appId` guard test overrides
 *  to `undefined` for a single run. `beforeEach` resets to the
 *  default so test ordering doesn't matter. */
let currentAppId: string | undefined = APP_ID;
let currentAuthUser: { id: string; name: string; email: string } | null = null;
let previewMenuCaseSelectionsMock: Readonly<
	Record<string, PreviewMenuCaseSelection>
> = {};
let capturedSession: BuilderSessionStoreApi | undefined;
let capturedController: EngineController | undefined;
let updateCapturedPersonaValue:
	| ReturnType<typeof useBlueprintMutations>["inline"]["updatePersonaValue"]
	| undefined;

/* The screen mounts BuilderFormEngineProvider, which resolves "Preview
 * as me" from `useAuth()`. Mock it so the suite doesn't subscribe Better
 * Auth's client session atom, its nanostores `onMount` schedules a
 * `setTimeout(0) → fetchSession()` real fetch that the async-leak
 * detector pins. The persisted test member supplies the same actor/owner
 * authority coordinates a live preview carries. */
vi.mock("@/lib/auth/hooks/useAuth", () => ({
	useAuth: () => ({
		user: currentAuthUser,
		isAuthenticated: currentAuthUser !== null,
		isAdmin: false,
		isImpersonating: false,
		isPending: false,
		error: null,
		signIn: () => {},
		signOut: () => {},
	}),
}));

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
		/* Preview mode mounts the submit row: every test in this file
		 *  asserts against the row's behavior. Mirroring CaseListScreen's
		 *  hook mocks so the two screens share a session-mode contract.
		 *  `usePreviewing` is mocked alongside because `TextEditable`
		 *  reads it directly (not through `useEditMode`); `true` is the
		 *  underlying source `useEditMode("preview")` derives from. */
		useEditMode: () => "preview" as const,
		usePreviewing: () => true,
		useBuilderIsReady: () => true,
		usePreviewMenuCaseSelections: () => previewMenuCaseSelectionsMock,
		useSetPreviewCaseTarget: () => setPreviewCaseTargetMock,
		useSetPreviewMenuCaseSelection: () => setPreviewMenuCaseSelectionMock,
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
import {
	invalidateCaseData,
	useCaseDataRevision,
} from "@/lib/preview/hooks/caseDataInvalidation";
import {
	__resetAttachmentCoordinatorForTests,
	getAttachmentSlotDraft,
	getAttachmentSlotIssue,
	getOwnedStagedAttachment,
	getSignatureDraft,
	reconcileAttachmentAuthoredPathMigration,
	registerAttachmentSlotPath,
	rememberAttachmentSlotDraft,
	rememberOwnedStagedAttachment,
	rememberSignatureDraft,
	runAttachmentTask,
	runFormAttachmentBarrier,
	setAttachmentSlotIssue,
} from "../../form/fields/attachment/attachmentClient";
import { FormScreen } from "../FormScreen";

// ── Fixtures ─────────────────────────────────────────────────────

const CASE_TYPE = "patient";
const FOLLOWUP_CASE_ID = "11111111-1111-1111-1111-111111111111";

function formCaseRow(
	caseId: string,
	parentCaseId: string | null = null,
): CaseRowWithCalculated {
	return {
		case_id: caseId,
		case_type: CASE_TYPE,
		case_name: `Case ${caseId}`,
		app_id: APP_ID,
		owner_id: "owner-test",
		status: "open",
		opened_on: null,
		modified_on: null,
		closed_on: null,
		external_id: null,
		parent_case_id: parentCaseId,
		properties: {},
		calculated: {},
	};
}

const onBackMock = vi.fn();

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((accept) => {
		resolve = accept;
	});
	return { promise, resolve };
}

function CaptureRuntimeHandles() {
	capturedSession = useBuilderSessionApi();
	capturedController = useBuilderFormEngine();
	const mutations = useBlueprintMutations().inline;
	updateCapturedPersonaValue = mutations.updatePersonaValue;
	return null;
}

function CaseDataRevisionProbe() {
	const revision = useCaseDataRevision(APP_ID, CASE_TYPE);
	return <div data-testid="case-data-revision">{revision}</div>;
}

/* Mount FormScreen against a BlueprintDocProvider that carries every
 *  FormType arm under one module. The ordinary case forms share one
 *  canonical `case_name` writer with a nonblank authored default so every
 *  registration submission is valid by construction. Survey and the
 *  special fixture forms leave that writer on Registration rather than
 *  attaching a case-writing question to a form with no case action.
 *  `REQUIRED_FORM_UUID` owns a separate required `case_name` field so the
 *  validate-fail test still exercises the `valid === false` short-circuit.
 *  Engine value-walking has dedicated coverage in `formEngine.test.ts`. */
function renderFormScreen(opts: {
	formUuid: typeof REG_FORM_UUID;
	caseId?: string;
	selectedUuid?: Uuid;
	menuCaseRelationship?: "same-type" | "different-type";
	nestedAfterSubmit?: "automatic" | "manual";
}) {
	currentLocation = {
		kind: "form",
		moduleUuid: MODULE_UUID,
		formUuid: opts.formUuid,
		selectedUuid: opts.selectedUuid,
	};
	return render(
		<BlueprintDocProvider
			appId={APP_ID}
			initialDoc={{
				appId: APP_ID,
				appName: "Form screen test app",
				connectType: null,
				personas: {
					[PERSONA_UUID]: {
						uuid: PERSONA_UUID,
						name: "Persona B",
						values: { [PERSONA_REGION_UUID]: "north" },
					},
				},
				personaOrder: [PERSONA_UUID],
				userProperties: {
					[PERSONA_REGION_UUID]: {
						uuid: PERSONA_REGION_UUID,
						slug: "region",
						label: "Region",
					},
				},
				userPropertyOrder: [PERSONA_REGION_UUID],
				caseTypes: [
					{
						name: CASE_TYPE,
						...(opts.menuCaseRelationship === "different-type"
							? { parent_type: "household" }
							: {}),
						properties: [],
					},
					...(opts.menuCaseRelationship === "different-type"
						? [{ name: "household", properties: [] }]
						: []),
					...(opts.nestedAfterSubmit !== undefined
						? [
								{
									name: "encounter",
									parent_type: CASE_TYPE,
									properties: [],
								},
							]
						: []),
				],
				modules: {
					[MODULE_UUID]: {
						uuid: MODULE_UUID,
						id: "patient_module",
						name: "Patients",
						caseType: CASE_TYPE,
						...(opts.menuCaseRelationship === "same-type"
							? { parentModuleUuid: MENU_CASE_PARENT_MODULE_UUID }
							: {}),
						caseListConfig: {
							columns: [
								plainColumn(CASE_NAME_COLUMN_UUID, "case_name", "Case name"),
							],
							listColumnOrder: [CASE_NAME_COLUMN_UUID],
							detailColumnOrder: [CASE_NAME_COLUMN_UUID],
							searchInputs: [],
						},
					},
					...(opts.menuCaseRelationship !== undefined
						? {
								[MENU_CASE_PARENT_MODULE_UUID]: {
									uuid: MENU_CASE_PARENT_MODULE_UUID,
									id: "menu_case_parent",
									name: "Parent cases",
									caseType:
										opts.menuCaseRelationship === "same-type"
											? CASE_TYPE
											: "household",
								},
							}
						: {}),
					...(opts.nestedAfterSubmit !== undefined
						? {
								[NESTED_TARGET_MODULE_UUID]: {
									uuid: NESTED_TARGET_MODULE_UUID,
									id: "encounter_module",
									name: "Encounters",
									caseType: "encounter",
									parentModuleUuid: MODULE_UUID,
								},
							}
						: {}),
				},
				forms: {
					[REG_FORM_UUID]: {
						uuid: REG_FORM_UUID,
						id: "registration_form",
						name: "Registration",
						type: "registration",
						...(opts.nestedAfterSubmit === "automatic"
							? {
									formLinks: [
										{
											uuid: NESTED_LINK_UUID,
											target: {
												type: "form" as const,
												moduleUuid: NESTED_TARGET_MODULE_UUID,
												formUuid: NESTED_TARGET_FORM_UUID,
											},
										},
									],
								}
							: {}),
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
						...(opts.nestedAfterSubmit === "manual"
							? {
									formLinks: [
										{
											uuid: NESTED_LINK_UUID,
											target: {
												type: "form" as const,
												moduleUuid: NESTED_TARGET_MODULE_UUID,
												formUuid: NESTED_TARGET_FORM_UUID,
											},
											datums: [
												{ name: "parent_id", xpath: xp("'manual-patient'") },
												{ name: "case_id", xpath: xp("''") },
											],
										},
									],
								}
							: {}),
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
					[STRUCTURE_FORM_UUID]: {
						uuid: STRUCTURE_FORM_UUID,
						id: "structure_form",
						name: "Structure form",
						type: "survey",
					},
					[CAPTURE_REQUIRED_FORM_UUID]: {
						uuid: CAPTURE_REQUIRED_FORM_UUID,
						id: "required_captures",
						name: "Required captures",
						type: "survey",
					},
					...(opts.menuCaseRelationship !== undefined
						? {
								[MENU_CASE_PARENT_FORM_UUID]: {
									uuid: MENU_CASE_PARENT_FORM_UUID,
									id: "parent_followup",
									name: "Parent follow-up",
									type: "followup" as const,
								},
							}
						: {}),
					...(opts.nestedAfterSubmit !== undefined
						? {
								[NESTED_TARGET_FORM_UUID]: {
									uuid: NESTED_TARGET_FORM_UUID,
									id: "encounter_followup",
									name: "Encounter follow-up",
									type: "followup" as const,
								},
							}
						: {}),
				},
				/* `FIELD_UUID`: non-required text bound to the standard
				 *  `case_name` scalar. `FIELD_REQUIRED_UUID`: same shape with
				 *  `required: "true()"` so the engine marks it invalid when
				 *  the value is empty. */
				fields: {
					[FIELD_UUID]: {
						uuid: FIELD_UUID,
						id: "name",
						kind: "text",
						label: proseText("Name"),
						caseWrite: { caseType: CASE_TYPE, property: "case_name" },
						default_value: xp("'Test case'"),
					},
					[FIELD_REQUIRED_UUID]: {
						uuid: FIELD_REQUIRED_UUID,
						id: "name",
						kind: "text",
						label: proseText("Name"),
						caseWrite: { caseType: CASE_TYPE, property: "case_name" },
						required: xp("true()"),
					},
					...(opts.nestedAfterSubmit === "automatic"
						? {
								[NESTED_CHILD_FIELD_UUID]: {
									uuid: NESTED_CHILD_FIELD_UUID,
									id: "encounter_name",
									kind: "text" as const,
									label: proseText("Encounter name"),
									caseWrite: {
										caseType: "encounter",
										property: "case_name",
									},
									default_value: xp("'Created encounter'"),
								},
							}
						: {}),
					[FOLLOWUP_FIELD_UUID]: {
						uuid: FOLLOWUP_FIELD_UUID,
						id: "followup_note",
						kind: "text",
						label: proseText("Followup note"),
					},
					[CLOSE_FIELD_UUID]: {
						uuid: CLOSE_FIELD_UUID,
						id: "close_note",
						kind: "text",
						label: proseText("Close note"),
					},
					[SURVEY_FIELD_UUID]: {
						uuid: SURVEY_FIELD_UUID,
						id: "survey_note",
						kind: "text",
						label: proseText("Survey note"),
					},
					[GROUP_ONE_UUID]: {
						uuid: GROUP_ONE_UUID,
						id: "visit_one",
						kind: "group",
						label: proseText("Visit"),
					},
					[GROUP_TWO_UUID]: {
						uuid: GROUP_TWO_UUID,
						id: "visit_two",
						kind: "group",
						label: proseText("Visit"),
					},
					[REPEAT_UUID]: {
						uuid: REPEAT_UUID,
						id: "visits",
						kind: "repeat",
						label: proseText("Visit"),
						repeat_mode: "user_controlled",
					},
					[GROUP_ONE_PHOTO_UUID]: {
						uuid: GROUP_ONE_PHOTO_UUID,
						id: "photo",
						kind: "image",
						label: proseText("Photo"),
						required: xp("true()"),
					},
					[GROUP_TWO_PHOTO_UUID]: {
						uuid: GROUP_TWO_PHOTO_UUID,
						id: "photo",
						kind: "image",
						label: proseText("Photo"),
					},
					[REPEAT_PHOTO_UUID]: {
						uuid: REPEAT_PHOTO_UUID,
						id: "photo",
						kind: "image",
						label: proseText("Photo"),
					},
					[GROUP_TWO_SIGNATURE_UUID]: {
						uuid: GROUP_TWO_SIGNATURE_UUID,
						id: "consent",
						kind: "signature",
						label: proseText("Signed consent"),
					},
					[REQUIRED_PHOTO_UUID]: {
						uuid: REQUIRED_PHOTO_UUID,
						id: "photo",
						kind: "image",
						label: proseText("Photo"),
						hint: proseText("Attach a clear image."),
						required: xp("true()"),
					},
					[REQUIRED_SIGNATURE_UUID]: {
						uuid: REQUIRED_SIGNATURE_UUID,
						id: "consent",
						kind: "signature",
						label: proseText("Signed consent"),
						hint: proseText("Ask the participant to sign."),
						required: xp("true()"),
					},
				},
				moduleOrder: [
					...(opts.menuCaseRelationship !== undefined
						? [MENU_CASE_PARENT_MODULE_UUID]
						: []),
					MODULE_UUID,
					...(opts.nestedAfterSubmit !== undefined
						? [NESTED_TARGET_MODULE_UUID]
						: []),
				],
				formOrder: {
					...(opts.menuCaseRelationship !== undefined
						? { [MENU_CASE_PARENT_MODULE_UUID]: [MENU_CASE_PARENT_FORM_UUID] }
						: {}),
					[MODULE_UUID]: [
						REG_FORM_UUID,
						FOLLOWUP_FORM_UUID,
						CLOSE_FORM_UUID,
						SURVEY_FORM_UUID,
						REQUIRED_FORM_UUID,
						STRUCTURE_FORM_UUID,
						CAPTURE_REQUIRED_FORM_UUID,
					],
					...(opts.nestedAfterSubmit !== undefined
						? { [NESTED_TARGET_MODULE_UUID]: [NESTED_TARGET_FORM_UUID] }
						: {}),
				},
				fieldOrder: {
					...(opts.menuCaseRelationship !== undefined
						? { [MENU_CASE_PARENT_FORM_UUID]: [] }
						: {}),
					[REG_FORM_UUID]: [
						FIELD_UUID,
						...(opts.nestedAfterSubmit === "automatic"
							? [NESTED_CHILD_FIELD_UUID]
							: []),
					],
					[FOLLOWUP_FORM_UUID]: [FOLLOWUP_FIELD_UUID],
					[CLOSE_FORM_UUID]: [CLOSE_FIELD_UUID],
					[SURVEY_FORM_UUID]: [SURVEY_FIELD_UUID],
					[REQUIRED_FORM_UUID]: [FIELD_REQUIRED_UUID],
					[STRUCTURE_FORM_UUID]: [GROUP_ONE_UUID, GROUP_TWO_UUID, REPEAT_UUID],
					[CAPTURE_REQUIRED_FORM_UUID]: [
						REQUIRED_PHOTO_UUID,
						REQUIRED_SIGNATURE_UUID,
					],
					[GROUP_ONE_UUID]: [GROUP_ONE_PHOTO_UUID],
					[GROUP_TWO_UUID]: [GROUP_TWO_PHOTO_UUID, GROUP_TWO_SIGNATURE_UUID],
					[REPEAT_UUID]: [REPEAT_PHOTO_UUID],
					...(opts.nestedAfterSubmit !== undefined
						? { [NESTED_TARGET_FORM_UUID]: [] }
						: {}),
				},
			}}
		>
			<BuilderLocalizationProvider>
				<BuilderSessionProvider
					init={{
						appId: currentAppId,
						projectId: "project-form-screen-test",
						role: "editor",
						canEdit: true,
					}}
				>
					<BuilderFormEngineProvider>
						<CaptureRuntimeHandles />
						<CaseDataRevisionProbe />
						<FormScreen
							screen={{
								type: "form",
								moduleUuid: MODULE_UUID,
								formUuid: opts.formUuid,
								caseId: opts.caseId,
							}}
							onBack={onBackMock}
						/>
					</BuilderFormEngineProvider>
				</BuilderSessionProvider>
			</BuilderLocalizationProvider>
		</BlueprintDocProvider>,
	);
}

async function seedMalformedAttachmentRecovery(args: {
	readonly fieldUuid: Uuid;
	readonly slotKey: string;
	readonly oldPath: string;
	readonly currentPath: string;
	readonly captureKind: "image" | "signature";
}): Promise<{
	readonly entryKey: string;
	readonly fileDraft: File | undefined;
	readonly signatureInk: { x: number; y: number }[][] | undefined;
}> {
	await waitFor(() => expect(capturedController?.entryKey).toBeDefined());
	const entryKey = capturedController?.entryKey;
	if (entryKey === undefined) throw new Error("Expected an active form entry.");
	const fileDraft =
		args.captureKind === "image"
			? new File(["retained"], "retained-photo.png", { type: "image/png" })
			: undefined;
	const signatureInk =
		args.captureKind === "signature" ? [[{ x: 0.2, y: 0.4 }]] : undefined;
	act(() => {
		registerAttachmentSlotPath({
			appId: APP_ID,
			entryKey,
			slotKey: args.slotKey,
			fieldUuid: args.fieldUuid,
			instancePath: args.oldPath,
			captureKind: args.captureKind,
		});
		rememberOwnedStagedAttachment({
			appId: APP_ID,
			entryKey,
			slotKey: args.slotKey,
			instancePath: args.oldPath,
			attachment: {
				attachmentId: `attachment-${args.slotKey}`,
				attachmentName: `${args.slotKey}.png`,
				originalFilename: `${args.slotKey}.png`,
				sizeBytes: 3,
			},
		});
		if (fileDraft !== undefined) {
			rememberAttachmentSlotDraft({
				appId: APP_ID,
				entryKey,
				slotKey: args.slotKey,
				file: fileDraft,
				status: "needs-attention",
				generation: 9,
			});
		}
		if (signatureInk !== undefined) {
			rememberSignatureDraft(entryKey, args.slotKey, signatureInk);
		}
	});
	await act(async () => {
		await reconcileAttachmentAuthoredPathMigration({
			appId: APP_ID,
			entryKey,
			migration: {
				moves: [
					{
						kind: "retained",
						fieldUuid: args.fieldUuid,
						previous: {
							pathTemplate: args.oldPath.replace(/\[\d+\]/g, ""),
							segmentKeys: [
								"$data",
								...args.oldPath
									.split("/")
									.filter(Boolean)
									.slice(1)
									.map((_, index) => `old-${index}`),
								args.fieldUuid,
							],
							captureKind: args.captureKind,
						},
						current: {
							pathTemplate: args.currentPath,
							segmentKeys: ["$data", "duplicate", "duplicate"],
							captureKind: args.captureKind,
						},
					},
				],
			},
		});
	});
	return { entryKey, fileDraft, signatureInk };
}

beforeEach(async () => {
	onBackMock.mockClear();
	navigateMock.goHome.mockClear();
	navigateMock.openModule.mockClear();
	navigateMock.openForm.mockClear();
	navigateMock.replace.mockClear();
	setPreviewCaseTargetMock.mockClear();
	setPreviewMenuCaseSelectionMock.mockClear();
	setPreviewSelectedCaseMock.mockClear();
	/* Reset the appId carrier so the `!appId` guard test's per-run
	 *  override doesn't leak into sibling tests. */
	currentAppId = APP_ID;
	currentAuthUser = {
		id: "member-form-screen-test",
		name: "Form Screen Tester",
		email: "member@example.com",
	};
	previewMenuCaseSelectionsMock = {};
	capturedSession = undefined;
	capturedController = undefined;
	updateCapturedPersonaValue = undefined;
	await __resetAttachmentCoordinatorForTests();
	vi.unstubAllGlobals();
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
	vi.mocked(loadCasesAction).mockResolvedValue({
		constraintSource: "unconstrained",
		kind: "empty",
	});
});

afterEach(async () => {
	await __resetAttachmentCoordinatorForTests();
	vi.unstubAllGlobals();
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
		const initialRevision = Number(
			screen.getByTestId("case-data-revision").textContent,
		);

		const submit = await screen.findByRole("button", { name: /^submit$/i });
		fireEvent.click(submit);

		await waitFor(() => {
			expect(vi.mocked(submitFormAction)).toHaveBeenCalledTimes(1);
		});
		const [mutation, appIdArg] = vi.mocked(submitFormAction).mock.calls[0];
		expect(mutation).toMatchObject({
			kind: "registration",
			formUuid: REG_FORM_UUID,
			entryKey: expect.any(String),
			attachmentRefs: [],
		});
		expect(appIdArg).toBe(APP_ID);
		/* Registration's default post-submit destination is `app_home`,
		 *  resolved via `defaultPostSubmit("registration")`. The screen
		 *  fires `navigate.goHome` on success. */
		await waitFor(() => {
			expect(navigateMock.goHome).toHaveBeenCalledTimes(1);
		});
		expect(Number(screen.getByTestId("case-data-revision").textContent)).toBe(
			initialRevision + 1,
		);
	});
});

describe("FormScreen — followup submit", () => {
	it("dispatches submitFormAction with a followup-shaped mutation", async () => {
		/* Followup forms require a bound caseId: the case-loading
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
		/* Close inherits followup's `previous` destination: both
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

		/* Survey owns no ordinary case row, but the action still validates the
		 * final protocol and inspects the authorized committed form before it
		 * may classify the request as effect-free. */
		await waitFor(() => {
			expect(vi.mocked(submitFormAction)).toHaveBeenCalledTimes(1);
		});
		const [mutation] = vi.mocked(submitFormAction).mock.calls[0];
		expect(mutation).toMatchObject({
			kind: "survey",
			formUuid: SURVEY_FORM_UUID,
			entryKey: expect.any(String),
			attachmentRefs: [],
		});
		/* Survey's default post-submit destination is `app_home`. */
		await waitFor(() => {
			expect(navigateMock.goHome).toHaveBeenCalledTimes(1);
		});
	});
});

describe("FormScreen — nested after-submit case session", () => {
	it("applies automatically matched created parent and child cases before opening the target form", async () => {
		vi.mocked(submitFormAction).mockResolvedValue({
			kind: "registration",
			caseId: "new-patient",
			childCaseIds: ["new-encounter"],
		});
		vi.mocked(loadCaseDataAction).mockResolvedValue({
			kind: "row",
			row: {
				...formCaseRow("new-patient"),
				case_name: "Created patient",
			},
			ancestors: [],
		});
		renderFormScreen({
			formUuid: REG_FORM_UUID,
			nestedAfterSubmit: "automatic",
		});

		fireEvent.click(await screen.findByRole("button", { name: /^submit$/i }));

		await waitFor(() =>
			expect(navigateMock.openForm).toHaveBeenCalledWith(
				NESTED_TARGET_MODULE_UUID,
				NESTED_TARGET_FORM_UUID,
			),
		);
		expect(setPreviewMenuCaseSelectionMock).toHaveBeenCalledWith(MODULE_UUID, {
			caseType: CASE_TYPE,
			caseId: "new-patient",
			caseName: "Created patient",
		});
		expect(setPreviewMenuCaseSelectionMock).toHaveBeenCalledWith(
			NESTED_TARGET_MODULE_UUID,
			{
				caseType: "encounter",
				caseId: "new-encounter",
				caseName: "Created encounter",
			},
		);
		expect(setPreviewCaseTargetMock).toHaveBeenCalledWith({
			formUuid: NESTED_TARGET_FORM_UUID,
			caseId: "new-encounter",
			caseName: "Created encounter",
		});
		const lastSelectionOrder = Math.max(
			...setPreviewMenuCaseSelectionMock.mock.invocationCallOrder,
		);
		expect(lastSelectionOrder).toBeLessThan(
			navigateMock.openForm.mock.invocationCallOrder[0] ?? 0,
		);
	});

	it("applies a manual parent datum, clears a blank child selection, and keeps the form's blank target", async () => {
		previewMenuCaseSelectionsMock = {
			[NESTED_TARGET_MODULE_UUID]: {
				caseType: "encounter",
				caseId: "stale-encounter",
				caseName: "Stale encounter",
			},
		};
		vi.mocked(submitFormAction).mockResolvedValue({ kind: "survey" });
		renderFormScreen({
			formUuid: SURVEY_FORM_UUID,
			nestedAfterSubmit: "manual",
		});

		fireEvent.click(await screen.findByRole("button", { name: /^submit$/i }));

		await waitFor(() =>
			expect(navigateMock.openForm).toHaveBeenCalledWith(
				NESTED_TARGET_MODULE_UUID,
				NESTED_TARGET_FORM_UUID,
			),
		);
		expect(setPreviewMenuCaseSelectionMock).toHaveBeenCalledWith(MODULE_UUID, {
			caseType: CASE_TYPE,
			caseId: "manual-patient",
			caseName: "Case",
		});
		expect(setPreviewMenuCaseSelectionMock).toHaveBeenCalledWith(
			NESTED_TARGET_MODULE_UUID,
			undefined,
		);
		expect(setPreviewCaseTargetMock).toHaveBeenCalledWith({
			formUuid: NESTED_TARGET_FORM_UUID,
			caseId: "",
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
		/* The form stays mounted: no navigation fires. The Clear button
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
		 *  into one `whitespace-pre-line` text node: reading `alert.textContent`
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
	it("keeps the mounted control, answers, and entry key through a same-Project access refresh", async () => {
		renderFormScreen({ formUuid: REG_FORM_UUID });
		const runtimeInput = () =>
			document.querySelector<HTMLInputElement>(
				`[data-field-uuid="${FIELD_UUID}"] input`,
			);
		await waitFor(() => expect(runtimeInput()).not.toBeNull());
		const input = runtimeInput();
		if (input === null) throw new Error("Expected the runtime Name answer.");
		fireEvent.change(input, { target: { value: "answer in progress" } });
		act(() => input.focus());
		await waitFor(() => expect(capturedController?.entryKey).toBeDefined());
		const entryKey = capturedController?.entryKey;
		if (capturedSession === undefined || entryKey === undefined) {
			throw new Error("Expected mounted session and form entry handles.");
		}
		const fileSlotKey = "refresh-file-slot";
		const signatureSlotKey = "refresh-signature-slot";
		const fileDraft = new File(["draft"], "draft.png", {
			type: "image/png",
		});
		const signatureInk = [[{ x: 0.2, y: 0.4 }]];
		act(() => {
			registerAttachmentSlotPath({
				appId: APP_ID,
				entryKey,
				slotKey: fileSlotKey,
				fieldUuid: GROUP_TWO_PHOTO_UUID,
				instancePath: "/data/visit_two/photo",
				captureKind: "image",
			});
			rememberOwnedStagedAttachment({
				appId: APP_ID,
				entryKey,
				slotKey: fileSlotKey,
				instancePath: "/data/visit_two/photo",
				attachment: {
					attachmentId: "attachment-refresh-file",
					attachmentName: "attachment-refresh-file.png",
					originalFilename: "draft.png",
					sizeBytes: 5,
				},
			});
			rememberAttachmentSlotDraft({
				appId: APP_ID,
				entryKey,
				slotKey: fileSlotKey,
				file: fileDraft,
				status: "uploading",
				generation: 7,
			});
			setAttachmentSlotIssue({
				appId: APP_ID,
				entryKey,
				slotKey: fileSlotKey,
				issue: {
					kind: "invariant",
					message: "The exact retained file still needs attention.",
				},
			});
			registerAttachmentSlotPath({
				appId: APP_ID,
				entryKey,
				slotKey: signatureSlotKey,
				fieldUuid: GROUP_TWO_SIGNATURE_UUID,
				instancePath: "/data/visit_two/consent",
				captureKind: "signature",
			});
			rememberOwnedStagedAttachment({
				appId: APP_ID,
				entryKey,
				slotKey: signatureSlotKey,
				instancePath: "/data/visit_two/consent",
				attachment: {
					attachmentId: "attachment-refresh-signature",
					attachmentName: "attachment-refresh-signature.png",
					originalFilename: "signature.png",
					sizeBytes: 5,
				},
			});
			rememberSignatureDraft(entryKey, signatureSlotKey, signatureInk);
		});
		const fetchMock = vi
			.fn()
			.mockResolvedValue(new Response(null, { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);

		act(() => {
			capturedSession?.getState().beginAccessRefresh();
			capturedSession?.getState().resetProjectScope();
			capturedSession?.getState().applyAccessSnapshot({
				projectId: "project-form-screen-test",
				role: "editor",
				canEdit: true,
			});
		});
		expect(runtimeInput()).toBe(input);
		expect((input as HTMLInputElement).value).toBe("answer in progress");
		expect(document.activeElement).toBe(input);
		expect(capturedController?.entryKey).toBe(entryKey);
		expect(
			getOwnedStagedAttachment({
				appId: APP_ID,
				entryKey,
				slotKey: fileSlotKey,
			}),
		).toMatchObject({ attachmentId: "attachment-refresh-file" });
		expect(
			getAttachmentSlotDraft({
				appId: APP_ID,
				entryKey,
				slotKey: fileSlotKey,
			}),
		).toMatchObject({
			file: fileDraft,
			status: "needs-attention",
			generation: 7,
		});
		expect(
			getAttachmentSlotIssue({
				appId: APP_ID,
				entryKey,
				slotKey: fileSlotKey,
			}),
		).toEqual({
			kind: "invariant",
			message: "The exact retained file still needs attention.",
		});
		expect(getSignatureDraft(entryKey, signatureSlotKey)).toEqual(signatureInk);
		await expect(
			runFormAttachmentBarrier(entryKey, async () => "must not submit"),
		).rejects.toThrow(/exact retained file/i);
		expect(fetchMock).not.toHaveBeenCalled();

		act(() => capturedSession?.getState().revokeAccess());
		await waitFor(() => expect(capturedController?.entryKey).toBeUndefined());
		await waitFor(() =>
			expect(
				fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE"),
			).toHaveLength(2),
		);
		expect(
			getOwnedStagedAttachment({
				appId: APP_ID,
				entryKey,
				slotKey: fileSlotKey,
			}),
		).toBeUndefined();
		expect(getSignatureDraft(entryKey, signatureSlotKey)).toEqual([]);
	});

	it("keeps Submit and Clear form read-only after viewer authority replaces the editor session", async () => {
		renderFormScreen({ formUuid: REG_FORM_UUID });
		await waitFor(() => expect(capturedController?.entryKey).toBeDefined());
		const entryKey = capturedController?.entryKey;
		if (capturedSession === undefined || entryKey === undefined) {
			throw new Error("Expected mounted session and form entry handles.");
		}

		act(() => {
			capturedSession?.setState({
				canEdit: false,
				role: "viewer",
				accessPhase: "authorized",
			});
		});
		const submit = screen.getByRole("button", { name: /^submit$/i });
		const clear = screen.getByRole("button", { name: /clear form/i });
		expect((submit as HTMLButtonElement).disabled).toBe(true);
		expect((clear as HTMLButtonElement).disabled).toBe(true);

		fireEvent.click(clear);
		expect(capturedController?.entryKey).toBe(entryKey);
	});

	it("retires the entry and rejects stale Submit and Clear handlers after the current app changes", async () => {
		renderFormScreen({ formUuid: REG_FORM_UUID });
		await waitFor(() => expect(capturedController?.entryKey).toBeDefined());
		const entryKey = capturedController?.entryKey;
		if (capturedSession === undefined || entryKey === undefined) {
			throw new Error("Expected mounted session and form entry handles.");
		}

		act(() => {
			capturedSession?.setState({
				appId: "different-app",
				canEdit: true,
				role: "editor",
				accessPhase: "authorized",
			});
		});
		fireEvent.click(screen.getByRole("button", { name: /^submit$/i }));
		fireEvent.click(screen.getByRole("button", { name: /clear form/i }));

		expect(vi.mocked(submitFormAction)).not.toHaveBeenCalled();
		expect(capturedController?.entryKey).toBeUndefined();
	});

	it("disables Submit + Clear and swaps the label to Submitting while the action is in flight", async () => {
		/* Stall the action via a controllable deferred so the screen sits
		 *  in the `running` arm long enough to assert the pending UX, then
		 *  resolve it after the assertion. A never-resolving `new Promise`
		 *  is never destroyed: async_hooks reports it as a permanent leak
		 *  under `--detectAsyncLeaks`, so the deferred is resolved before
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
		 *  "Submitting" while the action is in flight (no ellipsis in a
		 *  button label; the disabled state carries the in-flight cue). */
		const pending = await screen.findByRole("button", {
			name: /^submitting$/i,
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
		/* Registration's success arm fires `navigate.goHome`: waiting on
		 *  it confirms every follow-on async has flushed. */
		await waitFor(() => {
			expect(navigateMock.goHome).toHaveBeenCalledTimes(1);
		});
	});

	it("freezes every answer while Submit waits behind earlier attachment work", async () => {
		vi.mocked(submitFormAction).mockResolvedValue({
			kind: "registration",
			caseId: "new-case-id",
			childCaseIds: [],
		});
		renderFormScreen({ formUuid: REG_FORM_UUID });
		await waitFor(() => expect(capturedController?.entryKey).toBeDefined());
		const entryKey = capturedController?.entryKey;
		if (!entryKey) throw new Error("Expected an active form entry");

		const allTextboxes = await screen.findAllByRole("textbox");
		const input = allTextboxes.find(
			(el) => !(el as HTMLInputElement).readOnly,
		) as HTMLInputElement;
		fireEvent.change(input, { target: { value: "before submit" } });

		const blockerStarted = deferred<void>();
		const releaseBlocker = deferred<void>();
		const blocker = runAttachmentTask({
			entryKey,
			slotKey: "/data/slow-photo",
			task: async () => {
				blockerStarted.resolve();
				await releaseBlocker.promise;
			},
		});
		await blockerStarted.promise;

		fireEvent.click(screen.getByRole("button", { name: /^submit$/i }));
		await screen.findByRole("button", { name: /^submitting$/i });

		// A post-click gesture must not mutate the coherent answer set that
		// will be read once the attachment barrier opens.
		fireEvent.change(input, { target: { value: "after submit" } });

		await act(async () => {
			releaseBlocker.resolve();
			await blocker;
		});
		await waitFor(() =>
			expect(vi.mocked(submitFormAction)).toHaveBeenCalledTimes(1),
		);
		const [mutation] = vi.mocked(submitFormAction).mock.calls[0];
		expect(mutation.kind).toBe("registration");
		if (mutation.kind === "registration") {
			expect(mutation.primary.caseName).toBe("before submit");
			expect(mutation.primary.properties).toEqual({});
		}
	});

	it("does not cross-submit queued answers after persona and form navigation rotate the entry", async () => {
		currentAuthUser = {
			id: "member-1",
			name: "Member One",
			email: "member@example.com",
		};
		vi.mocked(submitFormAction).mockClear();
		renderFormScreen({ formUuid: REG_FORM_UUID });
		const submit = await screen.findByRole("button", { name: /^submit$/i });
		await waitFor(() => expect(capturedController?.entryKey).toBeDefined());
		const initiatingEntryKey = capturedController?.entryKey;
		if (!initiatingEntryKey) throw new Error("Expected an active form entry");

		let releaseUpload!: () => void;
		let uploadStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			uploadStarted = resolve;
		});
		const release = new Promise<void>((resolve) => {
			releaseUpload = resolve;
		});
		const upload = runAttachmentTask({
			entryKey: initiatingEntryKey,
			slotKey: "/data/photo",
			task: async () => {
				uploadStarted();
				await release;
			},
		});
		const uploadResult = upload.catch((error: unknown) => error);
		await started;

		fireEvent.click(submit);
		currentLocation = {
			kind: "form",
			moduleUuid: MODULE_UUID,
			formUuid: SURVEY_FORM_UUID,
		};
		act(() => {
			capturedSession?.getState().setPreviewPersonaUuid(PERSONA_UUID);
		});
		await waitFor(() => {
			expect(capturedController?.entryKey).not.toBe(initiatingEntryKey);
		});

		releaseUpload();
		expect(await uploadResult).toMatchObject({ name: "AbortError" });
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(vi.mocked(submitFormAction)).not.toHaveBeenCalled();
		expect(navigateMock.goHome).not.toHaveBeenCalled();
		expect(onBackMock).not.toHaveBeenCalled();
	});

	it("settles a queued submit when same-persona data rotates the controller entry", async () => {
		currentAuthUser = {
			id: "member-1",
			name: "Member One",
			email: "member@example.com",
		};
		const view = renderFormScreen({ formUuid: REG_FORM_UUID });
		await waitFor(() => expect(capturedController?.entryKey).toBeDefined());
		const memberEntryKey = capturedController?.entryKey;
		if (!memberEntryKey) throw new Error("Expected the member entry");
		act(() => {
			capturedSession?.getState().setPreviewPersonaUuid(PERSONA_UUID);
		});
		await waitFor(() => {
			expect(capturedController?.entryKey).not.toBe(memberEntryKey);
		});
		const initiatingEntryKey = capturedController?.entryKey;
		if (!initiatingEntryKey) throw new Error("Expected persona entry");

		const blockerStarted = deferred<void>();
		const releaseBlocker = deferred<void>();
		const blocker = runAttachmentTask({
			entryKey: initiatingEntryKey,
			slotKey: "/data/photo",
			task: async () => {
				blockerStarted.resolve();
				await releaseBlocker.promise;
			},
		});
		const blockerResult = blocker.catch((error: unknown) => error);
		await blockerStarted.promise;
		fireEvent.click(screen.getByRole("button", { name: /^submit$/i }));
		await screen.findByRole("button", { name: /^submitting$/i });

		let updateOutcome:
			| ReturnType<NonNullable<typeof updateCapturedPersonaValue>>
			| undefined;
		act(() => {
			updateOutcome = updateCapturedPersonaValue?.(
				PERSONA_UUID,
				PERSONA_REGION_UUID,
				"south",
			);
		});
		expect(updateOutcome).toEqual({ ok: true });
		await waitFor(() => {
			expect(capturedController?.entryKey).not.toBe(initiatingEntryKey);
		});

		releaseBlocker.resolve();
		expect(await blockerResult).toMatchObject({ name: "AbortError" });
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(screen.getByRole("button", { name: /^submit$/i })).toBeDefined();
		expect(vi.mocked(submitFormAction)).not.toHaveBeenCalled();

		const rotatedEntryKey = capturedController?.entryKey;
		if (!rotatedEntryKey) throw new Error("Expected the rotated entry");
		act(() => {
			rememberOwnedStagedAttachment({
				appId: APP_ID,
				entryKey: rotatedEntryKey,
				slotKey: "photo:rotated-entry",
				instancePath: "/data/photo",
				attachment: {
					attachmentId: "attachment-rotated-entry",
					attachmentName: "attachment-rotated-entry.png",
					originalFilename: "photo.png",
					sizeBytes: 3,
				},
			});
		});
		const fetchMock = vi
			.fn()
			.mockResolvedValue(new Response(null, { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		view.unmount();
		await waitFor(() =>
			expect(fetchMock).toHaveBeenCalledWith(
				`/api/apps/${APP_ID}/attachments/attachment-rotated-entry`,
				expect.objectContaining({ method: "DELETE" }),
			),
		);
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
		/* The field owns its visible error; FormScreen contributes only a
		 * screen-reader announcement for the focus jump. */
		expect(
			await screen.findByText(/review the highlighted question/i),
		).toBeDefined();
		expect(navigateMock.goHome).not.toHaveBeenCalled();
		expect(onBackMock).not.toHaveBeenCalled();
	});

	it("expands collapsed ancestors, announces the error, and focuses the invalid control", async () => {
		renderFormScreen({ formUuid: STRUCTURE_FORM_UUID });
		const groupToggle = await screen.findByRole("button", {
			name: /Collapse.*Section 1.*Visit/i,
		});
		fireEvent.click(groupToggle);
		expect(groupToggle.getAttribute("aria-expanded")).toBe("false");
		expect(groupToggle.getAttribute("aria-controls")).toBeTruthy();
		expect(
			screen.queryByLabelText(
				/Section 1.*Visit.*Question 1.*Photo.*Attach file/i,
			),
		).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: /^submit$/i }));

		await waitFor(() => {
			expect(groupToggle.getAttribute("aria-expanded")).toBe("true");
		});
		const file = await screen.findByLabelText(
			/Section 1.*Visit.*Question 1.*Photo.*Required.*Attach file/i,
		);
		await waitFor(() => expect(document.activeElement).toBe(file));
		expect(file.getAttribute("aria-invalid")).toBe("true");
		expect(screen.getByText(/review the highlighted question/i)).toBeDefined();
		expect(vi.mocked(submitFormAction)).not.toHaveBeenCalled();
	});

	it("uses non-animated scrolling when reduced motion is requested", async () => {
		const scrollIntoView = vi.fn();
		vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(
			scrollIntoView,
		);
		vi.stubGlobal(
			"matchMedia",
			vi.fn(() => ({
				matches: true,
				media: "(prefers-reduced-motion: reduce)",
				onchange: null,
				addEventListener: vi.fn(),
				removeEventListener: vi.fn(),
				addListener: vi.fn(),
				removeListener: vi.fn(),
				dispatchEvent: vi.fn(),
			})),
		);
		renderFormScreen({ formUuid: REQUIRED_FORM_UUID });

		fireEvent.click(await screen.findByRole("button", { name: /^submit$/i }));

		await waitFor(() =>
			expect(scrollIntoView).toHaveBeenCalledWith({
				behavior: "auto",
				block: "center",
			}),
		);
	});

	it("expands and focuses the signature pad for a kind-change replacement blocker", async () => {
		renderFormScreen({ formUuid: STRUCTURE_FORM_UUID });
		const controlName =
			/Section 2.*Visit.*Question 2.*Signed consent.*Signature pad/i;
		await screen.findByLabelText(controlName);
		await waitFor(() => expect(capturedController?.entryKey).toBeDefined());
		const entryKey = capturedController?.entryKey;
		if (!entryKey) throw new Error("Expected an active form entry");
		act(() => {
			setAttachmentSlotIssue({
				appId: APP_ID,
				entryKey,
				slotKey: `${GROUP_TWO_SIGNATURE_UUID}\u0000`,
				issue: {
					kind: "replace",
					message:
						"This question is now a signature. Draw a new signature before submitting.",
				},
			});
		});
		const initialPad = await screen.findByLabelText(controlName);
		expect(initialPad.getAttribute("aria-invalid")).toBe("true");
		expect(initialPad.hasAttribute("data-attachment-recovery")).toBe(true);

		const groupToggle = screen.getByRole("button", {
			name: /Collapse.*Section 2.*Visit/i,
		});
		fireEvent.click(groupToggle);
		expect(groupToggle.getAttribute("aria-expanded")).toBe("false");
		expect(screen.queryByLabelText(controlName)).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: /^submit$/i }));
		await waitFor(() => {
			expect(groupToggle.getAttribute("aria-expanded")).toBe("true");
		});
		const restoredPad = await screen.findByLabelText(controlName);
		await waitFor(() => expect(document.activeElement).toBe(restoredPad));
		expect(restoredPad.getAttribute("aria-invalid")).toBe("true");
		expect(vi.mocked(submitFormAction)).not.toHaveBeenCalled();
	});

	it.each([
		{
			kind: "file",
			fieldUuid: GROUP_TWO_PHOTO_UUID,
			controlName: /Section 2.*Visit.*Question 1.*Photo.*Attach file/i,
			recoveryName: /Retry.*Photo/i,
			message:
				"This attachment could not move to the question's current location. Retry now, attach a replacement, or remove it.",
		},
		{
			kind: "signature",
			fieldUuid: GROUP_TWO_SIGNATURE_UUID,
			controlName:
				/Section 2.*Visit.*Question 2.*Signed consent.*Signature pad/i,
			recoveryName: /Retry.*Signed consent/i,
			message:
				"This signature could not move to the question's current location. Retry now, draw it again, or use Clear signature.",
		},
	])(
		"expands a collapsed $kind recovery target, announces it, and focuses its action",
		async ({ fieldUuid, controlName, recoveryName, message }) => {
			renderFormScreen({ formUuid: STRUCTURE_FORM_UUID });
			await screen.findByLabelText(controlName);
			await waitFor(() => expect(capturedController?.entryKey).toBeDefined());
			const entryKey = capturedController?.entryKey;
			if (!entryKey) throw new Error("Expected an active form entry");
			act(() => {
				setAttachmentSlotIssue({
					appId: APP_ID,
					entryKey,
					slotKey: `${fieldUuid}\u0000`,
					issue: { kind: "retarget", message },
				});
			});
			expect(
				await screen.findByRole("button", { name: recoveryName }),
			).toBeDefined();

			const groupToggle = screen.getByRole("button", {
				name: /Collapse.*Section 2.*Visit/i,
			});
			fireEvent.click(groupToggle);
			expect(groupToggle.getAttribute("aria-expanded")).toBe("false");
			expect(screen.queryByRole("button", { name: recoveryName })).toBeNull();

			fireEvent.click(screen.getByRole("button", { name: /^submit$/i }));

			await waitFor(() => {
				expect(groupToggle.getAttribute("aria-expanded")).toBe("true");
			});
			const recovery = await screen.findByRole("button", {
				name: recoveryName,
			});
			await waitFor(() => expect(document.activeElement).toBe(recovery));
			expect(screen.getByText(message)).toBeDefined();
			expect(vi.mocked(submitFormAction)).not.toHaveBeenCalled();
		},
	);

	it.each([
		{
			name: "malformed group-to-repeat move",
			fieldUuid: GROUP_TWO_PHOTO_UUID,
			slotKey: "orphan-group-to-repeat-photo",
			oldPath: "/data/legacy_visit/photo",
			currentPath: "/data/visits[0]/photo",
			captureKind: "image",
			actionName: /Remove attachment from Photo/i,
		},
		{
			name: "malformed cross-repeat move",
			fieldUuid: GROUP_TWO_SIGNATURE_UUID,
			slotKey: "orphan-cross-repeat-signature",
			oldPath: "/data/households[1]/visits[2]/consent",
			currentPath: "/data/other_visits[0]/consent",
			captureKind: "signature",
			actionName: /Clear signature for Signed consent/i,
		},
	])(
		"renders a question-qualified form-level recovery for a $name",
		async ({
			fieldUuid,
			slotKey,
			oldPath,
			currentPath,
			captureKind,
			actionName,
		}) => {
			renderFormScreen({ formUuid: STRUCTURE_FORM_UUID });
			await waitFor(() => expect(capturedController?.entryKey).toBeDefined());
			const entryKey = capturedController?.entryKey;
			if (!entryKey) throw new Error("Expected an active form entry");
			act(() => {
				capturedController?.onValueChange(
					GROUP_ONE_PHOTO_UUID,
					"required-photo.png",
				);
			});
			act(() => {
				registerAttachmentSlotPath({
					appId: APP_ID,
					entryKey,
					slotKey,
					fieldUuid,
					instancePath: oldPath,
					captureKind,
				});
				rememberOwnedStagedAttachment({
					appId: APP_ID,
					entryKey,
					slotKey,
					instancePath: oldPath,
					attachment: {
						attachmentId: `attachment-${slotKey}`,
						attachmentName: `${slotKey}.png`,
						originalFilename: `${slotKey}.png`,
						sizeBytes: 3,
					},
				});
				if (captureKind === "signature") {
					rememberSignatureDraft(entryKey, slotKey, [[{ x: 0.2, y: 0.4 }]]);
				}
			});
			await act(async () => {
				await reconcileAttachmentAuthoredPathMigration({
					appId: APP_ID,
					entryKey,
					migration: {
						moves: [
							{
								kind: "retained",
								fieldUuid,
								previous: {
									pathTemplate: oldPath.replace(/\[\d+\]/g, ""),
									segmentKeys: [
										"$data",
										...oldPath
											.split("/")
											.filter(Boolean)
											.slice(1)
											.map((_, index) => `old-${index}`),
										fieldUuid,
									],
									captureKind,
								},
								current: {
									pathTemplate: currentPath,
									// Duplicate identities make this cross-container
									// projection invalid without authorizing deletion.
									segmentKeys: ["$data", "duplicate", "duplicate"],
									captureKind,
								},
							},
						],
					},
				});
			});

			const recoveries = await screen.findAllByRole("button", {
				name: actionName,
			});
			expect(recoveries).toHaveLength(1);
			const recovery = recoveries[0];
			if (recovery === undefined) {
				throw new Error("Expected one question-qualified recovery action.");
			}
			expect(recovery).toBeDefined();
			expect(screen.getByText(/could not be verified/i)).toBeDefined();
			fireEvent.click(screen.getByRole("button", { name: /^submit$/i }));
			await waitFor(() => expect(document.activeElement).toBe(recovery));
			expect(vi.mocked(submitFormAction)).not.toHaveBeenCalled();

			const fetchMock = vi
				.fn()
				.mockResolvedValue(new Response(null, { status: 200 }));
			vi.stubGlobal("fetch", fetchMock);
			fireEvent.click(recovery);
			await waitFor(() =>
				expect(screen.queryByRole("button", { name: actionName })).toBeNull(),
			);
			vi.mocked(submitFormAction).mockResolvedValue({ kind: "survey" });
			fireEvent.click(screen.getByRole("button", { name: /^submit$/i }));
			await waitFor(() =>
				expect(vi.mocked(submitFormAction)).toHaveBeenCalledTimes(1),
			);
			await waitFor(() =>
				expect(fetchMock).toHaveBeenCalledWith(
					`/api/apps/${APP_ID}/attachments/attachment-${slotKey}`,
					expect.objectContaining({ method: "DELETE" }),
				),
			);
		},
	);

	it.each([
		{
			denial: "access refresh",
			fieldUuid: GROUP_TWO_PHOTO_UUID,
			slotKey: "refresh-denied-recovery-photo",
			oldPath: "/data/legacy_visit/photo",
			currentPath: "/data/visits[0]/photo",
			captureKind: "image" as const,
			actionName: /Remove attachment from Photo/i,
		},
		{
			denial: "viewer downgrade",
			fieldUuid: GROUP_TWO_SIGNATURE_UUID,
			slotKey: "viewer-denied-recovery-signature",
			oldPath: "/data/households[1]/visits[2]/consent",
			currentPath: "/data/other_visits[0]/consent",
			captureKind: "signature" as const,
			actionName: /Clear signature for Signed consent/i,
		},
	])(
		"keeps retained recovery state read-only through a $denial",
		async ({
			denial,
			fieldUuid,
			slotKey,
			oldPath,
			currentPath,
			captureKind,
			actionName,
		}) => {
			renderFormScreen({ formUuid: STRUCTURE_FORM_UUID });
			const { entryKey, fileDraft, signatureInk } =
				await seedMalformedAttachmentRecovery({
					fieldUuid,
					slotKey,
					oldPath,
					currentPath,
					captureKind,
				});
			const recovery = await screen.findByRole("button", {
				name: actionName,
			});
			expect((recovery as HTMLButtonElement).disabled).toBe(false);

			act(() => {
				if (denial === "access refresh") {
					capturedSession?.getState().beginAccessRefresh();
					return;
				}
				capturedSession?.setState({
					canEdit: false,
					role: "viewer",
					accessPhase: "authorized",
				});
			});
			await waitFor(() =>
				expect((recovery as HTMLButtonElement).disabled).toBe(true),
			);
			fireEvent.click(recovery);

			expect(
				getOwnedStagedAttachment({
					appId: APP_ID,
					entryKey,
					slotKey,
				}),
			).toMatchObject({ attachmentId: `attachment-${slotKey}` });
			expect(
				getAttachmentSlotIssue({
					appId: APP_ID,
					entryKey,
					slotKey,
				}),
			).toMatchObject({ kind: "invariant" });
			if (fileDraft !== undefined) {
				expect(
					getAttachmentSlotDraft({
						appId: APP_ID,
						entryKey,
						slotKey,
					})?.file,
				).toBe(fileDraft);
			}
			if (signatureInk !== undefined) {
				expect(getSignatureDraft(entryKey, slotKey)).toEqual(signatureInk);
			}

			act(() => {
				capturedSession?.getState().applyAccessSnapshot({
					projectId: "project-form-screen-test",
					role: "editor",
					canEdit: true,
				});
			});
			await waitFor(() =>
				expect((recovery as HTMLButtonElement).disabled).toBe(false),
			);
		},
	);
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
	it("binds the exact same-type case inherited from its parent menu", async () => {
		const selectedCaseId = "selected-patient";
		previewMenuCaseSelectionsMock = {
			[MENU_CASE_PARENT_MODULE_UUID]: {
				caseType: CASE_TYPE,
				caseId: selectedCaseId,
				caseName: "Selected patient",
			},
		};
		vi.mocked(loadCaseDataAction).mockResolvedValue({
			kind: "row",
			row: formCaseRow(selectedCaseId),
			ancestors: [],
		});

		renderFormScreen({
			formUuid: CLOSE_FORM_UUID,
			menuCaseRelationship: "same-type",
		});

		expect(
			await screen.findByRole("button", { name: /^submit$/i }),
		).toBeDefined();
		expect(vi.mocked(loadCaseDataAction).mock.calls[0]?.slice(0, 3)).toEqual([
			APP_ID,
			CASE_TYPE,
			selectedCaseId,
		]);
		expect(vi.mocked(loadCasesAction)).not.toHaveBeenCalled();
	});

	it("constrains a different-type child lookup to the independently selected case parent", async () => {
		const parentCaseId = "selected-household";
		const childCaseId = "selected-household-patient";
		previewMenuCaseSelectionsMock = {
			[MENU_CASE_PARENT_MODULE_UUID]: {
				caseType: "household",
				caseId: parentCaseId,
				caseName: "Selected household",
			},
		};
		vi.mocked(loadCasesAction).mockResolvedValue({
			constraintSource: "authored-rules",
			kind: "rows",
			rows: [formCaseRow(childCaseId, parentCaseId)],
		});
		vi.mocked(loadCaseDataAction).mockResolvedValue({
			kind: "row",
			row: formCaseRow(childCaseId, parentCaseId),
			ancestors: [],
		});

		renderFormScreen({
			formUuid: CLOSE_FORM_UUID,
			menuCaseRelationship: "different-type",
		});

		expect(
			await screen.findByRole("button", { name: /^submit$/i }),
		).toBeDefined();
		expect(vi.mocked(loadCasesAction)).toHaveBeenCalledWith(
			expect.objectContaining({
				caseType: CASE_TYPE,
				parentCase: expect.objectContaining({
					caseType: "household",
					caseId: parentCaseId,
				}),
			}),
		);
		await waitFor(() =>
			expect(vi.mocked(loadCaseDataAction).mock.calls[0]?.slice(0, 3)).toEqual([
				APP_ID,
				CASE_TYPE,
				childCaseId,
			]),
		);
	});

	it("auto-selects the first available case and renders the form — never blocks", async () => {
		/* Close is a case-loading form. Previewed directly with no bound
		 *  case, it must auto-bind the FIRST available case (so the form is
		 *  usable), not gate on navigation: same stance as the case list.
		 *  The submit row renders against that bound case. */
		vi.mocked(loadCasesAction).mockResolvedValue({
			constraintSource: "unconstrained",
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
		vi.mocked(loadCasesAction).mockResolvedValue({
			constraintSource: "unconstrained",
			kind: "empty",
		});
		renderFormScreen({ formUuid: CLOSE_FORM_UUID });

		/* The form itself renders, its field's textbox is present (an
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
		/* Sequence: pins the invariant the handler enforces:
		 *   1. Render the required-field form, populate the field so
		 *      the first submit passes validate. The action mock
		 *      resolves to a server validation failure → alert renders.
		 *   2. Re-empty the required field, click Submit again. The
		 *      engine reports invalid; the handler short-circuits
		 *      BEFORE the action call. The alert must disappear: the
		 *      surface now reflects the per-field required indicator,
		 *      not a stale server-side failure that no longer applies.
		 *
		 * This test pins that `handleSubmit` clears `submitStatus`
		 * before validating: the alert from step 1 must disappear
		 * when step 2's validate-fail short-circuit fires. */
		vi.mocked(submitFormAction).mockResolvedValue({
			kind: "case-properties-validation",
			caseType: CASE_TYPE,
			failures: [{ path: "/age", message: "must be integer" }],
		});

		renderFormScreen({ formUuid: REQUIRED_FORM_UUID });

		/* The screen renders two `<input>`s: a readonly title input
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
		/* The action MUST NOT have re-fired: the validate-fail branch
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

		/* The alert renders first: the user sees the error and decides
		 *  to start over via Clear. */
		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toMatch(/Could not reach the case store\./);

		const clear = screen.getByRole("button", { name: /clear form/i });
		fireEvent.click(clear);

		/* "Start fresh" means the surface returns to idle: the alert
		 *  must disappear. Leaving it visible while the form fields
		 *  reset contradicts the user's mental model. */
		await waitFor(() => {
			expect(screen.queryByRole("alert")).toBeNull();
		});
	});

	it("rotates to an editable fresh entry without waiting for old cleanup", async () => {
		renderFormScreen({ formUuid: REG_FORM_UUID });
		await waitFor(() => expect(capturedController?.entryKey).toBeDefined());
		const previousEntryKey = capturedController?.entryKey;
		if (!previousEntryKey) throw new Error("Expected an active form entry");
		const cleanup = deferred<{ ok: boolean; status: number }>();
		vi.stubGlobal(
			"fetch",
			vi.fn(() => cleanup.promise),
		);
		act(() => {
			rememberOwnedStagedAttachment({
				appId: APP_ID,
				entryKey: previousEntryKey,
				slotKey: "photo:old-entry",
				instancePath: "/data/photo",
				attachment: {
					attachmentId: "attachment-old-entry",
					attachmentName: "attachment-old-entry.png",
					originalFilename: "old.png",
					sizeBytes: 3,
				},
			});
		});
		const oldInput = document.querySelector(
			`[data-field-uuid="${FIELD_UUID}"] input`,
		) as HTMLInputElement;
		expect(oldInput).not.toBeNull();
		fireEvent.change(oldInput, { target: { value: "Old answer" } });

		const clear = screen.getByRole("button", { name: /clear form/i });
		fireEvent.click(clear);
		const freshEntryKey = capturedController?.entryKey;
		fireEvent.click(screen.getByRole("button", { name: /clear form/i }), {
			detail: 2,
		});

		expect(freshEntryKey).toEqual(expect.any(String));
		expect(freshEntryKey).not.toBe(previousEntryKey);
		expect(capturedController?.entryKey).toBe(freshEntryKey);
		fireEvent.change(oldInput, { target: { value: "Late old edit" } });
		const freshInput = document.querySelector(
			`[data-field-uuid="${FIELD_UUID}"] input`,
		) as HTMLInputElement;
		expect(freshInput).not.toBe(oldInput);
		expect(freshInput.value).toBe("Test case");
		fireEvent.change(freshInput, { target: { value: "New answer" } });
		expect(freshInput.value).toBe("New answer");
		expect(capturedController?.entryKey).toBe(freshEntryKey);

		cleanup.resolve({ ok: false, status: 500 });
		await act(async () => {
			await Promise.resolve();
		});
		expect(freshInput.value).toBe("New answer");
		expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
	});

	it("uses a new idempotency key after a response-lost submit is cleared", async () => {
		vi.mocked(submitFormAction)
			.mockRejectedValueOnce(new Error("response lost after acceptance"))
			.mockResolvedValueOnce({
				kind: "registration",
				caseId: "new-case-after-clear",
				childCaseIds: [],
			});
		renderFormScreen({ formUuid: REG_FORM_UUID });
		await screen.findByRole("button", { name: /^submit$/i });
		const input = document.querySelector(
			`[data-field-uuid="${FIELD_UUID}"] input`,
		) as HTMLInputElement;
		fireEvent.change(input, { target: { value: "First answer" } });
		fireEvent.click(screen.getByRole("button", { name: /^submit$/i }));
		await screen.findByRole("alert");
		const firstMutation = vi.mocked(submitFormAction).mock.calls[0]?.[0];
		expect(firstMutation?.entryKey).toEqual(expect.any(String));

		fireEvent.click(screen.getByRole("button", { name: /clear form/i }));
		const freshInput = document.querySelector(
			`[data-field-uuid="${FIELD_UUID}"] input`,
		) as HTMLInputElement;
		fireEvent.change(freshInput, { target: { value: "Second answer" } });
		fireEvent.click(screen.getByRole("button", { name: /^submit$/i }));
		await waitFor(() =>
			expect(vi.mocked(submitFormAction)).toHaveBeenCalledTimes(2),
		);
		const secondMutation = vi.mocked(submitFormAction).mock.calls[1]?.[0];
		expect(secondMutation?.entryKey).toEqual(expect.any(String));
		expect(secondMutation?.entryKey).not.toBe(firstMutation?.entryKey);
	});
});

describe("FormScreen — repeated structure accessibility", () => {
	it("associates both empty required capture errors after Submit", async () => {
		renderFormScreen({ formUuid: CAPTURE_REQUIRED_FORM_UUID });
		const submit = await screen.findByRole("button", { name: /^submit$/i });
		fireEvent.click(submit);

		const file = screen.getByLabelText(
			/Question 1.*Photo.*Required.*Attach file/i,
		) as HTMLInputElement;
		const canvas = screen.getByLabelText(
			/Question 2.*Signed consent.*Required.*Signature pad/i,
		);
		await waitFor(() => {
			expect(file.getAttribute("aria-invalid")).toBe("true");
			expect(canvas.getAttribute("aria-invalid")).toBe("true");
		});
		expect(file.required).toBe(true);
		expect(canvas.getAttribute("aria-required")).toBe("true");
		expect(file.getAttribute("aria-describedby")).toBeTruthy();
		expect(canvas.getAttribute("aria-describedby")).toBeTruthy();
		expect(screen.getAllByRole("alert")).toHaveLength(3);
		expect(screen.getAllByRole("status")).toHaveLength(2);
		expect(vi.mocked(submitFormAction)).not.toHaveBeenCalled();
	});

	it("focuses a selected signature control when Preview opens", async () => {
		renderFormScreen({
			formUuid: CAPTURE_REQUIRED_FORM_UUID,
			selectedUuid: REQUIRED_SIGNATURE_UUID,
		});
		const canvas = await screen.findByLabelText(
			/Question 2.*Signed consent.*Signature pad/i,
		);
		await waitFor(() => expect(document.activeElement).toBe(canvas));
	});

	it("focuses the signature pad when it is the first invalid control", async () => {
		renderFormScreen({ formUuid: CAPTURE_REQUIRED_FORM_UUID });
		await waitFor(() => expect(capturedController).toBeDefined());
		act(() => {
			capturedController?.setValueAt("/data/photo", "already-attached.png");
		});
		fireEvent.click(screen.getByRole("button", { name: /^submit$/i }));

		const canvas = await screen.findByLabelText(
			/Question 2.*Signed consent.*Required.*Signature pad/i,
		);
		await waitFor(() => expect(document.activeElement).toBe(canvas));
		expect(canvas.getAttribute("aria-invalid")).toBe("true");
		expect(vi.mocked(submitFormAction)).not.toHaveBeenCalled();
	});

	it("disambiguates duplicate controls and keeps structural actions touch-sized", async () => {
		renderFormScreen({ formUuid: STRUCTURE_FORM_UUID });

		const firstGroupToggle = await screen.findByRole("button", {
			name: /Collapse.*Section 1.*Visit/i,
		});
		const secondGroupToggle = screen.getByRole("button", {
			name: /Collapse.*Section 2.*Visit/i,
		});
		const repeatToggle = screen.getByRole("button", {
			name: /Collapse.*Repeat 3.*Repeat.*Visit/i,
		});
		for (const toggle of [firstGroupToggle, secondGroupToggle, repeatToggle]) {
			expect(toggle.className).toContain("min-h-11");
			expect(toggle.className).toContain("min-w-11");
			expect(toggle.className).toContain("touch-manipulation");
			expect(toggle.getAttribute("aria-expanded")).toBe("true");
			expect(toggle.getAttribute("aria-controls")).toBeTruthy();
		}

		expect(
			screen.getByLabelText(
				/Section 1.*Visit.*Question 1.*Photo.*Attach file/i,
			),
		).toBeDefined();
		expect(
			screen.getByLabelText(
				/Section 2.*Visit.*Question 1.*Photo.*Attach file/i,
			),
		).toBeDefined();
		expect(
			screen.getByLabelText(
				/Repeat 3.*Repeat.*Visit.*Instance 1.*Question 1.*Photo.*Attach file/i,
			),
		).toBeDefined();

		const add = screen.getByRole("button", {
			name: /Add Visit.*Repeat 3.*Repeat.*Visit/i,
		});
		expect(add.className).toContain("min-h-11");
		expect(add.className).toContain("touch-manipulation");
		fireEvent.click(add);

		expect(
			await screen.findByLabelText(
				/Repeat 3.*Repeat.*Visit.*Instance 2.*Question 1.*Photo.*Attach file/i,
			),
		).toBeDefined();
		const removeSecond = screen.getByRole("button", {
			name: /Remove.*Repeat 3.*Repeat.*Visit.*Instance 2/i,
		});
		expect(removeSecond.className).toContain("min-h-11");
		expect(removeSecond.className).toContain("min-w-11");
	});

	it("preserves a repeated capture when stale removal loses authority and permits a restored removal", async () => {
		renderFormScreen({ formUuid: STRUCTURE_FORM_UUID });
		const add = await screen.findByRole("button", {
			name: /Add Visit.*Repeat 3.*Repeat.*Visit/i,
		});
		fireEvent.click(add);
		const removeSecond = await screen.findByRole("button", {
			name: /Remove.*Repeat 3.*Repeat.*Visit.*Instance 2/i,
		});
		const entryKey = capturedController?.entryKey;
		if (entryKey === undefined || capturedSession === undefined) {
			throw new Error("Expected mounted session and repeated form entry.");
		}
		const slotKey = "repeat-removal-authority-photo";
		const fileDraft = new File(["repeat"], "repeat-photo.png", {
			type: "image/png",
		});
		act(() => {
			registerAttachmentSlotPath({
				appId: APP_ID,
				entryKey,
				slotKey,
				fieldUuid: REPEAT_PHOTO_UUID,
				instancePath: "/data/visits[1]/photo",
				captureKind: "image",
			});
			rememberOwnedStagedAttachment({
				appId: APP_ID,
				entryKey,
				slotKey,
				instancePath: "/data/visits[1]/photo",
				attachment: {
					attachmentId: "attachment-repeat-removal-authority",
					attachmentName: "attachment-repeat-removal-authority.png",
					originalFilename: "repeat-photo.png",
					sizeBytes: 6,
				},
			});
			rememberAttachmentSlotDraft({
				appId: APP_ID,
				entryKey,
				slotKey,
				file: fileDraft,
				status: "needs-attention",
				generation: 4,
			});
		});

		act(() => capturedSession?.getState().beginAccessRefresh());
		await waitFor(() =>
			expect((removeSecond as HTMLButtonElement).disabled).toBe(true),
		);
		fireEvent.click(removeSecond);
		expect(capturedController?.getRepeatCount(REPEAT_UUID)).toBe(2);
		expect(
			getOwnedStagedAttachment({ appId: APP_ID, entryKey, slotKey }),
		).toMatchObject({ attachmentId: "attachment-repeat-removal-authority" });
		expect(
			getAttachmentSlotDraft({ appId: APP_ID, entryKey, slotKey })?.file,
		).toBe(fileDraft);

		act(() => {
			capturedSession?.getState().applyAccessSnapshot({
				projectId: "project-form-screen-test",
				role: "editor",
				canEdit: true,
			});
		});
		await waitFor(() =>
			expect((removeSecond as HTMLButtonElement).disabled).toBe(false),
		);
		const fetchMock = vi
			.fn()
			.mockResolvedValue(new Response(null, { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		fireEvent.click(removeSecond);
		await waitFor(() =>
			expect(capturedController?.getRepeatCount(REPEAT_UUID)).toBe(1),
		);
		expect(
			getOwnedStagedAttachment({ appId: APP_ID, entryKey, slotKey }),
		).toBeUndefined();
		await waitFor(() =>
			expect(fetchMock).toHaveBeenCalledWith(
				`/api/apps/${APP_ID}/attachments/attachment-repeat-removal-authority`,
				expect.objectContaining({ method: "DELETE" }),
			),
		);
	});

	it("keeps footer actions touch-sized and wrapping at compact widths", async () => {
		renderFormScreen({ formUuid: REG_FORM_UUID });
		const submit = await screen.findByRole("button", { name: /^submit$/i });
		const clear = screen.getByRole("button", { name: /clear form/i });
		for (const action of [submit, clear]) {
			expect(action.className).toContain("min-h-11");
			expect(action.className).toContain("touch-manipulation");
		}
		expect(submit.parentElement?.className).toContain("flex-wrap");
	});
});
