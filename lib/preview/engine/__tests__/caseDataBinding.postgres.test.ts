// Real Postgres acceptance: tenant isolation, reads, writes, and submission effects.
// Pure projections and mocked action contracts live in the sibling files.
import { type Kysely, sql } from "kysely";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { resolveCaseListConfig } from "@/lib/__tests__/docHelpers";
import {
	buildCaseTypeMap,
	CasePropertiesValidationError,
	type CaseRow,
	type CaseStore,
	type JsonObject,
} from "@/lib/case-store";
import { buildSimpleBlueprint } from "@/lib/case-store/__tests__/fixtures/simpleBlueprint";
import { PostgresCaseStore } from "@/lib/case-store/postgres/store";
import { HeuristicCaseGenerator } from "@/lib/case-store/sample/heuristic";
import { setupPerTestDatabase } from "@/lib/case-store/sql/__tests__/perTestDatabase";
import type { Database } from "@/lib/case-store/sql/database";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import {
	advancedSearchInputDef,
	type BlueprintDoc,
	type CaseListConfig,
	type CaseType,
	calculatedColumn,
	emptyCaseListConfig,
	exactMode,
	plainColumn,
	simpleSearchInputDef,
	startsWithMode,
	tileCell,
} from "@/lib/domain";
import {
	and,
	concat,
	dateLiteral,
	eq,
	gt,
	input,
	literal,
	matchAll,
	matchNone,
	not,
	or,
	prop,
	sessionContext,
	sessionUser,
	term,
	whenInput,
} from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { buildDoc, f } from "../../../__tests__/docHelpers";
import { validateCaptureSubmissionProjection } from "../captureSubmissionValidation";
import {
	mapPopulateSampleCasesError,
	mapSubmitFormError,
	pickBlueprintDoc,
} from "../caseDataBindingClient";
import {
	buildCaseOperationProgramFromDoc,
	submissionEnvelopeArgs as projectSubmissionEnvelopeArgs,
	readCaseData,
	readCases,
	readFilterPreview,
	resetSampleCases,
	SAMPLE_CASE_DEFAULT_COUNT,
	seedSampleCases,
} from "../caseDataBindingHelpers";
import type { SubmissionMutation } from "../caseDataBindingTypes";
import { previewAsMe } from "../identity";
import type { SearchInputValues } from "../runtimeBindings";

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

const dbHandle = setupPerTestDatabase({
	schema: "migrated",
	databaseNamePrefix: "binding_test_",
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
	await sql`
		INSERT INTO apps (id, owner, project_id, app_name, app_name_lower)
		VALUES (
			${APP_ID},
			${OWNER_A},
			${PROJECT_A},
			${"Case data binding fixture"},
			${"case data binding fixture"}
		)
	`.execute(dbHandle.db);
});

const APP_ID = "app-binding";

const OWNER_A = "owner-a";

const OWNER_B = "owner-b";

const PROJECT_A = "project-a";

const PROJECT_B = "project-b";

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

const BOB_CASE_ID = "40000000-0000-0000-0000-000000000002";

const HOUSEHOLD_CASE_ID = "40000000-0000-0000-0000-000000000003";

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

