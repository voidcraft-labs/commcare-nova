// lib/preview/engine/__tests__/caseDataBinding.test.ts
//
// Contract tests for the running-app view's data-binding helpers
// (`lib/preview/engine/caseDataBindingHelpers.ts`). The helpers
// take a `CaseStore` instance and a typed argument bundle; tests
// inject a per-test `PostgresCaseStore` from `setupPerTestDatabase`
// and exercise the discriminated-union return shapes against real
// Postgres state.
//
// ## Why the helpers, not the Server Actions
//
// `caseDataBinding.ts` exports `"use server"` actions that wrap
// `getSession()` + `withProjectContext`. Driving those through a
// real session is heavy (Better Auth + Postgres); the
// architecture splits the action wrapper from the underlying
// helpers precisely so tests can bind against a `CaseStore`
// instance from the contract harness without spinning up a
// session. The helpers carry every behavior the actions delegate
// to; the actions are thin wrappers.
//
// ## Tenant-scope coverage
//
// The "tenant boundary structural" assertion mirrors the contract
// harness's existing tenant-isolation tests: a row inserted by
// owner A is not readable by a store bound to owner B; the
// `LoadCasesResult` returned for owner B is `{ kind: "empty" }`,
// not an error. The case-store layer enforces the filter at the
// SQL layer; the binding inherits the structural enforcement.

