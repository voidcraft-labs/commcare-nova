// Server-action contracts with mocked auth and CaseStore boundaries.
// No database fixture: these tests prove authorization, argument projection, and failure handling.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { resolveCaseListConfig } from "@/lib/__tests__/docHelpers";
import {
	CaseNotFoundError,
	CasePropertiesValidationError,
	type CasePropertyFailure,
	type CaseRow,
	type CaseStore,
	type JsonObject,
	SchemaNotSyncedError,
} from "@/lib/case-store";
import { buildSimpleBlueprint } from "@/lib/case-store/__tests__/fixtures/simpleBlueprint";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import {
	advancedSearchInputDef,
	type CaseListConfig,
	type CaseOperation,
	type CaseType,
	calculatedColumn,
	type LookupColumnId,
	type LookupTableId,
	plainColumn,
	simpleSearchInputDef,
	USERCASE_CASE_TYPE,
	type Uuid,
} from "@/lib/domain";
import {
	and,
	between,
	dateAdd,
	dateLiteral,
	double,
	eq,
	formField,
	ifExpr,
	input,
	isBlank,
	isIn,
	literal,
	matchNone,
	not,
	or,
	prop,
	sessionContext,
	sessionUser,
	sessionUserProperty,
	tableColumn,
	tableLookup,
	term,
	today,
	whenInput,
} from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { buildDoc, f } from "../../../__tests__/docHelpers";
import { validateCaptureSubmissionProjection } from "../captureSubmissionValidation";
import {
	buildSubmissionOperationProgram,
	buildSubmissionReceiptIdentity,
	submissionEnvelopeArgs as projectSubmissionEnvelopeArgs,
	readCaseDatabaseSnapshot,
	SAMPLE_CASE_DEFAULT_COUNT,
} from "../caseDataBindingHelpers";
import type {
	SubmissionMutation,
	SubmissionWireMutation,
} from "../caseDataBindingTypes";
import { previewAsMe } from "../identity";

type CaseQuery = CaseStore["query"];

function appCaseQuery(...pages: ReadonlyArray<Awaited<ReturnType<CaseQuery>>>) {
	const remaining = [...pages];
	return vi.fn<CaseQuery>(async (args) =>
		args.caseType === USERCASE_CASE_TYPE ? [] : (remaining.shift() ?? []),
	);
}

function appCaseQueryArg<T extends { readonly caseType: string }>(mock: {
	readonly mock: { readonly calls: ReadonlyArray<readonly [T, ...unknown[]]> };
}): T | undefined {
	return mock.mock.calls
		.map((call) => call[0])
		.find((arg) => arg.caseType !== USERCASE_CASE_TYPE);
}

describe("readCaseDatabaseSnapshot", () => {
	it("delegates one all-case-type read with the exact restore scope", async () => {
		const snapshot = { rows: [], indices: [] };
		const readDeviceCaseDatabase = vi.fn<CaseStore["readDeviceCaseDatabase"]>(
			async () => snapshot,
		);
		const store = { readDeviceCaseDatabase } as unknown as CaseStore;
		const restoreScope = { ownerIds: ["worker-1", "place-1"] } as const;

		await expect(
			readCaseDatabaseSnapshot(store, {
				appId: "app-1",
				restoreScope,
			}),
		).resolves.toBe(snapshot);
		expect(readDeviceCaseDatabase).toHaveBeenCalledWith({
			appId: "app-1",
			restoreScope,
		});
	});
});

vi.mock("@/lib/auth-utils", () => ({
	getSession: vi.fn(),
}));

const { prepareCaptureSubmissionBytesMock } = vi.hoisted(() => ({
	prepareCaptureSubmissionBytesMock: vi.fn(),
}));

vi.mock("@/lib/case-store", async () => {
	const actual =
		await vi.importActual<typeof import("@/lib/case-store")>(
			"@/lib/case-store",
		);
	return {
		...actual,
		withProjectContext: vi.fn(),
	};
});

vi.mock("@/lib/case-store/postgres/submissionAttachments", () => ({
	prepareCaptureSubmissionBytes: prepareCaptureSubmissionBytesMock,
}));

const { loadAuthorizedFormSubmissionSnapshotMock } = vi.hoisted(() => ({
	loadAuthorizedFormSubmissionSnapshotMock: vi.fn(),
}));

vi.mock("@/lib/db/formAttachments", async () => {
	const actual = await vi.importActual<
		typeof import("@/lib/db/formAttachments")
	>("@/lib/db/formAttachments");
	return {
		...actual,
		loadAuthorizedFormSubmissionSnapshot:
			loadAuthorizedFormSubmissionSnapshotMock,
	};
});

const {
	getLookupDefinitionsMock,
	drainPendingMock,
	loadAppMock,
	materializeMock,
	resolveAppScopeMock,
	resolveAuthorizedAppSnapshotMock,
} = vi.hoisted(() => ({
	getLookupDefinitionsMock: vi.fn(),
	drainPendingMock: vi.fn(),
	loadAppMock: vi.fn(),
	materializeMock: vi.fn(),
	resolveAppScopeMock: vi.fn(),
	resolveAuthorizedAppSnapshotMock: vi.fn(),
}));

vi.mock("@/lib/db/apps", () => ({ loadApp: loadAppMock }));

vi.mock("@/lib/db/materializeCaseStoreSchemas", () => ({
	drainPendingCaseSchemaIndexes: drainPendingMock,
	materializeCaseStoreSchemas: materializeMock,
}));

vi.mock("@/lib/lookup/service", async () => {
	const actual = await vi.importActual<typeof import("@/lib/lookup/service")>(
		"@/lib/lookup/service",
	);
	return { ...actual, getLookupDefinitions: getLookupDefinitionsMock };
});

vi.mock("@/lib/db/appAccess", async () => {
	const actual =
		await vi.importActual<typeof import("@/lib/db/appAccess")>(
			"@/lib/db/appAccess",
		);
	return {
		...actual,
		resolveAppScope: resolveAppScopeMock,
		resolveAuthorizedAppSnapshot: resolveAuthorizedAppSnapshotMock,
	};
});

beforeEach(async () => {
	// The action tests queue per-call resolutions on the shared
	// `getSession` / `withProjectContext` module mocks via
	// `mockResolvedValueOnce`. The `clearMocks` config runs `mockClear`
	// (call history only) — it does NOT drain a `*Once` queue, so a test
	// that short-circuits before consuming its queued value would leak it
	// to the next test and misattribute that test's failure. Reset every
	// mock's queue so each test is diagnostically independent. (Only the
	// module mocks — auth, store context, and the heal's Postgres
	// boundary — are vi.fn()s at this point; in-test spies/stubs are
	// created inside the bodies that follow.)
	vi.resetAllMocks();
	// Default both membership paths to success — the common case. Denial-path
	// tests override the applicable resolver with a rejected `AppAccessError`.
	// `withProjectContext` is mocked per-test to return the store under
	// test, so the resolved `projectId` here is inert; it only needs to
	// not throw.
	resolveAppScopeMock.mockResolvedValue({
		projectId: PROJECT_A,
		role: "owner",
		actorUserId: OWNER_A,
	});
	loadAuthorizedFormSubmissionSnapshotMock.mockResolvedValue({
		kind: "current",
		projectId: PROJECT_A,
		app: {
			blueprint: finalSubmissionDoc(),
			mutation_seq: 1,
			project_id: PROJECT_A,
		},
	});
	loadAppMock.mockResolvedValue({
		blueprint: finalSubmissionDoc(),
		mutation_seq: 1,
		project_id: PROJECT_A,
	});
	resolveAuthorizedAppSnapshotMock.mockImplementation(
		async (appId: string, actorUserId: string) => {
			const app = await loadAppMock(appId);
			return {
				app,
				projectId: PROJECT_A,
				role: "owner",
				actorUserId,
				canEdit: true,
				baseSeq: Number(app?.mutation_seq ?? 0),
			};
		},
	);
});

const APP_ID = "app-binding";

const OWNER_A = "owner-a";

const OWNER_B = "owner-b";

const PROJECT_A = "project-a";

const OPERATION_LOOKUP_TABLE =
	"00000000-0000-7000-8000-000000000091" as LookupTableId;

const OPERATION_LOOKUP_COLUMN =
	"10000000-0000-7000-8000-000000000092" as LookupColumnId;

const LOOKUP_SCOPE = {
	projectId: PROJECT_A,
	actorId: OWNER_A,
	role: "owner",
} as const;

const FINAL_FORM_UUID = testUuid("10000000-0000-4000-8000-000000000001");

const FINAL_ENTRY_KEY = "10000000-0000-4000-8000-000000000002";

const FINAL_SUBMISSION_PROTOCOL = {
	formUuid: FINAL_FORM_UUID,
	entryKey: FINAL_ENTRY_KEY,
	attachmentRefs: [],
} as const;

let submissionEnvelopeReceiptSequence = 0;

function submissionEnvelopeArgs(
	mutation: Parameters<typeof projectSubmissionEnvelopeArgs>[0],
	appId: Parameters<typeof projectSubmissionEnvelopeArgs>[1],
	built?: Parameters<typeof projectSubmissionEnvelopeArgs>[2],
): ReturnType<typeof projectSubmissionEnvelopeArgs> {
	submissionEnvelopeReceiptSequence += 1;
	const children =
		mutation.kind === "registration" ||
		mutation.kind === "followup" ||
		mutation.kind === "close"
			? mutation.children
			: [];
	const ordinaryChildRelationships =
		built?.ordinaryChildRelationships ??
		new Map(children.map((child) => [child.caseType, "child"] as const));
	const childSeeds = children.map((child) => ({
		...child,
		parentRelationship:
			ordinaryChildRelationships.get(child.caseType) ?? ("child" as const),
	}));
	const ordinaryCaseType =
		built?.ordinaryCaseType ??
		(mutation.kind === "followup" || mutation.kind === "close"
			? "patient"
			: undefined);
	const ordinarySelection =
		built?.ordinarySelection ??
		(mutation.kind === "followup" || mutation.kind === "close"
			? { kind: "single" as const, maximum: 1 as const }
			: undefined);
	const ordinaryAction =
		built?.ordinaryAction ??
		(mutation.kind === "registration"
			? {
					kind: "registration" as const,
					primary: mutation.primary,
					children: childSeeds,
				}
			: mutation.kind === "followup" || mutation.kind === "close"
				? {
						kind:
							mutation.kind === "close" && (built?.ordinaryCloseCase ?? true)
								? ("close" as const)
								: ("followup" as const),
						caseIds: mutation.caseIds,
						caseType: ordinaryCaseType ?? "patient",
						selection:
							ordinarySelection ?? ({ kind: "single", maximum: 1 } as const),
						patch: mutation.patch,
						children: childSeeds,
					}
				: { kind: "none" as const });
	return projectSubmissionEnvelopeArgs(mutation, appId, {
		...built,
		ordinaryAction,
		ordinaryFormType: built?.ordinaryFormType ?? mutation.kind,
		ordinaryCloseCase:
			built?.ordinaryCloseCase ??
			(mutation.kind === "close" ? true : undefined),
		// Whatever the mutation names, unless a test says otherwise: these
		// tests are about the envelope's other halves, and the committed-form
		// filter has its own coverage.
		usercaseWriteProperties:
			built?.usercaseWriteProperties ??
			new Set(Object.keys(mutation.usercase ?? {})),
		ordinaryChildRelationships,
		ordinaryCaseType,
		ordinarySelection,
		submissionReceipt:
			built?.submissionReceipt ??
			({
				entryKey: mutation.entryKey,
				formUuid: testUuid(mutation.formUuid),
				expectedAppMutationSeq: 0,
				blueprintDigest: FINAL_BLUEPRINT_DIGEST,
				requestDigest: `case-data-binding-request-${submissionEnvelopeReceiptSequence}`,
			} as const),
	});
}

function finalSubmissionDoc() {
	return buildDoc({
		appName: "Final submission protocol",
		modules: [
			{
				uuid: "10000000-0000-4000-8000-000000000003",
				name: "Module",
				forms: [
					{
						uuid: FINAL_FORM_UUID,
						name: "Form",
						type: "survey",
						fields: [],
					},
				],
			},
		],
	});
}

const FINAL_BLUEPRINT_DIGEST = canonicalJsonDigest(
	toPersistableDoc(finalSubmissionDoc()),
);

const ALICE_CASE_ID = "40000000-0000-0000-0000-000000000001";

const EMPTY_CASE_DATABASE_PATCH = { rows: [], indices: [] } as const;

function actionStore(overrides: Partial<CaseStore> = {}): CaseStore {
	return {
		query: appCaseQuery(),
		readDeviceCaseDatabase: vi.fn(async () => ({ rows: [], indices: [] })),
		readCaseDatabasePatch: vi.fn(async () => ({ rows: [], indices: [] })),
		queryGrouped: vi.fn(),
		count: vi.fn(),
		insert: vi.fn(),
		applySubmission: vi.fn(),
		update: vi.fn(),
		close: vi.fn(),
		traverse: vi.fn(),
		applySchemaChange: vi.fn(),
		unparkValues: vi.fn(),
		conversionImpact: vi.fn(),
		listParkedValues: vi.fn(),
		restoreParkedValues: vi.fn(),
		setParkedValuesDismissed: vi.fn(),
		replaceParkedValue: vi.fn(),
		generateSampleData: vi.fn(),
		resetSampleData: vi.fn(),
		...overrides,
	} satisfies CaseStore;
}

const VISIT_CASE_ID = "40000000-0000-0000-0000-000000000004";

const PATIENT_CASE_TYPE: CaseType = {
	name: "patient",
	properties: [{ name: "age", label: proseText("Age"), data_type: "int" }],
};

const VISIT_CASE_TYPE: CaseType = {
	name: "visit",
	parent_type: "patient",
	properties: [{ name: "notes", label: proseText("Notes"), data_type: "text" }],
};

const _HOUSEHOLD_CASE_TYPE: CaseType = {
	name: "household",
	properties: [{ name: "head_name", label: proseText("Head of household") }],
};

const FORMATTED_PROPS_CASE_TYPE: CaseType = {
	name: "patient",
	properties: [
		{ name: "age", label: proseText("Age"), data_type: "int" },
		{ name: "weight", label: proseText("Weight"), data_type: "decimal" },
		{ name: "dob", label: proseText("DOB"), data_type: "date" },
		{ name: "wake_time", label: proseText("Wake time"), data_type: "time" },
		{ name: "last_seen", label: proseText("Last seen"), data_type: "datetime" },
		{ name: "home_location", label: proseText("Home"), data_type: "geopoint" },
	],
};

function buildBlueprint(caseTypes: CaseType[]) {
	return buildSimpleBlueprint(caseTypes, APP_ID);
}

function buildSyntheticRow(properties: JsonObject): CaseRow {
	return {
		case_id: "test-id",
		app_id: APP_ID,
		case_type: "patient",
		owner_id: OWNER_A,
		status: "open",
		opened_on: null,
		modified_on: null,
		closed_on: null,
		case_name: "Synthetic Case",
		external_id: null,
		parent_case_id: null,
		properties,
	};
}

function makeCaseListConfig(
	overrides: Partial<CaseListConfig> = {},
): CaseListConfig {
	return resolveCaseListConfig({
		columns: [],
		searchInputs: [],
		...overrides,
	});
}