const HOUSEHOLD_CASE_TYPE: CaseType = {
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

function makeStore(
	projectId: string,
	actorUserId: string = projectId,
	/** The CommCare worker rows are owned by — a persona, when Preview is
	 *  running as one. Defaults to the acting member. */
	ownerId: string = actorUserId,
): CaseStore {
	return new PostgresCaseStore({
		projectId,
		actorUserId,
		ownerId,
		db: dbHandle.db as unknown as Kysely<Database>,
		sampleGenerator: new HeuristicCaseGenerator(),
	});
}

async function seedSchema(
	store: CaseStore,
	blueprint: BlueprintDoc,
	caseType: string,
): Promise<void> {
	await store.applySchemaChange({
		appId: APP_ID,
		caseType,
		caseTypeSchemas: buildCaseTypeMap(blueprint),
	});
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

describe("a submission made while previewing as a persona", () => {
	const PERSONA = "aa000000-0000-4000-8000-00000000000a";

	it("owns every case it creates by the persona, not the signed-in member", async () => {
		const store = makeStore(PROJECT_A, OWNER_A, PERSONA);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");

		const result = await store.applySubmission(
			submissionEnvelopeArgs(
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
			),
		);

		const rows = await store.query({
			appId: APP_ID,
			caseType: "patient",
		});
		const created = rows.find((r) => r.case_id === result.primaryCaseIds[0]);
		expect(created?.owner_id).toBe(PERSONA);
		expect(created?.owner_id).not.toBe(OWNER_A);
	});

	it("owns sample data by the persona too — the bulk path agrees with the single-row one", async () => {
		const store = makeStore(PROJECT_A, OWNER_A, PERSONA);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");

		await store.generateSampleData({
			appId: APP_ID,
			caseType: PATIENT_CASE_TYPE,
			count: 2,
			seed: "persona-owner",
		});

		const rows = await store.query({ appId: APP_ID, caseType: "patient" });
		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows) expect(row.owner_id).toBe(PERSONA);
	});

	it("owns rows by the member when no persona is acting", async () => {
		const store = makeStore(PROJECT_A, OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");

		const result = await store.applySubmission(
			submissionEnvelopeArgs(
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
			),
		);
		const rows = await store.query({ appId: APP_ID, caseType: "patient" });
		expect(
			rows.find((r) => r.case_id === result.primaryCaseIds[0])?.owner_id,
		).toBe(OWNER_A);
	});
});

describe("readCases", () => {
	it("returns the empty arm when no rows exist", async () => {
		const store = makeStore(PROJECT_A, OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");

		const result = await readCases(store, {
			appId: APP_ID,
			caseType: "patient",
		});
		expect(result.kind).toBe("empty");
	});

	it("returns the rows arm with the inserted rows", async () => {
		const store = makeStore(PROJECT_A, OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");

		await store.insert({
			appId: APP_ID,
			row: {
				case_id: ALICE_CASE_ID,
				case_type: "patient",
				case_name: "test-case",
				status: "open",
				properties: { age: 30 },
			},
		});
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: BOB_CASE_ID,
				case_type: "patient",
				case_name: "test-case",
				status: "open",
				properties: { age: 45 },
			},
		});

		const result = await readCases(store, {
			appId: APP_ID,
			caseType: "patient",
		});
		expect(result.kind).toBe("rows");
		if (result.kind !== "rows") return;
		expect(result.rows).toHaveLength(2);
		const ids = result.rows.map((r) => r.case_id).sort();
		expect(ids).toEqual([ALICE_CASE_ID, BOB_CASE_ID].sort());
	});

	it("constrains a child case list to the complete selected-parent set", async () => {
		const store = makeStore(PROJECT_A, OWNER_A);
		const relationship = "child" as const;
		const visitCaseType = { ...VISIT_CASE_TYPE, relationship };
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE, visitCaseType]);
		await seedSchema(store, blueprint, "patient");
		await seedSchema(store, blueprint, "visit");
		for (const [caseId, name] of [
			[ALICE_CASE_ID, "Alice"],
			[BOB_CASE_ID, "Bob"],
		] as const) {
			await store.insert({
				appId: APP_ID,
				row: {
					case_id: caseId,
					case_type: "patient",
					case_name: name,
					status: "open",
					properties: {},
				},
			});
		}
		await store.insert({
			appId: APP_ID,
			parentRelationship: relationship,
			row: {
				case_id: VISIT_CASE_ID,
				case_type: "visit",
				case_name: "Alice visit",
				status: "open",
				parent_case_id: ALICE_CASE_ID,
				properties: {},
			},
		});
		const bobVisitId = "40000000-0000-0000-0000-000000000005";
		await store.insert({
			appId: APP_ID,
			parentRelationship: relationship,
			row: {
				case_id: bobVisitId,
				case_type: "visit",
				case_name: "Bob visit",
				status: "open",
				parent_case_id: BOB_CASE_ID,
				properties: {},
			},
		});

		const result = await readCases(store, {
			appId: APP_ID,
			caseType: "visit",
			caseTypeSchemas: buildCaseTypeMap(blueprint),
			parentCase: {
				caseType: "patient",
				caseIds: [BOB_CASE_ID, ALICE_CASE_ID],
			},
		});

		expect(result.kind).toBe("rows");
		if (result.kind !== "rows") return;
		expect(result.rows.map((row) => row.case_id).sort()).toEqual(
			[VISIT_CASE_ID, bobVisitId].sort(),
		);
		expect(result.constraintSource).toBe("authored-rules");
	});

	it("excludes extension links from selected-parent submenu rows and counts", async () => {
		const store = makeStore(PROJECT_A, OWNER_A);
		const blueprint = buildBlueprint([
			PATIENT_CASE_TYPE,
			{ ...VISIT_CASE_TYPE, relationship: "child" },
		]);
		await seedSchema(store, blueprint, "patient");
		await seedSchema(store, blueprint, "visit");
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: ALICE_CASE_ID,
				case_type: "patient",
				case_name: "Alice",
				status: "open",
				properties: {},
			},
		});
		await store.insert({
			appId: APP_ID,
			parentRelationship: "child",
			row: {
				case_id: VISIT_CASE_ID,
				case_type: "visit",
				case_name: "Alice child visit",
				status: "open",
				parent_case_id: ALICE_CASE_ID,
				properties: {},
			},
		});
		const extensionCaseId = "40000000-0000-0000-0000-000000000006";
		await store.insert({
			appId: APP_ID,
			parentRelationship: "extension",
			row: {
				case_id: extensionCaseId,
				case_type: "visit",
				case_name: "Alice host extension",
				status: "open",
				parent_case_id: ALICE_CASE_ID,
				properties: {},
			},
		});

		const result = await readCases(store, {
			appId: APP_ID,
			caseType: "visit",
			caseTypeSchemas: buildCaseTypeMap(blueprint),
			parentCase: { caseType: "patient", caseIds: [ALICE_CASE_ID] },
			page: { offset: 0, limit: 50 },
		});

		expect(result.kind).toBe("rows");
		if (result.kind !== "rows") return;
		expect(result.rows.map((row) => row.case_id)).toEqual([VISIT_CASE_ID]);
		expect(result.totalCount).toBe(1);
		expect(result.constraintSource).toBe("authored-rules");
	});

	it("counts authored matches inside the selected parent when Search is empty", async () => {
		const store = makeStore(PROJECT_A, OWNER_A);
		const blueprint = buildBlueprint([
			PATIENT_CASE_TYPE,
			{ ...VISIT_CASE_TYPE, relationship: "child" },
		]);
		await seedSchema(store, blueprint, "patient");
		await seedSchema(store, blueprint, "visit");
		for (const [caseId, name] of [
			[ALICE_CASE_ID, "Alice"],
			[BOB_CASE_ID, "Bob"],
		] as const) {
			await store.insert({
				appId: APP_ID,
				row: {
					case_id: caseId,
					case_type: "patient",
					case_name: name,
					status: "open",
					properties: {},
				},
			});
		}
		await store.insert({
			appId: APP_ID,
			parentRelationship: "child",
			row: {
				case_id: VISIT_CASE_ID,
				case_type: "visit",
				case_name: "Bob visit",
				status: "open",
				parent_case_id: BOB_CASE_ID,
				properties: {},
			},
		});

		const result = await readCases(store, {
			appId: APP_ID,
			caseType: "visit",
			caseTypeSchemas: buildCaseTypeMap(blueprint),
			parentCase: { caseType: "patient", caseIds: [ALICE_CASE_ID] },
			caseListConfig: resolveCaseListConfig({
				columns: [],
				searchInputs: [
					simpleSearchInputDef(
						READCASES_PRIMARY_INPUT_UUID,
						"name",
						"Name",
						"text",
						"case_name",
						{ mode: exactMode() },
					),
				],
			}),
			inputValues: new Map([["name", "Bob visit"]]),
			page: { offset: 0, limit: 50 },
		});

		expect(result).toEqual({
			kind: "empty",
			constraintSource: "worker-search",
			authoredMatchingCount: 0,
		});
	});

	// The reveal beside Results is the ONLY consumer of the whole-tenant count
	// behind `outsideRestoreCount`. It is a second `store.count` over the same
	// predicate with the restriction lifted, so a path that draws nothing must
	// not pay for it.
	describe("the restore-scope reveal", () => {
		// Two rows in ONE tenant under two different owners. `owner_id` is
		// stamped by the store from the identity it is bound to, never named
		// on the insert, so the second row needs a second store — the same
		// member acting as a different worker.
		async function seedTwoOwners(): Promise<CaseStore> {
			const store = makeStore(PROJECT_A, OWNER_A);
			const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
			await seedSchema(store, blueprint, "patient");
			await store.insert({
				appId: APP_ID,
				row: {
					case_id: ALICE_CASE_ID,
					case_type: "patient",
					case_name: "mine",
					status: "open",
					properties: { age: 30 },
				},
			});
			await makeStore(PROJECT_A, OWNER_A, OWNER_B).insert({
				appId: APP_ID,
				row: {
					case_id: BOB_CASE_ID,
					case_type: "patient",
					case_name: "theirs",
					status: "open",
					properties: { age: 45 },
				},
			});
			return store;
		}

		it("counts what a bounded read left out", async () => {
			const store = await seedTwoOwners();
			const result = await readCases(store, {
				appId: APP_ID,
				caseType: "patient",
				page: { offset: 0, limit: 10 },
				restoreScope: { ownerIds: [OWNER_A] },
			});
			expect(result.kind).toBe("rows");
			if (result.kind !== "rows") return;
			expect(result.rows.map((row) => row.case_id)).toEqual([ALICE_CASE_ID]);
			expect(result.outsideRestoreCount).toBe(1);
		});

		it("counts what an empty bounded read left out", async () => {
			const store = await seedTwoOwners();
			const result = await readCases(store, {
				appId: APP_ID,
				caseType: "patient",
				page: { offset: 0, limit: 10 },
				restoreScope: { ownerIds: ["owner-nobody"] },
			});
			expect(result.kind).toBe("empty");
			if (result.kind !== "empty") return;
			// The screen renders this INSTEAD of "no case data", which would be
			// the only other reading of an empty list over a populated project.
			expect(result.outsideRestoreCount).toBe(2);
		});

		it("stays silent on the unpaged read, which draws nothing", async () => {
			const store = await seedTwoOwners();
			const counts = vi.spyOn(store, "count");
			const result = await readCases(store, {
				appId: APP_ID,
				caseType: "patient",
				restoreScope: { ownerIds: [OWNER_A] },
			});
			expect(result.kind).toBe("rows");
			if (result.kind !== "rows") return;
			// Still RESTRICTED — the form's auto-selection candidate read may
			// only offer a case the worker's device would hold.
			expect(result.rows.map((row) => row.case_id)).toEqual([ALICE_CASE_ID]);
			expect(result.outsideRestoreCount).toBeUndefined();
			expect(counts).not.toHaveBeenCalled();
			counts.mockRestore();
		});

		// The unpaged read that matches NOTHING. Its sibling above proves the
		// rows exit stays silent; this one pins the empty exit, which is the
		// easier of the two to lose — a reader returning empty has three
		// places to say why, and only one of them is on the paged path.
		it("stays silent on an unpaged read that matches nothing", async () => {
			const store = await seedTwoOwners();
			const counts = vi.spyOn(store, "count");
			const result = await readCases(store, {
				appId: APP_ID,
				caseType: "patient",
				restoreScope: { ownerIds: ["owner-nobody"] },
			});
			expect(result.kind).toBe("empty");
			if (result.kind !== "empty") return;
			expect(result.outsideRestoreCount).toBeUndefined();
			// The whole point: a read that draws nothing must not pay a
			// whole-tenant count to populate a field no one renders.
			expect(counts).not.toHaveBeenCalled();
			counts.mockRestore();
		});

		it("stays silent when no restore is bound", async () => {
			const store = await seedTwoOwners();
			const result = await readCases(store, {
				appId: APP_ID,
				caseType: "patient",
				page: { offset: 0, limit: 10 },
			});
			expect(result.kind).toBe("rows");
			if (result.kind !== "rows") return;
			expect(result.rows).toHaveLength(2);
			expect(result.outsideRestoreCount).toBeUndefined();
		});
	});

	it("returns stable bounded windows with honest totals and clamps a stale offset", async () => {
		const store = makeStore(PROJECT_A, OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");
		// The unsorted list orders by the durable `(opened_on, case_id)`
		// fact — creation time first, id purely as tie-break — so ids are
		// deliberately OUT of id order while `opened_on` fixes the pages.
		const caseIds = [
			"10000000-0000-0000-0000-000000000003",
			"10000000-0000-0000-0000-000000000001",
			"10000000-0000-0000-0000-000000000002",
		];
		for (const [index, caseId] of caseIds.entries()) {
			await store.insert({
				appId: APP_ID,
				row: {
					case_id: caseId,
					case_type: "patient",
					case_name: `Patient ${index + 1}`,
					status: "open",
					opened_on: new Date(Date.UTC(2026, 0, index + 1)),
					properties: { age: 20 + index },
				},
			});
		}

		const firstPage = await readCases(store, {
			appId: APP_ID,
			caseType: "patient",
			page: { offset: 0, limit: 2 },
		});
		expect(firstPage).toMatchObject({
			kind: "rows",
			totalCount: 3,
			pageOffset: 0,
			pageSize: 2,
		});
		if (firstPage.kind !== "rows") return;
		expect(firstPage.rows.map((row) => row.case_id)).toEqual(
			caseIds.slice(0, 2),
		);

		const staleFinalPage = await readCases(store, {
			appId: APP_ID,
			caseType: "patient",
			page: { offset: 100, limit: 2 },
		});
		expect(staleFinalPage).toMatchObject({
			kind: "rows",
			totalCount: 3,
			pageOffset: 2,
			pageSize: 2,
		});
		if (staleFinalPage.kind !== "rows") return;
		expect(staleFinalPage.rows.map((row) => row.case_id)).toEqual([caseIds[2]]);
	});

	it("recounts and retries once when a delete empties the counted page", async () => {
		let backingRows = Array.from({ length: 51 }, (_, index) => ({
			...buildSyntheticRow({ name: `Patient ${index + 1}` }),
			case_id: `10000000-0000-0000-0000-${String(index + 1).padStart(12, "0")}`,
			calculated: {},
		}));
		const count = vi.fn(async () => backingRows.length);
		const query = vi.fn(async (args) => {
			if (query.mock.calls.length === 1) {
				// The store's backing population mutates after COUNT observed 51
				// rows but before the first SELECT applies its offset.
				backingRows = backingRows.slice(0, 50);
			}
			const offset = args.offset ?? 0;
			return backingRows.slice(
				offset,
				offset + (args.limit ?? backingRows.length),
			);
		});
		const racingStore = { count, query } as unknown as CaseStore;

		const result = await readCases(racingStore, {
			appId: APP_ID,
			caseType: "patient",
			page: { offset: 50, limit: 50 },
		});

		expect(result).toMatchObject({
			kind: "rows",
			totalCount: 50,
			pageOffset: 0,
			pageSize: 50,
		});
		if (result.kind !== "rows") return;
		expect(result.rows).toHaveLength(50);
		expect(count).toHaveBeenCalledTimes(2);
		expect(query).toHaveBeenCalledTimes(2);
		expect(query.mock.calls.map(([args]) => args.offset)).toEqual([50, 0]);
		expect(query.mock.calls.map(([args]) => args.limit)).toEqual([50, 50]);
	});

	it("uses Results order, not Details order, to break equal sort priorities", async () => {
		const store = makeStore(PROJECT_A, OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");

		const CAROL_CASE_ID = "40000000-0000-0000-0000-000000000003";
		for (const row of [
			{ caseId: ALICE_CASE_ID, name: "A", age: 2 },
			{ caseId: BOB_CASE_ID, name: "A", age: 1 },
			{ caseId: CAROL_CASE_ID, name: "B", age: 0 },
		]) {
			await store.insert({
				appId: APP_ID,
				row: {
					case_id: row.caseId,
					case_type: "patient",
					case_name: row.name,
					status: "open",
					properties: { age: row.age },
				},
			});
		}

		const result = await readCases(store, {
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: buildCaseTypeMap(blueprint),
			caseListConfig: resolveCaseListConfig({
				columns: [
					plainColumn(NAME_COLUMN_UUID, "case_name", "Name", {
						sort: { direction: "asc", priority: 0 },
					}),
					plainColumn(
						testUuid("10000000-0000-0000-0000-000000000003"),
						"age",
						"Age",
						{
							sort: { direction: "asc", priority: 0 },
						},
					),
				],
				searchInputs: [],
			}),
		});

		expect(result.kind).toBe("rows");
		if (result.kind !== "rows") return;
		// Results order makes `name` primary, then `age`: B, A, C. If
		// Details order leaked into sorting, `age` would lead: C, B, A.
		expect(result.rows.map((row) => row.case_id)).toEqual([
			BOB_CASE_ID,
			ALICE_CASE_ID,
			CAROL_CASE_ID,
		]);
	});

	it("respects tenant scope — Project B sees an empty case-type that Project A populated", async () => {
		const storeA = makeStore(PROJECT_A, OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
		await seedSchema(storeA, blueprint, "patient");
		await storeA.insert({
			appId: APP_ID,
			row: {
				case_id: ALICE_CASE_ID,
				case_type: "patient",
				case_name: "test-case",
				status: "open",
				properties: { age: 30 },
			},
		});

		const storeB = makeStore(PROJECT_B, OWNER_B);
		const result = await readCases(storeB, {
			appId: APP_ID,
			caseType: "patient",
		});
		expect(result.kind).toBe("empty");
	});

	it("uses the same session bindings for the page count, filter, sort, and projection", async () => {
		const store = makeStore(PROJECT_A, OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: ALICE_CASE_ID,
				case_type: "patient",
				case_name: "Alice",
				status: "open",
				properties: { age: 30 },
			},
		});
		const regionUuid = testUuid("00000000-0000-0000-0000-000000000b01");
		const bindings = {
			sessionContext: new Map([["userid", OWNER_A]]),
			sessionUser: new Map<string, string>(),
			sessionUserFallback: "",
		};

		const result = await readCases(store, {
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: buildCaseTypeMap(blueprint),
			bindings,
			caseListConfig: resolveCaseListConfig({
				columns: [
					calculatedColumn(regionUuid, "Region", term(sessionUser("region")), {
						visibleInList: true,
						sort: { direction: "asc", priority: 0 },
					}),
				],
				searchInputs: [],
				filter: eq(prop("patient", "owner_id"), sessionContext("userid")),
			}),
			page: { offset: 0, limit: 50 },
		});

		expect(result).toMatchObject({ kind: "rows", totalCount: 1 });
		if (result.kind !== "rows") return;
		expect(result.rows[0]?.calculated[regionUuid]).toBe("");
	});
});