import { type Kysely, sql } from "kysely";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { resolveCaseListConfig } from "@/lib/__tests__/docHelpers";
import {
	buildCaseTypeMap,
	CaptureSubmissionRejectedError,
	CaseNotFoundError,
	CasePropertiesValidationError,
	type CasePropertyFailure,
	type CaseRow,
	type CaseStore,
	CaseTypeNotInBlueprintError,
	type JsonObject,
	SchemaNotSyncedError,
} from "@/lib/case-store";
import { buildSimpleBlueprint } from "@/lib/case-store/__tests__/fixtures/simpleBlueprint";
import { runCaseStoreMigrations } from "@/lib/case-store/migrate";
import { PostgresCaseStore } from "@/lib/case-store/postgres/store";
import { HeuristicCaseGenerator } from "@/lib/case-store/sample/heuristic";
import { setupPerTestDatabase } from "@/lib/case-store/sql/__tests__/perTestDatabase";
// `Database` is the Kysely type contract for the four case-store
// tables — package-private, so the test reaches in via the
// internal subpath rather than the curated public barrel.
import type { Database } from "@/lib/case-store/sql/database";
import {
	advancedSearchInputDef,
	type BlueprintDoc,
	type CaseListConfig,
	type CaseOperation,
	type CaseType,
	calculatedColumn,
	emptyCaseListConfig,
	exactMode,
	type LookupColumnId,
	type LookupTableId,
	plainColumn,
	simpleSearchInputDef,
	startsWithMode,
	tileCell,
	USERCASE_CASE_TYPE,
	type Uuid,
} from "@/lib/domain";
import {
	and,
	between,
	concat,
	dateAdd,
	dateLiteral,
	double,
	eq,
	formField,
	gt,
	ifExpr,
	input,
	isBlank,
	isIn,
	literal,
	matchAll,
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
import { buildDoc, f } from "../../../__tests__/docHelpers";
import { validateCaptureSubmissionProjection } from "../captureSubmissionValidation";
import {
	caseRowDisplayValue,
	caseRowsToFormPreloads,
	caseRowToFormPreload,
	mapFilterPreviewError,
	mapPopulateSampleCasesError,
	mapSubmitFormError,
	pickBlueprintDoc,
} from "../caseDataBindingClient";
import {
	buildCaseOperationProgramFromDoc,
	buildSubmissionOperationProgram,
	buildSubmissionReceiptIdentity,
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

/**
 * A `query` mock that answers the acting worker's own-case read separately.
 *
 * Resolving a preview context reads the `commcare-user` row before anything
 * else, because `#user/<prop>` answers from that ROW rather than from a
 * projection — the wire resolves the hashtag against `casedb`, so the row is
 * what a device would read. A mock returning one canned page for every case
 * type hands that page to the usercase read instead, and the test then asserts
 * against a store its own case type never reached.
 *
 * Each argument is one page, handed out in order to the reads that are about
 * the case type under test. Reads past the last page get nothing, which is
 * what an exhausted `mockResolvedValueOnce` chain meant before.
 */
type CaseQuery = CaseStore["query"];

function appCaseQuery(...pages: ReadonlyArray<Awaited<ReturnType<CaseQuery>>>) {
	const remaining = [...pages];
	return vi.fn<CaseQuery>(async (args) =>
		args.caseType === USERCASE_CASE_TYPE ? [] : (remaining.shift() ?? []),
	);
}

/** The first read that is about the case type under test, never the usercase. */
function appCaseQueryArg<T extends { readonly caseType: string }>(mock: {
	readonly mock: { readonly calls: ReadonlyArray<readonly [T, ...unknown[]]> };
}): T | undefined {
	return mock.mock.calls
		.map((call) => call[0])
		.find((arg) => arg.caseType !== USERCASE_CASE_TYPE);
}

// ---------------------------------------------------------------
// Module mocks for the `submitFormAction` Server Action tests
// ---------------------------------------------------------------
//
// `vi.mock` calls are hoisted above every import — they apply to
// the whole file. The helper-level tests above the
// `submitFormAction` block don't import `getSession` or
// `withProjectContext`, so the mock surface is invisible to them.
// `vi.importActual` preserves every other case-store export so the
// typed-error classes the helper-level tests rely on stay real
// (`instanceof` checks would break otherwise).
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
// The schema heal's Postgres boundary, stubbed for the SAME reason the
// auth boundary is: the actions wrap their store in
// `schemaHealingCaseStore`, whose heal loads the persisted blueprint via
// `loadApp` — the REAL one lazily constructs the shared Cloud SQL
// `Connector` + `pg.Pool`, whose background keepalive is an async-resource
// leak no unit test may create. The heal-reaching action test scripts these per
// call; every other test never enters the heal (only
// `SchemaNotSyncedError` does), so the stubs stay invisible to them.
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
// The action boundary uses `resolveAppScope` when it needs only membership and
// `resolveAuthorizedAppSnapshot` when persona/program resolution needs the
// blueprint under the same app-row + membership locks. Both real paths read
// Postgres + the auth tables, so this suite replaces them. The snapshot mock
// delegates its app payload to `loadAppMock`: that keeps the existing
// per-test blueprint fixtures and makes authorization-before-document ordering
// observable without constructing the shared Cloud SQL pool. Spread the actual
// module so `AppAccessError` stays the real class — the actions' catch does
// `err instanceof AppAccessError`.
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
// The program builder's activation-flag read hits the shared app-state
// pool; stub it so the flag-gate tests script it per call.
// `readLookupActivationForShare` is present only because the actual
// `appAccess` module (spread above) imports it at module scope —
// nothing here calls it (`resolveAppScope` is stubbed).

// ---------------------------------------------------------------
// Per-test database lifecycle (mirrors PostgresCaseStore tests)
// ---------------------------------------------------------------

const dbHandle = setupPerTestDatabase({
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
	await runCaseStoreMigrations(dbHandle.db);
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

// ---------------------------------------------------------------
// Test fixture
// ---------------------------------------------------------------

const APP_ID = "app-binding";
const OWNER_A = "owner-a";
const OWNER_B = "owner-b";
const PROJECT_A = "project-a";
const PROJECT_B = "project-b";
const OPERATION_LOOKUP_TABLE =
	"00000000-0000-7000-8000-000000000091" as LookupTableId;
const OPERATION_LOOKUP_COLUMN =
	"10000000-0000-7000-8000-000000000092" as LookupColumnId;
/** These cases carry no lookup carriers, so the scope only has to be a
 *  well-formed authorized triple — the loader takes its empty-id fast path
 *  and performs no lookup read. */
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
	return projectSubmissionEnvelopeArgs(mutation, appId, {
		...built,
		// Whatever the mutation names, unless a test says otherwise: these
		// tests are about the envelope's other halves, and the committed-form
		// filter has its own coverage.
		usercaseWriteProperties:
			built?.usercaseWriteProperties ??
			new Set(Object.keys(mutation.usercase ?? {})),
		ordinaryChildRelationships:
			built?.ordinaryChildRelationships ??
			new Map(children.map((child) => [child.caseType, "child"] as const)),
		submissionReceipt:
			built?.submissionReceipt ??
			({
				entryKey: mutation.entryKey,
				formUuid: testUuid(mutation.formUuid),
				expectedAppMutationSeq: 0,
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

const ALICE_CASE_ID = "40000000-0000-0000-0000-000000000001";
const BOB_CASE_ID = "40000000-0000-0000-0000-000000000002";

/** Actor-action stub with every CaseStore method present and no database work. */
function actionStore(overrides: Partial<CaseStore> = {}): CaseStore {
	return {
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
		...overrides,
	} satisfies CaseStore;
}
const HOUSEHOLD_CASE_ID = "40000000-0000-0000-0000-000000000003";
const VISIT_CASE_ID = "40000000-0000-0000-0000-000000000004";

/**
 * The case type the binding tests bind against — `patient` with
 * the standard `case_name` scalar and one int property (`age`). Same
 * shape the contract harness uses, intentionally — the binding
 * tests are the case-store contract's running-app-view-side
 * acceptance tests.
 */
const PATIENT_CASE_TYPE: CaseType = {
	name: "patient",
	properties: [{ name: "age", label: proseText("Age"), data_type: "int" }],
};

/**
 * Child case-type with `parent_type: "patient"` so the submission-
 * mutation tests exercise the child-insert + parent-threading path
 * without re-deriving the schema. Two simple text properties keep
 * the assertion targets stable across child-related tests.
 */
const VISIT_CASE_TYPE: CaseType = {
	name: "visit",
	parent_type: "patient",
	properties: [{ name: "notes", label: proseText("Notes"), data_type: "text" }],
};

/**
 * Grandparent case-type for the ancestor-walk tests — `household ←
 * patient ← visit` gives `readCaseData` a two-hop chain to return
 * nearest-first. (The catalog's `parent_type` is authoring metadata;
 * the walk itself follows the ROWS' `parent_case_id` links.)
 */
const HOUSEHOLD_CASE_TYPE: CaseType = {
	name: "household",
	properties: [{ name: "head_name", label: proseText("Head of household") }],
};

/**
 * Case-type carrying every formatted-property data type AJV's strict
 * mode rejects on an empty string — `format: date`, `format: time`,
 * `format: date-time`, the geopoint pattern, plus `integer` and
 * `number` types. Used by the registration helper test that pins
 * the empty-properties round-trip: a registration mutation whose
 * `properties` is `{}` must clear AJV against this schema.
 *
 * `caseTypeToJsonSchema` emits `{ type: "object" }` with no
 * `required` keys, so an empty `properties` document trivially
 * passes any case-type schema. The structural protection is real
 * but easy to break — adding `required` keys to the generator
 * would silently regress every running-app form whose user fills
 * only `case_name` against a case-type with formatted properties.
 * This fixture turns the structural protection into an asserted
 * invariant.
 */
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

/**
 * Local wrapper that pins this suite's `APP_ID`. The shared
 * `buildSimpleBlueprint` helper takes `(caseTypes, appId)`;
 * wrapping it here keeps each test body to a one-liner.
 */
function buildBlueprint(caseTypes: CaseType[]) {
	return buildSimpleBlueprint(caseTypes, APP_ID);
}

/**
 * Construct a `PostgresCaseStore` bound to `ownerId` against the
 * per-test database. Bypasses `withProjectContext` (which threads
 * through the production singleton) — same shape the contract
 * harness's factory uses.
 */
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

/**
 * Seed the case-type's JSON Schema so subsequent inserts pass
 * AJV validation. Mirrors the shape the contract harness uses —
 * one call per test body before the first `insert`. Builds the
 * `caseTypeSchemas` map at the call boundary so the test reuses
 * the same `BlueprintDoc → ReadonlyMap<string, CaseType>` lift the
 * production helpers run.
 */
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

/**
 * Build a synthetic `CaseRow` literal for tests that exercise the
 * helpers' coercion behavior on JSONB shapes the JSON Schema
 * validator would reject at write time (boolean / null / array /
 * object values against typed properties). The helpers are pure
 * and operate against `CaseRow.properties` directly, so a synthetic
 * row sidesteps the round-trip through `insert` without losing
 * coverage — other write paths (sample-data generator, direct
 * admin writes, future bulk-import flows) can produce these
 * shapes, so the helper has to handle the full `JsonValue` tree.
 */
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

// ---------------------------------------------------------------
// The persona reaches the row
// ---------------------------------------------------------------
//
// The Server-Action tests below prove `submitFormAction` hands the
// persona to `withProjectContext`, and the store's own tests prove it
// stamps `owner_id` from its bound worker. Those are two correct halves,
// and this is the join between them — read back over real Postgres,
// because "the persona's uuid IS the owner id" is the precondition the
// complex-app plan's organization unit (owner-set assembly) and usercase
// unit (restore closure) both build on, and a mock at either end would
// stay green while the middle broke.

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
		const created = rows.find((r) => r.case_id === result.primaryCaseId);
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
		expect(rows.find((r) => r.case_id === result.primaryCaseId)?.owner_id).toBe(
			OWNER_A,
		);
	});
});

// ---------------------------------------------------------------
// `readCases`
// ---------------------------------------------------------------

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

	it.each(["child", "extension"] as const)(
		"constrains a %s case list to the selected case-type parent",
		async (relationship) => {
			const store = makeStore(PROJECT_A, OWNER_A);
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
				parentCase: { caseType: "patient", caseId: ALICE_CASE_ID },
			});

			expect(result.kind).toBe("rows");
			if (result.kind !== "rows") return;
			expect(result.rows.map((row) => row.case_id)).toEqual([VISIT_CASE_ID]);
			expect(result.constraintSource).toBe("authored-rules");
		},
	);

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
			parentCase: { caseType: "patient", caseId: ALICE_CASE_ID },
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

// ---------------------------------------------------------------
// `readCases` — grouped tile
// ---------------------------------------------------------------

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

// ---------------------------------------------------------------
// `readCases` — runtime-bindings composition
// ---------------------------------------------------------------
//
// Acceptance tests for the `inputValues?` extension. The helper
// composes `composeRuntimeFilter(searchInputs, inputValues, caseType)`
// (from `../runtimeBindings`) and AND-joins the result with
// `caseListConfig.filter` to form the predicate that flows to
// `store.query(...)`. The unified-filter slot is the single source
// for both the case-list always-on filter and the search-input
// contributions. The tests below pin each compositional arm against
// real Postgres state — the SQL layer is the authoritative semantic.

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

// ---------------------------------------------------------------
// `resetSampleCases`
// ---------------------------------------------------------------

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

// ---------------------------------------------------------------
// `readCaseData`
// ---------------------------------------------------------------

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

// ---------------------------------------------------------------
// `seedSampleCases`
// ---------------------------------------------------------------

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

// ---------------------------------------------------------------
// `caseRowToFormPreload`
// ---------------------------------------------------------------

describe("caseRowToFormPreload", () => {
	it("coerces every JsonValue branch to its string form", () => {
		const row = buildSyntheticRow({
			str_prop: "hello",
			num_prop: 42,
			bool_prop: true,
			null_prop: null,
			array_prop: ["a", "b"],
			object_prop: { nested: "value" },
		});

		const preload = caseRowToFormPreload(row);
		expect(preload.get("str_prop")).toBe("hello");
		expect(preload.get("num_prop")).toBe("42");
		// Booleans stringify via String() — `true` / `false` become
		// `"true"` / `"false"`.
		expect(preload.get("bool_prop")).toBe("true");
		// `null` collapses to the empty string — the form engine
		// treats absent and empty as the same domain state.
		expect(preload.get("null_prop")).toBe("");
		// Arrays are multi_select values and preload in the FORM value
		// convention — space-separated tokens (`SelectMultiField` splits
		// on " ", and submit's coerceValueForProperty splits on /\s+/) —
		// so the stored selections round-trip: options render checked and
		// an untouched submit writes the same array back.
		expect(preload.get("array_prop")).toBe("a b");
		expect(preload.get("object_prop")).toBe('{"nested":"value"}');
	});
});

// ---------------------------------------------------------------
// `caseRowsToFormPreloads`
// ---------------------------------------------------------------

describe("caseRowsToFormPreloads", () => {
	it("binds each reachable namespace to the row at its blueprint depth", () => {
		const patient = {
			...buildSyntheticRow({}),
			case_type: "patient",
			case_name: "Alice",
		};
		const household = {
			...buildSyntheticRow({ head_name: "John Smith" }),
			case_id: "test-household",
			case_type: "household",
		};

		const byType = caseRowsToFormPreloads(
			patient,
			[household],
			[
				{ name: "patient", depth: 0 },
				{ name: "household", depth: 1 },
			],
		);
		expect([...byType.keys()]).toEqual(["patient", "household"]);
		expect(byType.get("patient")?.get("case_name")).toBe("Alice");
		expect(byType.get("household")?.get("head_name")).toBe("John Smith");
		// Canonical scalar names flatten per row — an ancestor's
		// `case_id` is addressable as `#household/case_id`.
		expect(byType.get("household")?.get("case_id")).toBe("test-household");
	});

	it("binds by depth, not row type — the wire's positional walk", () => {
		// Blueprint chain visit → patient → household, but the live data
		// chain skips a level (visit's parent IS a household row — data
		// predating a hierarchy edit, or a re-parented case). The wire's
		// `index/parent × depth` walk has NO case-type filter: depth 1
		// lands on the household row for #patient refs, and depth 2
		// walks past the chain's end for #household refs. The preview
		// must read the same rows, not same-named rows elsewhere.
		const visit = {
			...buildSyntheticRow({ notes: "initial" }),
			case_type: "visit",
		};
		const household = {
			...buildSyntheticRow({ head_name: "John Smith" }),
			case_id: "test-household",
			case_type: "household",
		};

		const byType = caseRowsToFormPreloads(
			visit,
			[household],
			[
				{ name: "visit", depth: 0 },
				{ name: "patient", depth: 1 },
				{ name: "household", depth: 2 },
			],
		);
		expect(byType.get("visit")?.get("notes")).toBe("initial");
		expect(byType.get("patient")?.get("head_name")).toBe("John Smith");
		expect(byType.has("household")).toBe(false);
	});

	it("addresses the loaded case at depth 0 on a self-parented chain", () => {
		// `reachableCaseTypes`' cycle guard emits a self-parented type
		// once, at depth 0 — so the deeper same-type row is unaddressed,
		// matching the wire (where #person/ refs always mean the loaded
		// case).
		const person = {
			...buildSyntheticRow({ nickname: "child" }),
			case_type: "person",
		};
		const parentPerson = {
			...buildSyntheticRow({ nickname: "parent" }),
			case_id: "test-parent",
			case_type: "person",
		};

		const byType = caseRowsToFormPreloads(
			person,
			[parentPerson],
			[{ name: "person", depth: 0 }],
		);
		expect(byType.get("person")?.get("nickname")).toBe("child");
		expect(byType.size).toBe(1);
	});
});

// ---------------------------------------------------------------
// `caseRowDisplayValue`
// ---------------------------------------------------------------

describe("caseRowDisplayValue", () => {
	it("coerces every JsonValue branch to its display string", () => {
		const row = buildSyntheticRow({
			bool_prop: false,
			null_prop: null,
			array_prop: [1, 2, 3],
			object_prop: { a: 1, b: "two" },
		});

		expect(caseRowDisplayValue(row, "bool_prop")).toBe("false");
		expect(caseRowDisplayValue(row, "null_prop")).toBe("");
		expect(caseRowDisplayValue(row, "array_prop")).toBe("[1,2,3]");
		expect(caseRowDisplayValue(row, "object_prop")).toBe('{"a":1,"b":"two"}');
	});

	// Each canonical scalar column has a dedicated dispatch arm so the
	// helper reads the authoritative column rather than the JSONB document.
	it.each([
		["case_id", "real-row-id"],
		["case_type", "patient"],
		["owner_id", "real-owner"],
		["status", "open"],
		["case_name", "Real Name"],
	])(
		"caseRowDisplayValue resolves canonical scalar %s from its column",
		(field, columnValue) => {
			const row: CaseRow = {
				case_id: field === "case_id" ? columnValue : "test-id",
				app_id: APP_ID,
				case_type: field === "case_type" ? columnValue : "patient",
				owner_id: field === "owner_id" ? columnValue : OWNER_A,
				status: field === "status" ? columnValue : "open",
				opened_on: null,
				modified_on: null,
				closed_on: null,
				case_name: field === "case_name" ? columnValue : "Synthetic Case",
				external_id: null,
				parent_case_id: null,
				properties: {},
			};
			expect(caseRowDisplayValue(row, field)).toBe(columnValue);
		},
	);

	it("resolves only Nova's exact canonical names onto scalar columns", () => {
		const opened = new Date("2026-01-02T03:04:05.000Z");
		const modified = new Date("2026-02-03T04:05:06.000Z");
		const row: CaseRow = {
			case_id: "test-id",
			app_id: APP_ID,
			case_type: "patient",
			owner_id: OWNER_A,
			status: "open",
			opened_on: opened,
			modified_on: modified,
			closed_on: null,
			case_name: "Real Name",
			external_id: "EXT-1",
			parent_case_id: null,
			properties: {},
		};
		expect(caseRowDisplayValue(row, "case_name")).toBe("Real Name");
		expect(caseRowDisplayValue(row, "external_id")).toBe("EXT-1");
		expect(caseRowDisplayValue(row, "date_opened")).toBe(opened.toISOString());
		expect(caseRowDisplayValue(row, "last_modified")).toBe(
			modified.toISOString(),
		);
	});

	it.each([["owner_id"], ["status"]])(
		"caseRowDisplayValue surfaces null for nullable reserved column %s",
		(field) => {
			// `owner_id` and `status` are nullable on `cases`; the
			// helper coerces a `null` column read to the empty string
			// (consistent with `jsonValueToString`'s `null` arm) so
			// case-list table cells render empty rather than the literal
			// "null".
			const row: CaseRow = {
				case_id: "test-id",
				app_id: APP_ID,
				case_type: "patient",
				owner_id: field === "owner_id" ? null : OWNER_A,
				status: field === "status" ? null : "open",
				opened_on: null,
				modified_on: null,
				closed_on: null,
				case_name: "Synthetic Case",
				external_id: null,
				parent_case_id: null,
				properties: {},
			};
			expect(caseRowDisplayValue(row, field)).toBe("");
		},
	);
});

// ---------------------------------------------------------------
// `pickBlueprintDoc`
// ---------------------------------------------------------------

describe("pickBlueprintDoc", () => {
	it("strips function-typed extras off a doc-store-shaped state", () => {
		// `BlueprintDocState` (the doc store's shape) carries action
		// methods alongside the data fields. Server Actions reject
		// function values during RSC serialization, so the
		// projection has to drop them. Verify by extending a
		// `BlueprintDoc` with a function-typed key and checking it's
		// absent from the result.
		const blueprint = buildSimpleBlueprint([PATIENT_CASE_TYPE], APP_ID);
		const stateShaped = {
			...blueprint,
			// Synthetic action method the projection must strip.
			applyMany: () => {
				/* no-op */
			},
		};
		const projected = pickBlueprintDoc(stateShaped) as Record<string, unknown>;
		expect(projected.applyMany).toBeUndefined();
	});

	it("preserves every BlueprintDoc data field including fieldParent", () => {
		// `BlueprintDoc` extends `PersistableDoc` (the schema-defined
		// shape) with `fieldParent` (in-memory only, derived from
		// `fieldOrder`). The projection re-attaches `fieldParent` from
		// the source state so the running-app `loadCasesAction` (which
		// never parses) can read it; the parsing preview actions strip
		// it back off before their `.strict()` parse via
		// `toPersistableDoc`. Verify the reverse-index round-trips here.
		const blueprint = buildSimpleBlueprint([PATIENT_CASE_TYPE], APP_ID);
		const withFieldParent = {
			...blueprint,
			fieldParent: { "child-uuid": "parent-uuid" },
		};
		const projected = pickBlueprintDoc(withFieldParent);
		expect(projected.fieldParent).toEqual({ "child-uuid": "parent-uuid" });
		expect(projected.appId).toBe(APP_ID);
		expect(projected.caseTypes).toEqual(blueprint.caseTypes);
		expect(projected.modules).toEqual(blueprint.modules);
		expect(projected.forms).toEqual(blueprint.forms);
		expect(projected.fields).toEqual(blueprint.fields);
		expect(projected.moduleOrder).toEqual(blueprint.moduleOrder);
		expect(projected.formOrder).toEqual(blueprint.formOrder);
		expect(projected.fieldOrder).toEqual(blueprint.fieldOrder);
	});
});

// ---------------------------------------------------------------
// `mapPopulateSampleCasesError`
// ---------------------------------------------------------------

describe("mapPopulateSampleCasesError", () => {
	// The Server Action's catch block delegates to this helper so
	// the typed-error → typed-result-arm mapping is testable
	// without driving `getSession` + `withProjectContext`. The
	// integration tests above already exercise the round-trip
	// through `seedSampleCases`; these tests pin the discriminator
	// shape one more layer down.

	it("maps CaseTypeNotInBlueprintError to the missing-case-type arm carrying the case type", () => {
		const err = new CaseTypeNotInBlueprintError("app-1", "patient");
		const result = mapPopulateSampleCasesError(err);
		expect(result).toEqual({ kind: "missing-case-type", caseType: "patient" });
	});

	it("maps SchemaNotSyncedError to the schema-not-synced arm carrying the case type", () => {
		const err = new SchemaNotSyncedError("app-1", "patient");
		const result = mapPopulateSampleCasesError(err);
		expect(result).toEqual({ kind: "schema-not-synced", caseType: "patient" });
	});

	it("maps CasePropertiesValidationError to the validation-failure arm carrying the structured failures", () => {
		// AJV's per-field failure list is the user-actionable shape;
		// the mapping helper preserves it verbatim onto the arm so
		// the consumer renders one entry per offending field. Without
		// this branch, the running-app view's error toast would show
		// the wrapped invariant body (internal vocabulary), defeating
		// the typed-error pattern's purpose.
		const failures: ReadonlyArray<CasePropertyFailure> = [
			{ path: "/age", message: "must be integer" },
			{ path: "/age", message: "must NOT have fewer than 1 characters" },
		];
		const err = new CasePropertiesValidationError("app-1", "patient", failures);
		const result = mapPopulateSampleCasesError(err);
		expect(result).toEqual({
			kind: "validation-failure",
			caseType: "patient",
			failures,
		});
	});

	it("falls through to the generic error arm for an unrelated Error instance", () => {
		const err = new Error("connection refused");
		const result = mapPopulateSampleCasesError(err);
		expect(result.kind).toBe("error");
		if (result.kind !== "error") return;
		expect(result.message).toBe("connection refused");
	});

	it("falls through to the generic error arm with a default message for non-Error throws", () => {
		// JS allows `throw "foo"`. The case-store doesn't, but the
		// catch block has to handle every shape — RSC framework
		// errors in particular can surface as non-Error objects.
		const result = mapPopulateSampleCasesError("some string");
		expect(result.kind).toBe("error");
		if (result.kind !== "error") return;
		expect(result.message).toBe("Failed to seed cases.");
	});

	// `CaseTypeNotInBlueprintError` is no longer thrown by
	// `seedSampleCases` itself — the helper accepts the resolved
	// `CaseType` directly, so the missing-from-blueprint case lives
	// at the Server Action layer (`populateSampleCasesAction`'s
	// boundary resolution). The synthetic mapping test above already
	// pins the typed-arm shape.

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

/**
 * Build a v2 `CaseListConfig` snapshot. The schema collapses to
 * three slots — `columns` (carrying display + sort + calc +
 * visibility), optional `filter`, and `searchInputs`. Tests
 * override `columns` (and occasionally `filter`) per case; the
 * baseline empty arrays cover the rest.
 */
function makeCaseListConfig(
	overrides: Partial<CaseListConfig> = {},
): CaseListConfig {
	return resolveCaseListConfig({
		columns: [],
		searchInputs: [],
		...overrides,
	});
}

/**
 * Stable per-test column uuids. Synthetic IDs satisfy the schema's
 * `Uuid` brand without requiring a fresh `crypto.randomUUID()` per
 * column — assertions that read `row.calculated[uuid]` reuse the
 * same constant. The rendered string respects the 8-4-4-4-12
 * grouping the schema accepts.
 */
const NAME_COLUMN_UUID = testUuid("50000000-0000-0000-0000-000000000001");
const NOTE_CALC_COLUMN_UUID = testUuid("50000000-0000-0000-0000-000000000002");

// ---------------------------------------------------------------
// `applySubmission` — registration
// ---------------------------------------------------------------

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
		// `primaryCaseId`; the child id arrives in input order, and an
		// ordinary-only submission records no operation effects.
		expect(result.primaryCaseId).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
		expect(result.childCaseIds).toHaveLength(1);
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
		expect(visits.rows[0]?.parent_case_id).toBe(result.primaryCaseId);
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
							fields: [],
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
		const childCaseId = result.childCaseIds[0];
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
			ancestor_id: result.primaryCaseId,
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
		expect(result.childCaseIds).toEqual([]);

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
		expect(result.childCaseIds).toEqual([]);

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

// ---------------------------------------------------------------
// `applySubmission` — followup
// ---------------------------------------------------------------

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
			caseId: ALICE_CASE_ID,
			patch: { caseName: "Alice R", properties: { age: 31 } },
			children: [
				{
					caseType: "visit",
					caseName: "Followup visit",
					properties: { notes: "stable" },
					parentCaseId: ALICE_CASE_ID,
				},
			],
		};

		const result = await store.applySubmission(
			submissionEnvelopeArgs(mutation, APP_ID),
		);
		expect(result.primaryCaseId).toBe(ALICE_CASE_ID);
		expect(result.childCaseIds).toHaveLength(1);

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
			caseId: ALICE_CASE_ID,
			patch: { properties: {} },
			children: [
				{
					caseType: "visit",
					caseName: "Followup visit",
					properties: { notes: "stable" },
					parentCaseId: ALICE_CASE_ID,
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
			caseId: ALICE_CASE_ID,
			patch: { properties: { age: 31 } },
			children: [
				{
					caseType: "visit",
					caseName: "Doomed visit",
					// `unknown_prop` is undeclared on the `visit` schema, so
					// the child insert fails AJV validation.
					properties: { unknown_prop: "x" },
					parentCaseId: ALICE_CASE_ID,
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

// ---------------------------------------------------------------
// `applySubmission` — close
// ---------------------------------------------------------------

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
			caseId: ALICE_CASE_ID,
			patch: { properties: { age: 32 } },
			children: [
				{
					caseType: "visit",
					caseName: "Closing visit",
					properties: { notes: "discharged" },
					parentCaseId: ALICE_CASE_ID,
				},
			],
		};

		const result = await store.applySubmission(
			submissionEnvelopeArgs(mutation, APP_ID),
		);
		expect(result.primaryCaseId).toBe(ALICE_CASE_ID);
		expect(result.childCaseIds).toHaveLength(1);

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
			caseId: ALICE_CASE_ID,
			patch: { properties: {} },
			children: [
				{
					caseType: "visit",
					caseName: "Closing visit",
					properties: { notes: "discharged" },
					parentCaseId: ALICE_CASE_ID,
				},
			],
		};

		const result = await store.applySubmission(
			submissionEnvelopeArgs(mutation, APP_ID),
		);
		expect(result.primaryCaseId).toBe(ALICE_CASE_ID);
		expect(result.childCaseIds).toHaveLength(1);

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

// ---------------------------------------------------------------
// `submissionEnvelopeArgs` — the pure engine→envelope projection
// ---------------------------------------------------------------

describe("submissionEnvelopeArgs", () => {
	it("maps a registration mutation onto the ordinary registration action", () => {
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
		expect(submissionEnvelopeArgs(mutation, APP_ID)).toEqual({
			appId: APP_ID,
			submissionReceipt: {
				entryKey: FINAL_ENTRY_KEY,
				formUuid: FINAL_FORM_UUID,
				expectedAppMutationSeq: 0,
				requestDigest: expect.stringMatching(/^case-data-binding-request-/),
			},
			ordinary: {
				kind: "registration",
				primary: mutation.primary,
				children: mutation.children.map((child) => ({
					...child,
					parentRelationship: "child",
				})),
			},
		});
	});

	it("maps a followup mutation onto the ordinary followup action", () => {
		const mutation: Extract<SubmissionMutation, { kind: "followup" }> = {
			kind: "followup",
			...FINAL_SUBMISSION_PROTOCOL,
			caseId: ALICE_CASE_ID,
			patch: { caseName: "Alice R", properties: { age: 31 } },
			children: [
				{
					caseType: "visit",
					caseName: "Followup visit",
					properties: { notes: "stable" },
					parentCaseId: ALICE_CASE_ID,
				},
			],
		};
		expect(submissionEnvelopeArgs(mutation, APP_ID)).toEqual({
			appId: APP_ID,
			submissionReceipt: {
				entryKey: FINAL_ENTRY_KEY,
				formUuid: FINAL_FORM_UUID,
				expectedAppMutationSeq: 0,
				requestDigest: expect.stringMatching(/^case-data-binding-request-/),
			},
			ordinary: {
				kind: "followup",
				caseId: ALICE_CASE_ID,
				patch: mutation.patch,
				children: mutation.children.map((child) => ({
					...child,
					parentRelationship: "child",
				})),
			},
		});
	});

	it("maps a close mutation onto the ordinary close action", () => {
		const mutation: Extract<SubmissionMutation, { kind: "close" }> = {
			kind: "close",
			...FINAL_SUBMISSION_PROTOCOL,
			caseId: ALICE_CASE_ID,
			patch: { properties: { age: 32 } },
			children: [
				{
					caseType: "visit",
					caseName: "Closing visit",
					properties: { notes: "discharged" },
					parentCaseId: ALICE_CASE_ID,
				},
			],
		};
		expect(submissionEnvelopeArgs(mutation, APP_ID)).toEqual({
			appId: APP_ID,
			submissionReceipt: {
				entryKey: FINAL_ENTRY_KEY,
				formUuid: FINAL_FORM_UUID,
				expectedAppMutationSeq: 0,
				requestDigest: expect.stringMatching(/^case-data-binding-request-/),
			},
			ordinary: {
				kind: "close",
				caseId: ALICE_CASE_ID,
				patch: mutation.patch,
				children: mutation.children.map((child) => ({
					...child,
					parentRelationship: "child",
				})),
			},
		});
	});

	it("maps a survey mutation onto the ordinary none action (no case effect)", () => {
		expect(
			submissionEnvelopeArgs(
				{ kind: "survey", ...FINAL_SUBMISSION_PROTOCOL },
				APP_ID,
			),
		).toEqual({
			appId: APP_ID,
			submissionReceipt: {
				entryKey: FINAL_ENTRY_KEY,
				formUuid: FINAL_FORM_UUID,
				expectedAppMutationSeq: 0,
				requestDigest: expect.stringMatching(/^case-data-binding-request-/),
			},
			ordinary: { kind: "none" },
		});
	});
});

// ---------------------------------------------------------------
// `mapSubmitFormError`
// ---------------------------------------------------------------

describe("mapSubmitFormError", () => {
	// Synthetic-error mapping — same shape as the
	// `mapPopulateSampleCasesError` block above. The Server Action's
	// catch block delegates to this helper so the typed-error →
	// typed-result-arm translation is testable without driving
	// `getSession` / `withProjectContext`.

	it("maps a capture admission rejection to its safe user-facing message", () => {
		const err = new CaptureSubmissionRejectedError(
			"This form entry was already submitted.",
		);
		expect(mapSubmitFormError(err)).toEqual({
			kind: "error",
			message: "This form entry was already submitted.",
		});
	});

	it("maps CaseNotFoundError to the case-not-found arm carrying the case id", () => {
		const err = new CaseNotFoundError(ALICE_CASE_ID);
		expect(mapSubmitFormError(err)).toEqual({
			kind: "case-not-found",
			caseId: ALICE_CASE_ID,
		});
	});

	it("maps CasePropertiesValidationError to the case-properties-validation arm carrying the failures", () => {
		const failures: ReadonlyArray<CasePropertyFailure> = [
			{ path: "/age", message: "must be integer" },
		];
		const err = new CasePropertiesValidationError(APP_ID, "patient", failures);
		expect(mapSubmitFormError(err)).toEqual({
			kind: "case-properties-validation",
			caseType: "patient",
			failures,
		});
	});

	it("maps CaseTypeNotInBlueprintError to the missing-case-type arm", () => {
		const err = new CaseTypeNotInBlueprintError(APP_ID, "patient");
		expect(mapSubmitFormError(err)).toEqual({
			kind: "missing-case-type",
			caseType: "patient",
		});
	});

	it("maps SchemaNotSyncedError to the schema-not-synced arm", () => {
		const err = new SchemaNotSyncedError(APP_ID, "patient");
		expect(mapSubmitFormError(err)).toEqual({
			kind: "schema-not-synced",
			caseType: "patient",
		});
	});

	it("falls through to the generic error arm for an unrelated Error instance", () => {
		const result = mapSubmitFormError(new Error("connection refused"));
		expect(result).toEqual({
			kind: "error",
			message: "connection refused",
		});
	});

	it("falls through to the generic error arm with a default message for non-Error throws", () => {
		// JS allows `throw "string"`; RSC framework errors can surface
		// as non-Error objects. The helper handles both.
		const result = mapSubmitFormError("plain string");
		expect(result).toEqual({
			kind: "error",
			message: "Failed to submit form.",
		});
	});

	it("maps a typed CaseNotFoundError thrown by the real store envelope", async () => {
		// End-to-end mapping: `CaseStore.applySubmission` running a
		// followup against an unknown id throws `CaseNotFoundError` from
		// its update core; the helper translates to the structured arm.
		// Pins the catch path through the real error-thrower, paralleling
		// the `seedSampleCases` end-to-end mapping tests above.
		const store = makeStore(PROJECT_A, OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");

		const mutation: Extract<SubmissionMutation, { kind: "followup" }> = {
			kind: "followup",
			...FINAL_SUBMISSION_PROTOCOL,
			caseId: ALICE_CASE_ID,
			patch: { properties: { age: 31 } },
			children: [],
		};

		try {
			await store.applySubmission(submissionEnvelopeArgs(mutation, APP_ID));
			throw new Error("applySubmission should have thrown");
		} catch (err) {
			const result = mapSubmitFormError(err);
			expect(result).toEqual({
				kind: "case-not-found",
				caseId: ALICE_CASE_ID,
			});
		}
	});
});

// ---------------------------------------------------------------
// `submitFormAction` (Server Action)
// ---------------------------------------------------------------
//
// The helper-level tests above drive every mutation arm against
// real Postgres; this block exercises the Server Action's
// session-resolution + error-catch wrapper without driving Better
// Auth / Postgres. The `vi.mock` calls at the top of the file
// stub `getSession` and `withProjectContext` so the action's body
// branches are reachable from the test runner.

describe("submitFormAction", () => {
	it("returns the unauthenticated arm when getSession resolves to null", async () => {
		const { getSession } = await import("@/lib/auth-utils");
		vi.mocked(getSession).mockResolvedValueOnce(null);

		const { submitFormAction } = await import("../caseDataBinding");
		const result = await submitFormAction(
			{ kind: "survey", ...FINAL_SUBMISSION_PROTOCOL },
			"app-anything",
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
			submitFormAction(payload as unknown as SubmissionMutation, APP_ID),
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
			submitFormAction(oldPayload as unknown as SubmissionMutation, APP_ID),
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

		const { submitFormAction } = await import("../caseDataBinding");
		const result = await submitFormAction(
			{ kind: "survey", ...FINAL_SUBMISSION_PROTOCOL },
			APP_ID,
		);
		expect(result).toEqual({ kind: "survey" });
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
				requestDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
			},
		});
		for (const [name, method] of Object.entries(stubStore)) {
			if (name !== "applySubmission") expect(method).not.toHaveBeenCalled();
		}
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

		const { submitFormAction } = await import("../caseDataBinding");
		const result = await submitFormAction(
			{
				kind: "followup",
				...FINAL_SUBMISSION_PROTOCOL,
				caseId: ALICE_CASE_ID,
				patch: { properties: { age: 31 } },
				children: [],
			},
			APP_ID,
		);
		expect(result).toEqual({
			kind: "case-not-found",
			caseId: ALICE_CASE_ID,
		});
	});

	it("routes a case-bearing submission through applySubmission and maps the envelope result to the matching arm", async () => {
		// The new wiring: the action projects the mutation via
		// `submissionEnvelopeArgs` and hands it to `store.applySubmission`,
		// then maps the `SubmissionEnvelopeResult`'s `primaryCaseId` +
		// `childCaseIds` onto the mutation-kind result arm.
		const { getSession } = await import("@/lib/auth-utils");
		const { withProjectContext } = await import("@/lib/case-store");
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: OWNER_A },
		} as unknown as Awaited<ReturnType<typeof getSession>>);
		const stubStore = {
			query: appCaseQuery(),
			queryGrouped: vi.fn(),
			count: vi.fn(),
			insert: vi.fn(),
			applySubmission: vi.fn().mockResolvedValueOnce({
				primaryCaseId: ALICE_CASE_ID,
				childCaseIds: [VISIT_CASE_ID],
				operations: [],
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
		};
		loadAuthorizedFormSubmissionSnapshotMock.mockResolvedValueOnce({
			kind: "current",
			projectId: PROJECT_A,
			app: {
				blueprint: buildDoc({
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
									fields: [],
								},
							],
						},
					],
				}),
				mutation_seq: 1,
				project_id: PROJECT_A,
			},
		});

		const { submitFormAction } = await import("../caseDataBinding");
		const result = await submitFormAction(mutation, APP_ID);

		// The store saw exactly the pure projection of the mutation.
		expect(stubStore.applySubmission).toHaveBeenCalledWith({
			...submissionEnvelopeArgs(mutation, APP_ID),
			submissionReceipt: {
				entryKey: FINAL_ENTRY_KEY,
				formUuid: FINAL_FORM_UUID,
				expectedAppMutationSeq: 1,
				requestDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
			},
		});
		// The envelope result mapped onto the registration arm.
		expect(result).toEqual({
			kind: "registration",
			caseId: ALICE_CASE_ID,
			childCaseIds: [VISIT_CASE_ID],
		});
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
			query: appCaseQuery(),
			queryGrouped: vi.fn(),
			count: vi.fn(),
			insert: vi.fn(),
			applySubmission: vi.fn().mockResolvedValue({
				primaryCaseId: ALICE_CASE_ID,
				childCaseIds: [],
				operations: [],
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
		await submitFormAction(mutation, APP_ID, undefined, PERSONA);

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
			query: appCaseQuery(),
			queryGrouped: vi.fn(),
			count: vi.fn(),
			insert: vi.fn(),
			applySubmission: vi.fn().mockResolvedValue({
				primaryCaseId: ALICE_CASE_ID,
				childCaseIds: [],
				operations: [],
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
			childCaseIds: [],
			operations: [{ operationUuid: "op", iteration: 0, executed: true }],
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
		);
		// The survey arm returns WITHOUT the primaryCaseId invariant —
		// an operations-bearing survey has no primary case.
		expect(result).toEqual({ kind: "survey" });
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
			childCaseIds: [],
			operations: [],
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
			),
		).toEqual({ kind: "survey" });

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
			.mockResolvedValueOnce({ childCaseIds: [], operations: [] });
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
			),
		).toEqual({ kind: "survey" });

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
			childCaseIds: [],
			operations: [],
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
		const result = await submitFormAction(mutation, APP_ID);

		expect(result).toEqual({ kind: "survey" });
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
					primaryCaseId: ALICE_CASE_ID,
					childCaseIds: [VISIT_CASE_ID],
					operations: [],
				},
			},
		});

		const { submitFormAction } = await import("../caseDataBinding");
		await expect(submitFormAction(mutation, APP_ID)).resolves.toEqual({
			kind: "registration",
			caseId: ALICE_CASE_ID,
			childCaseIds: [VISIT_CASE_ID],
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
		await expect(submitFormAction(mutation, APP_ID)).resolves.toEqual({
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
		loadAuthorizedFormSubmissionSnapshotMock.mockResolvedValueOnce({
			kind: "current",
			projectId: PROJECT_A,
			app: {
				blueprint: buildDoc({ appName: "Form deleted before acceptance" }),
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
		await expect(submitFormAction(mutation, APP_ID)).resolves.toMatchObject({
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
			identity,
			lookupScope: LOOKUP_SCOPE,
			mutation,
			projection,
			viewerTimeZone: "UTC",
		});
		const retry = await buildSubmissionOperationProgram({
			appId: APP_ID,
			committedApp: retryApp,
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

// ---------------------------------------------------------------
// `loadCasesAction` (Server Action)
// ---------------------------------------------------------------
//
// The action's own responsibility is thin: resolve the session, rebuild the
// SQL compiler's `(name → CaseType)` map from the LIVE catalog the client sends
// in `caseTypes`, resolve a selected persona from the locked authorized-app
// snapshot, and delegate to `readCases`. The case-type map never comes from
// that server snapshot. `readCases` itself is covered by the suites above
// against a real per-test store; here `withProjectContext` is stubbed so the
// wrapper branches are reachable without Postgres.

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

// ---------------------------------------------------------------
// `loadCaseCountAction` (Server Action)
// ---------------------------------------------------------------

describe("loadCaseCountAction", () => {
	it("returns the complete unfiltered population for the bound case type", async () => {
		const { getSession } = await import("@/lib/auth-utils");
		const { withProjectContext } = await import("@/lib/case-store");
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: OWNER_A },
		} as unknown as Awaited<ReturnType<typeof getSession>>);
		const stubStore = {
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

// ---------------------------------------------------------------
// `resetSampleCasesAction` (Server Action)
// ---------------------------------------------------------------
//
// Mirrors `populateSampleCasesAction` over the case-store's atomic
// `resetSampleData` path. The block pins the action's wrapper
// responsibilities — session resolution and the catch-and-map
// delegation through `mapPopulateSampleCasesError` — without driving
// Better Auth / Postgres. The `CaseType` arrives from the client, so
// there is no server-side lookup to stub. The `vi.mock` calls at the top
// of the file stub `getSession` and `withProjectContext` so each branch is
// reachable.

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

// ---------------------------------------------------------------
// `readFilterPreview` + `mapFilterPreviewError`
// ---------------------------------------------------------------
//
// The Filters-section live preview routes through the case-store's
// `query` (with `calculated`) for the row sample AND `count` for
// the totality figure — both compile the same predicate through the
// same stack so the count + row-list pair is internally consistent.
// These tests pin the discriminated-union return shapes the
// preview's UI dispatches on.

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

describe("mapFilterPreviewError", () => {
	// Typed case-store errors get stable result arms for the inspector.

	it("maps CaseTypeNotInBlueprintError to the missing-case-type arm", () => {
		const err = new CaseTypeNotInBlueprintError("app-1", "patient");
		expect(mapFilterPreviewError(err)).toEqual({
			kind: "missing-case-type",
			caseType: "patient",
		});
	});

	it("maps SchemaNotSyncedError to the schema-not-synced arm", () => {
		const err = new SchemaNotSyncedError("app-1", "patient");
		expect(mapFilterPreviewError(err)).toEqual({
			kind: "schema-not-synced",
			caseType: "patient",
		});
	});

	it("falls through to the generic error arm for an unrelated Error", () => {
		const err = new Error("connection refused");
		const result = mapFilterPreviewError(err);
		expect(result.kind).toBe("error");
		if (result.kind !== "error") return;
		expect(result.message).toBe("connection refused");
	});

	it("falls through to the generic error arm with a default message for non-Error throws", () => {
		const result = mapFilterPreviewError("some string");
		expect(result.kind).toBe("error");
		if (result.kind !== "error") return;
		expect(result.message).toBe("Failed to load preview.");
	});
});

// ---------------------------------------------------------------
// `loadFilterPreviewAction` (Server Action)
// ---------------------------------------------------------------
//
// Pins the wire-boundary parse arms and session-first ordering invariant.

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