const NAME_COLUMN_UUID = testUuid("50000000-0000-0000-0000-000000000001");

describe("submitFormAction", () => {
	it("returns the unauthenticated arm when getSession resolves to null", async () => {
		const { getSession } = await import("@/lib/auth-utils");
		vi.mocked(getSession).mockResolvedValueOnce(null);

		const { submitFormAction } = await import("../caseDataBinding");
		const result = await submitFormAction(
			{ kind: "survey", ...FINAL_SUBMISSION_PROTOCOL },
			"app-anything",
			FINAL_BLUEPRINT_DIGEST,
		);
		expect(result).toEqual({ kind: "unauthenticated" });
	});

	it.each([
		[
			"a case-bearing submission without an entry key",
			{
				kind: "registration",
				formUuid: FINAL_FORM_UUID,
				attachmentRefs: [],
				primary: {
					caseType: "patient",
					caseName: "Must not land",
					properties: {},
				},
				children: [],
			},
		],
		[
			"a survey without a form UUID",
			{
				kind: "survey",
				entryKey: FINAL_ENTRY_KEY,
				attachmentRefs: [],
			},
		],
		[
			"a capture-capable survey without its exact attachment projection",
			{
				kind: "survey",
				formUuid: FINAL_FORM_UUID,
				entryKey: FINAL_ENTRY_KEY,
			},
		],
	])("rejects %s before authorization or effects", async (_label, payload) => {
		const { getSession } = await import("@/lib/auth-utils");
		const { withProjectContext } = await import("@/lib/case-store");
		const { submitFormAction } = await import("../caseDataBinding");

		await expect(
			submitFormAction(
				payload as unknown as SubmissionMutation,
				APP_ID,
				FINAL_BLUEPRINT_DIGEST,
			),
		).resolves.toMatchObject({
			kind: "error",
			message: expect.stringContaining("requires a valid form identity"),
		});
		expect(getSession).not.toHaveBeenCalled();
		expect(withProjectContext).not.toHaveBeenCalled();
		expect(loadAuthorizedFormSubmissionSnapshotMock).not.toHaveBeenCalled();
		expect(prepareCaptureSubmissionBytesMock).not.toHaveBeenCalled();
		expect(loadAppMock).not.toHaveBeenCalled();
	});

	it("rejects the retired attachmentNames-only payload instead of digesting it as compatibility data", async () => {
		const { getSession } = await import("@/lib/auth-utils");
		const { submitFormAction } = await import("../caseDataBinding");
		const oldPayload = {
			kind: "survey",
			formUuid: FINAL_FORM_UUID,
			entryKey: FINAL_ENTRY_KEY,
			attachmentNames: ["legacy.jpg"],
		};

		await expect(
			submitFormAction(
				oldPayload as unknown as SubmissionMutation,
				APP_ID,
				FINAL_BLUEPRINT_DIGEST,
			),
		).resolves.toEqual({
			kind: "error",
			message: "The retired attachmentNames submission field is not accepted.",
		});
		expect(getSession).not.toHaveBeenCalled();
		expect(loadAuthorizedFormSubmissionSnapshotMock).not.toHaveBeenCalled();
	});

	it("routes an effect-free survey through the receipt adjudication envelope", async () => {
		const { getSession } = await import("@/lib/auth-utils");
		const { withProjectContext } = await import("@/lib/case-store");
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: OWNER_A },
			// The action only reads `session.user.id`; the rest of the
			// shape is irrelevant for this assertion. Cast through
			// `unknown` because Better Auth's `Session` type carries
			// many fields we don't synthesize.
		} as unknown as Awaited<ReturnType<typeof getSession>>);
		// Even without effects or current capture fields, the envelope must
		// recheck a receipt that could have committed between the action
		// snapshot and this transaction.
		const stubStore = {
			...actionStore(),
			query: appCaseQuery(),
			queryGrouped: vi.fn(),
			count: vi.fn(),
			insert: vi.fn(),
			applySubmission: vi.fn().mockResolvedValue({
				primaryCaseIds: [],
				createdChildren: [],
				operations: [],
				blueprintDigest: FINAL_BLUEPRINT_DIGEST,
				caseDatabasePatch: EMPTY_CASE_DATABASE_PATCH,
			}),
			update: vi.fn(),
			close: vi.fn(),
			traverse: vi.fn(),
			applySchemaChange: vi.fn(),
			unparkValues: vi.fn(),
			conversionImpact: vi.fn(),
			listParkedValues: vi.fn(),
			restoreParkedValues: vi.fn(),
			setParkedValuesDismissed: vi.fn(),
			replaceParkedValue: vi.fn(),
			generateSampleData: vi.fn(),
			resetSampleData: vi.fn(),
		} satisfies CaseStore;
		vi.mocked(withProjectContext).mockResolvedValueOnce(stubStore);

		const { submitFormAction } = await import("../caseDataBinding");
		const result = await submitFormAction(
			{ kind: "survey", ...FINAL_SUBMISSION_PROTOCOL },
			APP_ID,
			FINAL_BLUEPRINT_DIGEST,
		);
		expect(result).toEqual({
			kind: "survey",
			caseDatabasePatch: EMPTY_CASE_DATABASE_PATCH,
		});
		expect(vi.mocked(withProjectContext)).toHaveBeenCalledOnce();
		expect(loadAuthorizedFormSubmissionSnapshotMock).toHaveBeenCalledWith({
			appId: APP_ID,
			actorUserId: OWNER_A,
			entryKey: FINAL_ENTRY_KEY,
		});
		expect(stubStore.applySubmission).toHaveBeenCalledWith({
			appId: APP_ID,
			ordinary: { kind: "none" },
			submissionReceipt: {
				entryKey: FINAL_ENTRY_KEY,
				formUuid: FINAL_FORM_UUID,
				expectedAppMutationSeq: 1,
				blueprintDigest: FINAL_BLUEPRINT_DIGEST,
				requestDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
			},
		});
		for (const [name, method] of Object.entries(stubStore)) {
			if (name !== "applySubmission" && name !== "readCaseDatabasePatch") {
				expect(method).not.toHaveBeenCalled();
			}
		}
	});

	it("refuses a new submission when the committed blueprint differs from the client revision", async () => {
		const { getSession } = await import("@/lib/auth-utils");
		const { withProjectContext } = await import("@/lib/case-store");
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: OWNER_A },
		} as unknown as Awaited<ReturnType<typeof getSession>>);

		const { submitFormAction } = await import("../caseDataBinding");
		await expect(
			submitFormAction(
				{ kind: "survey", ...FINAL_SUBMISSION_PROTOCOL },
				APP_ID,
				"0".repeat(64),
			),
		).resolves.toEqual({
			kind: "blueprint-changed",
			message:
				"This app changed before the form could submit. Wait for it to finish saving, then try again.",
		});
		expect(withProjectContext).not.toHaveBeenCalled();
		expect(prepareCaptureSubmissionBytesMock).not.toHaveBeenCalled();
	});

	it("translates a CaseNotFoundError thrown by the envelope to the case-not-found arm", async () => {
		// The Server Action's catch block delegates to
		// `mapSubmitFormError`; pin that delegation via a stub store
		// whose `applySubmission` throws the typed error.
		const { getSession } = await import("@/lib/auth-utils");
		const { withProjectContext } = await import("@/lib/case-store");
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: OWNER_A },
		} as unknown as Awaited<ReturnType<typeof getSession>>);
		const stubStore = {
			...actionStore(),
			query: appCaseQuery(),
			queryGrouped: vi.fn(),
			count: vi.fn(),
			insert: vi.fn(),
			applySubmission: vi
				.fn()
				.mockRejectedValueOnce(new CaseNotFoundError(ALICE_CASE_ID)),
			update: vi.fn(),
			close: vi.fn(),
			traverse: vi.fn(),
			applySchemaChange: vi.fn(),
			unparkValues: vi.fn(),
			conversionImpact: vi.fn(),
			listParkedValues: vi.fn(),
			restoreParkedValues: vi.fn(),
			setParkedValuesDismissed: vi.fn(),
			replaceParkedValue: vi.fn(),
			generateSampleData: vi.fn(),
			resetSampleData: vi.fn(),
		} satisfies CaseStore;
		vi.mocked(withProjectContext).mockResolvedValueOnce(stubStore);
		const committedBlueprint = buildDoc({
			appName: "Case-bearing error action",
			caseTypes: [PATIENT_CASE_TYPE],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [
						{
							uuid: FINAL_FORM_UUID,
							name: "Follow up patient",
							type: "followup",
							fields: [
								f({
									kind: "int",
									id: "age",
									caseWrite: { caseType: "patient", property: "age" },
								}),
							],
						},
					],
				},
			],
		});
		loadAuthorizedFormSubmissionSnapshotMock.mockResolvedValueOnce({
			kind: "current",
			projectId: PROJECT_A,
			app: {
				blueprint: committedBlueprint,
				mutation_seq: 1,
				project_id: PROJECT_A,
			},
		});

		const { submitFormAction } = await import("../caseDataBinding");
		const result = await submitFormAction(
			{
				kind: "followup",
				...FINAL_SUBMISSION_PROTOCOL,
				caseIds: [ALICE_CASE_ID],
				patch: { properties: { age: 31 } },
				children: [],
			},
			APP_ID,
			canonicalJsonDigest(toPersistableDoc(committedBlueprint)),
		);
		expect(result).toEqual({
			kind: "case-not-found",
			caseId: ALICE_CASE_ID,
		});
	});

	it("routes a case-bearing submission through applySubmission and maps the envelope result to the matching arm", async () => {
		// The new wiring: the action projects the mutation via
		// `submissionEnvelopeArgs` and hands it to `store.applySubmission`,
		// then maps the `SubmissionEnvelopeResult`'s `primaryCaseIds` +
		// structured created-child receipt onto the mutation-kind result arm.
		const { getSession } = await import("@/lib/auth-utils");
		const { withProjectContext } = await import("@/lib/case-store");
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: OWNER_A },
		} as unknown as Awaited<ReturnType<typeof getSession>>);
		const stubStore = {
			...actionStore(),
			query: appCaseQuery(),
			queryGrouped: vi.fn(),
			count: vi.fn(),
			insert: vi.fn(),
			applySubmission: vi.fn().mockImplementationOnce(async (args) => ({
				primaryCaseIds: [ALICE_CASE_ID],
				createdChildren: [
					{
						authoredChildIndex: 0,
						parentCaseId: ALICE_CASE_ID,
						caseId: VISIT_CASE_ID,
					},
				],
				operations: [],
				blueprintDigest: args.submissionReceipt.blueprintDigest,
				caseDatabasePatch: EMPTY_CASE_DATABASE_PATCH,
			})),
			update: vi.fn(),
			close: vi.fn(),
			traverse: vi.fn(),
			applySchemaChange: vi.fn(),
			unparkValues: vi.fn(),
			conversionImpact: vi.fn(),
			listParkedValues: vi.fn(),
			restoreParkedValues: vi.fn(),
			setParkedValuesDismissed: vi.fn(),
			replaceParkedValue: vi.fn(),
			generateSampleData: vi.fn(),
			resetSampleData: vi.fn(),
		} satisfies CaseStore;
		vi.mocked(withProjectContext).mockResolvedValueOnce(stubStore);

		const mutation: SubmissionMutation = {
			kind: "registration",
			...FINAL_SUBMISSION_PROTOCOL,
			primary: {
				caseType: "patient",
				caseName: "Alice",
				properties: { age: 30 },
			},
			children: [
				{
					caseType: "visit",
					caseName: "First visit",
					properties: { notes: "checkup" },
				},
			],
			ordinaryChildBuckets: [{ caseType: "visit" }],
		};
		const committedBlueprint = buildDoc({
			appName: "Case-bearing action",
			caseTypes: [PATIENT_CASE_TYPE, VISIT_CASE_TYPE],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [
						{
							uuid: FINAL_FORM_UUID,
							name: "Register patient",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "patient_name",
									caseWrite: {
										caseType: "patient",
										property: "case_name",
									},
								}),
								f({
									kind: "int",
									id: "age",
									caseWrite: { caseType: "patient", property: "age" },
								}),
								f({
									kind: "text",
									id: "visit_name",
									caseWrite: { caseType: "visit", property: "case_name" },
								}),
								f({
									kind: "text",
									id: "visit_notes",
									caseWrite: { caseType: "visit", property: "notes" },
								}),
							],
						},
					],
				},
			],
		});
		loadAuthorizedFormSubmissionSnapshotMock.mockResolvedValueOnce({
			kind: "current",
			projectId: PROJECT_A,
			app: {
				blueprint: committedBlueprint,
				mutation_seq: 1,
				project_id: PROJECT_A,
			},
		});

		const { submitFormAction } = await import("../caseDataBinding");
		const result = await submitFormAction(
			mutation,
			APP_ID,
			canonicalJsonDigest(toPersistableDoc(committedBlueprint)),
		);

		// The store saw exactly the pure projection of the mutation.
		expect(stubStore.applySubmission).toHaveBeenCalledWith({
			...submissionEnvelopeArgs(mutation, APP_ID),
			submissionReceipt: {
				entryKey: FINAL_ENTRY_KEY,
				formUuid: FINAL_FORM_UUID,
				expectedAppMutationSeq: 1,
				blueprintDigest: canonicalJsonDigest(
					toPersistableDoc(committedBlueprint),
				),
				requestDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
			},
		});
		// The envelope result mapped onto the registration arm.
		expect(result).toEqual({
			kind: "registration",
			caseId: ALICE_CASE_ID,
			childCaseIds: [VISIT_CASE_ID],
			createdChildren: [
				{
					authoredChildIndex: 0,
					parentCaseId: ALICE_CASE_ID,
					caseId: VISIT_CASE_ID,
				},
			],
			caseDatabasePatch: EMPTY_CASE_DATABASE_PATCH,
		});
	});

	it("normalizes a pre-deploy scalar case request while preserving its receipt identity and response aliases", async () => {
		const { getSession } = await import("@/lib/auth-utils");
		const { withProjectContext } = await import("@/lib/case-store");
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: OWNER_A },
		} as unknown as Awaited<ReturnType<typeof getSession>>);
		const committedBlueprint = buildDoc({
			appName: "Open followup tab",
			caseTypes: [PATIENT_CASE_TYPE],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [
						{
							uuid: FINAL_FORM_UUID,
							name: "Follow up patient",
							type: "followup",
							fields: [],
						},
					],
				},
			],
		});
		const blueprintDigest = canonicalJsonDigest(
			toPersistableDoc(committedBlueprint),
		);
		loadAuthorizedFormSubmissionSnapshotMock.mockResolvedValueOnce({
			kind: "current",
			projectId: PROJECT_A,
			app: {
				blueprint: committedBlueprint,
				mutation_seq: 1,
				project_id: PROJECT_A,
			},
		});
		const applySubmission = vi.fn().mockResolvedValueOnce({
			primaryCaseIds: [ALICE_CASE_ID],
			createdChildren: [],
			operations: [],
			blueprintDigest,
			caseDatabasePatch: EMPTY_CASE_DATABASE_PATCH,
		});
		vi.mocked(withProjectContext).mockResolvedValueOnce(
			actionStore({ applySubmission }),
		);
		const mutation: SubmissionWireMutation = {
			kind: "followup",
			...FINAL_SUBMISSION_PROTOCOL,
			caseId: ALICE_CASE_ID,
			patch: { properties: {} },
			children: [],
		};
		const replayIdentity = previewAsMe({ id: OWNER_A });
		if (replayIdentity === null) throw new Error("Expected replay identity.");
		const legacyReceipt = buildSubmissionReceiptIdentity({
			appId: APP_ID,
			identity: replayIdentity,
			mutation,
			projection: validateCaptureSubmissionProjection(mutation),
		});

		const { submitFormAction } = await import("../caseDataBinding");
		await expect(
			submitFormAction(
				mutation as unknown as SubmissionMutation,
				APP_ID,
				blueprintDigest,
			),
		).resolves.toEqual({
			kind: "followup",
			caseIds: [ALICE_CASE_ID],
			caseId: ALICE_CASE_ID,
			childCaseIds: [],
			createdChildren: [],
			caseDatabasePatch: EMPTY_CASE_DATABASE_PATCH,
		});
		expect(applySubmission).toHaveBeenCalledWith({
			appId: APP_ID,
			ordinary: {
				kind: "followup",
				caseIds: [ALICE_CASE_ID],
				caseType: "patient",
				selection: { kind: "single", maximum: 1 },
				patch: { properties: {} },
				children: [],
			},
			submissionReceipt: {
				entryKey: FINAL_ENTRY_KEY,
				formUuid: FINAL_FORM_UUID,
				expectedAppMutationSeq: 1,
				blueprintDigest,
				requestDigest: legacyReceipt.requestDigest,
			},
		});
	});

	it("replays a pre-deploy scalar case receipt with both old and new result contracts", async () => {
		const { getSession } = await import("@/lib/auth-utils");
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: OWNER_A },
		} as unknown as Awaited<ReturnType<typeof getSession>>);
		const mutation: SubmissionWireMutation = {
			kind: "close",
			...FINAL_SUBMISSION_PROTOCOL,
			caseId: ALICE_CASE_ID,
			patch: { properties: {} },
			children: [],
		};
		const replayIdentity = previewAsMe({ id: OWNER_A });
		if (replayIdentity === null) throw new Error("Expected replay identity.");
		const receipt = buildSubmissionReceiptIdentity({
			appId: APP_ID,
			identity: replayIdentity,
			mutation,
			projection: validateCaptureSubmissionProjection(mutation),
		});
		loadAuthorizedFormSubmissionSnapshotMock.mockResolvedValueOnce({
			kind: "replay",
			projectId: PROJECT_A,
			receipt: {
				formUuid: FINAL_FORM_UUID,
				requestDigest: receipt.requestDigest,
				result: {
					primaryCaseId: ALICE_CASE_ID,
					childCaseIds: [VISIT_CASE_ID],
					operations: [],
					blueprintDigest: FINAL_BLUEPRINT_DIGEST,
					caseDatabasePatch: EMPTY_CASE_DATABASE_PATCH,
				},
			},
		});

		const { submitFormAction } = await import("../caseDataBinding");
		await expect(
			submitFormAction(
				mutation as unknown as SubmissionMutation,
				APP_ID,
				FINAL_BLUEPRINT_DIGEST,
			),
		).resolves.toEqual({
			kind: "close",
			caseIds: [ALICE_CASE_ID],
			caseId: ALICE_CASE_ID,
			childCaseIds: [VISIT_CASE_ID],
			caseDatabasePatch: EMPTY_CASE_DATABASE_PATCH,
		});
		expect(prepareCaptureSubmissionBytesMock).not.toHaveBeenCalled();
	});

	/**
	 * The persona has to reach the WRITE, not only the reads.
	 *
	 * A persona's uuid IS its CommCare owner id, so it is what
	 * `owner_id` carries on every case a submission creates
	 * (`PostgresCaseStore` stamps that from the store's bound worker).
	 * Dropping the argument at this one call site would leave every read
	 * persona-scoped and every written row owned by the signed-in member
	 * — a divergence nothing that only reads could notice. The store
	 * construction is the seam that fact travels through, so that is what
	 * this asserts, along with the half that must NOT move: authorization
	 * stays keyed on the member.
	 */
	it("stamps the persona as the owner of what a submission writes, while the member still authorizes", async () => {
		const PERSONA = testUuid("aa000000-0000-4000-8000-00000000000a");
		const { getSession } = await import("@/lib/auth-utils");
		const { withProjectContext } = await import("@/lib/case-store");
		vi.mocked(getSession).mockResolvedValue({
			user: { id: OWNER_A },
		} as unknown as Awaited<ReturnType<typeof getSession>>);

		const doc = finalSubmissionDoc();
		doc.personas = {
			[PERSONA]: { uuid: PERSONA, name: "Asha" },
		};
		loadAuthorizedFormSubmissionSnapshotMock.mockResolvedValue({
			kind: "current",
			projectId: PROJECT_A,
			app: {
				blueprint: doc,
				mutation_seq: 1,
				project_id: PROJECT_A,
			},
		});

		const stubStore = {
			...actionStore(),
			query: appCaseQuery(),
			queryGrouped: vi.fn(),
			count: vi.fn(),
			insert: vi.fn(),
			applySubmission: vi.fn().mockResolvedValue({
				primaryCaseIds: [ALICE_CASE_ID],
				createdChildren: [],
				operations: [],
				blueprintDigest: canonicalJsonDigest(toPersistableDoc(doc)),
			}),
			update: vi.fn(),
			close: vi.fn(),
			traverse: vi.fn(),
			applySchemaChange: vi.fn(),
			unparkValues: vi.fn(),
			conversionImpact: vi.fn(),
			listParkedValues: vi.fn(),
			restoreParkedValues: vi.fn(),
			setParkedValuesDismissed: vi.fn(),
			replaceParkedValue: vi.fn(),
			generateSampleData: vi.fn(),
			resetSampleData: vi.fn(),
		} satisfies CaseStore;
		vi.mocked(withProjectContext).mockResolvedValue(stubStore);

		const mutation: SubmissionMutation = {
			kind: "registration",
			...FINAL_SUBMISSION_PROTOCOL,
			primary: {
				caseType: "patient",
				caseName: "Alice",
				properties: {},
			},
			children: [],
		};

		const { submitFormAction } = await import("../caseDataBinding");
		await submitFormAction(
			mutation,
			APP_ID,
			canonicalJsonDigest(toPersistableDoc(doc)),
			undefined,
			PERSONA,
		);

		// The store's WORKER is the persona — the third argument is the
		// `owner_id` every inserted row carries.
		expect(vi.mocked(withProjectContext)).toHaveBeenCalledWith(
			PROJECT_A,
			OWNER_A,
			PERSONA,
		);
		// …and the membership gate still ran against the signed-in member.
		// A persona is authored blueprint content and must never authorize.
		expect(loadAuthorizedFormSubmissionSnapshotMock).toHaveBeenCalledWith({
			appId: APP_ID,
			actorUserId: OWNER_A,
			entryKey: FINAL_ENTRY_KEY,
		});
		expect(resolveAppScopeMock).toHaveBeenCalledWith(APP_ID, OWNER_A, "edit");
	});

	it("keeps the member as both actor and owner when no persona is selected", async () => {
		const { getSession } = await import("@/lib/auth-utils");
		const { withProjectContext } = await import("@/lib/case-store");
		vi.mocked(getSession).mockResolvedValue({
			user: { id: OWNER_A },
		} as unknown as Awaited<ReturnType<typeof getSession>>);

		const stubStore = {
			...actionStore(),
			query: appCaseQuery(),
			queryGrouped: vi.fn(),
			count: vi.fn(),
			insert: vi.fn(),
			applySubmission: vi.fn().mockResolvedValue({
				primaryCaseIds: [ALICE_CASE_ID],
				createdChildren: [],
				operations: [],
				blueprintDigest: FINAL_BLUEPRINT_DIGEST,
			}),
			update: vi.fn(),
			close: vi.fn(),
			traverse: vi.fn(),
			applySchemaChange: vi.fn(),
			unparkValues: vi.fn(),
			conversionImpact: vi.fn(),
			listParkedValues: vi.fn(),
			restoreParkedValues: vi.fn(),
			setParkedValuesDismissed: vi.fn(),
			replaceParkedValue: vi.fn(),
			generateSampleData: vi.fn(),
			resetSampleData: vi.fn(),
		} satisfies CaseStore;
		vi.mocked(withProjectContext).mockResolvedValue(stubStore);

		const { submitFormAction } = await import("../caseDataBinding");
		await submitFormAction(
			{
				kind: "registration",
				...FINAL_SUBMISSION_PROTOCOL,
				primary: {
					caseType: "patient",
					caseName: "Alice",
					properties: {},
				},
				children: [],
			},
			APP_ID,
			FINAL_BLUEPRINT_DIGEST,
		);

		expect(vi.mocked(withProjectContext)).toHaveBeenCalledWith(
			PROJECT_A,
			OWNER_A,
			OWNER_A,
		);
		expect(loadAuthorizedFormSubmissionSnapshotMock).toHaveBeenCalledOnce();
	});

	it("refuses a stale persona selector instead of silently submitting as the member", async () => {
		const { getSession } = await import("@/lib/auth-utils");
		const { withProjectContext } = await import("@/lib/case-store");
		vi.mocked(getSession).mockResolvedValue({
			user: { id: OWNER_A },
		} as unknown as Awaited<ReturnType<typeof getSession>>);
		loadAuthorizedFormSubmissionSnapshotMock.mockResolvedValue({
			kind: "current",
			projectId: PROJECT_A,
			app: {
				blueprint: finalSubmissionDoc(),
				mutation_seq: 1,
				project_id: PROJECT_A,
			},
		});

		const { submitFormAction } = await import("../caseDataBinding");
		const result = await submitFormAction(
			{
				kind: "registration",
				...FINAL_SUBMISSION_PROTOCOL,
				primary: {
					caseType: "patient",
					caseName: "Alice",
					properties: {},
				},
				children: [],
			},
			APP_ID,
			FINAL_BLUEPRINT_DIGEST,
			undefined,
			"removed-persona",
		);

		expect(result).toEqual({
			kind: "persona-unavailable",
			message:
				"The selected preview persona is no longer available. Choose another worker and try again.",
		});
		expect(loadAuthorizedFormSubmissionSnapshotMock).toHaveBeenCalledWith({
			appId: APP_ID,
			actorUserId: OWNER_A,
			entryKey: FINAL_ENTRY_KEY,
		});
		expect(resolveAppScopeMock).not.toHaveBeenCalled();
		expect(loadAppMock).not.toHaveBeenCalled();
		expect(vi.mocked(withProjectContext)).not.toHaveBeenCalled();
	});

	// ---------------------------------------------------------------
	// The case-operation program path: authorization ordering. The
	// committed doc comes from the one locked authorized-app snapshot; the
	// pure program builder consumes that snapshot without loading again.
	// ---------------------------------------------------------------

	/** A survey form carrying one root create operation. */
	function operationSurveyDoc(options?: { lookupCondition?: boolean }) {
		const doc = buildDoc({
			appName: "Ops survey",
			caseTypes: [
				{
					name: "patient",
					properties: [
						{
							name: "visit_note",
							label: proseText("Visit note"),
							data_type: "text",
						},
					],
				},
			],
			modules: [
				{
					uuid: "70000000-0000-4000-8000-00000000b010",
					name: "Mod",
					caseType: "patient",
					forms: [
						{
							uuid: "70000000-0000-4000-8000-00000000b011",
							name: "Survey",
							type: "survey",
							fields: [
								f({
									uuid: "70000000-0000-4000-8000-00000000b012",
									kind: "text",
									id: "note",
									label: proseText("Note"),
								}),
							],
						},
					],
				},
			],
		});
		const formUuid = Object.keys(doc.forms)[0] as Uuid;
		const noteUuid = Object.values(doc.fields).find(
			(field) => field.id === "note",
		)?.uuid as Uuid;
		const form = doc.forms[formUuid];
		const operation = {
			uuid: testUuid("70000000-0000-7000-8000-00000000b001"),
			id: "op_note",
			action: "create",
			caseType: "patient",
			target: { kind: "new" },
			name: term(formField(noteUuid)),
			...(options?.lookupCondition === true && {
				condition: eq(
					tableLookup(
						OPERATION_LOOKUP_TABLE,
						OPERATION_LOOKUP_COLUMN,
						eq(
							tableColumn(OPERATION_LOOKUP_TABLE, OPERATION_LOOKUP_COLUMN),
							literal("enabled"),
						),
					),
					literal("enabled"),
				),
			}),
			writes: [{ property: "visit_note", value: term(formField(noteUuid)) }],
		} as CaseOperation;
		return {
			doc: {
				...doc,
				forms: {
					...doc.forms,
					[formUuid]: { ...form, caseOperations: [operation] },
				},
			},
			formUuid,
			noteUuid,
		};
	}

	function stubCaseStore(
		applySubmission: CaseStore["applySubmission"] = vi.fn(),
	): CaseStore {
		return {
			query: appCaseQuery(),
			readDeviceCaseDatabase: vi.fn(async () => ({ rows: [], indices: [] })),
			readCaseDatabasePatch: vi.fn(async () => ({ rows: [], indices: [] })),
			queryGrouped: vi.fn(),
			count: vi.fn(),
			insert: vi.fn(),
			applySubmission,
			update: vi.fn(),
			close: vi.fn(),
			traverse: vi.fn(),
			applySchemaChange: vi.fn(),
			unparkValues: vi.fn(),
			conversionImpact: vi.fn(),
			listParkedValues: vi.fn(),
			restoreParkedValues: vi.fn(),
			setParkedValuesDismissed: vi.fn(),
			replaceParkedValue: vi.fn(),
			generateSampleData: vi.fn(),
			resetSampleData: vi.fn(),
		} satisfies CaseStore;
	}

	it("collapses authorization-snapshot denial to the IDOR-safe not-found arm", async () => {
		const { AppAccessError } = await import("@/lib/db/appAccess");
		const { getSession } = await import("@/lib/auth-utils");
		const { withProjectContext } = await import("@/lib/case-store");
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: OWNER_A },
		} as unknown as Awaited<ReturnType<typeof getSession>>);
		loadAuthorizedFormSubmissionSnapshotMock.mockRejectedValueOnce(
			new AppAccessError("not_member"),
		);

		const { submitFormAction } = await import("../caseDataBinding");
		await expect(
			submitFormAction(
				{ kind: "survey", ...FINAL_SUBMISSION_PROTOCOL },
				APP_ID,
				FINAL_BLUEPRINT_DIGEST,
			),
		).resolves.toEqual({ kind: "error", message: "App not found." });
		expect(withProjectContext).not.toHaveBeenCalled();
		expect(prepareCaptureSubmissionBytesMock).not.toHaveBeenCalled();
	});

	it("rejects a missing committed form after an authorized replay miss", async () => {
		const { getSession } = await import("@/lib/auth-utils");
		const { withProjectContext } = await import("@/lib/case-store");
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: OWNER_A },
		} as unknown as Awaited<ReturnType<typeof getSession>>);
		const applySubmission = vi.fn();
		vi.mocked(withProjectContext).mockResolvedValueOnce(
			stubCaseStore(applySubmission),
		);
		loadAuthorizedFormSubmissionSnapshotMock.mockResolvedValueOnce({
			kind: "current",
			projectId: PROJECT_A,
			app: {
				blueprint: buildDoc({ appName: "Submitted form deleted" }),
				mutation_seq: 2,
				project_id: PROJECT_A,
			},
		});

		const { submitFormAction } = await import("../caseDataBinding");
		await expect(
			submitFormAction(
				{ kind: "survey", ...FINAL_SUBMISSION_PROTOCOL },
				APP_ID,
				canonicalJsonDigest(
					toPersistableDoc(buildDoc({ appName: "Submitted form deleted" })),
				),
			),
		).resolves.toMatchObject({
			kind: "error",
			message: expect.stringContaining("no longer exists"),
		});
		expect(loadAuthorizedFormSubmissionSnapshotMock).toHaveBeenCalledOnce();
		expect(applySubmission).not.toHaveBeenCalled();
		expect(prepareCaptureSubmissionBytesMock).not.toHaveBeenCalled();
	});

	it("rejects operation-bearing skew without applying a survey envelope", async () => {
		const { getSession } = await import("@/lib/auth-utils");
		const { withProjectContext } = await import("@/lib/case-store");
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: OWNER_A },
		} as unknown as Awaited<ReturnType<typeof getSession>>);
		const { doc, formUuid } = operationSurveyDoc();
		loadAuthorizedFormSubmissionSnapshotMock.mockResolvedValueOnce({
			kind: "current",
			projectId: PROJECT_A,
			app: {
				blueprint: doc,
				mutation_seq: 2,
				project_id: PROJECT_A,
			},
		});
		const applySubmission = vi.fn();
		vi.mocked(withProjectContext).mockResolvedValueOnce(
			stubCaseStore(applySubmission),
		);

		const { submitFormAction } = await import("../caseDataBinding");
		await expect(
			submitFormAction(
				{
					kind: "survey",
					formUuid,
					entryKey: FINAL_ENTRY_KEY,
					attachmentRefs: [],
				},
				APP_ID,
				canonicalJsonDigest(toPersistableDoc(doc)),
			),
		).resolves.toMatchObject({
			kind: "error",
			message: expect.stringContaining(
				"missing answers required by its committed case operations",
			),
		});
		expect(applySubmission).not.toHaveBeenCalled();
	});

	it("builds the program only after membership passes and returns the survey arm from an executed program", async () => {
		const { getSession } = await import("@/lib/auth-utils");
		const { withProjectContext } = await import("@/lib/case-store");
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: OWNER_A },
		} as unknown as Awaited<ReturnType<typeof getSession>>);
		const { doc, formUuid, noteUuid } = operationSurveyDoc();
		loadAuthorizedFormSubmissionSnapshotMock.mockResolvedValue({
			kind: "current",
			projectId: PROJECT_A,
			app: {
				blueprint: doc,
				mutation_seq: 2,
				project_id: PROJECT_A,
			},
		});
		const applySubmission = vi.fn().mockResolvedValueOnce({
			primaryCaseIds: [],
			createdChildren: [],
			operations: [{ operationUuid: "op", iteration: 0, executed: true }],
			blueprintDigest: canonicalJsonDigest(toPersistableDoc(doc)),
			caseDatabasePatch: EMPTY_CASE_DATABASE_PATCH,
		});
		vi.mocked(withProjectContext).mockResolvedValueOnce(
			stubCaseStore(applySubmission),
		);

		const { submitFormAction } = await import("../caseDataBinding");
		const result = await submitFormAction(
			{
				kind: "survey",
				formUuid,
				entryKey: FINAL_ENTRY_KEY,
				attachmentRefs: [],
				operationAnswers: {
					root: [{ fieldUuid: noteUuid, value: "first" }],
					repeats: [],
				},
			},
			APP_ID,
			canonicalJsonDigest(toPersistableDoc(doc)),
		);
		// The survey arm returns WITHOUT the primaryCaseIds invariant —
		// an operations-bearing survey has no primary case.
		expect(result).toEqual({
			kind: "survey",
			caseDatabasePatch: EMPTY_CASE_DATABASE_PATCH,
		});
		// The envelope carried the server-built program over ordinary "none".
		const envelope = applySubmission.mock.calls[0]?.[0];
		expect(envelope.ordinary).toEqual({ kind: "none" });
		expect(envelope.operations?.formUuid).toBe(formUuid);
		expect(envelope.operations?.operations).toHaveLength(1);
		expect(envelope.operations?.lookupTableSchemas).toBeUndefined();
		// Carrier-free operation programs keep the common path read-free.
		expect(getLookupDefinitionsMock).not.toHaveBeenCalled();
		// The authorized snapshot is established before the store opens its
		// fresh mutation-boundary membership gate.
		expect(
			loadAuthorizedFormSubmissionSnapshotMock.mock.invocationCallOrder[0],
		).toBeLessThan(resolveAppScopeMock.mock.invocationCallOrder[0] ?? Infinity);
	});

	it("loads the exact Project-scoped definitions once and attaches them to the submitted program", async () => {
		const { getSession } = await import("@/lib/auth-utils");
		const { withProjectContext } = await import("@/lib/case-store");
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: OWNER_A },
		} as unknown as Awaited<ReturnType<typeof getSession>>);
		const { doc, formUuid, noteUuid } = operationSurveyDoc({
			lookupCondition: true,
		});
		loadAuthorizedFormSubmissionSnapshotMock.mockResolvedValue({
			kind: "current",
			projectId: PROJECT_A,
			app: {
				blueprint: doc,
				mutation_seq: 2,
				project_id: PROJECT_A,
			},
		});
		getLookupDefinitionsMock.mockResolvedValueOnce({
			projectId: PROJECT_A,
			projectRevision: "1",
			definitions: [
				{
					id: OPERATION_LOOKUP_TABLE,
					name: "Status",
					tag: "status",
					definitionRevision: "1",
					columns: [
						{
							id: OPERATION_LOOKUP_COLUMN,
							wireName: "status",
							label: "Status",
							dataType: "text",
						},
					],
				},
			],
		});
		const applySubmission = vi.fn().mockResolvedValueOnce({
			primaryCaseIds: [],
			createdChildren: [],
			operations: [],
			blueprintDigest: canonicalJsonDigest(toPersistableDoc(doc)),
			caseDatabasePatch: EMPTY_CASE_DATABASE_PATCH,
		});
		vi.mocked(withProjectContext).mockResolvedValueOnce(
			stubCaseStore(applySubmission),
		);

		const { submitFormAction } = await import("../caseDataBinding");
		expect(
			await submitFormAction(
				{
					kind: "survey",
					formUuid,
					entryKey: FINAL_ENTRY_KEY,
					attachmentRefs: [],
					operationAnswers: {
						root: [{ fieldUuid: noteUuid, value: "first" }],
						repeats: [],
					},
				},
				APP_ID,
				canonicalJsonDigest(toPersistableDoc(doc)),
			),
		).toEqual({
			kind: "survey",
			caseDatabasePatch: EMPTY_CASE_DATABASE_PATCH,
		});

		// Exactly the tables the program's own operations reference, read once
		// under the same Project scope the membership gate resolved.
		expect(getLookupDefinitionsMock).toHaveBeenCalledTimes(1);
		expect(getLookupDefinitionsMock).toHaveBeenCalledWith(
			{ projectId: PROJECT_A, actorId: OWNER_A, role: "owner" },
			[OPERATION_LOOKUP_TABLE],
		);
		const envelope = applySubmission.mock.calls[0]?.[0];
		expect(
			envelope.operations?.lookupTableSchemas
				?.get(OPERATION_LOOKUP_TABLE)
				?.get(OPERATION_LOOKUP_COLUMN),
		).toBe("text");

		// Authorized snapshot, then definitions, then the apply — the
		// definition read must never precede the membership proof.
		const snapshotOrder =
			loadAuthorizedFormSubmissionSnapshotMock.mock.invocationCallOrder[0];
		const definitionsReadOrder =
			getLookupDefinitionsMock.mock.invocationCallOrder[0];
		const applyOrder = applySubmission.mock.invocationCallOrder[0];
		expect(snapshotOrder).toBeLessThan(definitionsReadOrder);
		expect(definitionsReadOrder).toBeLessThan(applyOrder);
	});

	it("keeps one lookup-schema map on the same envelope across a schema-heal retry", async () => {
		const { getSession } = await import("@/lib/auth-utils");
		const { withProjectContext } = await import("@/lib/case-store");
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: OWNER_A },
		} as unknown as Awaited<ReturnType<typeof getSession>>);
		const { doc, formUuid, noteUuid } = operationSurveyDoc({
			lookupCondition: true,
		});
		loadAuthorizedFormSubmissionSnapshotMock.mockResolvedValue({
			kind: "current",
			projectId: PROJECT_A,
			app: {
				blueprint: doc,
				mutation_seq: 8,
				project_id: PROJECT_A,
			},
		});
		getLookupDefinitionsMock.mockResolvedValueOnce({
			projectId: PROJECT_A,
			projectRevision: "1",
			definitions: [
				{
					id: OPERATION_LOOKUP_TABLE,
					name: "Status",
					tag: "status",
					definitionRevision: "1",
					columns: [
						{
							id: OPERATION_LOOKUP_COLUMN,
							wireName: "status",
							label: "Status",
							dataType: "text",
						},
					],
				},
			],
		});
		materializeMock.mockResolvedValueOnce(undefined);
		const applySubmission = vi
			.fn()
			.mockRejectedValueOnce(new SchemaNotSyncedError(APP_ID, "patient"))
			.mockResolvedValueOnce({
				primaryCaseIds: [],
				createdChildren: [],
				operations: [],
				blueprintDigest: canonicalJsonDigest(toPersistableDoc(doc)),
				caseDatabasePatch: EMPTY_CASE_DATABASE_PATCH,
			});
		vi.mocked(withProjectContext).mockResolvedValueOnce(
			stubCaseStore(applySubmission),
		);

		const { submitFormAction } = await import("../caseDataBinding");
		expect(
			await submitFormAction(
				{
					kind: "survey",
					formUuid,
					entryKey: FINAL_ENTRY_KEY,
					attachmentRefs: [],
					operationAnswers: {
						root: [{ fieldUuid: noteUuid, value: "first" }],
						repeats: [],
					},
				},
				APP_ID,
				canonicalJsonDigest(toPersistableDoc(doc)),
			),
		).toEqual({
			kind: "survey",
			caseDatabasePatch: EMPTY_CASE_DATABASE_PATCH,
		});

		// The heal retries the WHOLE envelope, so the compiler context the
		// second attempt runs against must be the same object, not a second
		// definition read that could observe a changed schema mid-submission.
		expect(getLookupDefinitionsMock).toHaveBeenCalledTimes(1);
		expect(materializeMock).toHaveBeenCalledTimes(1);
		expect(applySubmission).toHaveBeenCalledTimes(2);
		const firstEnvelope = applySubmission.mock.calls[0]?.[0];
		const retryEnvelope = applySubmission.mock.calls[1]?.[0];
		expect(retryEnvelope).toBe(firstEnvelope);
		expect(retryEnvelope.operations?.lookupTableSchemas).toBe(
			firstEnvelope.operations?.lookupTableSchemas,
		);
	});

	it("prepares and atomically commits an attachment-bearing survey instead of taking the legacy no-op guard", async () => {
		const { getSession } = await import("@/lib/auth-utils");
		const { withProjectContext } = await import("@/lib/case-store");
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: OWNER_A },
		} as unknown as Awaited<ReturnType<typeof getSession>>);

		const doc = buildDoc({
			appName: "Capture survey",
			modules: [
				{
					uuid: "31111111-1111-4111-8111-111111111111",
					name: "Mod",
					forms: [
						{
							uuid: "41111111-1111-4111-8111-111111111111",
							name: "Survey",
							type: "survey",
							fields: [
								f({
									uuid: "51111111-1111-4111-8111-111111111111",
									kind: "image",
									id: "photo",
									label: proseText("Photo"),
								}),
							],
						},
					],
				},
			],
		});
		const formUuid = Object.keys(doc.forms)[0] as Uuid;
		const photoUuid = Object.values(doc.fields).find(
			(field) => field.id === "photo",
		)?.uuid as Uuid;
		loadAuthorizedFormSubmissionSnapshotMock.mockResolvedValue({
			kind: "current",
			projectId: PROJECT_A,
			app: {
				blueprint: doc,
				mutation_seq: 17,
				project_id: PROJECT_A,
			},
		});
		const applySubmission = vi.fn().mockResolvedValueOnce({
			primaryCaseIds: [],
			createdChildren: [],
			operations: [],
			blueprintDigest: canonicalJsonDigest(toPersistableDoc(doc)),
			caseDatabasePatch: EMPTY_CASE_DATABASE_PATCH,
		});
		vi.mocked(withProjectContext).mockResolvedValueOnce(
			stubCaseStore(applySubmission),
		);

		const entryKey = "11111111-1111-4111-8111-111111111111";
		const mutation: SubmissionMutation = {
			kind: "survey",
			formUuid,
			entryKey,
			attachmentRefs: [
				{
					attachmentName: "photo.jpg",
					fieldUuid: photoUuid,
					instancePath: "/data/photo",
				},
			],
		};
		const { submitFormAction } = await import("../caseDataBinding");
		const result = await submitFormAction(
			mutation,
			APP_ID,
			canonicalJsonDigest(toPersistableDoc(doc)),
		);

		expect(result).toEqual({
			kind: "survey",
			caseDatabasePatch: EMPTY_CASE_DATABASE_PATCH,
		});
		expect(applySubmission).toHaveBeenCalledOnce();
		const envelope = applySubmission.mock.calls[0]?.[0];
		expect(envelope.ordinary).toEqual({ kind: "none" });
		expect(envelope.captureIntent).toMatchObject({
			entryKey,
			formUuid,
			expectedAppMutationSeq: 17,
			attachments: mutation.attachmentRefs,
			allowedAttachments: [
				expect.objectContaining({
					fieldUuid: photoUuid,
					captureKind: "image",
					acceptedFormats: expect.arrayContaining([
						{ extension: ".jpg", contentType: "image/jpeg" },
						{ extension: ".png", contentType: "image/png" },
					]),
				}),
			],
		});
		expect(envelope.captureIntent.requestDigest).toMatch(/^[0-9a-f]{64}$/);
		expect(prepareCaptureSubmissionBytesMock).toHaveBeenCalledWith({
			appId: APP_ID,
			actorUserId: OWNER_A,
			projectId: PROJECT_A,
			intent: envelope.captureIntent,
		});
		expect(
			prepareCaptureSubmissionBytesMock.mock.invocationCallOrder[0],
		).toBeLessThan(applySubmission.mock.invocationCallOrder[0] ?? Infinity);
		// There is deliberately no post-commit attachment callback: once
		// applySubmission resolves, the action can return without awaiting any
		// storage promise that could make an accepted form appear failed.
		expect(prepareCaptureSubmissionBytesMock).toHaveBeenCalledTimes(1);
	});

	it("replays a nonempty accepted entry before loading a now-deleted form", async () => {
		const { getSession } = await import("@/lib/auth-utils");
		const { withProjectContext } = await import("@/lib/case-store");
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: OWNER_A },
		} as unknown as Awaited<ReturnType<typeof getSession>>);
		const applySubmission = vi.fn();
		vi.mocked(withProjectContext).mockResolvedValueOnce(
			stubCaseStore(applySubmission),
		);
		const formUuid = testUuid("41111111-1111-4111-8111-111111111111");
		const fieldUuid = testUuid("51111111-1111-4111-8111-111111111111");
		const mutation: SubmissionMutation = {
			kind: "registration",
			formUuid,
			entryKey: "11111111-1111-4111-8111-111111111111",
			attachmentRefs: [
				{
					attachmentName: "accepted.png",
					fieldUuid,
					instancePath: "/data/photo",
				},
			],
			primary: {
				caseType: "patient",
				caseName: "Alice",
				properties: {},
			},
			children: [],
		};
		const replayIdentity = previewAsMe({ id: OWNER_A });
		if (replayIdentity === null) throw new Error("Expected replay identity.");
		const receipt = buildSubmissionReceiptIdentity({
			appId: APP_ID,
			identity: replayIdentity,
			mutation,
			projection: validateCaptureSubmissionProjection(mutation),
		});
		loadAuthorizedFormSubmissionSnapshotMock.mockResolvedValueOnce({
			kind: "replay",
			projectId: PROJECT_A,
			receipt: {
				formUuid,
				requestDigest: receipt.requestDigest,
				result: {
					primaryCaseIds: [ALICE_CASE_ID],
					childCaseIds: [VISIT_CASE_ID],
					operations: [],
					blueprintDigest: FINAL_BLUEPRINT_DIGEST,
					caseDatabasePatch: EMPTY_CASE_DATABASE_PATCH,
				},
			},
		});

		const { submitFormAction } = await import("../caseDataBinding");
		await expect(
			submitFormAction(mutation, APP_ID, FINAL_BLUEPRINT_DIGEST),
		).resolves.toEqual({
			kind: "registration",
			caseId: ALICE_CASE_ID,
			childCaseIds: [VISIT_CASE_ID],
			caseDatabasePatch: EMPTY_CASE_DATABASE_PATCH,
		});
		expect(loadAuthorizedFormSubmissionSnapshotMock).toHaveBeenCalledWith({
			appId: APP_ID,
			actorUserId: OWNER_A,
			entryKey: mutation.entryKey,
		});
		expect(loadAppMock).not.toHaveBeenCalled();
		expect(applySubmission).not.toHaveBeenCalled();
		expect(prepareCaptureSubmissionBytesMock).not.toHaveBeenCalled();
	});

	it.each([
		["a historical receipt without a revision", undefined],
		["a receipt from a different revision", "0".repeat(64)],
	])(
		"keeps saved answers but refuses to route %s through the current topology",
		async (_label, receiptBlueprintDigest) => {
			const { getSession } = await import("@/lib/auth-utils");
			vi.mocked(getSession).mockResolvedValueOnce({
				user: { id: OWNER_A },
			} as unknown as Awaited<ReturnType<typeof getSession>>);
			const mutation: SubmissionMutation = {
				kind: "survey",
				...FINAL_SUBMISSION_PROTOCOL,
			};
			const replayIdentity = previewAsMe({ id: OWNER_A });
			if (replayIdentity === null) {
				throw new Error("Expected replay identity.");
			}
			const receipt = buildSubmissionReceiptIdentity({
				appId: APP_ID,
				identity: replayIdentity,
				mutation,
				projection: validateCaptureSubmissionProjection(mutation),
			});
			loadAuthorizedFormSubmissionSnapshotMock.mockResolvedValueOnce({
				kind: "replay",
				projectId: PROJECT_A,
				receipt: {
					formUuid: mutation.formUuid,
					requestDigest: receipt.requestDigest,
					result: {
						childCaseIds: [],
						operations: [],
						...(receiptBlueprintDigest === undefined
							? {}
							: { blueprintDigest: receiptBlueprintDigest }),
					},
				},
			});

			const { submitFormAction } = await import("../caseDataBinding");
			await expect(
				submitFormAction(mutation, APP_ID, FINAL_BLUEPRINT_DIGEST),
			).resolves.toEqual({
				kind: "blueprint-changed",
				message:
					"Your answers were saved, but this app changed before the next screen could be chosen. Reload the app to continue.",
			});
			expect(loadAppMock).not.toHaveBeenCalled();
			expect(prepareCaptureSubmissionBytesMock).not.toHaveBeenCalled();
		},
	);

	it("rejects changed answers against a receipt before loading current topology", async () => {
		const { getSession } = await import("@/lib/auth-utils");
		const { withProjectContext } = await import("@/lib/case-store");
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: OWNER_A },
		} as unknown as Awaited<ReturnType<typeof getSession>>);
		const applySubmission = vi.fn();
		vi.mocked(withProjectContext).mockResolvedValueOnce(
			stubCaseStore(applySubmission),
		);
		const mutation: SubmissionMutation = {
			kind: "survey",
			formUuid: testUuid("41111111-1111-4111-8111-111111111111"),
			entryKey: "11111111-1111-4111-8111-111111111111",
			attachmentRefs: [],
		};
		loadAuthorizedFormSubmissionSnapshotMock.mockResolvedValueOnce({
			kind: "replay",
			projectId: PROJECT_A,
			receipt: {
				formUuid: mutation.formUuid,
				requestDigest: "0".repeat(64),
				result: { childCaseIds: [], operations: [] },
			},
		});

		const { submitFormAction } = await import("../caseDataBinding");
		await expect(
			submitFormAction(mutation, APP_ID, FINAL_BLUEPRINT_DIGEST),
		).resolves.toEqual({
			kind: "error",
			message:
				"This form entry was already submitted with different answers. Start a new form entry before submitting again.",
		});
		expect(loadAppMock).not.toHaveBeenCalled();
		expect(applySubmission).not.toHaveBeenCalled();
		expect(prepareCaptureSubmissionBytesMock).not.toHaveBeenCalled();
	});

	it("rejects a current snapshot whose form was removed before acceptance", async () => {
		const { getSession } = await import("@/lib/auth-utils");
		const { withProjectContext } = await import("@/lib/case-store");
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: OWNER_A },
		} as unknown as Awaited<ReturnType<typeof getSession>>);
		const applySubmission = vi.fn();
		vi.mocked(withProjectContext).mockResolvedValueOnce(
			stubCaseStore(applySubmission),
		);
		const committedBlueprint = buildDoc({
			appName: "Form deleted before acceptance",
		});
		loadAuthorizedFormSubmissionSnapshotMock.mockResolvedValueOnce({
			kind: "current",
			projectId: PROJECT_A,
			app: {
				blueprint: committedBlueprint,
				mutation_seq: 18,
				project_id: PROJECT_A,
			},
		});
		const formUuid = testUuid("41111111-1111-4111-8111-111111111111");
		const mutation: SubmissionMutation = {
			kind: "registration",
			formUuid,
			entryKey: "11111111-1111-4111-8111-111111111111",
			attachmentRefs: [
				{
					attachmentName: "accepted.png",
					fieldUuid: testUuid("51111111-1111-4111-8111-111111111111"),
					instancePath: "/data/photo",
				},
			],
			primary: {
				caseType: "patient",
				caseName: "Alice",
				properties: {},
			},
			children: [],
		};

		const { submitFormAction } = await import("../caseDataBinding");
		await expect(
			submitFormAction(
				mutation,
				APP_ID,
				canonicalJsonDigest(toPersistableDoc(committedBlueprint)),
			),
		).resolves.toMatchObject({
			kind: "error",
			message: expect.stringContaining("no longer exists"),
		});
		expect(loadAuthorizedFormSubmissionSnapshotMock).toHaveBeenCalledOnce();
		expect(applySubmission).not.toHaveBeenCalled();
		expect(prepareCaptureSubmissionBytesMock).not.toHaveBeenCalled();
	});

	it("keeps replay identity stable when an unrelated app edit advances mutation_seq", async () => {
		const doc = buildDoc({
			appName: "Stable capture retry",
			modules: [
				{
					uuid: "61111111-1111-4111-8111-111111111111",
					name: "Mod",
					forms: [
						{
							uuid: "71111111-1111-4111-8111-111111111111",
							name: "Survey",
							type: "survey",
							fields: [
								f({
									uuid: "81111111-1111-4111-8111-111111111111",
									kind: "image",
									id: "photo",
									label: proseText("Photo"),
								}),
							],
						},
					],
				},
			],
		});
		const formUuid = Object.keys(doc.forms)[0] as Uuid;
		const photoUuid = Object.values(doc.fields).find(
			(field) => field.id === "photo",
		)?.uuid as Uuid;
		const mutation: SubmissionMutation = {
			kind: "survey",
			formUuid,
			entryKey: "21111111-1111-4111-8111-111111111111",
			attachmentRefs: [
				{
					attachmentName: "photo.jpg",
					fieldUuid: photoUuid,
					instancePath: "/data/photo",
				},
			],
		};
		const identity = {
			actorUserId: OWNER_A,
			ownerId: OWNER_A,
			session: { context: {}, user: {}, userPropertySlugs: {} },
			usercase: {},
		};
		const firstApp = { blueprint: doc, mutation_seq: 17 };
		const retryApp = { blueprint: doc, mutation_seq: 18 };
		const projection = validateCaptureSubmissionProjection(mutation);

		const first = await buildSubmissionOperationProgram({
			appId: APP_ID,
			committedApp: firstApp,
			blueprintDigest: FINAL_BLUEPRINT_DIGEST,
			identity,
			lookupScope: LOOKUP_SCOPE,
			mutation,
			projection,
			viewerTimeZone: "UTC",
		});
		const retry = await buildSubmissionOperationProgram({
			appId: APP_ID,
			committedApp: retryApp,
			blueprintDigest: FINAL_BLUEPRINT_DIGEST,
			identity,
			lookupScope: LOOKUP_SCOPE,
			mutation,
			projection,
			viewerTimeZone: "UTC",
		});

		expect(first.captureIntent?.expectedAppMutationSeq).toBe(17);
		expect(retry.captureIntent?.expectedAppMutationSeq).toBe(18);
		expect(retry.captureIntent?.requestDigest).toBe(
			first.captureIntent?.requestDigest,
		);
	});
});