describe("readCases — grouped tile", () => {
	/**
	 * Two patients with two visits each, interleaved by name, plus one
	 * visit with no patient at all. Sorting by name puts Ada, Ben, Cal,
	 * Dot in that order, so a result that shows whole groups is really
	 * showing the clustering rather than the sort.
	 */
	async function seedVisits(store: CaseStore) {
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE, VISIT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");
		await seedSchema(store, blueprint, "visit");
		const parents: string[] = [];
		for (const name of ["North", "South"]) {
			const { caseId } = await store.insert({
				appId: APP_ID,
				row: {
					case_type: "patient",
					case_name: name,
					status: "open",
					properties: {},
				},
			});
			parents.push(caseId);
		}
		for (const [name, parent] of [
			["Ada", parents[0]],
			["Ben", parents[1]],
			["Cal", parents[0]],
			["Dot", parents[1]],
		] as const) {
			await store.insert({
				appId: APP_ID,
				row: {
					case_type: "visit",
					case_name: name,
					status: "open",
					parent_case_id: parent,
					properties: { notes: name },
				},
			});
		}
		await store.insert({
			appId: APP_ID,
			row: {
				case_type: "visit",
				case_name: "Eve",
				status: "open",
				properties: { notes: "Eve" },
			},
		});
		return { blueprint, north: parents[0], south: parents[1] };
	}

	const groupedConfig = (headerRows = 1) =>
		makeCaseListConfig({
			columns: [
				plainColumn(NAME_COLUMN_UUID, "case_name", "Visit", {
					sort: { direction: "asc", priority: 0 },
					tile: tileCell(0, 0, 6, 1),
				}),
			],
			tile: { grouping: { identifier: "parent", headerRows } },
		});

	it("clusters the page, counts the window in groups, and keeps rows flat beside it", async () => {
		const store = makeStore(PROJECT_A, OWNER_A);
		const { blueprint, north, south } = await seedVisits(store);

		const result = await readCases(store, {
			appId: APP_ID,
			caseType: "visit",
			caseTypeSchemas: buildCaseTypeMap(blueprint),
			caseListConfig: groupedConfig(),
			page: { offset: 0, limit: 2 },
		});

		expect(result.kind).toBe("rows");
		if (result.kind !== "rows") return;
		// Two GROUPS on the page, four cases in them: a grouped page is
		// unbounded in rows, exactly as `getEntitiesForCurrentPage` is.
		expect(result.grouped?.groups.map((group) => group.key)).toEqual([
			north,
			south,
		]);
		expect(
			result.grouped?.groups.map((group) =>
				group.rows.map((row) => row.case_name),
			),
		).toEqual([
			["Ada", "Cal"],
			["Ben", "Dot"],
		]);
		expect(result.grouped?.pageOffset).toBe(0);
		expect(result.grouped?.pageSize).toBe(2);
		// Three groups (North, South, and Eve's empty key) over five cases.
		expect(result.grouped?.totalGroupCount).toBe(3);
		expect(result.totalCount).toBe(5);
		// `totalCount` counts CASES in both shapes, and the flat `rows` slot
		// stays the page in clustered order so every row-reading consumer
		// keeps working unchanged.
		expect(result.rows.map((row) => row.case_name)).toEqual([
			"Ada",
			"Cal",
			"Ben",
			"Dot",
		]);
		// A grouped read reports no ROW window — its window counts groups.
		expect(result.pageOffset).toBeUndefined();
		expect(result.pageSize).toBeUndefined();
	});

	it("puts every case with no such connection in one group", async () => {
		const store = makeStore(PROJECT_A, OWNER_A);
		const { blueprint } = await seedVisits(store);

		const result = await readCases(store, {
			appId: APP_ID,
			caseType: "visit",
			caseTypeSchemas: buildCaseTypeMap(blueprint),
			caseListConfig: groupedConfig(),
			page: { offset: 2, limit: 2 },
		});

		expect(result.kind).toBe("rows");
		if (result.kind !== "rows") return;
		// The empty key is what `string(./index/parent)` evaluates to on the
		// device for a parentless child, so the collapse is the runtime's,
		// not a synthetic bucket Nova invented.
		expect(result.grouped?.groups).toEqual([
			expect.objectContaining({ key: "" }),
		]);
		expect(result.rows.map((row) => row.case_name)).toEqual(["Eve"]);
	});

	it("reclamps a page past the last group instead of reporting an empty list", async () => {
		const store = makeStore(PROJECT_A, OWNER_A);
		const { blueprint } = await seedVisits(store);

		const result = await readCases(store, {
			appId: APP_ID,
			caseType: "visit",
			caseTypeSchemas: buildCaseTypeMap(blueprint),
			caseListConfig: groupedConfig(),
			page: { offset: 100, limit: 2 },
		});

		expect(result.kind).toBe("rows");
		if (result.kind !== "rows") return;
		expect(result.grouped?.pageOffset).toBe(2);
		expect(result.grouped?.totalGroupCount).toBe(3);
		expect(result.rows.map((row) => row.case_name)).toEqual(["Eve"]);
	});

	it("leaves an unpaged read flat, because grouping is a list's shape", async () => {
		const store = makeStore(PROJECT_A, OWNER_A);
		const { blueprint } = await seedVisits(store);

		// The form's auto-selection read wants the complete candidate set and
		// draws no list, so it stays on the ordinary path even here.
		const result = await readCases(store, {
			appId: APP_ID,
			caseType: "visit",
			caseTypeSchemas: buildCaseTypeMap(blueprint),
			caseListConfig: groupedConfig(),
		});

		expect(result.kind).toBe("rows");
		if (result.kind !== "rows") return;
		expect(result.grouped).toBeUndefined();
		expect(result.rows).toHaveLength(5);
	});
});

const READCASES_PRIMARY_INPUT_UUID = testUuid(
	"60000000-0000-0000-0000-000000000001",
);

const READCASES_SECONDARY_INPUT_UUID = testUuid(
	"60000000-0000-0000-0000-000000000002",
);

const READCASES_ADVANCED_INPUT_UUID = testUuid(
	"60000000-0000-0000-0000-000000000003",
);