describe("loadCasesAction", () => {
	it("returns the unauthenticated arm when getSession resolves to null", async () => {
		const { getSession } = await import("@/lib/auth-utils");
		const { withProjectContext } = await import("@/lib/case-store");
		vi.mocked(getSession).mockResolvedValueOnce(null);

		const { loadCasesAction } = await import("../caseDataBinding");
		const result = await loadCasesAction({
			appId: APP_ID,
			caseType: "patient",
		});
		expect(result).toEqual({ kind: "unauthenticated" });
		expect(vi.mocked(withProjectContext)).not.toHaveBeenCalled();
	});

	it("binds persona reads to the member actor and persona owner from one authorized snapshot", async () => {
		const personaUuid = testUuid("persona-results");
		const { getSession } = await import("@/lib/auth-utils");
		const { withProjectContext } = await import("@/lib/case-store");
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: OWNER_A, name: "Member" },
		} as unknown as Awaited<ReturnType<typeof getSession>>);
		const doc = buildDoc({ appName: "Persona results", modules: [] });
		doc.personas = {
			[personaUuid]: { uuid: personaUuid, name: "Asha" },
		};
		loadAppMock.mockResolvedValueOnce({ blueprint: doc });
		const store = actionStore({ query: appCaseQuery([]) });
		vi.mocked(withProjectContext).mockResolvedValueOnce(store);

		const { loadCasesAction } = await import("../caseDataBinding");
		const result = await loadCasesAction({
			appId: APP_ID,
			caseType: "patient",
			personaUuid,
		});

		expect(result).toEqual({
			kind: "empty",
			constraintSource: "unconstrained",
		});
		expect(resolveAuthorizedAppSnapshotMock).toHaveBeenCalledWith(
			APP_ID,
			OWNER_A,
			"view",
		);
		expect(vi.mocked(withProjectContext)).toHaveBeenCalledWith(
			PROJECT_A,
			OWNER_A,
			personaUuid,
		);
		expect(loadAppMock).toHaveBeenCalledTimes(1);
		expect(
			resolveAuthorizedAppSnapshotMock.mock.invocationCallOrder[0],
		).toBeLessThan(loadAppMock.mock.invocationCallOrder[0]);
	});

	it("binds custom worker identities through the committed catalog for self preview", async () => {
		const propertyUuid = testUuid("worker-property-region");
		const { getSession } = await import("@/lib/auth-utils");
		const { withProjectContext } = await import("@/lib/case-store");
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: OWNER_A, name: "Member" },
		} as unknown as Awaited<ReturnType<typeof getSession>>);
		const doc = buildDoc({ appName: "Worker catalog", modules: [] });
		doc.userProperties = {
			[propertyUuid]: {
				uuid: propertyUuid,
				slug: "supervision_area",
				label: "Supervision area",
			},
		};
		loadAppMock.mockResolvedValueOnce({ blueprint: doc });
		const store = actionStore({ query: appCaseQuery([]) });
		vi.mocked(withProjectContext).mockResolvedValueOnce(store);
		const columnUuid = testUuid("worker-column");

		const { loadCasesAction } = await import("../caseDataBinding");
		await loadCasesAction({
			appId: APP_ID,
			caseType: "patient",
			caseListConfig: resolveCaseListConfig({
				columns: [
					calculatedColumn(
						columnUuid,
						"Supervision area",
						term(sessionUserProperty(propertyUuid)),
					),
				],
				searchInputs: [],
			}),
			caseTypes: [PATIENT_CASE_TYPE],
		});

		const bindings = appCaseQueryArg(vi.mocked(store.query))?.bindings;
		expect(bindings?.userPropertySlugs?.get(propertyUuid)).toBe(
			"supervision_area",
		);
		// A signed-in Nova member has no authored worker value, but a declared
		// field is present-empty exactly as it is on a CommCare restore.
		expect(bindings?.sessionUser?.get("supervision_area")).toBe("");
		expect(resolveAuthorizedAppSnapshotMock).toHaveBeenCalledWith(
			APP_ID,
			OWNER_A,
			"view",
		);
	});

	it("returns an honest typed refusal when a selected persona disappeared", async () => {
		const { getSession } = await import("@/lib/auth-utils");
		const { withProjectContext } = await import("@/lib/case-store");
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: OWNER_A },
		} as unknown as Awaited<ReturnType<typeof getSession>>);
		loadAppMock.mockResolvedValueOnce({
			blueprint: buildDoc({ appName: "No personas", modules: [] }),
		});

		const { loadCasesAction } = await import("../caseDataBinding");
		const result = await loadCasesAction({
			appId: APP_ID,
			caseType: "patient",
			personaUuid: "removed-persona",
		});

		expect(result.kind).toBe("persona-unavailable");
		expect(vi.mocked(withProjectContext)).not.toHaveBeenCalled();
		expect(resolveAuthorizedAppSnapshotMock).toHaveBeenCalledWith(
			APP_ID,
			OWNER_A,
			"view",
		);
	});

	it.each(["constructor", "__proto__", ""])(
		"does not resolve a forged persona selector %j through the record prototype",
		async (personaUuid) => {
			const { getSession } = await import("@/lib/auth-utils");
			const { withProjectContext } = await import("@/lib/case-store");
			vi.mocked(getSession).mockResolvedValueOnce({
				user: { id: OWNER_A },
			} as unknown as Awaited<ReturnType<typeof getSession>>);
			loadAppMock.mockResolvedValueOnce({
				blueprint: buildDoc({ appName: "No personas", modules: [] }),
			});

			const { loadCasesAction } = await import("../caseDataBinding");
			const result = await loadCasesAction({
				appId: APP_ID,
				caseType: "patient",
				personaUuid,
			});

			expect(result.kind).toBe("persona-unavailable");
			expect(vi.mocked(withProjectContext)).not.toHaveBeenCalled();
		},
	);

	it("resolves a prototype-named selector when it is an own persona key", async () => {
		const personaUuid = testUuid("constructor");
		const { getSession } = await import("@/lib/auth-utils");
		const { withProjectContext } = await import("@/lib/case-store");
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: OWNER_A },
		} as unknown as Awaited<ReturnType<typeof getSession>>);
		const doc = buildDoc({ appName: "Own persona", modules: [] });
		doc.personas = Object.fromEntries([
			[personaUuid, { uuid: personaUuid, name: "Constructor persona" }],
		]);
		loadAppMock.mockResolvedValueOnce({ blueprint: doc });
		const store = actionStore({ query: appCaseQuery([]) });
		vi.mocked(withProjectContext).mockResolvedValueOnce(store);

		const { loadCasesAction } = await import("../caseDataBinding");
		await loadCasesAction({
			appId: APP_ID,
			caseType: "patient",
			personaUuid,
		});

		expect(vi.mocked(withProjectContext)).toHaveBeenCalledWith(
			PROJECT_A,
			OWNER_A,
			personaUuid,
		);
	});

	it("does not read a persona blueprint when the locked authorization snapshot is denied", async () => {
		const { getSession } = await import("@/lib/auth-utils");
		const { withProjectContext } = await import("@/lib/case-store");
		const { AppAccessError } = await import("@/lib/db/appAccess");
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: OWNER_B },
		} as unknown as Awaited<ReturnType<typeof getSession>>);
		resolveAuthorizedAppSnapshotMock.mockRejectedValueOnce(
			new AppAccessError("not_member"),
		);

		const { loadCasesAction } = await import("../caseDataBinding");
		const result = await loadCasesAction({
			appId: APP_ID,
			caseType: "patient",
			personaUuid: "foreign-persona",
		});

		expect(result).toEqual({ kind: "error", message: "App not found." });
		expect(loadAppMock).not.toHaveBeenCalled();
		expect(vi.mocked(withProjectContext)).not.toHaveBeenCalled();
	});

	it("rebuilds the schema map from the client-sent catalog and threads it into the store query", async () => {
		const { getSession } = await import("@/lib/auth-utils");
		const { withProjectContext } = await import("@/lib/case-store");
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: OWNER_A },
		} as unknown as Awaited<ReturnType<typeof getSession>>);
		const legacyRows = Array.from({ length: 51 }, (_, index) => ({
			...buildSyntheticRow({ name: `Patient ${index + 1}` }),
			case_id: `10000000-0000-0000-0000-${String(index + 1).padStart(12, "0")}`,
			calculated: {},
		}));
		const stubStore = {
			...actionStore(),
			query: appCaseQuery(legacyRows),
			queryGrouped: vi.fn(),
			count: vi.fn(),
			insert: vi.fn(),
			applySubmission: vi.fn(),
			update: vi.fn(),
			close: vi.fn(),
			traverse: vi.fn(),
			applySchemaChange: vi.fn(),
			unparkValues: vi.fn(),
			conversionImpact: vi.fn(),
			listParkedValues: vi.fn(),
			restoreParkedValues: vi.fn(),
			setParkedValuesDismissed: vi.fn(),
			replaceParkedValue: vi.fn(),
			generateSampleData: vi.fn(),
			resetSampleData: vi.fn(),
		} satisfies CaseStore;
		vi.mocked(withProjectContext).mockResolvedValueOnce(stubStore);

		const { loadCasesAction } = await import("../caseDataBinding");
		const result = await loadCasesAction({
			appId: APP_ID,
			caseType: "patient",
			caseTypes: [PATIENT_CASE_TYPE],
		});
		expect(result.kind).toBe("rows");
		if (result.kind !== "rows") return;
		expect(result.rows).toHaveLength(51);
		// The catalog is rebuilt into the `(name → CaseType)` map the SQL
		// compiler reads — sourced from the wire arg, not a server read.
		const queryArg = appCaseQueryArg(stubStore.query);
		// An old client omits `page` and has no pager. Rolling compatibility
		// requires the legacy call to remain unbounded.
		expect(queryArg?.limit).toBeUndefined();
		expect(queryArg?.offset).toBeUndefined();
		expect(queryArg?.caseTypeSchemas).toBeInstanceOf(Map);
		expect(queryArg?.caseTypeSchemas?.get("patient")).toEqual(
			PATIENT_CASE_TYPE,
		);
		expect(queryArg?.bindings?.sessionContext?.get("userid")).toBe(OWNER_A);
		expect(queryArg?.bindings?.sessionUserFallback).toBe("");
	});

	it("caps only an explicit new-client page request", async () => {
		const { getSession } = await import("@/lib/auth-utils");
		const { withProjectContext } = await import("@/lib/case-store");
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: OWNER_A },
		} as unknown as Awaited<ReturnType<typeof getSession>>);
		const stubStore = {
			...actionStore(),
			query: appCaseQuery([
				{ ...buildSyntheticRow({ name: "Alice" }), calculated: {} },
			]),
			queryGrouped: vi.fn(),
			count: vi.fn().mockResolvedValueOnce(150),
			insert: vi.fn(),
			applySubmission: vi.fn(),
			update: vi.fn(),
			close: vi.fn(),
			traverse: vi.fn(),
			applySchemaChange: vi.fn(),
			unparkValues: vi.fn(),
			conversionImpact: vi.fn(),
			listParkedValues: vi.fn(),
			restoreParkedValues: vi.fn(),
			setParkedValuesDismissed: vi.fn(),
			replaceParkedValue: vi.fn(),
			generateSampleData: vi.fn(),
			resetSampleData: vi.fn(),
		} satisfies CaseStore;
		vi.mocked(withProjectContext).mockResolvedValueOnce(stubStore);

		const { loadCasesAction } = await import("../caseDataBinding");
		await loadCasesAction({
			appId: APP_ID,
			caseType: "patient",
			page: { offset: 25.8, limit: 10_000 },
		});

		expect(stubStore.query).toHaveBeenCalledWith(
			expect.objectContaining({ limit: 100, offset: 25 }),
		);
		expect(appCaseQueryArg(stubStore.query)?.bindings).toBe(
			stubStore.count.mock.calls[0]?.[0].bindings,
		);
	});

	it("rejects an invalid calendar quantity before opening the case store", async () => {
		const { getSession } = await import("@/lib/auth-utils");
		const { withProjectContext } = await import("@/lib/case-store");
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: OWNER_A },
		} as unknown as Awaited<ReturnType<typeof getSession>>);
		const monthInputUuid = testUuid("month-input");
		const predicate = whenInput(
			input(monthInputUuid),
			eq(
				prop("patient", "due_date"),
				dateAdd(today(), "months", double(term(input(monthInputUuid)))),
			),
		);

		const { loadCasesAction } = await import("../caseDataBinding");
		const result = await loadCasesAction({
			appId: APP_ID,
			caseType: "patient",
			caseTypes: [PATIENT_CASE_TYPE],
			caseListConfig: resolveCaseListConfig({
				columns: [],
				searchInputs: [
					advancedSearchInputDef(
						monthInputUuid,
						"months",
						"Months",
						"text",
						predicate,
					),
				],
			}),
			inputValues: { months: "1.5" },
		});

		expect(result).toEqual({
			kind: "invalid-search",
			message: expect.stringContaining("whole number"),
			repair: "inputs",
		});
		expect(vi.mocked(withProjectContext)).not.toHaveBeenCalled();
	});

	it("evaluates a session-backed excluded-owner expression before querying", async () => {
		const { getSession } = await import("@/lib/auth-utils");
		const { withProjectContext } = await import("@/lib/case-store");
		vi.mocked(getSession).mockResolvedValueOnce({
			user: {
				id: OWNER_A,
				name: "Owner A",
				email: "owner-a@example.org",
			},
		} as unknown as Awaited<ReturnType<typeof getSession>>);
		const stubStore = {
			...actionStore(),
			query: appCaseQuery([]),
			queryGrouped: vi.fn(),
			count: vi.fn(),
			insert: vi.fn(),
			applySubmission: vi.fn(),
			update: vi.fn(),
			close: vi.fn(),
			traverse: vi.fn(),
			applySchemaChange: vi.fn(),
			unparkValues: vi.fn(),
			conversionImpact: vi.fn(),
			listParkedValues: vi.fn(),
			restoreParkedValues: vi.fn(),
			setParkedValuesDismissed: vi.fn(),
			replaceParkedValue: vi.fn(),
			generateSampleData: vi.fn(),
			resetSampleData: vi.fn(),
		} satisfies CaseStore;
		vi.mocked(withProjectContext).mockResolvedValueOnce(stubStore);

		const { loadCasesAction } = await import("../caseDataBinding");
		const result = await loadCasesAction({
			appId: APP_ID,
			caseType: "patient",
			excludedOwnerIdsExpression: term(sessionContext("userid")),
		});

		expect(result).toEqual({
			kind: "empty",
			constraintSource: "authored-rules",
		});
		expect(stubStore.query).toHaveBeenCalledWith(
			expect.objectContaining({
				predicate: or(
					isBlank(prop("patient", "owner_id")),
					not(isIn(prop("patient", "owner_id"), literal(OWNER_A))),
				),
			}),
		);
	});

	it("reports an empty evaluated owner exclusion as unconstrained", async () => {
		const { getSession } = await import("@/lib/auth-utils");
		const { withProjectContext } = await import("@/lib/case-store");
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: OWNER_A },
		} as unknown as Awaited<ReturnType<typeof getSession>>);
		const stubStore = {
			...actionStore(),
			query: appCaseQuery([]),
			queryGrouped: vi.fn(),
			count: vi.fn(),
			insert: vi.fn(),
			applySubmission: vi.fn(),
			update: vi.fn(),
			close: vi.fn(),
			traverse: vi.fn(),
			applySchemaChange: vi.fn(),
			unparkValues: vi.fn(),
			conversionImpact: vi.fn(),
			listParkedValues: vi.fn(),
			restoreParkedValues: vi.fn(),
			setParkedValuesDismissed: vi.fn(),
			replaceParkedValue: vi.fn(),
			generateSampleData: vi.fn(),
			resetSampleData: vi.fn(),
		} satisfies CaseStore;
		vi.mocked(withProjectContext).mockResolvedValueOnce(stubStore);

		const { loadCasesAction } = await import("../caseDataBinding");
		const result = await loadCasesAction({
			appId: APP_ID,
			caseType: "patient",
			excludedOwnerIdsExpression: term(literal("")),
		});

		expect(result).toEqual({
			kind: "empty",
			constraintSource: "unconstrained",
		});
		expect(stubStore.query).toHaveBeenCalledWith(
			expect.objectContaining({ predicate: undefined }),
		);
	});

	it("binds a completed date range into excluded-owner expression evaluation", async () => {
		const { getSession } = await import("@/lib/auth-utils");
		const { withProjectContext } = await import("@/lib/case-store");
		vi.mocked(getSession).mockResolvedValueOnce({
			user: {
				id: OWNER_A,
				name: "Owner A",
				email: "owner-a@example.org",
			},
		} as unknown as Awaited<ReturnType<typeof getSession>>);
		const stubStore = {
			...actionStore(),
			query: appCaseQuery([]),
			queryGrouped: vi.fn(),
			count: vi.fn(),
			insert: vi.fn(),
			applySubmission: vi.fn(),
			update: vi.fn(),
			close: vi.fn(),
			traverse: vi.fn(),
			applySchemaChange: vi.fn(),
			unparkValues: vi.fn(),
			conversionImpact: vi.fn(),
			listParkedValues: vi.fn(),
			restoreParkedValues: vi.fn(),
			setParkedValuesDismissed: vi.fn(),
			replaceParkedValue: vi.fn(),
			generateSampleData: vi.fn(),
			resetSampleData: vi.fn(),
		} satisfies CaseStore;
		vi.mocked(withProjectContext).mockResolvedValueOnce(stubStore);

		const rangeInput = simpleSearchInputDef(
			testUuid("range-action"),
			"visit_dates",
			"Visit dates",
			"date-range",
			"dob",
		);
		const excludedOwnerIdsExpression = ifExpr(
			not(whenInput(input(rangeInput.uuid), matchNone())),
			term(literal("range-owner")),
			term(literal("")),
		);
		const { loadCasesAction } = await import("../caseDataBinding");
		const result = await loadCasesAction({
			appId: APP_ID,
			caseType: "patient",
			caseTypes: [FORMATTED_PROPS_CASE_TYPE],
			caseListConfig: resolveCaseListConfig({
				columns: [],
				searchInputs: [rangeInput],
			}),
			inputValues: {
				"visit_dates:from": "2025-01-02",
				"visit_dates:to": "2025-03-04",
			},
			excludedOwnerIdsExpression,
		});

		expect(result).toEqual({
			kind: "empty",
			constraintSource: "worker-search",
		});
		expect(stubStore.query).toHaveBeenCalledWith(
			expect.objectContaining({
				predicate: and(
					between(prop("patient", "dob"), {
						lower: dateLiteral("2025-01-02"),
						upper: dateLiteral("2025-03-04"),
					}),
					or(
						isBlank(prop("patient", "owner_id")),
						not(isIn(prop("patient", "owner_id"), literal("range-owner"))),
					),
				),
			}),
		);
	});

	it("rejects an incomplete date-range request before querying the store", async () => {
		const { getSession } = await import("@/lib/auth-utils");
		const { withProjectContext } = await import("@/lib/case-store");
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: OWNER_A },
		} as unknown as Awaited<ReturnType<typeof getSession>>);
		const stubStore = {
			...actionStore(),
			query: appCaseQuery(),
			queryGrouped: vi.fn(),
			count: vi.fn(),
			insert: vi.fn(),
			applySubmission: vi.fn(),
			update: vi.fn(),
			close: vi.fn(),
			traverse: vi.fn(),
			applySchemaChange: vi.fn(),
			unparkValues: vi.fn(),
			conversionImpact: vi.fn(),
			listParkedValues: vi.fn(),
			restoreParkedValues: vi.fn(),
			setParkedValuesDismissed: vi.fn(),
			replaceParkedValue: vi.fn(),
			generateSampleData: vi.fn(),
			resetSampleData: vi.fn(),
		} satisfies CaseStore;
		vi.mocked(withProjectContext).mockResolvedValueOnce(stubStore);

		const rangeInput = simpleSearchInputDef(
			testUuid("range-action"),
			"visit_dates",
			"Visit dates",
			"date-range",
			"dob",
		);
		const { loadCasesAction } = await import("../caseDataBinding");
		const result = await loadCasesAction({
			appId: APP_ID,
			caseType: "patient",
			caseTypes: [FORMATTED_PROPS_CASE_TYPE],
			caseListConfig: resolveCaseListConfig({
				columns: [],
				searchInputs: [rangeInput],
			}),
			inputValues: { "visit_dates:from": "2025-01-02" },
		});

		expect(result).toEqual({
			kind: "invalid-search",
			message: "Choose both a start date and an end date",
			repair: "inputs",
		});
		expect(stubStore.query).not.toHaveBeenCalled();
	});

	it("collapses a Project-membership denial to the not-found arm without binding a store", async () => {
		// The IDOR gate: a non-member / absent / under-privileged request
		// rejects with `AppAccessError` (here from a non-member), which the
		// action maps to the not-found `error` arm. Asserting the exact "App
		// not found." message proves the dedicated short-circuit ran, NOT the
		// generic catch (which would surface the raw error message). And
		// `withProjectContext` is never reached, so no store ever binds to
		// another Project's case data — the gate is the IDOR boundary that
		// replaced owner-scoping making the client-supplied `appId` safe.
		const { getSession } = await import("@/lib/auth-utils");
		const { withProjectContext } = await import("@/lib/case-store");
		const { AppAccessError } = await import("@/lib/db/appAccess");
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: OWNER_B },
		} as unknown as Awaited<ReturnType<typeof getSession>>);
		resolveAuthorizedAppSnapshotMock.mockRejectedValueOnce(
			new AppAccessError("not_member"),
		);

		const { loadCasesAction } = await import("../caseDataBinding");
		const result = await loadCasesAction({
			appId: APP_ID,
			caseType: "patient",
		});
		expect(result).toEqual({ kind: "error", message: "App not found." });
		expect(vi.mocked(withProjectContext)).not.toHaveBeenCalled();
	});
});