describe("readCases — running-app search-input composition", () => {
	it("excludes resolved owner ids inside the case-store query", async () => {
		const store = makeStore(PROJECT_A, OWNER_A);
		const excludedOwnerStore = makeStore(PROJECT_A, OWNER_A, "excluded-owner");
		const visibleOwnerStore = makeStore(PROJECT_A, OWNER_A, "visible-owner");
		const unownedCaseId = "40000000-0000-0000-0000-000000000003";
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");
		await excludedOwnerStore.insert({
			appId: APP_ID,
			row: {
				case_id: ALICE_CASE_ID,
				case_type: "patient",
				case_name: "Alice",
				status: "open",
				properties: { age: 30 },
			},
		});
		await visibleOwnerStore.insert({
			appId: APP_ID,
			row: {
				case_id: BOB_CASE_ID,
				case_type: "patient",
				case_name: "Bob",
				status: "open",
				properties: { age: 40 },
			},
		});
		await visibleOwnerStore.insert({
			appId: APP_ID,
			row: {
				case_id: unownedCaseId,
				case_type: "patient",
				case_name: "Unowned",
				status: "open",
				properties: { age: 50 },
			},
		});
		/* Historical/imported rows may carry no CommCare owner. SQL's
		 * three-valued logic makes `NOT (NULL IN (...))` unknown, so mutate
		 * this fixture to the nullable storage shape and pin that owner
		 * exclusion keeps it visible. */
		await (dbHandle.db as unknown as Kysely<Database>)
			.updateTable("cases")
			.set({ owner_id: null })
			.where("case_id", "=", unownedCaseId)
			.execute();

		const result = await readCases(store, {
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: buildCaseTypeMap(blueprint),
			caseListConfig: emptyCaseListConfig(),
			excludedOwnerIds: ["excluded-owner"],
		});

		expect(result.kind).toBe("rows");
		if (result.kind !== "rows") return;
		expect(result.rows.map((row) => [row.case_id, row.owner_id])).toEqual([
			[BOB_CASE_ID, "visible-owner"],
			[unownedCaseId, null],
		]);
	});

	it("reads as before when caseListConfig has no search inputs (filter alone)", async () => {
		// Pins the no-runtime-contribution short-circuit. The helper
		// MUST pass `caseListConfig.filter` through to `store.query`
		// verbatim when `searchInputs` is empty — the running-app
		// fallback when the author hasn't declared any inputs.
		const store = makeStore(PROJECT_A, OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: ALICE_CASE_ID,
				case_type: "patient",
				case_name: "Alice",
				status: "open",
				properties: { age: 25 },
			},
		});
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: BOB_CASE_ID,
				case_type: "patient",
				case_name: "Bob",
				status: "open",
				properties: { age: 40 },
			},
		});

		const result = await readCases(store, {
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: buildCaseTypeMap(blueprint),
			caseListConfig: resolveCaseListConfig({
				columns: [],
				searchInputs: [],
				// `age > 30` — only Bob matches the always-on filter.
				filter: gt(prop("patient", "age"), literal(30)),
			}),
			// Even with `inputValues` defined, the helper must skip
			// `composeRuntimeFilter` because `searchInputs.length === 0`.
			inputValues: new Map(),
		});
		expect(result.kind).toBe("rows");
		if (result.kind !== "rows") return;
		expect(result.rows).toHaveLength(1);
		expect(result.rows[0]?.case_id).toBe(BOB_CASE_ID);
	});

	it("narrows the row set when a simple-arm exact input matches a single row", async () => {
		// Simple-arm dispatch with `exact` mode. Two cases differ on
		// the standard `case_name` scalar; typing one value into the input must
		// drop the other from the result.
		const store = makeStore(PROJECT_A, OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: ALICE_CASE_ID,
				case_type: "patient",
				case_name: "Alice",
				status: "open",
				properties: { age: 30 },
			},
		});
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: BOB_CASE_ID,
				case_type: "patient",
				case_name: "Bob",
				status: "open",
				properties: { age: 40 },
			},
		});

		const result = await readCases(store, {
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: buildCaseTypeMap(blueprint),
			caseListConfig: resolveCaseListConfig({
				columns: [],
				searchInputs: [
					simpleSearchInputDef(
						READCASES_PRIMARY_INPUT_UUID,
						"name",
						"Name",
						"text",
						"case_name",
						{ mode: exactMode() },
					),
				],
			}),
			inputValues: new Map([["name", "Alice"]]),
		});
		expect(result.kind).toBe("rows");
		if (result.kind !== "rows") return;
		expect(result.rows).toHaveLength(1);
		expect(result.rows[0]?.case_id).toBe(ALICE_CASE_ID);
	});

	it("narrows the row set when an advanced-arm input substitutes its value", async () => {
		// Advanced-arm: the input's `predicate` AST carries an
		// `input(name)` term reference; `composeRuntimeFilter`'s
		// substituter walks the AST and binds the typed value at every
		// value-position match before the predicate reaches
		// `store.query(...)`.
		const store = makeStore(PROJECT_A, OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: ALICE_CASE_ID,
				case_type: "patient",
				case_name: "Alice",
				status: "open",
				properties: { age: 30 },
			},
		});
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: BOB_CASE_ID,
				case_type: "patient",
				case_name: "Bob",
				status: "open",
				properties: { age: 40 },
			},
		});

		// `prop("name") starts-with input("name_prefix")` — the
		// `inputValues` map binds "Al" at the substitution site, so
		// only Alice survives.
		const result = await readCases(store, {
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: buildCaseTypeMap(blueprint),
			caseListConfig: resolveCaseListConfig({
				columns: [],
				searchInputs: [
					advancedSearchInputDef(
						READCASES_ADVANCED_INPUT_UUID,
						"name_prefix",
						"Name starts with",
						"text",
						// Wire-shape: match(prop(...), "starts-with", input(...))
						{
							kind: "match",
							property: prop("patient", "case_name"),
							value: {
								kind: "term",
								term: input(READCASES_ADVANCED_INPUT_UUID),
							},
							mode: "starts-with",
						},
					),
				],
			}),
			inputValues: new Map([["name_prefix", "Al"]]),
		});
		expect(result.kind).toBe("rows");
		if (result.kind !== "rows") return;
		expect(result.rows).toHaveLength(1);
		expect(result.rows[0]?.case_id).toBe(ALICE_CASE_ID);
	});

	it("binds a wrapped input in the always-on filter and neutralizes its absent gate", async () => {
		const store = makeStore(PROJECT_A, OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: ALICE_CASE_ID,
				case_type: "patient",
				case_name: "Alice",
				status: "open",
				properties: { age: 30 },
			},
		});
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: BOB_CASE_ID,
				case_type: "patient",
				case_name: "Bob",
				status: "open",
				properties: { age: 40 },
			},
		});
		const caseListConfig: CaseListConfig = resolveCaseListConfig({
			columns: [],
			searchInputs: [
				advancedSearchInputDef(
					READCASES_ADVANCED_INPUT_UUID,
					"name_filter",
					"Name",
					"text",
					matchAll(),
				),
			],
			filter: whenInput(
				input(READCASES_ADVANCED_INPUT_UUID),
				eq(prop("patient", "case_name"), input(READCASES_ADVANCED_INPUT_UUID)),
			),
		});

		const present = await readCases(store, {
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: buildCaseTypeMap(blueprint),
			caseListConfig,
			inputValues: new Map([["name_filter", "Alice"]]),
		});
		expect(present.kind).toBe("rows");
		if (present.kind !== "rows") return;
		expect(present.rows.map((row) => row.case_id)).toEqual([ALICE_CASE_ID]);
		expect(present.constraintSource).toBe("worker-search");

		const absent = await readCases(store, {
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: buildCaseTypeMap(blueprint),
			caseListConfig,
		});
		expect(absent.kind).toBe("rows");
		if (absent.kind !== "rows") return;
		expect(absent.rows).toHaveLength(2);
		expect(absent.constraintSource).toBe("unconstrained");
	});

	it("AND-composes multiple contributing inputs across simple-arm modes", async () => {
		// Mixed-arm composition: a `select` exact match on `status`
		// AND a `text` starts-with match on `name`. Each contributes
		// a clause; the helper folds them into one conjunction that
		// reaches `store.query`. Three cases sit in the store; only
		// the row matching BOTH inputs survives.
		const store = makeStore(PROJECT_A, OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");
		const CAROL_CASE_ID = "40000000-0000-0000-0000-000000000003";
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: ALICE_CASE_ID,
				case_type: "patient",
				case_name: "Alice",
				status: "open",
				properties: { age: 30 },
			},
		});
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: BOB_CASE_ID,
				case_type: "patient",
				case_name: "Bob",
				// Bob's status is closed — the status input drops him.
				status: "closed",
				properties: { age: 40 },
			},
		});
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: CAROL_CASE_ID,
				case_type: "patient",
				case_name: "Carol",
				// Carol matches the status input but not the name input.
				status: "open",
				properties: { age: 35 },
			},
		});

		const result = await readCases(store, {
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: buildCaseTypeMap(blueprint),
			caseListConfig: resolveCaseListConfig({
				columns: [],
				searchInputs: [
					// `case_name` starts-with — text-mode input the widget
					// would render as a text field with a starts-with
					// mode. Matches Alice (starts with "Al"); skips Bob
					// + Carol.
					simpleSearchInputDef(
						READCASES_PRIMARY_INPUT_UUID,
						"name",
						"Name starts with",
						"text",
						"case_name",
						{ mode: startsWithMode() },
					),
					// `status` exact — text input. Matches
					// Alice + Carol; drops Bob.
					simpleSearchInputDef(
						READCASES_SECONDARY_INPUT_UUID,
						"status",
						"Status",
						"text",
						"status",
						{ mode: exactMode() },
					),
				],
			}),
			// `name=Al, status=open` — the intersection is Alice
			// alone.
			inputValues: new Map([
				["name", "Al"],
				["status", "open"],
			]),
		});
		expect(result.kind).toBe("rows");
		if (result.kind !== "rows") return;
		expect(result.rows).toHaveLength(1);
		expect(result.rows[0]?.case_id).toBe(ALICE_CASE_ID);
	});

	it("short-circuits to filter-only results when every search-input value is empty", async () => {
		// All-empty `inputValues`: `composeRuntimeFilter` returns
		// `match-all` (the conjunction-identity element), the helper
		// drops it before AND-composing, and the case-store sees the
		// same predicate it would have seen with the no-input
		// passthrough. The always-on `caseListConfig.filter` still
		// applies.
		const store = makeStore(PROJECT_A, OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: ALICE_CASE_ID,
				case_type: "patient",
				case_name: "Alice",
				status: "open",
				properties: { age: 25 },
			},
		});
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: BOB_CASE_ID,
				case_type: "patient",
				case_name: "Bob",
				status: "open",
				properties: { age: 40 },
			},
		});

		const result = await readCases(store, {
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: buildCaseTypeMap(blueprint),
			caseListConfig: resolveCaseListConfig({
				columns: [],
				searchInputs: [
					simpleSearchInputDef(
						READCASES_PRIMARY_INPUT_UUID,
						"name",
						"Name",
						"text",
						"case_name",
					),
				],
				// Filter only — `age > 30`. Bob alone survives.
				filter: gt(prop("patient", "age"), literal(30)),
			}),
			// Empty values bag — no runtime contribution. The
			// constructed predicate must equal the filter-only path.
			inputValues: new Map() satisfies SearchInputValues,
		});
		expect(result.kind).toBe("rows");
		if (result.kind !== "rows") return;
		expect(result.rows).toHaveLength(1);
		expect(result.rows[0]?.case_id).toBe(BOB_CASE_ID);
	});

	it("intersects an always-on rule and a search input on the same property", async () => {
		// Both halves deliberately target `case_name`. A compatible entered value
		// keeps Bob; a disagreeing value returns zero rows. That is ordinary AND
		// semantics, not an invalid configuration.
		const store = makeStore(PROJECT_A, OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: ALICE_CASE_ID,
				case_type: "patient",
				case_name: "Alice",
				status: "open",
				properties: { age: 25 },
			},
		});
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: BOB_CASE_ID,
				case_type: "patient",
				case_name: "Bob",
				status: "open",
				properties: { age: 40 },
			},
		});

		const result = await readCases(store, {
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: buildCaseTypeMap(blueprint),
			caseListConfig: resolveCaseListConfig({
				columns: [],
				searchInputs: [
					simpleSearchInputDef(
						READCASES_PRIMARY_INPUT_UUID,
						"name",
						"Name",
						"text",
						"case_name",
						{ mode: exactMode() },
					),
				],
				filter: eq(prop("patient", "case_name"), literal("Bob")),
			}),
			inputValues: new Map([["name", "Bob"]]),
		});
		expect(result.kind).toBe("rows");
		if (result.kind !== "rows") return;
		expect(result.rows).toHaveLength(1);
		expect(result.rows[0]?.case_id).toBe(BOB_CASE_ID);

		const noMatch = await readCases(store, {
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: buildCaseTypeMap(blueprint),
			caseListConfig: resolveCaseListConfig({
				columns: [],
				searchInputs: [
					simpleSearchInputDef(
						READCASES_PRIMARY_INPUT_UUID,
						"name",
						"Name",
						"text",
						"case_name",
						{ mode: exactMode() },
					),
				],
				filter: eq(prop("patient", "case_name"), literal("Bob")),
			}),
			inputValues: new Map([["name", "Alice"]]),
		});
		expect(noMatch).toEqual({
			kind: "empty",
			constraintSource: "worker-search",
			authoredMatchingCount: 1,
		});
	});

	it("keeps the selected final day for both date and UTC datetime range targets", async () => {
		const store = makeStore(PROJECT_A, OWNER_A);
		const blueprint = buildBlueprint([FORMATTED_PROPS_CASE_TYPE]);
		const caseTypeSchemas = buildCaseTypeMap(blueprint);
		await seedSchema(store, blueprint, "patient");
		const beforeRangeId = "40000000-0000-0000-0000-000000000011";
		const finalDayId = "40000000-0000-0000-0000-000000000012";
		const afterRangeId = "40000000-0000-0000-0000-000000000013";
		for (const row of [
			{
				case_id: beforeRangeId,
				case_name: "Before",
				properties: {
					dob: "2025-05-31",
					last_seen: "2025-05-31T23:59:59Z",
				},
			},
			{
				case_id: finalDayId,
				case_name: "Final day late",
				properties: {
					dob: "2025-06-30",
					// The regression: an inclusive `<= 2025-06-30::date` cast
					// excluded this valid same-day instant after midnight.
					last_seen: "2025-06-30T23:59:59Z",
				},
			},
			{
				case_id: afterRangeId,
				case_name: "After",
				properties: {
					dob: "2025-07-01",
					last_seen: "2025-07-01T00:00:00Z",
				},
			},
		] as const) {
			await store.insert({
				appId: APP_ID,
				row: {
					...row,
					case_type: "patient",
					status: "open",
				},
			});
		}

		const inputValues = new Map([
			["window:from", "2025-06-01"],
			["window:to", "2025-06-30"],
		]);
		const query = async (property: "dob" | "last_seen") =>
			readCases(store, {
				appId: APP_ID,
				caseType: "patient",
				caseTypeSchemas,
				caseListConfig: resolveCaseListConfig({
					columns: [],
					searchInputs: [
						simpleSearchInputDef(
							READCASES_PRIMARY_INPUT_UUID,
							"window",
							"Date window",
							"date-range",
							property,
						),
					],
				}),
				inputValues,
			});

		for (const property of ["dob", "last_seen"] as const) {
			const result = await query(property);
			expect(result.kind).toBe("rows");
			if (result.kind !== "rows") continue;
			expect(result.rows.map((row) => row.case_id)).toEqual([finalDayId]);
		}
	});
});