describe("loadCaseCountAction", () => {
	it("returns the complete unfiltered population for the bound case type", async () => {
		const { getSession } = await import("@/lib/auth-utils");
		const { withProjectContext } = await import("@/lib/case-store");
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: OWNER_A },
		} as unknown as Awaited<ReturnType<typeof getSession>>);
		const stubStore = {
			...actionStore(),
			query: appCaseQuery(),
			queryGrouped: vi.fn(),
			count: vi.fn().mockResolvedValueOnce(37),
			insert: vi.fn(),
			applySubmission: vi.fn(),
			update: vi.fn(),
			close: vi.fn(),
			traverse: vi.fn(),
			applySchemaChange: vi.fn(),
			unparkValues: vi.fn(),
			conversionImpact: vi.fn(),
			listParkedValues: vi.fn(),
			restoreParkedValues: vi.fn(),
			setParkedValuesDismissed: vi.fn(),
			replaceParkedValue: vi.fn(),
			generateSampleData: vi.fn(),
			resetSampleData: vi.fn(),
		} satisfies CaseStore;
		vi.mocked(withProjectContext).mockResolvedValueOnce(stubStore);

		const { loadCaseCountAction } = await import("../caseDataBinding");
		const result = await loadCaseCountAction({
			appId: APP_ID,
			caseType: "patient",
		});

		expect(result).toEqual({ kind: "count", count: 37 });
		// The flag is CALLER-controlled: only the builder's Case data
		// manager passes true (its population includes held rows); this
		// probe-style call leaves it unset and inherits the hold, so the
		// running app's empty states attribute against the population
		// the app can actually reach.
		expect(stubStore.count).toHaveBeenCalledWith({
			appId: APP_ID,
			caseType: "patient",
			parentCases: undefined,
			includeHeld: false,
		});
	});

	it("retains the selected-parent population on a nested Results probe", async () => {
		const { getSession } = await import("@/lib/auth-utils");
		const { withProjectContext } = await import("@/lib/case-store");
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: OWNER_A },
		} as unknown as Awaited<ReturnType<typeof getSession>>);
		const store = actionStore({ count: vi.fn().mockResolvedValueOnce(0) });
		vi.mocked(withProjectContext).mockResolvedValueOnce(store);

		const { loadCaseCountAction } = await import("../caseDataBinding");
		const result = await loadCaseCountAction({
			appId: APP_ID,
			caseType: "visit",
			parentCase: {
				caseType: "patient",
				caseIds: [ALICE_CASE_ID, "patient-b"],
			},
		});

		expect(result).toEqual({ kind: "count", count: 0 });
		expect(store.count).toHaveBeenCalledWith({
			appId: APP_ID,
			caseType: "visit",
			parentCases: {
				caseType: "patient",
				caseIds: [ALICE_CASE_ID, "patient-b"],
			},
			includeHeld: false,
		});
	});

	it("short-circuits before the store when the session is missing", async () => {
		const { getSession } = await import("@/lib/auth-utils");
		const { withProjectContext } = await import("@/lib/case-store");
		vi.mocked(getSession).mockResolvedValueOnce(null);

		const { loadCaseCountAction } = await import("../caseDataBinding");
		expect(
			await loadCaseCountAction({ appId: APP_ID, caseType: "patient" }),
		).toEqual({ kind: "unauthenticated" });
		expect(vi.mocked(withProjectContext)).not.toHaveBeenCalled();
	});
});

describe("countCasesOwnedByAction", () => {
	it("counts every retained row for the server-resolved persona without a case-type list", async () => {
		const personaUuid = testUuid("persona-owned-count");
		const { getSession } = await import("@/lib/auth-utils");
		const { withProjectContext } = await import("@/lib/case-store");
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: OWNER_A },
		} as unknown as Awaited<ReturnType<typeof getSession>>);
		const doc = buildDoc({ appName: "Persona count", modules: [] });
		doc.personas = {
			[personaUuid]: { uuid: personaUuid, name: "Asha" },
		};
		loadAppMock.mockResolvedValueOnce({ blueprint: doc });
		const store = actionStore({ count: vi.fn().mockResolvedValueOnce(12) });
		vi.mocked(withProjectContext).mockResolvedValueOnce(store);

		const { countCasesOwnedByAction } = await import("../caseDataBinding");
		const result = await countCasesOwnedByAction({
			appId: APP_ID,
			personaUuid,
		});

		expect(result).toEqual({ kind: "count", count: 12 });
		expect(store.count).toHaveBeenCalledWith({
			appId: APP_ID,
			ownerId: personaUuid,
			includeHeld: true,
		});
		expect(vi.mocked(withProjectContext)).toHaveBeenCalledWith(
			PROJECT_A,
			OWNER_A,
			personaUuid,
		);
	});

	it("blocks removal counting when the persona no longer exists", async () => {
		const { getSession } = await import("@/lib/auth-utils");
		const { withProjectContext } = await import("@/lib/case-store");
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: OWNER_A },
		} as unknown as Awaited<ReturnType<typeof getSession>>);
		loadAppMock.mockResolvedValueOnce({
			blueprint: buildDoc({ appName: "No persona", modules: [] }),
		});

		const { countCasesOwnedByAction } = await import("../caseDataBinding");
		const result = await countCasesOwnedByAction({
			appId: APP_ID,
			personaUuid: "removed-persona",
		});

		expect(result.kind).toBe("persona-unavailable");
		expect(vi.mocked(withProjectContext)).not.toHaveBeenCalled();
	});
});