describe("resetSampleCases", () => {
	it("deletes the prior sample population and regenerates a fresh row set", async () => {
		// The helper wraps `CaseStore.resetSampleData` — the atomic
		// delete-then-regenerate path. After the call, the case-type
		// MUST hold `SAMPLE_CASE_DEFAULT_COUNT` rows with case_ids
		// that differ from the prior population (the store picks a
		// fresh seed at call time, so the regenerated rows have new
		// uuids and likely differ in property content).
		const store = makeStore(PROJECT_A, OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");

		// Seed the initial population so the reset has something to
		// drop. Snapshot the resulting case_ids — they're the
		// distinct-row check below.
		const seeded = await seedSampleCases(store, {
			appId: APP_ID,
			caseType: PATIENT_CASE_TYPE,
		});
		expect(seeded.kind).toBe("ok");
		if (seeded.kind !== "ok") return;
		expect(seeded.inserted).toBe(SAMPLE_CASE_DEFAULT_COUNT);
		const before = await readCases(store, {
			appId: APP_ID,
			caseType: "patient",
		});
		if (before.kind !== "rows") throw new Error("expected seeded rows");
		const beforeIds = new Set(before.rows.map((r) => r.case_id));

		const result = await resetSampleCases(store, {
			appId: APP_ID,
			caseType: PATIENT_CASE_TYPE,
		});
		expect(result.kind).toBe("ok");
		if (result.kind !== "ok") return;
		expect(result.inserted).toBe(SAMPLE_CASE_DEFAULT_COUNT);

		// Population after reset MUST equal the default count — the
		// helper deleted the old rows before regenerating.
		const after = await readCases(store, {
			appId: APP_ID,
			caseType: "patient",
		});
		if (after.kind !== "rows") throw new Error("expected regenerated rows");
		expect(after.rows).toHaveLength(SAMPLE_CASE_DEFAULT_COUNT);

		// Every regenerated row's case_id must be new — the reset
		// path generates fresh uuid v7 values, never reuses the
		// prior population's ids.
		for (const row of after.rows) {
			expect(beforeIds.has(row.case_id)).toBe(false);
		}
	});
});

describe("readCaseData", () => {
	it("returns the row arm for an existing case-id", async () => {
		const store = makeStore(PROJECT_A, OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: ALICE_CASE_ID,
				case_type: "patient",
				case_name: "test-case",
				status: "open",
				properties: { age: 30 },
			},
		});

		const result = await readCaseData(store, {
			appId: APP_ID,
			caseType: "patient",
			caseId: ALICE_CASE_ID,
			ancestorDepth: 5,
		});
		expect(result.kind).toBe("row");
		if (result.kind !== "row") return;
		expect(result.row.case_id).toBe(ALICE_CASE_ID);
		expect(result.row.properties).toEqual({ age: 30 });
		// A root case (no parent link) carries an empty ancestor chain.
		expect(result.ancestors).toEqual([]);
	});

	it("constrains an identity read through any direct non-extension index", async () => {
		const store = makeStore(PROJECT_A, OWNER_A);
		const blueprint = buildBlueprint([
			PATIENT_CASE_TYPE,
			{ ...VISIT_CASE_TYPE, relationship: "child" },
		]);
		await seedSchema(store, blueprint, "patient");
		await seedSchema(store, blueprint, "visit");
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: ALICE_CASE_ID,
				case_type: "patient",
				case_name: "Alice",
				status: "open",
				properties: {},
			},
		});
		await store.insert({
			appId: APP_ID,
			parentRelationship: "child",
			row: {
				case_id: VISIT_CASE_ID,
				case_type: "visit",
				case_name: "Custom-index visit",
				status: "open",
				parent_case_id: ALICE_CASE_ID,
				properties: {},
			},
		});
		const extensionCaseId = "40000000-0000-0000-0000-000000000006";
		await store.insert({
			appId: APP_ID,
			parentRelationship: "extension",
			row: {
				case_id: extensionCaseId,
				case_type: "visit",
				case_name: "Hosted visit",
				status: "open",
				parent_case_id: ALICE_CASE_ID,
				properties: {},
			},
		});
		/* Imported CommCare data may use a non-`parent` identifier. Keep the
		 * direct case index authoritative even when the compatibility column does
		 * not describe that edge. */
		await sql`
			UPDATE case_indices
			SET identifier = 'guardian'
			WHERE case_id = ${VISIT_CASE_ID}
		`.execute(dbHandle.db);
		await sql`
			UPDATE cases
			SET parent_case_id = NULL
			WHERE case_id = ${VISIT_CASE_ID}
		`.execute(dbHandle.db);

		const customIndex = await readCaseData(store, {
			appId: APP_ID,
			caseType: "visit",
			caseId: VISIT_CASE_ID,
			parentCase: { caseType: "patient", caseIds: [ALICE_CASE_ID] },
			ancestorDepth: 0,
		});
		expect(customIndex.kind).toBe("row");

		const extension = await readCaseData(store, {
			appId: APP_ID,
			caseType: "visit",
			caseId: extensionCaseId,
			parentCase: { caseType: "patient", caseIds: [ALICE_CASE_ID] },
			ancestorDepth: 0,
		});
		expect(extension).toEqual({ kind: "missing" });
	});

	it("projects calculated display values for an identity-loaded Details row", async () => {
		const store = makeStore(PROJECT_A, OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: ALICE_CASE_ID,
				case_type: "patient",
				case_name: "Alice",
				status: "open",
				properties: { age: 30 },
			},
		});
		const calculatedUuid = testUuid("00000000-0000-0000-0000-000000000d01");
		const caseListConfig: CaseListConfig = resolveCaseListConfig({
			columns: [
				calculatedColumn(
					calculatedUuid,
					"Age from calculation",
					term(prop("patient", "age")),
					{ visibleInList: false, visibleInDetail: true },
				),
			],
			searchInputs: [],
			// This filter deliberately excludes Alice. Identity-backed Details
			// enriches the selected row but must never inherit Results filtering.
			filter: matchNone(),
		});

		const result = await readCaseData(store, {
			appId: APP_ID,
			caseType: "patient",
			caseId: ALICE_CASE_ID,
			ancestorDepth: 0,
			caseListConfig,
			caseTypeSchemas: buildCaseTypeMap(blueprint),
		});

		expect(result.kind).toBe("row");
		if (result.kind !== "row") return;
		expect(result.row.case_id).toBe(ALICE_CASE_ID);
		expect(Number(result.row.calculated[calculatedUuid])).toBe(30);
	});

	it("projects a session-backed Details value with the device blank fallback", async () => {
		const store = makeStore(PROJECT_A, OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: ALICE_CASE_ID,
				case_type: "patient",
				case_name: "Alice",
				status: "open",
				properties: { age: 30 },
			},
		});
		const calculatedUuid = testUuid("00000000-0000-0000-0000-000000000d02");
		const result = await readCaseData(store, {
			appId: APP_ID,
			caseType: "patient",
			caseId: ALICE_CASE_ID,
			ancestorDepth: 0,
			caseListConfig: resolveCaseListConfig({
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
			caseTypeSchemas: buildCaseTypeMap(blueprint),
			bindings: {
				sessionUser: new Map(),
				sessionUserFallback: "",
			},
		});

		expect(result.kind).toBe("row");
		if (result.kind !== "row") return;
		expect(result.row.calculated[calculatedUuid]).toBe("");
	});

	it("walks the ancestor chain nearest-first onto the row arm", async () => {
		const store = makeStore(PROJECT_A, OWNER_A);
		const blueprint = buildBlueprint([
			HOUSEHOLD_CASE_TYPE,
			PATIENT_CASE_TYPE,
			VISIT_CASE_TYPE,
		]);
		await seedSchema(store, blueprint, "household");
		await seedSchema(store, blueprint, "patient");
		await seedSchema(store, blueprint, "visit");
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: HOUSEHOLD_CASE_ID,
				case_type: "household",
				case_name: "Smith household",
				status: "open",
				external_id: "HH-42",
				properties: { head_name: "John Smith" },
			},
		});
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: ALICE_CASE_ID,
				case_type: "patient",
				case_name: "Alice",
				status: "open",
				parent_case_id: HOUSEHOLD_CASE_ID,
				properties: { age: 30 },
			},
		});
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: VISIT_CASE_ID,
				case_type: "visit",
				case_name: "Visit 1",
				status: "open",
				parent_case_id: ALICE_CASE_ID,
				properties: { notes: "initial" },
			},
		});

		const result = await readCaseData(store, {
			appId: APP_ID,
			caseType: "visit",
			caseId: VISIT_CASE_ID,
			ancestorDepth: 5,
		});
		expect(result.kind).toBe("row");
		if (result.kind !== "row") return;
		expect(result.ancestors.map((a) => a.case_id)).toEqual([
			ALICE_CASE_ID,
			HOUSEHOLD_CASE_ID,
		]);
		// The rows are full `CaseRow`s — the form engine flattens them
		// per type, so the property bags must arrive intact.
		expect(result.ancestors[1]?.properties).toEqual({
			head_name: "John Smith",
		});
		// `external_id` rides the traverse projection like every other
		// reserved scalar — an ancestor's `#<type>/external_id` must
		// preview the same value the wire's casedb walk returns.
		expect(result.ancestors[1]?.external_id).toBe("HH-42");
	});

	it("walks only as deep as the requested ancestorDepth", async () => {
		const store = makeStore(PROJECT_A, OWNER_A);
		const blueprint = buildBlueprint([
			HOUSEHOLD_CASE_TYPE,
			PATIENT_CASE_TYPE,
			VISIT_CASE_TYPE,
		]);
		await seedSchema(store, blueprint, "household");
		await seedSchema(store, blueprint, "patient");
		await seedSchema(store, blueprint, "visit");
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: HOUSEHOLD_CASE_ID,
				case_type: "household",
				case_name: "Smith household",
				status: "open",
				properties: {},
			},
		});
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: ALICE_CASE_ID,
				case_type: "patient",
				case_name: "Alice",
				status: "open",
				parent_case_id: HOUSEHOLD_CASE_ID,
				properties: {},
			},
		});
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: VISIT_CASE_ID,
				case_type: "visit",
				case_name: "Visit 1",
				status: "open",
				parent_case_id: ALICE_CASE_ID,
				properties: {},
			},
		});

		// Depth 1: only the direct parent — the caller's blueprint says
		// no ref can address deeper, so no deeper hop is paid for.
		const shallow = await readCaseData(store, {
			appId: APP_ID,
			caseType: "visit",
			caseId: VISIT_CASE_ID,
			ancestorDepth: 1,
		});
		expect(shallow.kind).toBe("row");
		if (shallow.kind !== "row") return;
		expect(shallow.ancestors.map((a) => a.case_id)).toEqual([ALICE_CASE_ID]);

		// Depth 0 (and any non-finite/negative garbage a crafted request
		// could send) clamps to no walk at all.
		const none = await readCaseData(store, {
			appId: APP_ID,
			caseType: "visit",
			caseId: VISIT_CASE_ID,
			ancestorDepth: Number.NaN,
		});
		expect(none.kind).toBe("row");
		if (none.kind !== "row") return;
		expect(none.ancestors).toEqual([]);
	});

	it("degrades to the partial chain when a hop throws mid-walk", async () => {
		const store = makeStore(PROJECT_A, OWNER_A);
		const blueprint = buildBlueprint([
			HOUSEHOLD_CASE_TYPE,
			PATIENT_CASE_TYPE,
			VISIT_CASE_TYPE,
		]);
		await seedSchema(store, blueprint, "household");
		await seedSchema(store, blueprint, "patient");
		await seedSchema(store, blueprint, "visit");
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: HOUSEHOLD_CASE_ID,
				case_type: "household",
				case_name: "Smith household",
				status: "open",
				properties: {},
			},
		});
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: ALICE_CASE_ID,
				case_type: "patient",
				case_name: "Alice",
				status: "open",
				parent_case_id: HOUSEHOLD_CASE_ID,
				properties: {},
			},
		});
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: VISIT_CASE_ID,
				case_type: "visit",
				case_name: "Visit 1",
				status: "open",
				parent_case_id: ALICE_CASE_ID,
				properties: {},
			},
		});

		// The chain is enrichment: the second hop's failure must not
		// fail a load whose essential row (and first ancestor) already
		// succeeded — the unreached namespace just reads blank. Explicit
		// per-method delegation (a spread would miss the class
		// prototype's methods), same shape as `schemaHealingCaseStore`.
		let calls = 0;
		const flaky: CaseStore = {
			query: (a) => store.query(a),
			readDeviceCaseDatabase: (a) => store.readDeviceCaseDatabase(a),
			readCaseDatabasePatch: (a) => store.readCaseDatabasePatch(a),
			queryGrouped: (a) => store.queryGrouped(a),
			count: (a) => store.count(a),
			insert: (a) => store.insert(a),
			applySubmission: (a) => store.applySubmission(a),
			update: (a) => store.update(a),
			close: (a) => store.close(a),
			traverse: (a) => {
				calls += 1;
				if (calls > 1) throw new Error("connection dropped mid-walk");
				return store.traverse(a);
			},
			applySchemaChange: (a) => store.applySchemaChange(a),
			unparkValues: (a) => store.unparkValues(a),
			conversionImpact: (a) => store.conversionImpact(a),
			listParkedValues: (a) => store.listParkedValues(a),
			restoreParkedValues: (a) => store.restoreParkedValues(a),
			setParkedValuesDismissed: (a) => store.setParkedValuesDismissed(a),
			replaceParkedValue: (a) => store.replaceParkedValue(a),
			generateSampleData: (a) => store.generateSampleData(a),
			resetSampleData: (a) => store.resetSampleData(a),
		};
		const result = await readCaseData(flaky, {
			appId: APP_ID,
			caseType: "visit",
			caseId: VISIT_CASE_ID,
			ancestorDepth: 5,
		});
		expect(result.kind).toBe("row");
		if (result.kind !== "row") return;
		expect(result.ancestors.map((a) => a.case_id)).toEqual([ALICE_CASE_ID]);
	});

	it("ends the walk at a dangling parent link without erroring", async () => {
		const store = makeStore(PROJECT_A, OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");
		const deletedParentId = "40000000-0000-0000-0000-00000000dead";
		/* Relationship writes now require a live, tenant-local parent. Create a
		 * valid relationship first, then delete the parent below the store
		 * boundary to reproduce a legacy/imported dangling edge. The read path
		 * must remain defensive even though new writes are valid by construction. */
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: deletedParentId,
				case_type: "patient",
				case_name: "Deleted parent",
				status: "open",
				properties: { age: 60 },
			},
		});
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: ALICE_CASE_ID,
				case_type: "patient",
				case_name: "Alice",
				status: "open",
				parent_case_id: deletedParentId,
				properties: { age: 30 },
			},
		});
		await (dbHandle.db as unknown as Kysely<Database>)
			.deleteFrom("cases")
			.where("case_id", "=", deletedParentId)
			.execute();

		const result = await readCaseData(store, {
			appId: APP_ID,
			caseType: "patient",
			caseId: ALICE_CASE_ID,
			ancestorDepth: 5,
		});
		expect(result.kind).toBe("row");
		if (result.kind !== "row") return;
		expect(result.ancestors).toEqual([]);
	});

	it("terminates on a parent-link cycle", async () => {
		const store = makeStore(PROJECT_A, OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: ALICE_CASE_ID,
				case_type: "patient",
				case_name: "Alice",
				status: "open",
				properties: { age: 30 },
			},
		});
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: BOB_CASE_ID,
				case_type: "patient",
				case_name: "Bob",
				status: "open",
				parent_case_id: ALICE_CASE_ID,
				properties: { age: 60 },
			},
		});
		// Close the loop: Alice's parent becomes Bob. The seen-set must
		// stop the walk after one full lap instead of spinning.
		await store.update({
			appId: APP_ID,
			caseId: ALICE_CASE_ID,
			parentRelationship: "child",
			patch: { parent_case_id: BOB_CASE_ID },
		});

		const result = await readCaseData(store, {
			appId: APP_ID,
			caseType: "patient",
			caseId: BOB_CASE_ID,
			ancestorDepth: 5,
		});
		expect(result.kind).toBe("row");
		if (result.kind !== "row") return;
		expect(result.ancestors.map((a) => a.case_id)).toEqual([ALICE_CASE_ID]);
	});

	it("returns the missing arm for an absent case-id", async () => {
		const store = makeStore(PROJECT_A, OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");

		const result = await readCaseData(store, {
			appId: APP_ID,
			caseType: "patient",
			caseId: "does-not-exist",
			ancestorDepth: 5,
		});
		expect(result.kind).toBe("missing");
	});

	it("loads a case by an authored URL-significant opaque id (no UUID shape gate)", async () => {
		const store = makeStore(PROJECT_A, OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");
		const authoredId =
			"nova-case-v1:9ac52723-445f-54a7-8c1b-7e90c985637b:external/1 %x:y+z";
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: authoredId,
				case_type: "patient",
				case_name: "Authored",
				status: "open",
				properties: { age: 30 },
			},
		});

		const result = await readCaseData(store, {
			appId: APP_ID,
			caseType: "patient",
			caseId: authoredId,
			ancestorDepth: 5,
		});
		expect(result.kind).toBe("row");
		if (result.kind !== "row") return;
		expect(result.row.case_id).toBe(authoredId);
	});

	it("returns the missing arm for a cross-tenant case-id (tenant boundary stays structural)", async () => {
		const storeA = makeStore(PROJECT_A, OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
		await seedSchema(storeA, blueprint, "patient");
		await storeA.insert({
			appId: APP_ID,
			row: {
				case_id: ALICE_CASE_ID,
				case_type: "patient",
				case_name: "test-case",
				status: "open",
				properties: { age: 30 },
			},
		});

		// Project B's store cannot see Project A's case — the binding
		// returns `missing` rather than leaking a row across the
		// tenant boundary.
		const storeB = makeStore(PROJECT_B, OWNER_B);
		const result = await readCaseData(storeB, {
			appId: APP_ID,
			caseType: "patient",
			caseId: ALICE_CASE_ID,
			ancestorDepth: 5,
		});
		expect(result.kind).toBe("missing");
	});
});