describe("resetSampleCasesAction", () => {
	it("returns the unauthenticated arm when getSession resolves to null", async () => {
		// Session-first ordering means an unauthenticated request
		// short-circuits before the blueprint lookup. `withProjectContext`
		// must not be invoked.
		const { getSession } = await import("@/lib/auth-utils");
		const { withProjectContext } = await import("@/lib/case-store");
		vi.mocked(getSession).mockResolvedValueOnce(null);

		const { resetSampleCasesAction } = await import("../caseDataBinding");
		const result = await resetSampleCasesAction(APP_ID, PATIENT_CASE_TYPE);
		expect(result).toEqual({ kind: "unauthenticated" });
		expect(vi.mocked(withProjectContext)).not.toHaveBeenCalled();
	});

	it("returns the ok arm with the regenerated row count on the success path", async () => {
		// Stub the case-store's atomic `resetSampleData` so the action
		// resolves without touching real Postgres. The action's job is
		// to thread the resolved `CaseType` into the helper; the
		// helper's job is to call `resetSampleData`. Asserting the
		// final result shape pins the full delegation chain.
		const { getSession } = await import("@/lib/auth-utils");
		const { withProjectContext } = await import("@/lib/case-store");
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: OWNER_A },
		} as unknown as Awaited<ReturnType<typeof getSession>>);
		const stubStore = {
			...actionStore(),
			query: appCaseQuery(),
			queryGrouped: vi.fn(),
			count: vi.fn(),
			insert: vi.fn(),
			applySubmission: vi.fn(),
			update: vi.fn(),
			close: vi.fn(),
			traverse: vi.fn(),
			applySchemaChange: vi.fn(),
			unparkValues: vi.fn(),
			conversionImpact: vi.fn(),
			listParkedValues: vi.fn(),
			restoreParkedValues: vi.fn(),
			setParkedValuesDismissed: vi.fn(),
			replaceParkedValue: vi.fn(),
			generateSampleData: vi.fn(),
			resetSampleData: vi.fn().mockResolvedValueOnce({
				deleted: SAMPLE_CASE_DEFAULT_COUNT,
				inserted: SAMPLE_CASE_DEFAULT_COUNT,
			}),
		} satisfies CaseStore;
		vi.mocked(withProjectContext).mockResolvedValueOnce(stubStore);

		const { resetSampleCasesAction } = await import("../caseDataBinding");
		const result = await resetSampleCasesAction(APP_ID, PATIENT_CASE_TYPE);
		expect(result).toEqual({
			kind: "ok",
			inserted: SAMPLE_CASE_DEFAULT_COUNT,
		});
		expect(stubStore.resetSampleData).toHaveBeenCalledTimes(1);
	});

	it("threads the selected persona through both populate and reset ownership", async () => {
		const personaUuid = testUuid("persona-samples");
		const { getSession } = await import("@/lib/auth-utils");
		const { withProjectContext } = await import("@/lib/case-store");
		vi.mocked(getSession).mockResolvedValue({
			user: { id: OWNER_A },
		} as unknown as Awaited<ReturnType<typeof getSession>>);
		const doc = buildDoc({ appName: "Persona samples", modules: [] });
		doc.personas = {
			[personaUuid]: { uuid: personaUuid, name: "Asha" },
		};
		loadAppMock.mockResolvedValue({ blueprint: doc });
		const populateStore = actionStore({
			generateSampleData: vi.fn().mockResolvedValueOnce({ inserted: 5 }),
		});
		const resetStore = actionStore({
			resetSampleData: vi
				.fn()
				.mockResolvedValueOnce({ deleted: 5, inserted: 5 }),
		});
		vi.mocked(withProjectContext)
			.mockResolvedValueOnce(populateStore)
			.mockResolvedValueOnce(resetStore);

		const { populateSampleCasesAction, resetSampleCasesAction } = await import(
			"../caseDataBinding"
		);
		expect(
			await populateSampleCasesAction(APP_ID, PATIENT_CASE_TYPE, personaUuid),
		).toEqual({ kind: "ok", inserted: 5 });
		expect(
			await resetSampleCasesAction(APP_ID, PATIENT_CASE_TYPE, personaUuid),
		).toEqual({ kind: "ok", inserted: 5 });

		expect(vi.mocked(withProjectContext).mock.calls).toEqual([
			[PROJECT_A, OWNER_A, personaUuid],
			[PROJECT_A, OWNER_A, personaUuid],
		]);
		expect(resolveAuthorizedAppSnapshotMock.mock.calls).toEqual([
			[APP_ID, OWNER_A, "edit"],
			[APP_ID, OWNER_A, "edit"],
		]);
	});

	it("translates a CasePropertiesValidationError thrown by the store to the validation-failure arm", async () => {
		// `resetSampleData` runs AJV inside its transaction; a
		// generator emitting a schema-violating row trips
		// `CasePropertiesValidationError`. The action's catch path
		// delegates to `mapPopulateSampleCasesError`; the typed-arm
		// surfaces the per-field failure list verbatim.
		const { getSession } = await import("@/lib/auth-utils");
		const { withProjectContext } = await import("@/lib/case-store");
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: OWNER_A },
		} as unknown as Awaited<ReturnType<typeof getSession>>);
		const failures: ReadonlyArray<CasePropertyFailure> = [
			{ path: "/age", message: "must be integer" },
		];
		const stubStore = {
			...actionStore(),
			query: appCaseQuery(),
			queryGrouped: vi.fn(),
			count: vi.fn(),
			insert: vi.fn(),
			applySubmission: vi.fn(),
			update: vi.fn(),
			close: vi.fn(),
			traverse: vi.fn(),
			applySchemaChange: vi.fn(),
			unparkValues: vi.fn(),
			conversionImpact: vi.fn(),
			listParkedValues: vi.fn(),
			restoreParkedValues: vi.fn(),
			setParkedValuesDismissed: vi.fn(),
			replaceParkedValue: vi.fn(),
			generateSampleData: vi.fn(),
			resetSampleData: vi
				.fn()
				.mockRejectedValueOnce(
					new CasePropertiesValidationError(APP_ID, "patient", failures),
				),
		} satisfies CaseStore;
		vi.mocked(withProjectContext).mockResolvedValueOnce(stubStore);

		const { resetSampleCasesAction } = await import("../caseDataBinding");
		const result = await resetSampleCasesAction(APP_ID, PATIENT_CASE_TYPE);
		expect(result).toEqual({
			kind: "validation-failure",
			caseType: "patient",
			failures,
		});
	});

	it("translates a SchemaNotSyncedError thrown by the store to the schema-not-synced arm", async () => {
		// `resetSampleData` reaches `getValidator` which throws
		// `SchemaNotSyncedError` when the case-type's schema row
		// hasn't been materialized via `applySchemaChange`. The
		// action's healing store re-materializes from the persisted
		// blueprint (the stubbed `loadApp` below) and retries the one
		// store call; the retry throws again, and the catch path
		// delegates to `mapPopulateSampleCasesError` which translates
		// to the typed arm carrying the case type — the heal's honest
		// backstop.
		const { getSession } = await import("@/lib/auth-utils");
		const { withProjectContext } = await import("@/lib/case-store");
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: OWNER_A },
		} as unknown as Awaited<ReturnType<typeof getSession>>);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
		// The heal re-materializes from the persisted blueprint, so it reads
		// `loadApp` once — the action itself no longer reads it.
		loadAppMock.mockResolvedValueOnce({ owner: OWNER_A, blueprint });
		materializeMock.mockResolvedValueOnce(undefined);
		const stubStore = {
			...actionStore(),
			query: appCaseQuery(),
			queryGrouped: vi.fn(),
			count: vi.fn(),
			insert: vi.fn(),
			applySubmission: vi.fn(),
			update: vi.fn(),
			close: vi.fn(),
			traverse: vi.fn(),
			applySchemaChange: vi.fn(),
			unparkValues: vi.fn(),
			conversionImpact: vi.fn(),
			listParkedValues: vi.fn(),
			restoreParkedValues: vi.fn(),
			setParkedValuesDismissed: vi.fn(),
			replaceParkedValue: vi.fn(),
			generateSampleData: vi.fn(),
			// Persistent rejection — the healed retry must throw again for
			// the typed arm to surface.
			resetSampleData: vi
				.fn()
				.mockRejectedValue(new SchemaNotSyncedError(APP_ID, "patient")),
		} satisfies CaseStore;
		vi.mocked(withProjectContext).mockResolvedValueOnce(stubStore);

		const { resetSampleCasesAction } = await import("../caseDataBinding");
		const result = await resetSampleCasesAction(APP_ID, PATIENT_CASE_TYPE);
		expect(result).toEqual({
			kind: "schema-not-synced",
			caseType: "patient",
		});
		// The heal genuinely ran before the backstop arm surfaced: one
		// materialize from the persisted blueprint, exactly one retry.
		expect(materializeMock).toHaveBeenCalledTimes(1);
		expect(stubStore.resetSampleData).toHaveBeenCalledTimes(2);
	});
});

describe("loadCaseDataAction session projection", () => {
	it("threads authenticated session bindings into a Details calculated projection", async () => {
		const { getSession } = await import("@/lib/auth-utils");
		const { withProjectContext } = await import("@/lib/case-store");
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: OWNER_A, name: "Owner A", email: "owner-a@example.org" },
		} as unknown as Awaited<ReturnType<typeof getSession>>);
		const stubStore = {
			...actionStore(),
			query: appCaseQuery([
				{
					...buildSyntheticRow({ name: "Alice" }),
					case_id: ALICE_CASE_ID,
					calculated: {},
				},
			]),
			queryGrouped: vi.fn(),
			count: vi.fn(),
			insert: vi.fn(),
			applySubmission: vi.fn(),
			update: vi.fn(),
			close: vi.fn(),
			traverse: vi.fn(),
			applySchemaChange: vi.fn(),
			unparkValues: vi.fn(),
			conversionImpact: vi.fn(),
			listParkedValues: vi.fn(),
			restoreParkedValues: vi.fn(),
			setParkedValuesDismissed: vi.fn(),
			replaceParkedValue: vi.fn(),
			generateSampleData: vi.fn(),
			resetSampleData: vi.fn(),
		} satisfies CaseStore;
		vi.mocked(withProjectContext).mockResolvedValueOnce(stubStore);
		const calculatedUuid = testUuid("00000000-0000-0000-0000-000000000d03");

		const { loadCaseDataAction } = await import("../caseDataBinding");
		const result = await loadCaseDataAction(
			APP_ID,
			"patient",
			ALICE_CASE_ID,
			0,
			resolveCaseListConfig({
				columns: [
					calculatedColumn(
						calculatedUuid,
						"Region",
						term(sessionUser("region")),
						{ visibleInDetail: true },
					),
				],
				searchInputs: [],
			}),
			[PATIENT_CASE_TYPE],
		);

		expect(result.kind).toBe("row");
		const queryArg = appCaseQueryArg(stubStore.query);
		expect(queryArg?.bindings?.sessionContext?.get("userid")).toBe(OWNER_A);
		expect(queryArg?.bindings?.sessionUserFallback).toBe("");
	});

	it("uses the persona owner for a selected row while membership stays on the member", async () => {
		const personaUuid = testUuid("persona-details");
		const { getSession } = await import("@/lib/auth-utils");
		const { withProjectContext } = await import("@/lib/case-store");
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: OWNER_A },
		} as unknown as Awaited<ReturnType<typeof getSession>>);
		const doc = buildDoc({ appName: "Persona details", modules: [] });
		doc.personas = {
			[personaUuid]: { uuid: personaUuid, name: "Asha" },
		};
		loadAppMock.mockResolvedValueOnce({ blueprint: doc });
		const store = actionStore({ query: appCaseQuery([]) });
		vi.mocked(withProjectContext).mockResolvedValueOnce(store);

		const { loadCaseDataAction } = await import("../caseDataBinding");
		expect(
			await loadCaseDataAction(
				APP_ID,
				"patient",
				ALICE_CASE_ID,
				0,
				undefined,
				undefined,
				undefined,
				undefined,
				personaUuid,
			),
		).toEqual({ kind: "missing" });
		expect(resolveAuthorizedAppSnapshotMock).toHaveBeenCalledWith(
			APP_ID,
			OWNER_A,
			"view",
		);
		expect(vi.mocked(withProjectContext)).toHaveBeenCalledWith(
			PROJECT_A,
			OWNER_A,
			personaUuid,
		);
	});

	it("binds a persona's custom worker value by UUID through its current slug", async () => {
		const propertyUuid = testUuid("worker-property-region");
		const personaUuid = testUuid("persona-details-worker");
		const { getSession } = await import("@/lib/auth-utils");
		const { withProjectContext } = await import("@/lib/case-store");
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: OWNER_A, name: "Member" },
		} as unknown as Awaited<ReturnType<typeof getSession>>);
		const doc = buildDoc({ appName: "Persona worker catalog", modules: [] });
		doc.userProperties = {
			[propertyUuid]: {
				uuid: propertyUuid,
				slug: "supervision_area",
				label: "Supervision area",
			},
		};
		doc.personas = {
			[personaUuid]: {
				uuid: personaUuid,
				name: "Asha",
				values: { [propertyUuid]: "north" },
			},
		};
		loadAppMock.mockResolvedValueOnce({ blueprint: doc });
		const store = actionStore({ query: appCaseQuery([]) });
		vi.mocked(withProjectContext).mockResolvedValueOnce(store);
		const columnUuid = testUuid("worker-detail-column");

		const { loadCaseDataAction } = await import("../caseDataBinding");
		await loadCaseDataAction(
			APP_ID,
			"patient",
			ALICE_CASE_ID,
			0,
			resolveCaseListConfig({
				columns: [
					calculatedColumn(
						columnUuid,
						"Supervision area",
						term(sessionUserProperty(propertyUuid)),
						{ visibleInDetail: true },
					),
				],
				searchInputs: [],
			}),
			[PATIENT_CASE_TYPE],
			undefined,
			undefined,
			personaUuid,
		);

		const bindings = appCaseQueryArg(vi.mocked(store.query))?.bindings;
		expect(bindings?.userPropertySlugs?.get(propertyUuid)).toBe(
			"supervision_area",
		);
		expect(bindings?.sessionUser?.get("supervision_area")).toBe("north");
	});
});