describe("seedSampleCases", () => {
	it("returns the ok arm with the default insert count", async () => {
		const store = makeStore(PROJECT_A, OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");

		const result = await seedSampleCases(store, {
			appId: APP_ID,
			caseType: PATIENT_CASE_TYPE,
		});
		expect(result.kind).toBe("ok");
		if (result.kind !== "ok") return;
		expect(result.inserted).toBe(SAMPLE_CASE_DEFAULT_COUNT);

		// The seeded rows should land in the same case-type's table.
		const after = await readCases(store, {
			appId: APP_ID,
			caseType: "patient",
		});
		expect(after.kind).toBe("rows");
		if (after.kind !== "rows") return;
		expect(after.rows).toHaveLength(SAMPLE_CASE_DEFAULT_COUNT);
	});
});

describe("mapPopulateSampleCasesError through Postgres", () => {
	it("maps a typed SchemaNotSyncedError thrown by the real seed flow", async () => {
		// End-to-end mapping for the schema-sync-skipped path. The
		// blueprint declares the case type but `applySchemaChange`
		// hasn't run, so the case-store's `getValidator` reaches a
		// missing `case_type_schemas` row and throws.
		const store = makeStore(PROJECT_A, OWNER_A);
		// Skip `seedSchema` on purpose — that's the precondition the
		// error covers.
		try {
			await seedSampleCases(store, {
				appId: APP_ID,
				caseType: PATIENT_CASE_TYPE,
			});
			throw new Error("seedSampleCases should have thrown");
		} catch (err) {
			const result = mapPopulateSampleCasesError(err);
			expect(result).toEqual({
				kind: "schema-not-synced",
				caseType: "patient",
			});
		}
	});

	it("maps a typed CasePropertiesValidationError thrown by the real seed flow", async () => {
		// End-to-end mapping for the AJV-rejection path. A stub
		// `SampleCaseGenerator` emits a schema-violating row (`age`
		// declared as `int` but the generator returns the string
		// "not-a-number"); the case-store's bulk-insert path runs
		// AJV inside its transaction and throws
		// `CasePropertiesValidationError`. `seedSampleCases`
		// propagates; the mapping helper translates to the
		// structured `validation-failure` arm with the per-field
		// failure list intact.
		const stubGenerator = {
			generate: () => [
				{
					case_type: "patient",
					case_name: "Alice",
					status: "open",
					// `age` as a non-numeric string fails the int schema.
					properties: { age: "not-a-number" },
				},
			],
		};
		const store = new PostgresCaseStore({
			projectId: PROJECT_A,
			actorUserId: OWNER_A,
			ownerId: OWNER_A,
			db: dbHandle.db as unknown as Kysely<Database>,
			sampleGenerator: stubGenerator,
		});
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
		// Schema sync runs so the validator fetch succeeds; the
		// failure is on the candidate payload, not on the schema
		// row.
		await seedSchema(store, blueprint, "patient");

		try {
			await seedSampleCases(store, {
				appId: APP_ID,
				caseType: PATIENT_CASE_TYPE,
			});
			throw new Error("seedSampleCases should have thrown");
		} catch (err) {
			const result = mapPopulateSampleCasesError(err);
			expect(result.kind).toBe("validation-failure");
			if (result.kind !== "validation-failure") return;
			expect(result.caseType).toBe("patient");
			// The failure list carries at least the `/age` entry —
			// AJV may surface multiple failures depending on the
			// schema's strictness, so pin the load-bearing entry by
			// substring rather than locking the full array shape.
			expect(result.failures.length).toBeGreaterThan(0);
			const ageFailure = result.failures.find((f) => f.path === "/age");
			expect(ageFailure).toBeDefined();
			expect(ageFailure?.message).toMatch(/integer/);
		}
	});
});

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

const NOTE_CALC_COLUMN_UUID = testUuid("50000000-0000-0000-0000-000000000002");

describe("applySubmission — registration", () => {
	it("lands the primary + child through the envelope and returns the generated ids in input order", async () => {
		const store = makeStore(PROJECT_A, OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE, VISIT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");
		await seedSchema(store, blueprint, "visit");

		const mutation: Extract<SubmissionMutation, { kind: "registration" }> = {
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
		};

		const result = await store.applySubmission(
			submissionEnvelopeArgs(mutation, APP_ID),
		);

		// The primary id the envelope generated surfaces on
		// `primaryCaseIds[0]`; the child id arrives in input order, and an
		// ordinary-only submission records no operation effects.
		expect(result.primaryCaseIds[0]).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
		expect(result.createdChildren).toEqual([
			{
				authoredChildIndex: 0,
				parentCaseId: result.primaryCaseIds[0],
				caseId: expect.any(String),
			},
		]);
		expect(result.operations).toEqual([]);

		// Read-back through the store confirms the rows landed open with
		// the right column values + JSONB document; the visit row's
		// `parent_case_id` is threaded from the primary's generated id.
		const patients = await readCases(store, {
			appId: APP_ID,
			caseType: "patient",
		});
		expect(patients.kind).toBe("rows");
		if (patients.kind !== "rows") return;
		expect(patients.rows).toHaveLength(1);
		expect(patients.rows[0]?.case_name).toBe("Alice");
		expect(patients.rows[0]?.status).toBe("open");
		expect(patients.rows[0]?.properties).toEqual({ age: 30 });

		const visits = await readCases(store, {
			appId: APP_ID,
			caseType: "visit",
		});
		expect(visits.kind).toBe("rows");
		if (visits.kind !== "rows") return;
		expect(visits.rows).toHaveLength(1);
		expect(visits.rows[0]?.case_name).toBe("First visit");
		expect(visits.rows[0]?.status).toBe("open");
		expect(visits.rows[0]?.parent_case_id).toBe(result.primaryCaseIds[0]);
	});

	it("derives and persists an ordinary extension host from the committed case catalog", async () => {
		const store = makeStore(PROJECT_A, OWNER_A);
		const extensionVisit: CaseType = {
			...VISIT_CASE_TYPE,
			relationship: "extension",
		};
		const blueprint = buildDoc({
			appName: "Extension submission",
			caseTypes: [PATIENT_CASE_TYPE, extensionVisit],
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
		await seedSchema(store, blueprint, "patient");
		await seedSchema(store, blueprint, "visit");

		const mutation: Extract<SubmissionMutation, { kind: "registration" }> = {
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
					caseName: "Hosted visit",
					properties: { notes: "checkup" },
				},
			],
			ordinaryChildBuckets: [{ caseType: "visit" }],
		};
		const projection = validateCaptureSubmissionProjection(mutation);
		const identity = previewAsMe({ id: OWNER_A });
		if (identity === null) throw new Error("expected preview identity");
		const built = buildCaseOperationProgramFromDoc({
			blueprint: pickBlueprintDoc(blueprint),
			mutation,
			projection,
			identity,
		});
		expect(built.ordinaryChildRelationships.get("visit")).toBe("extension");

		const result = await store.applySubmission(
			submissionEnvelopeArgs(mutation, APP_ID, built),
		);
		const childCaseId = result.createdChildren[0]?.caseId;
		expect(childCaseId).toBeDefined();
		const edge = await sql<{
			identifier: string;
			relationship: string;
			ancestor_id: string;
		}>`
			SELECT identifier, relationship, ancestor_id
			FROM case_indices
			WHERE case_id = ${childCaseId ?? ""}
		`.execute(dbHandle.db);
		expect(edge.rows[0]).toEqual({
			identifier: "parent",
			relationship: "extension",
			ancestor_id: result.primaryCaseIds[0],
		});
	});

	it("admits zero children and lands the primary alone", async () => {
		const store = makeStore(PROJECT_A, OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");

		const mutation: Extract<SubmissionMutation, { kind: "registration" }> = {
			kind: "registration",
			...FINAL_SUBMISSION_PROTOCOL,
			primary: {
				caseType: "patient",
				caseName: "Solo",
				properties: { age: 25 },
			},
			children: [],
		};

		const result = await store.applySubmission(
			submissionEnvelopeArgs(mutation, APP_ID),
		);
		expect(result.createdChildren).toEqual([]);

		const patients = await readCases(store, {
			appId: APP_ID,
			caseType: "patient",
		});
		expect(patients.kind).toBe("rows");
		if (patients.kind !== "rows") return;
		expect(patients.rows).toHaveLength(1);
	});

	it("admits an empty properties document against a case-type with formatted properties (AJV does not reject)", async () => {
		// Empty-properties round-trip: a registration whose user filled
		// only `case_name` against a case-type carrying `format: date`,
		// `format: time`, `format: date-time`, geopoint, and numeric
		// properties must clear AJV. The engine's empty-value filter
		// (`raw === undefined || raw === ""` inside
		// `formEngine.ts::FormEngine.computeSubmissionMutation`)
		// guarantees the absent properties never reach the envelope, and
		// `caseTypeToJsonSchema` emits `{ type: "object" }` with no
		// `required` keys — so the empty document trivially passes.
		// Pinning the round-trip end-to-end protects against a future
		// generator change that adds `required` keys (which would crash
		// every running-app form whose user fills only `case_name`).
		const store = makeStore(PROJECT_A, OWNER_A);
		const blueprint = buildBlueprint([FORMATTED_PROPS_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");

		const mutation: Extract<SubmissionMutation, { kind: "registration" }> = {
			kind: "registration",
			...FINAL_SUBMISSION_PROTOCOL,
			primary: {
				caseType: "patient",
				caseName: "Alice",
				// Every formatted property left absent — `format: date`
				// would crash on `""`, the geopoint pattern would
				// reject `""`, the `integer` / `number` types would
				// reject `null`. Omission is the only shape that lands.
				properties: {},
			},
			children: [],
		};

		const result = await store.applySubmission(
			submissionEnvelopeArgs(mutation, APP_ID),
		);
		expect(result.createdChildren).toEqual([]);

		const patients = await readCases(store, {
			appId: APP_ID,
			caseType: "patient",
		});
		if (patients.kind !== "rows") throw new Error("expected rows");
		expect(patients.rows).toHaveLength(1);
		// JSONB document is empty; `case_name` lands on the column.
		expect(patients.rows[0]?.case_name).toBe("Alice");
		expect(patients.rows[0]?.properties).toEqual({});
	});

	it("rejects with the compiler-bug invariant when the primary carries no caseName, inserting nothing", async () => {
		const store = makeStore(PROJECT_A, OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");

		// `caseName` is `text NOT NULL` at the column; reaching the
		// envelope without one is an upstream invariant violation. The
		// engine's walker plucks `case_name` into the slot for every
		// contentful bucket, so this throw is structural — the envelope's
		// `requireCaseName` raises it before the primary insert.
		const mutation: Extract<SubmissionMutation, { kind: "registration" }> = {
			kind: "registration",
			...FINAL_SUBMISSION_PROTOCOL,
			primary: {
				caseType: "patient",
				properties: { age: 30 },
			},
			children: [],
		};

		await expect(
			store.applySubmission(submissionEnvelopeArgs(mutation, APP_ID)),
		).rejects.toThrow(/produced no `case_name` value/);

		// The envelope threw before its first insert — nothing landed.
		const patients = await readCases(store, {
			appId: APP_ID,
			caseType: "patient",
		});
		expect(patients.kind).toBe("empty");
	});

	it("rejects with the compiler-bug invariant when a child carries no caseName, rolling the primary insert back", async () => {
		const store = makeStore(PROJECT_A, OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE, VISIT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");
		await seedSchema(store, blueprint, "visit");

		const mutation: Extract<SubmissionMutation, { kind: "registration" }> = {
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
					properties: { notes: "checkup" },
				},
			],
		};

		await expect(
			store.applySubmission(submissionEnvelopeArgs(mutation, APP_ID)),
		).rejects.toThrow(/produced no `case_name` value/);

		// The primary inserted first, but the child's missing name threw
		// inside the one envelope transaction, so the whole submission
		// rolled back — neither row persists.
		const patients = await readCases(store, {
			appId: APP_ID,
			caseType: "patient",
		});
		expect(patients.kind).toBe("empty");
		const visits = await readCases(store, {
			appId: APP_ID,
			caseType: "visit",
		});
		expect(visits.kind).toBe("empty");
	});
});

describe("applySubmission — followup", () => {
	it("merges the patch, writes the caseName, and lands children with their parentCaseId", async () => {
		const store = makeStore(PROJECT_A, OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE, VISIT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");
		await seedSchema(store, blueprint, "visit");
		// Pre-seed the bound primary case so the followup has a row
		// to update.
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: ALICE_CASE_ID,
				case_type: "patient",
				case_name: "Alice",
				status: "open",
				properties: { age: 30 },
			},
		});

		const mutation: Extract<SubmissionMutation, { kind: "followup" }> = {
			kind: "followup",
			...FINAL_SUBMISSION_PROTOCOL,
			caseIds: [ALICE_CASE_ID],
			patch: { caseName: "Alice R", properties: { age: 31 } },
			children: [
				{
					caseType: "visit",
					caseName: "Followup visit",
					properties: { notes: "stable" },
				},
			],
		};

		const result = await store.applySubmission(
			submissionEnvelopeArgs(mutation, APP_ID),
		);
		expect(result.primaryCaseIds).toEqual([ALICE_CASE_ID]);
		expect(result.createdChildren).toHaveLength(1);

		// Primary's `age` updated; `name` preserved (JSONB merge, not
		// replace); the new display name lands on the `case_name` column.
		const patients = await readCases(store, {
			appId: APP_ID,
			caseType: "patient",
		});
		if (patients.kind !== "rows") throw new Error("expected rows");
		expect(patients.rows[0]?.properties).toEqual({ age: 31 });
		expect(patients.rows[0]?.case_name).toBe("Alice R");

		// Child row's `parent_case_id` matches the bound caseId.
		const visits = await readCases(store, {
			appId: APP_ID,
			caseType: "visit",
		});
		if (visits.kind !== "rows") throw new Error("expected rows");
		expect(visits.rows[0]?.parent_case_id).toBe(ALICE_CASE_ID);
	});

	it("skips the primary update when the patch carries no writes", async () => {
		// Empty-patch short-circuit: a followup whose form has no
		// editable fields (or whose children are the only writes)
		// should NOT bump `modified_on` for nothing. The envelope skips
		// `updateCase` when the patch carries neither properties nor a
		// caseName. Pre-seed the primary, snapshot its `modified_on`, run
		// an empty-patch followup, then assert the timestamp didn't move.
		const store = makeStore(PROJECT_A, OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE, VISIT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");
		await seedSchema(store, blueprint, "visit");
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: ALICE_CASE_ID,
				case_type: "patient",
				case_name: "Alice",
				status: "open",
				properties: { age: 30 },
			},
		});

		// Read the pre-call modified_on for the comparison.
		const before = await readCases(store, {
			appId: APP_ID,
			caseType: "patient",
		});
		if (before.kind !== "rows") throw new Error("expected rows");
		const beforeModifiedOn = before.rows[0]?.modified_on;

		const mutation: Extract<SubmissionMutation, { kind: "followup" }> = {
			kind: "followup",
			...FINAL_SUBMISSION_PROTOCOL,
			caseIds: [ALICE_CASE_ID],
			patch: { properties: {} },
			children: [
				{
					caseType: "visit",
					caseName: "Followup visit",
					properties: { notes: "stable" },
				},
			],
		};

		await store.applySubmission(submissionEnvelopeArgs(mutation, APP_ID));

		const after = await readCases(store, {
			appId: APP_ID,
			caseType: "patient",
		});
		if (after.kind !== "rows") throw new Error("expected rows");
		// `modified_on` either stays `null` (insert path didn't set
		// one) or matches the pre-call snapshot — either way, it must
		// not advance.
		expect(after.rows[0]?.modified_on).toEqual(beforeModifiedOn);
	});

	it("rolls the whole envelope back when a child fails validation — the primary update never lands", async () => {
		// The envelope is ONE Postgres transaction: the followup's
		// primary update runs first, then each child insert. A child that
		// fails AJV validation must roll the primary update back with it,
		// so partial success is unobservable — the running-app view
		// re-queries one settled state on resolve.
		const store = makeStore(PROJECT_A, OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE, VISIT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");
		await seedSchema(store, blueprint, "visit");
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: ALICE_CASE_ID,
				case_type: "patient",
				case_name: "Alice",
				status: "open",
				properties: { age: 30 },
			},
		});

		const mutation: Extract<SubmissionMutation, { kind: "followup" }> = {
			kind: "followup",
			...FINAL_SUBMISSION_PROTOCOL,
			caseIds: [ALICE_CASE_ID],
			patch: { properties: { age: 31 } },
			children: [
				{
					caseType: "visit",
					caseName: "Doomed visit",
					// `unknown_prop` is undeclared on the `visit` schema, so
					// the child insert fails AJV validation.
					properties: { unknown_prop: "x" },
				},
			],
		};

		await expect(
			store.applySubmission(submissionEnvelopeArgs(mutation, APP_ID)),
		).rejects.toBeInstanceOf(CasePropertiesValidationError);

		// The primary's `age` update rolled back with the failed child —
		// the row still reads its pre-submission state, and no visit row
		// landed.
		const patients = await readCases(store, {
			appId: APP_ID,
			caseType: "patient",
		});
		if (patients.kind !== "rows") throw new Error("expected rows");
		expect(patients.rows[0]?.properties).toEqual({ age: 30 });
		expect(patients.rows[0]?.case_name).toBe("Alice");
		const visits = await readCases(store, {
			appId: APP_ID,
			caseType: "visit",
		});
		expect(visits.kind).toBe("empty");
	});
});

describe("applySubmission — close", () => {
	it("updates properties, inserts children, and stamps the lifecycle close last", async () => {
		const store = makeStore(PROJECT_A, OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE, VISIT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");
		await seedSchema(store, blueprint, "visit");
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: ALICE_CASE_ID,
				case_type: "patient",
				case_name: "Alice",
				status: "open",
				properties: { age: 30 },
			},
		});

		const mutation: Extract<SubmissionMutation, { kind: "close" }> = {
			kind: "close",
			...FINAL_SUBMISSION_PROTOCOL,
			caseIds: [ALICE_CASE_ID],
			patch: { properties: { age: 32 } },
			children: [
				{
					caseType: "visit",
					caseName: "Closing visit",
					properties: { notes: "discharged" },
				},
			],
		};

		const result = await store.applySubmission(
			submissionEnvelopeArgs(mutation, APP_ID),
		);
		expect(result.primaryCaseIds).toEqual([ALICE_CASE_ID]);
		expect(result.createdChildren).toHaveLength(1);

		const patients = await readCases(store, {
			appId: APP_ID,
			caseType: "patient",
		});
		if (patients.kind !== "rows") throw new Error("expected rows");
		// Property update + both halves of the built-in lifecycle
		// transition landed atop the same row, close applied after the
		// property write. The envelope passes no status value; the
		// CaseStore close operation owns it.
		expect(patients.rows[0]?.properties).toEqual({ age: 32 });
		expect(patients.rows[0]?.closed_on).not.toBeNull();
		expect(patients.rows[0]?.status).toBe("closed");
	});

	it("skips the primary property write on an empty patch but still stamps the close", async () => {
		// Empty-patch close: a close form whose only effect is the
		// closure stamp itself (no property writes) skips the primary's
		// property UPDATE but MUST still land `closed_on` + the built-in
		// `status = "closed"`. The former helper test spied on
		// `store.update` to detect the skip; the envelope routes the
		// primary write through the store's PRIVATE in-transaction update
		// core (never the public `update()` method), so that spy can no
		// longer observe it. The observable contract is pinned instead:
		// properties unchanged (no write ran) and the lifecycle stamped.
		const store = makeStore(PROJECT_A, OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE, VISIT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");
		await seedSchema(store, blueprint, "visit");
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: ALICE_CASE_ID,
				case_type: "patient",
				case_name: "Alice",
				status: "open",
				properties: { age: 30 },
			},
		});

		const mutation: Extract<SubmissionMutation, { kind: "close" }> = {
			kind: "close",
			...FINAL_SUBMISSION_PROTOCOL,
			caseIds: [ALICE_CASE_ID],
			patch: { properties: {} },
			children: [
				{
					caseType: "visit",
					caseName: "Closing visit",
					properties: { notes: "discharged" },
				},
			],
		};

		const result = await store.applySubmission(
			submissionEnvelopeArgs(mutation, APP_ID),
		);
		expect(result.primaryCaseIds).toEqual([ALICE_CASE_ID]);
		expect(result.createdChildren).toHaveLength(1);

		const patients = await readCases(store, {
			appId: APP_ID,
			caseType: "patient",
		});
		if (patients.kind !== "rows") throw new Error("expected rows");
		// Properties unchanged (no property write ran); the closure stamp
		// landed regardless.
		expect(patients.rows[0]?.properties).toEqual({ age: 30 });
		expect(patients.rows[0]?.closed_on).not.toBeNull();
		expect(patients.rows[0]?.status).toBe("closed");
	});
});