describe("loadFilterPreviewAction", () => {
	it("returns the invalid-config arm with a path-prefixed message when caseListConfig fails Zod parse", async () => {
		const { getSession } = await import("@/lib/auth-utils");
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: OWNER_A },
		} as unknown as Awaited<ReturnType<typeof getSession>>);

		const { loadFilterPreviewAction } = await import("../caseDataBinding");
		const result = await loadFilterPreviewAction({
			appId: APP_ID,
			caseType: "patient",
			blueprint: buildBlueprint([PATIENT_CASE_TYPE]),
			caseListConfig: {
				columns: "not an array",
				searchInputs: [],
			} as unknown as Parameters<
				typeof loadFilterPreviewAction
			>[0]["caseListConfig"],
		});
		expect(result.kind).toBe("invalid-config");
		if (result.kind !== "invalid-config") return;
		expect(result.message).toMatch(/^columns:/);
	});

	it("returns the invalid-blueprint arm with a path-prefixed message when blueprint fails Zod parse", async () => {
		const { getSession } = await import("@/lib/auth-utils");
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: OWNER_A },
		} as unknown as Awaited<ReturnType<typeof getSession>>);

		const { loadFilterPreviewAction } = await import("../caseDataBinding");
		const result = await loadFilterPreviewAction({
			appId: APP_ID,
			caseType: "patient",
			blueprint: {
				appId: 42,
				appName: "Test app",
				connectType: null,
				caseTypes: [],
				modules: {},
				forms: {},
				fields: {},
				moduleOrder: [],
				formOrder: {},
				fieldOrder: {},
				fieldParent: {},
			} as unknown as Parameters<
				typeof loadFilterPreviewAction
			>[0]["blueprint"],
			caseListConfig: makeCaseListConfig(),
		});
		expect(result.kind).toBe("invalid-blueprint");
		if (result.kind !== "invalid-blueprint") return;
		expect(result.message).toMatch(/^appId:/);
	});

	it("returns the unauthenticated arm before parsing when the session is absent (session-first ordering)", async () => {
		// Pins the session-first ordering: an unauthenticated
		// request short-circuits BEFORE the Zod parse. The ordering
		// matches every other action in the file. Passing a deliberately malformed
		// `caseListConfig` here would fail `invalid-config` if the
		// parse ran first; the test asserts `unauthenticated` to
		// confirm the session check beats the parse to the punch.
		const { getSession } = await import("@/lib/auth-utils");
		vi.mocked(getSession).mockResolvedValueOnce(null);

		const { loadFilterPreviewAction } = await import("../caseDataBinding");
		const result = await loadFilterPreviewAction({
			appId: APP_ID,
			caseType: "patient",
			blueprint: buildBlueprint([PATIENT_CASE_TYPE]),
			caseListConfig: {
				columns: "not an array",
				searchInputs: [],
			} as unknown as Parameters<
				typeof loadFilterPreviewAction
			>[0]["caseListConfig"],
		});
		expect(result).toEqual({ kind: "unauthenticated" });
	});

	it("parses a filter-preview blueprint carrying the in-memory fieldParent index instead of rejecting it as an unrecognized key", async () => {
		// The Filters-section live preview ships a `pickBlueprintDoc`
		// snapshot (with `fieldParent` re-attached) and runs the same
		// strict `blueprintDocSchema.safeParse`, so it carried the same
		// "Blueprint is malformed" failure. The action must strip the
		// derived index before the parse.
		const { getSession } = await import("@/lib/auth-utils");
		const { withProjectContext } = await import("@/lib/case-store");
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: OWNER_A },
		} as unknown as Awaited<ReturnType<typeof getSession>>);
		const stubStore = {
			...actionStore(),
			query: appCaseQuery([]),
			queryGrouped: vi.fn(),
			count: vi.fn().mockResolvedValueOnce(0),
			insert: vi.fn(),
			applySubmission: vi.fn(),
			update: vi.fn(),
			close: vi.fn(),
			traverse: vi.fn(),
			applySchemaChange: vi.fn(),
			unparkValues: vi.fn(),
			conversionImpact: vi.fn(),
			listParkedValues: vi.fn(),
			restoreParkedValues: vi.fn(),
			setParkedValuesDismissed: vi.fn(),
			replaceParkedValue: vi.fn(),
			generateSampleData: vi.fn(),
			resetSampleData: vi.fn(),
		} satisfies CaseStore;
		vi.mocked(withProjectContext).mockResolvedValueOnce(stubStore);
		const canonicalPatientCaseType: CaseType = {
			...PATIENT_CASE_TYPE,
			properties: [
				{ name: "full_name", label: proseText("Full name"), data_type: "text" },
				{ name: "age", label: proseText("Age"), data_type: "int" },
			],
		};

		const { loadFilterPreviewAction } = await import("../caseDataBinding");
		const result = await loadFilterPreviewAction({
			appId: APP_ID,
			caseType: "patient",
			blueprint: {
				...buildBlueprint([canonicalPatientCaseType]),
				fieldParent: {
					[testUuid("70000000-0000-0000-0000-000000000001")]: testUuid(
						"70000000-0000-0000-0000-000000000002",
					),
				},
			},
			caseListConfig: makeCaseListConfig({
				columns: [plainColumn(NAME_COLUMN_UUID, "case_name", "Case name")],
			}),
		});
		// Filter preview returns a single `rows` arm even when empty. The
		// load-bearing assertion is the negative: NOT `invalid-blueprint`.
		expect(result).toEqual({ kind: "rows", rows: [], totalCount: 0 });
		const queryArg = appCaseQueryArg(stubStore.query);
		const countArg = stubStore.count.mock.calls[0]?.[0];
		expect(queryArg?.bindings).toBe(countArg?.bindings);
		expect(queryArg?.bindings?.sessionContext?.get("userid")).toBe(OWNER_A);
		expect(queryArg?.bindings?.sessionUserFallback).toBe("");
	});

	it("binds UUID worker refs through the parsed candidate catalog", async () => {
		const propertyUuid = testUuid("worker-property-region");
		const { getSession } = await import("@/lib/auth-utils");
		const { withProjectContext } = await import("@/lib/case-store");
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: OWNER_A, name: "Member" },
		} as unknown as Awaited<ReturnType<typeof getSession>>);
		const candidate = buildBlueprint([
			{
				...PATIENT_CASE_TYPE,
				properties: [
					{
						name: "full_name",
						label: proseText("Full name"),
						data_type: "text",
					},
					{ name: "age", label: proseText("Age"), data_type: "int" },
				],
			},
		]);
		candidate.userProperties = {
			[propertyUuid]: {
				uuid: propertyUuid,
				slug: "candidate_area",
				label: "Candidate area",
			},
		};
		candidate.userPropertyOrder = [propertyUuid];
		const store = actionStore({
			query: appCaseQuery([]),
			queryGrouped: vi.fn(),
			count: vi.fn().mockResolvedValueOnce(0),
		});
		vi.mocked(withProjectContext).mockResolvedValueOnce(store);

		const { loadFilterPreviewAction } = await import("../caseDataBinding");
		await loadFilterPreviewAction({
			appId: APP_ID,
			caseType: "patient",
			blueprint: candidate,
			caseListConfig: resolveCaseListConfig({
				columns: [
					calculatedColumn(
						testUuid("candidate-worker-column"),
						"Candidate area",
						term(sessionUserProperty(propertyUuid)),
					),
				],
				searchInputs: [],
			}),
		});

		const bindings = appCaseQueryArg(vi.mocked(store.query))?.bindings;
		expect(bindings?.userPropertySlugs?.get(propertyUuid)).toBe(
			"candidate_area",
		);
		// The candidate catalog is presentation/compiler state only; the
		// authenticated member still owns the actual session values.
		expect(bindings?.sessionUser?.get("candidate_area")).toBeUndefined();
	});

	it("returns the invalid-blueprint arm (not a thrown error) for a null blueprint over the wire", async () => {
		// The pre-parse strip must not throw on a `null` wire payload — it
		// must reach the typed `invalid-blueprint` arm, not a raw
		// destructure TypeError surfaced through the generic `error` arm.
		const { getSession } = await import("@/lib/auth-utils");
		const { withProjectContext } = await import("@/lib/case-store");
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: OWNER_A },
		} as unknown as Awaited<ReturnType<typeof getSession>>);

		const { loadFilterPreviewAction } = await import("../caseDataBinding");
		const result = await loadFilterPreviewAction({
			appId: APP_ID,
			caseType: "patient",
			blueprint: null as unknown as Parameters<
				typeof loadFilterPreviewAction
			>[0]["blueprint"],
			caseListConfig: makeCaseListConfig(),
		});
		expect(result.kind).toBe("invalid-blueprint");
		expect(vi.mocked(withProjectContext)).not.toHaveBeenCalled();
	});
});