describe("mapSubmitFormError through Postgres", () => {
	it("keeps an unavailable selected case in the non-disclosing submission rejection arm", async () => {
		// End-to-end mapping: selected-case validation deliberately combines a
		// missing id and an out-of-Project id in one rejection reason. That keeps
		// the action from turning an authoritative batch lookup into a foreign-case
		// existence probe. Direct `CaseNotFoundError` mapping remains independently
		// covered above for store operations that genuinely throw that class.
		const store = makeStore(PROJECT_A, OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");

		const mutation: Extract<SubmissionMutation, { kind: "followup" }> = {
			kind: "followup",
			...FINAL_SUBMISSION_PROTOCOL,
			caseIds: [ALICE_CASE_ID],
			patch: { properties: { age: 31 } },
			children: [],
		};

		try {
			await store.applySubmission(submissionEnvelopeArgs(mutation, APP_ID));
			throw new Error("applySubmission should have thrown");
		} catch (err) {
			const result = mapSubmitFormError(err);
			expect(result).toEqual({
				kind: "submission-rejected",
				rejection: {
					kind: "selection",
					reason: "not-found-or-out-of-scope",
					caseId: ALICE_CASE_ID,
				},
			});
		}
	});
});

describe("readFilterPreview", () => {
	it("returns the rows arm with empty rows + totalCount: 0 when no cases exist", async () => {
		const store = makeStore(PROJECT_A, OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");
		const result = await readFilterPreview(store, {
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: buildCaseTypeMap(blueprint),
			caseListConfig: makeCaseListConfig({
				columns: [plainColumn(NAME_COLUMN_UUID, "case_name", "Name")],
			}),
		});
		// Single `rows` arm covers both populated and empty success
		// paths — the empty case is `rows: []` + `totalCount: 0`.
		expect(result).toEqual({ kind: "rows", rows: [], totalCount: 0 });
	});

	it("returns the rows arm with the row sample + total matching count when no filter is applied", async () => {
		const store = makeStore(PROJECT_A, OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: ALICE_CASE_ID,
				case_type: "patient",
				case_name: "Alice",
				status: "open",
				properties: { age: 30 },
			},
		});
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: BOB_CASE_ID,
				case_type: "patient",
				case_name: "Bob",
				status: "open",
				properties: { age: 40 },
			},
		});

		const result = await readFilterPreview(store, {
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: buildCaseTypeMap(blueprint),
			caseListConfig: makeCaseListConfig({
				columns: [plainColumn(NAME_COLUMN_UUID, "case_name", "Name")],
			}),
		});
		expect(result.kind).toBe("rows");
		if (result.kind !== "rows") return;
		expect(result.rows).toHaveLength(2);
		expect(result.totalCount).toBe(2);
	});

	it("narrows to the predicate-matching subset and reports the matching totalCount", async () => {
		// Editing the filter must update BOTH the row sample and
		// the totalCount, identically — applying a predicate
		// affects both surfaces or neither.
		const store = makeStore(PROJECT_A, OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: ALICE_CASE_ID,
				case_type: "patient",
				case_name: "Alice",
				status: "open",
				properties: { age: 25 },
			},
		});
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: BOB_CASE_ID,
				case_type: "patient",
				case_name: "Bob",
				status: "open",
				properties: { age: 40 },
			},
		});

		// `age > 30` — only Bob matches.
		const result = await readFilterPreview(store, {
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: buildCaseTypeMap(blueprint),
			caseListConfig: makeCaseListConfig({
				columns: [plainColumn(NAME_COLUMN_UUID, "case_name", "Name")],
				filter: gt(prop("patient", "age"), literal(30)),
			}),
		});
		expect(result.kind).toBe("rows");
		if (result.kind !== "rows") return;
		expect(result.rows).toHaveLength(1);
		expect(result.rows[0]?.case_id).toBe(BOB_CASE_ID);
		expect(result.totalCount).toBe(1);
	});

	it("counts a nested filter whose Combined text value still has one blank part", async () => {
		// Acceptance coverage for the full Results authoring path: the row
		// sample and match count both compile this same predicate immediately
		// after a user chooses Combined text, before they fill its first part.
		// PostgreSQL's variadic concat cannot infer the type of a lone prepared
		// parameter unless the SQL compiler supplies the AST's text coercion.
		const store = makeStore(PROJECT_A, OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: ALICE_CASE_ID,
				case_type: "patient",
				case_name: "Alice",
				status: "open",
				properties: { age: 30 },
			},
		});

		const result = await readFilterPreview(store, {
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: buildCaseTypeMap(blueprint),
			caseListConfig: makeCaseListConfig({
				columns: [plainColumn(NAME_COLUMN_UUID, "case_name", "Name")],
				filter: and(
					eq(prop("patient", "case_name"), literal("")),
					or(
						eq(prop("patient", "case_name"), literal("")),
						eq(prop("patient", "case_name"), literal("")),
						not(eq(prop("patient", "case_name"), concat(term(literal(""))))),
					),
				),
			}),
		});

		expect(result).toEqual({ kind: "rows", rows: [], totalCount: 0 });
	});

	it("treats an unset typed date in a live filter as no matches, not a database error", async () => {
		// The predicate editor commits `dateLiteral("")` while its optional
		// native date control is empty. Both the sample query and count query
		// execute immediately, so this acceptance test pins the whole live-
		// preview boundary against PostgreSQL's `invalid input syntax for type
		// date: ""` failure rather than only checking the cold SQL string.
		const store = makeStore(PROJECT_A, OWNER_A);
		const datePatient: CaseType = {
			...PATIENT_CASE_TYPE,
			properties: [
				...PATIENT_CASE_TYPE.properties,
				{ name: "dob", label: proseText("Date of birth"), data_type: "date" },
			],
		};
		const blueprint = buildBlueprint([datePatient]);
		await seedSchema(store, blueprint, "patient");
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: ALICE_CASE_ID,
				case_type: "patient",
				case_name: "Alice",
				status: "open",
				properties: { age: 30, dob: "2000-06-15" },
			},
		});

		const result = await readFilterPreview(store, {
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: buildCaseTypeMap(blueprint),
			caseListConfig: makeCaseListConfig({
				columns: [plainColumn(NAME_COLUMN_UUID, "case_name", "Name")],
				filter: eq(prop("patient", "dob"), dateLiteral("")),
			}),
		});
		expect(result).toEqual({ kind: "rows", rows: [], totalCount: 0 });
	});

	it("applies assigned-case exclusions to both the sample and total count", async () => {
		const store = makeStore(PROJECT_A, OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: ALICE_CASE_ID,
				case_type: "patient",
				case_name: "Alice",
				status: "open",
				properties: { age: 30 },
			},
		});

		const result = await readFilterPreview(store, {
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: buildCaseTypeMap(blueprint),
			caseListConfig: makeCaseListConfig({
				columns: [plainColumn(NAME_COLUMN_UUID, "case_name", "Name")],
			}),
			excludedOwnerIds: [OWNER_A],
		});

		expect(result).toEqual({ kind: "rows", rows: [], totalCount: 0 });
	});

	it("populates calculated columns inline when the filter passes", async () => {
		// Pins the cross-feature shape: filter narrowing AND
		// calculated-column projection compose. The structural query
		// returns the same calculated row shape as the running Preview,
		// so the two compiler paths cannot drift.
		const store = makeStore(PROJECT_A, OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: ALICE_CASE_ID,
				case_type: "patient",
				case_name: "Alice",
				status: "open",
				properties: { age: 30 },
			},
		});

		const result = await readFilterPreview(store, {
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: buildCaseTypeMap(blueprint),
			caseListConfig: makeCaseListConfig({
				columns: [
					plainColumn(NAME_COLUMN_UUID, "case_name", "Name"),
					calculatedColumn(
						NOTE_CALC_COLUMN_UUID,
						"Note",
						term(literal("hello")),
					),
				],
				filter: eq(prop("patient", "case_name"), literal("Alice")),
			}),
		});
		expect(result.kind).toBe("rows");
		if (result.kind !== "rows") return;
		expect(result.rows[0]?.calculated[NOTE_CALC_COLUMN_UUID]).toBe("hello");
		expect(result.totalCount).toBe(1);
	});

	it("threads session bindings through both filter-preview reads", async () => {
		const store = makeStore(PROJECT_A, OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: ALICE_CASE_ID,
				case_type: "patient",
				case_name: "Alice",
				status: "open",
				properties: { age: 30 },
			},
		});
		const result = await readFilterPreview(store, {
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: buildCaseTypeMap(blueprint),
			bindings: {
				sessionContext: new Map([["userid", OWNER_A]]),
			},
			caseListConfig: makeCaseListConfig({
				columns: [plainColumn(NAME_COLUMN_UUID, "case_name", "Name")],
				filter: eq(prop("patient", "owner_id"), sessionContext("userid")),
			}),
		});

		expect(result).toMatchObject({ kind: "rows", totalCount: 1 });
	});
});
