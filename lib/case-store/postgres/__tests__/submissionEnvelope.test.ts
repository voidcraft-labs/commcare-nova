// lib/case-store/postgres/__tests__/submissionEnvelope.test.ts
//
// Integration suite for `CaseStore.applySubmission`'s advanced
// case-operation program — the atomic submission envelope. Runs
// against per-test Postgres databases (the store's transaction-using
// methods reject the harness's outer BEGIN/ROLLBACK fixture).
//
// The ordinary-action arms (registration/followup/close shapes,
// rollback, id ordering) are pinned by the store contract harness and
// the preview binding suite; this file owns what only the operation
// program exercises: in-transaction expression evaluation against the
// pre-submission snapshot, identity allocation (including the pinned
// TS↔XPath authored-id vector), server-side target reauthorization,
// the resolved rolling-type proof, text-facet preparation, the
// wirePortable retype subset, identifier-keyed link CRUD with authored
// relationships, and whole-envelope rollback across ordinary +
// operation effects.

import { type Kysely, sql } from "kysely";
import { beforeEach, describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	type CaseOperation,
	type CaseType,
	type OrganizationLevel,
	USERCASE_CASE_TYPE,
} from "@/lib/domain";
import {
	actingUser,
	eq,
	fixedLocation,
	formField,
	idOf,
	literal,
	ownerLocationAtLevel,
	prop,
	term,
	unowned,
} from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";
import { buildSimpleBlueprint } from "../../__tests__/fixtures/simpleBlueprint";
import {
	CaptureSubmissionRejectedError,
	CasePropertiesValidationError,
	SubmissionRejectedError,
} from "../../errors";
import { runCaseStoreMigrations } from "../../migrate";
import { HeuristicCaseGenerator } from "../../sample/heuristic";
import { setupPerTestDatabase } from "../../sql/__tests__/perTestDatabase";
import type { Database } from "../../sql/database";
import { buildCaseTypeMap } from "../../store";
import type {
	ApplySubmissionArgs,
	CaseOperationProgram,
	EnvelopeCaseOperation,
	SubmissionReceiptClaim,
} from "../../submission";
import { PostgresCaseStore } from "../store";
import { storageValueFromEvaluation } from "../submissionEnvelope";

// ---------------------------------------------------------------
// Per-test database + store construction
// ---------------------------------------------------------------

const dbHandle = setupPerTestDatabase({
	databaseNamePrefix: "envelope_test_",
});

beforeEach(async () => {
	await runCaseStoreMigrations(dbHandle.db);
	await sql`
		INSERT INTO apps (id, owner, project_id, app_name, app_name_lower)
		VALUES
			(${APP_ID}, ${ACTOR}, ${PROJECT_A}, 'Envelope app', 'envelope app'),
			(${FOREIGN_APP_ID}, 'worker-2', ${PROJECT_B},
			 'Foreign envelope app', 'foreign envelope app')
	`.execute(dbHandle.db);
});

// `test-app` + the fixed form/operation uuids below reproduce the
// EXACT namespace tuple the domain identity suite pins, so the stored
// id can be asserted against the same literal UUIDv5 vector the XForm
// calculate implements.
const APP_ID = "test-app";
const FOREIGN_APP_ID = "test-app-foreign";
const PROJECT_A = "project-a";
const PROJECT_B = "project-b";
const ACTOR = "worker-1";
const FORM_UUID = testUuid("66666666-6666-4666-8666-666666666666");
const VECTOR_OP_UUID = testUuid("44444444-4444-4444-8444-444444444444");
const PINNED_VECTOR_PREFIX =
	"nova-case-v1:9ac52723-445f-54a7-8c1b-7e90c985637b:";

const OP_A = testUuid("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
const OP_B = testUuid("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
const OP_C = testUuid("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
const REPEAT_UUID = testUuid("99999999-9999-4999-8999-999999999999");
const KEY_FIELD = testUuid("11111111-1111-4111-8111-111111111111");
const FLAG_FIELD = testUuid("22222222-2222-4222-8222-222222222222");
const MEDS_FIELD = testUuid("33333333-3333-4333-8333-333333333333");

const SESSION_CASE_ID = "00000000-0000-7000-8000-00000000aaaa";
const SECOND_SESSION_CASE_ID = "00000000-0000-7000-8000-00000000bbbb";

const PATIENT: CaseType = {
	name: "patient",
	properties: [
		{ name: "notes", label: proseText("Notes"), data_type: "text" },
		{ name: "copy", label: proseText("Copy"), data_type: "text" },
		{ name: "age", label: proseText("Age"), data_type: "int" },
		{ name: "prior_age", label: proseText("Prior age"), data_type: "int" },
		{ name: "meds", label: proseText("Meds"), data_type: "multi_select" },
	],
};
// A superset of `patient` — every shared property keeps its exact
// type (the wirePortable retype destination), plus a destination-only
// `severity` slot a retyping operation's write may populate.
const PATIENT_V2: CaseType = {
	name: "patient_v2",
	properties: [
		...PATIENT.properties,
		{ name: "severity", label: proseText("Severity"), data_type: "text" },
	],
};
const VISIT: CaseType = {
	name: "visit",
	properties: [
		{ name: "outcome", label: proseText("Outcome"), data_type: "text" },
	],
};
// Declares only `notes` — a patient row carrying `age` cannot retype
// here without parking, so the wirePortable runtime check rejects it.
const NARROW: CaseType = {
	name: "narrow",
	properties: [{ name: "notes", label: proseText("Notes"), data_type: "text" }],
};

const ALL_TYPES = [PATIENT, PATIENT_V2, VISIT, NARROW];
const SCHEMAS = buildCaseTypeMap(buildSimpleBlueprint(ALL_TYPES, APP_ID));
let receiptSequence = 0;

function makeStore(
	projectId = PROJECT_A,
	actorUserId = ACTOR,
	ownerId = actorUserId,
) {
	return new PostgresCaseStore({
		projectId,
		actorUserId,
		ownerId,
		db: dbHandle.db as unknown as Kysely<Database>,
		sampleGenerator: new HeuristicCaseGenerator(),
	});
}

type TestSubmissionArgs = Omit<ApplySubmissionArgs, "submissionReceipt"> & {
	readonly submissionReceipt?: SubmissionReceiptClaim;
};

function receiptFor(args: TestSubmissionArgs): SubmissionReceiptClaim {
	if (args.captureIntent !== undefined) {
		return {
			entryKey: args.captureIntent.entryKey,
			formUuid: args.captureIntent.formUuid,
			expectedAppMutationSeq: args.captureIntent.expectedAppMutationSeq,
			blueprintDigest: "0".repeat(64),
			requestDigest: args.captureIntent.requestDigest,
		};
	}
	receiptSequence += 1;
	return {
		entryKey: `submission-envelope-entry-${receiptSequence}`,
		formUuid: args.operations?.formUuid ?? FORM_UUID,
		expectedAppMutationSeq: 0,
		blueprintDigest: "0".repeat(64),
		requestDigest: `submission-envelope-request-${receiptSequence}`,
	};
}

function submit(
	store: PostgresCaseStore,
	args: TestSubmissionArgs,
): Promise<Awaited<ReturnType<PostgresCaseStore["applySubmission"]>>> {
	return store.applySubmission({
		...args,
		submissionReceipt: args.submissionReceipt ?? receiptFor(args),
	});
}

async function seedSchemas(
	store: PostgresCaseStore,
	appId = APP_ID,
): Promise<void> {
	for (const caseType of ALL_TYPES) {
		await store.applySchemaChange({
			appId,
			caseType: caseType.name,
			caseTypeSchemas: SCHEMAS,
		});
	}
}

async function seedSessionPatient(
	store: PostgresCaseStore,
	properties: Record<string, unknown> = { notes: "original" },
): Promise<void> {
	await seedPatient(store, SESSION_CASE_ID, "Alice", properties);
}

async function seedPatient(
	store: PostgresCaseStore,
	caseId: string,
	caseName: string,
	properties: Record<string, unknown> = { notes: "original" },
): Promise<void> {
	await store.insert({
		appId: APP_ID,
		row: {
			case_id: caseId,
			case_type: "patient",
			case_name: caseName,
			status: "open",
			properties: JSON.stringify(properties),
		},
	});
}

// ---------------------------------------------------------------
// Program construction sugar
// ---------------------------------------------------------------

function operation(partial: Partial<CaseOperation>): CaseOperation {
	return {
		uuid: OP_A,
		id: "op_a",
		action: "update",
		caseType: "patient",
		target: { kind: "session" },
		...partial,
	} as CaseOperation;
}

function envOp(
	op: CaseOperation,
	extras?: Partial<Omit<EnvelopeCaseOperation, "operation">>,
): EnvelopeCaseOperation {
	return {
		operation: op,
		guardConditions: [],
		expressionSnapshotTypes: { links: new Map() },
		...extras,
	};
}

function rootProgram(
	operations: EnvelopeCaseOperation[],
	opts?: {
		formFields?: ReadonlyArray<[string, string | readonly string[]]>;
		sessionCaseId?: string | null;
		organizationLevels?: Readonly<Record<string, OrganizationLevel>>;
	},
): CaseOperationProgram {
	const sessionCaseId =
		opts?.sessionCaseId === null
			? undefined
			: (opts?.sessionCaseId ?? SESSION_CASE_ID);
	return {
		formUuid: FORM_UUID,
		operations,
		scopes: [
			{
				iterations: [
					{
						formFields: new Map(
							(opts?.formFields ?? []).map(([k, v]) => [testUuid(k), v]),
						),
					},
				],
			},
		],
		...(sessionCaseId === undefined ? {} : { sessionCaseIds: [sessionCaseId] }),
		caseTypeSchemas: SCHEMAS,
		...(opts?.organizationLevels === undefined
			? {}
			: { organizationLevels: opts.organizationLevels }),
	};
}

function followupOrdinary(patchProperties: Record<string, unknown> = {}): {
	kind: "followup";
	caseIds: string[];
	selection: { kind: "single"; maximum: 1 };
	caseType: string;
	patch: { properties: Record<string, never> };
	children: [];
} {
	return {
		kind: "followup",
		caseIds: [SESSION_CASE_ID],
		selection: { kind: "single", maximum: 1 },
		caseType: "patient",
		patch: { properties: patchProperties as Record<string, never> },
		children: [],
	};
}

async function rejection(
	promise: Promise<unknown>,
): Promise<SubmissionRejectedError> {
	try {
		await promise;
	} catch (err) {
		expect(err).toBeInstanceOf(SubmissionRejectedError);
		return err as SubmissionRejectedError;
	}
	throw new Error("expected the envelope to reject, but it resolved");
}

async function patientRow(store: PostgresCaseStore, caseId: string) {
	const rows = await store.query({
		appId: APP_ID,
		caseType: "patient",
		includeHeld: true,
	});
	return rows.find((row) => row.case_id === caseId);
}

// ---------------------------------------------------------------
// Authored identity — the pinned TS↔XPath vector via the executor
// ---------------------------------------------------------------

describe("authored create identity", () => {
	it("derives the pinned nova-case-v1 vector id and stores the row under it", async () => {
		const store = makeStore();
		await seedSchemas(store);

		await submit(store, {
			appId: APP_ID,
			ordinary: { kind: "none" },
			operations: rootProgram(
				[
					envOp(
						operation({
							uuid: VECTOR_OP_UUID,
							id: "make_visit",
							action: "create",
							caseType: "visit",
							target: { kind: "new", idFrom: KEY_FIELD },
							name: term(literal("Visit A")),
						}),
					),
				],
				{
					formFields: [[KEY_FIELD, "external-123"]],
					sessionCaseId: null,
				},
			),
		});

		// The exact literal the domain identity suite and the XForm
		// calculate pin — the executor implements the same versioned
		// derivation, not a lookalike.
		const visits = await store.query({ appId: APP_ID, caseType: "visit" });
		expect(visits).toHaveLength(1);
		expect(visits[0]?.case_id).toBe(`${PINNED_VECTOR_PREFIX}external-123`);
		expect(visits[0]?.case_name).toBe("Visit A");
		expect(visits[0]?.owner_id).toBe(ACTOR);
		expect(visits[0]?.status).toBe("open");
	});

	it("rejects a blank authored key before any DML", async () => {
		const store = makeStore();
		await seedSchemas(store);

		const err = await rejection(
			submit(store, {
				appId: APP_ID,
				ordinary: { kind: "none" },
				operations: rootProgram(
					[
						envOp(
							operation({
								uuid: VECTOR_OP_UUID,
								action: "create",
								caseType: "visit",
								target: { kind: "new", idFrom: KEY_FIELD },
								name: term(literal("Visit A")),
							}),
						),
					],
					{ formFields: [[KEY_FIELD, ""]], sessionCaseId: null },
				),
			}),
		);
		expect(err.rejection).toMatchObject({
			kind: "authored-key",
			reason: "blank",
			operationUuid: VECTOR_OP_UUID,
		});
		expect(
			await store.query({ appId: APP_ID, caseType: "visit" }),
		).toHaveLength(0);
	});

	it("rejects an over-205-unit authored key before any DML", async () => {
		const store = makeStore();
		await seedSchemas(store);

		const err = await rejection(
			submit(store, {
				appId: APP_ID,
				ordinary: { kind: "none" },
				operations: rootProgram(
					[
						envOp(
							operation({
								uuid: VECTOR_OP_UUID,
								action: "create",
								caseType: "visit",
								target: { kind: "new", idFrom: KEY_FIELD },
								name: term(literal("Visit A")),
							}),
						),
					],
					{
						formFields: [[KEY_FIELD, "x".repeat(206)]],
						sessionCaseId: null,
					},
				),
			}),
		);
		expect(err.rejection).toMatchObject({
			kind: "authored-key",
			reason: "too-long",
			maxKeyLength: 205,
		});
		expect(
			await store.query({ appId: APP_ID, caseType: "visit" }),
		).toHaveLength(0);
	});

	it("merges a duplicate authored id onto the existing row (create-of-existing)", async () => {
		const store = makeStore();
		await seedSchemas(store);
		const submitExisting = (name: string, notes: string) =>
			submit(store, {
				appId: APP_ID,
				ordinary: { kind: "none" },
				operations: rootProgram(
					[
						envOp(
							operation({
								uuid: VECTOR_OP_UUID,
								action: "create",
								caseType: "visit",
								target: { kind: "new", idFrom: KEY_FIELD },
								name: term(literal(name)),
								writes: [
									{ property: "outcome", value: term(literal(notes)) },
									{
										property: "external_id",
										value: term(literal(`external-${name}`)),
									},
								],
							}),
						),
					],
					{ formFields: [[KEY_FIELD, "repeat-key"]], sessionCaseId: null },
				),
			});

		await submitExisting("First", "started");
		await submitExisting("Second", "finished");

		// One row, the retry's facets applied over it — the same merge
		// Core and HQ perform for a create naming a known id.
		const visits = await store.query({ appId: APP_ID, caseType: "visit" });
		expect(visits).toHaveLength(1);
		expect(visits[0]?.case_id).toBe(`${PINNED_VECTOR_PREFIX}repeat-key`);
		expect(visits[0]?.case_name).toBe("Second");
		expect(visits[0]?.external_id).toBe("external-Second");
		expect(visits[0]?.properties).toMatchObject({ outcome: "finished" });
		expect(visits[0]?.properties).not.toHaveProperty("external_id");
	});

	it("carries a non-UUID authored id through update, link, and close", async () => {
		const store = makeStore();
		await seedSchemas(store);
		await seedSessionPatient(store);
		const authoredId = `${PINNED_VECTOR_PREFIX}url unsafe/&?id`;

		await submit(store, {
			appId: APP_ID,
			ordinary: { kind: "none" },
			operations: rootProgram(
				[
					envOp(
						operation({
							uuid: VECTOR_OP_UUID,
							action: "create",
							caseType: "visit",
							target: { kind: "new", idFrom: KEY_FIELD },
							name: term(literal("Visit A")),
						}),
					),
				],
				{ formFields: [[KEY_FIELD, "url unsafe/&?id"]], sessionCaseId: null },
			),
		});

		// A later submission updates, links, and closes the authored-id
		// row through a runtime expression target — the opaque id is a
		// first-class identity on every arm.
		await submit(store, {
			appId: APP_ID,
			ordinary: { kind: "none" },
			operations: rootProgram([
				envOp(
					operation({
						uuid: OP_B,
						id: "op_b",
						action: "update",
						caseType: "visit",
						target: { kind: "expression", expr: term(literal(authoredId)) },
						writes: [{ property: "outcome", value: term(literal("complete")) }],
					}),
					{ expressionSnapshotTypes: { target: "visit", links: new Map() } },
				),
				envOp(
					operation({
						uuid: OP_C,
						id: "op_c",
						action: "update",
						caseType: "patient",
						target: { kind: "session" },
						links: [
							{
								identifier: "recent_visit",
								targetType: "visit",
								target: {
									kind: "expression",
									expr: term(literal(authoredId)),
								},
								relationship: "extension",
							},
						],
					}),
					{
						expressionSnapshotTypes: {
							links: new Map([[0, "visit"]]),
						},
					},
				),
				envOp(
					operation({
						uuid: OP_A,
						id: "op_close",
						action: "close",
						caseType: "visit",
						target: { kind: "expression", expr: term(literal(authoredId)) },
					}),
					{ expressionSnapshotTypes: { target: "visit", links: new Map() } },
				),
			]),
		});

		const visits = await store.query({
			appId: APP_ID,
			caseType: "visit",
		});
		expect(visits[0]?.properties).toMatchObject({ outcome: "complete" });
		expect(visits[0]?.status).toBe("closed");
		expect(visits[0]?.closed_on).not.toBeNull();

		const edges = await dbHandle.pool.query(
			`SELECT ancestor_id, relationship FROM case_indices WHERE case_id = $1 AND identifier = 'recent_visit'`,
			[SESSION_CASE_ID],
		);
		expect(edges.rows).toEqual([
			{ ancestor_id: authoredId, relationship: "extension" },
		]);
	});
});

// ---------------------------------------------------------------
// Whole-envelope atomicity
// ---------------------------------------------------------------

describe("whole-envelope atomicity", () => {
	it("a three-operation program lands together or not at all", async () => {
		const store = makeStore();
		await seedSchemas(store);
		await seedSessionPatient(store);

		const program = (thirdTarget: string) =>
			rootProgram([
				envOp(
					operation({
						uuid: OP_A,
						id: "op_a",
						action: "create",
						caseType: "visit",
						target: { kind: "new" },
						name: term(literal("Visit A")),
					}),
				),
				envOp(
					operation({
						uuid: OP_B,
						id: "op_b",
						action: "update",
						caseType: "patient",
						target: { kind: "session" },
						writes: [{ property: "notes", value: term(literal("updated")) }],
					}),
				),
				envOp(
					operation({
						uuid: OP_C,
						id: "op_c",
						action: "close",
						caseType: "visit",
						target: { kind: "expression", expr: term(literal(thirdTarget)) },
					}),
					{ expressionSnapshotTypes: { target: "visit", links: new Map() } },
				),
			]);

		// Third operation's runtime target resolves nothing — the whole
		// program must roll back: no created visit, no patient write.
		const err = await rejection(
			submit(store, {
				appId: APP_ID,
				ordinary: { kind: "none" },
				operations: program("no-such-case"),
			}),
		);
		expect(err.rejection).toMatchObject({
			kind: "target",
			reason: "not-found-or-out-of-scope",
			operationUuid: OP_C,
		});
		expect(
			await store.query({ appId: APP_ID, caseType: "visit" }),
		).toHaveLength(0);
		expect(
			(await patientRow(store, SESSION_CASE_ID))?.properties,
		).toMatchObject({ notes: "original" });
	});

	it("rolls the operation program back when the ordinary close's child fails", async () => {
		const store = makeStore();
		await seedSchemas(store);
		await seedSessionPatient(store);

		await expect(
			submit(store, {
				appId: APP_ID,
				ordinary: {
					kind: "close",
					caseIds: [SESSION_CASE_ID],
					selection: { kind: "single", maximum: 1 },
					caseType: "patient",
					patch: { properties: { notes: "final" } },
					children: [
						{
							caseType: "visit",
							caseName: "Bad child",
							// `outcome` is text; an unknown property fails the
							// schema's additionalProperties check.
							properties: { unknown_property: "boom" },
						},
					],
				},
				operations: rootProgram([
					envOp(
						operation({
							uuid: OP_A,
							action: "create",
							caseType: "visit",
							target: { kind: "new" },
							name: term(literal("Visit A")),
						}),
					),
				]),
			}),
		).rejects.toThrow(CasePropertiesValidationError);

		// NOTHING landed: not the operation's create, not the ordinary
		// patch, not the lifecycle transition.
		expect(
			await store.query({ appId: APP_ID, caseType: "visit" }),
		).toHaveLength(0);
		const row = await patientRow(store, SESSION_CASE_ID);
		expect(row?.properties).toMatchObject({ notes: "original" });
		expect(row?.status).toBe("open");
		expect(row?.closed_on).toBeNull();
	});
});

describe("ordered selected-case batches", () => {
	it("runs form-level creates once per repeat before selected-case operations", async () => {
		const store = makeStore();
		await seedSchemas(store);
		await seedPatient(store, SESSION_CASE_ID, "Alice");
		await seedPatient(store, SECOND_SESSION_CASE_ID, "Bob");
		const caseIds = [SECOND_SESSION_CASE_ID, SESSION_CASE_ID];

		const result = await submit(store, {
			appId: APP_ID,
			ordinary: {
				kind: "followup",
				caseIds,
				selection: { kind: "multiple", maximum: 2 },
				caseType: "patient",
				patch: { properties: {} },
				children: [],
			},
			operations: {
				formUuid: FORM_UUID,
				sessionCaseIds: caseIds,
				operations: [
					envOp(
						operation({
							uuid: OP_A,
							id: "make_visit",
							action: "create",
							caseType: "visit",
							target: { kind: "new" },
							name: term(formField(KEY_FIELD)),
							forEach: { repeat: REPEAT_UUID },
						}),
					),
					envOp(
						operation({
							uuid: OP_B,
							id: "record_visit",
							action: "update",
							caseType: "patient",
							target: { kind: "session" },
							writes: [{ property: "copy", value: idOf(OP_A) }],
							forEach: { repeat: REPEAT_UUID },
						}),
					),
				],
				scopes: [
					{ iterations: [{ formFields: new Map() }] },
					{
						repeat: REPEAT_UUID,
						iterations: [
							{ formFields: new Map([[KEY_FIELD, "Intake"]]) },
							{ formFields: new Map([[KEY_FIELD, "Exit"]]) },
						],
					},
				],
				caseTypeSchemas: SCHEMAS,
			},
		});

		expect(result.primaryCaseIds).toEqual(caseIds);
		expect(
			result.operations.map(
				({ operationUuid, iteration, selection, caseId }) => ({
					operationUuid,
					iteration,
					selection,
					caseId,
				}),
			),
		).toEqual([
			{
				operationUuid: OP_A,
				iteration: 0,
				selection: 0,
				caseId: expect.any(String),
			},
			{
				operationUuid: OP_B,
				iteration: 0,
				selection: 0,
				caseId: SECOND_SESSION_CASE_ID,
			},
			{
				operationUuid: OP_B,
				iteration: 0,
				selection: 1,
				caseId: SESSION_CASE_ID,
			},
			{
				operationUuid: OP_A,
				iteration: 1,
				selection: 0,
				caseId: expect.any(String),
			},
			{
				operationUuid: OP_B,
				iteration: 1,
				selection: 0,
				caseId: SECOND_SESSION_CASE_ID,
			},
			{
				operationUuid: OP_B,
				iteration: 1,
				selection: 1,
				caseId: SESSION_CASE_ID,
			},
		]);
		const createdCaseIds = result.operations
			.filter(({ operationUuid }) => operationUuid === OP_A)
			.map(({ caseId }) => caseId);
		expect(createdCaseIds).toHaveLength(2);
		expect(new Set(createdCaseIds).size).toBe(2);
		expect(
			await store.query({ appId: APP_ID, caseType: "visit" }),
		).toHaveLength(2);
		for (const caseId of caseIds) {
			expect((await patientRow(store, caseId))?.properties).toMatchObject({
				copy: createdCaseIds[1],
			});
		}
	});

	it("runs repeat outer by selected case inner with one session anchor per case", async () => {
		const store = makeStore();
		await seedSchemas(store);
		await seedPatient(store, SESSION_CASE_ID, "Alice");
		await seedPatient(store, SECOND_SESSION_CASE_ID, "Bob");
		const caseIds = [SESSION_CASE_ID, SECOND_SESSION_CASE_ID];

		const result = await submit(store, {
			appId: APP_ID,
			ordinary: {
				kind: "followup",
				caseIds,
				selection: { kind: "multiple", maximum: 2 },
				caseType: "patient",
				patch: { properties: {} },
				children: [],
			},
			operations: {
				formUuid: FORM_UUID,
				sessionCaseIds: caseIds,
				operations: [
					envOp(
						operation({
							action: "update",
							caseType: "patient",
							target: { kind: "session" },
							writes: [
								{ property: "notes", value: term(formField(KEY_FIELD)) },
							],
							forEach: { repeat: REPEAT_UUID },
						}),
					),
				],
				scopes: [
					{ iterations: [{ formFields: new Map() }] },
					{
						repeat: REPEAT_UUID,
						iterations: [
							{ formFields: new Map([[KEY_FIELD, "first"]]) },
							{ formFields: new Map([[KEY_FIELD, "second"]]) },
						],
					},
				],
				caseTypeSchemas: SCHEMAS,
			},
		});

		expect(result.primaryCaseIds).toEqual(caseIds);
		expect(
			result.operations.map(({ iteration, selection, caseId }) => ({
				iteration,
				selection,
				caseId,
			})),
		).toEqual([
			{ iteration: 0, selection: 0, caseId: SESSION_CASE_ID },
			{ iteration: 0, selection: 1, caseId: SECOND_SESSION_CASE_ID },
			{ iteration: 1, selection: 0, caseId: SESSION_CASE_ID },
			{ iteration: 1, selection: 1, caseId: SECOND_SESSION_CASE_ID },
		]);
		for (const caseId of caseIds) {
			expect((await patientRow(store, caseId))?.properties).toMatchObject({
				notes: "second",
			});
		}
	});

	it("fans children and close across the ordered selection", async () => {
		const store = makeStore();
		await seedSchemas(store);
		await seedPatient(store, SESSION_CASE_ID, "Alice");
		await seedPatient(store, SECOND_SESSION_CASE_ID, "Bob");
		const caseIds = [SECOND_SESSION_CASE_ID, SESSION_CASE_ID];

		const result = await submit(store, {
			appId: APP_ID,
			ordinary: {
				kind: "close",
				caseIds,
				selection: { kind: "multiple", maximum: 4 },
				caseType: "patient",
				patch: { properties: {} },
				children: [
					{
						caseType: "visit",
						caseName: "Intake",
						properties: { outcome: "intake" },
					},
					{
						caseType: "visit",
						caseName: "Exit",
						properties: { outcome: "exit" },
					},
				],
			},
		});

		expect(result.primaryCaseIds).toEqual(caseIds);
		const children = await store.query({
			appId: APP_ID,
			caseType: "visit",
			caseIds: result.createdChildren.map((child) => child.caseId),
		});
		const childById = new Map(children.map((row) => [row.case_id, row]));
		expect(result.createdChildren).toEqual([
			{
				authoredChildIndex: 0,
				parentCaseId: SECOND_SESSION_CASE_ID,
				caseId: expect.any(String),
			},
			{
				authoredChildIndex: 0,
				parentCaseId: SESSION_CASE_ID,
				caseId: expect.any(String),
			},
			{
				authoredChildIndex: 1,
				parentCaseId: SECOND_SESSION_CASE_ID,
				caseId: expect.any(String),
			},
			{
				authoredChildIndex: 1,
				parentCaseId: SESSION_CASE_ID,
				caseId: expect.any(String),
			},
		]);
		for (const createdChild of result.createdChildren) {
			expect(childById.get(createdChild.caseId)?.parent_case_id).toBe(
				createdChild.parentCaseId,
			);
		}
		for (const caseId of caseIds) {
			expect((await patientRow(store, caseId))?.status).toBe("closed");
		}
	});

	it("rolls back the receipt on stale selection and accepts an exact retry", async () => {
		const store = makeStore();
		await seedSchemas(store);
		await seedPatient(store, SESSION_CASE_ID, "Alice");
		const submissionReceipt: SubmissionReceiptClaim = {
			entryKey: "multi-selection-retry",
			formUuid: FORM_UUID,
			expectedAppMutationSeq: 0,
			blueprintDigest: "0".repeat(64),
			requestDigest: "multi-selection-retry-request",
		};
		const args = {
			appId: APP_ID,
			submissionReceipt,
			ordinary: {
				kind: "close" as const,
				caseIds: [SESSION_CASE_ID, SECOND_SESSION_CASE_ID],
				selection: { kind: "multiple" as const, maximum: 2 },
				caseType: "patient",
				patch: { properties: {} },
				children: [
					{
						caseType: "visit",
						caseName: "Final visit",
						properties: { outcome: "done" },
					},
				],
			},
		};

		const firstError = await rejection(submit(store, args));
		expect(firstError.rejection).toMatchObject({
			kind: "selection",
			reason: "not-found-or-out-of-scope",
			caseId: SECOND_SESSION_CASE_ID,
		});
		expect((await patientRow(store, SESSION_CASE_ID))?.status).toBe("open");
		const receiptCount = await sql<{ count: string }>`
			SELECT count(*)::text AS count
			FROM form_submission_intents
			WHERE app_id = ${APP_ID} AND entry_key = ${submissionReceipt.entryKey}
		`.execute(dbHandle.db);
		expect(receiptCount.rows[0]?.count).toBe("0");

		await seedPatient(store, SECOND_SESSION_CASE_ID, "Bob");
		const accepted = await submit(store, args);
		expect(await submit(store, args)).toEqual(accepted);
		expect(accepted.createdChildren).toHaveLength(2);
		const acceptedReceipt = await sql<{ result: unknown }>`
			SELECT result
			FROM form_submission_intents
			WHERE app_id = ${APP_ID} AND entry_key = ${submissionReceipt.entryKey}
		`.execute(dbHandle.db);
		expect(acceptedReceipt.rows[0]?.result).toMatchObject({
			createdChildren: accepted.createdChildren,
		});
		expect(acceptedReceipt.rows[0]?.result).not.toHaveProperty("childCaseIds");
		expect(
			await store.query({ appId: APP_ID, caseType: "visit" }),
		).toHaveLength(2);
	});
});

// ---------------------------------------------------------------
// Pre-submission snapshot semantics
// ---------------------------------------------------------------

describe("pre-submission snapshot", () => {
	it("every expression evaluates against pre-effect values", async () => {
		const store = makeStore();
		await seedSchemas(store);
		await seedSessionPatient(store, { notes: "original" });

		await submit(store, {
			appId: APP_ID,
			ordinary: { kind: "none" },
			operations: rootProgram([
				envOp(
					operation({
						uuid: OP_A,
						id: "op_a",
						action: "update",
						caseType: "patient",
						target: { kind: "session" },
						writes: [{ property: "notes", value: term(literal("changed")) }],
					}),
				),
				envOp(
					operation({
						uuid: OP_B,
						id: "op_b",
						action: "update",
						caseType: "patient",
						target: { kind: "session" },
						// Reads the SNAPSHOT value of `notes`, not op_a's
						// effect — the device's calculates all run against the
						// immutable pre-submission casedb.
						writes: [
							{ property: "copy", value: term(prop("patient", "notes")) },
						],
					}),
				),
			]),
		});

		const row = await patientRow(store, SESSION_CASE_ID);
		expect(row?.properties).toMatchObject({
			notes: "changed",
			copy: "original",
		});
	});
});

// ---------------------------------------------------------------
// Blank writes — the wire's '' projected onto typed storage
// ---------------------------------------------------------------

describe("blank writes", () => {
	it("an explicit blank external_id write stores an empty scalar, never a JSONB removal", async () => {
		const store = makeStore();
		await seedSchemas(store);
		await seedSessionPatient(store);

		await submit(store, {
			appId: APP_ID,
			ordinary: { kind: "none" },
			operations: rootProgram([
				envOp(
					operation({
						uuid: OP_A,
						action: "update",
						caseType: "patient",
						target: { kind: "session" },
						writes: [
							{ property: "external_id", value: term(literal(" \t\r\n ")) },
						],
					}),
				),
			]),
		});

		const row = await patientRow(store, SESSION_CASE_ID);
		expect(row?.external_id).toBe("");
		expect(row?.properties).not.toHaveProperty("external_id");
	});

	it("a blank-evaluated typed write clears the stored key instead of failing", async () => {
		const store = makeStore();
		await seedSchemas(store);
		// `age` holds a value; `prior_age` is absent, so the int→int
		// write below evaluates SQL NULL — the device's calculate writes
		// `''` and commits; Nova's typed storage projects that blank as
		// key-absent, clearing the previous value.
		await seedSessionPatient(store, { notes: "original", age: 30 });

		await submit(store, {
			appId: APP_ID,
			ordinary: { kind: "none" },
			operations: rootProgram([
				envOp(
					operation({
						uuid: OP_A,
						action: "update",
						caseType: "patient",
						target: { kind: "session" },
						writes: [
							{ property: "age", value: term(prop("patient", "prior_age")) },
							{ property: "notes", value: term(literal("still here")) },
						],
					}),
				),
			]),
		});

		const row = await patientRow(store, SESSION_CASE_ID);
		expect(row?.properties).toMatchObject({ notes: "still here" });
		expect(row?.properties).not.toHaveProperty("age");
	});

	it("a blank write on a fresh create never mints the key", async () => {
		const store = makeStore();
		await seedSchemas(store);

		await submit(store, {
			appId: APP_ID,
			ordinary: { kind: "none" },
			operations: rootProgram(
				[
					envOp(
						operation({
							uuid: OP_A,
							action: "create",
							caseType: "visit",
							target: { kind: "new" },
							name: term(literal("Visit A")),
							writes: [{ property: "outcome", value: term(literal("")) }],
						}),
					),
				],
				{ sessionCaseId: null },
			),
		});

		const visits = await store.query({ appId: APP_ID, caseType: "visit" });
		expect(visits).toHaveLength(1);
		expect(visits[0]?.properties).not.toHaveProperty("outcome");
	});
});

// ---------------------------------------------------------------
// Conditions and guards
// ---------------------------------------------------------------

describe("conditions", () => {
	it("a false condition skips the operation and its guarded consumers", async () => {
		const store = makeStore();
		await seedSchemas(store);
		const condition = eq(formField(FLAG_FIELD), literal("yes"));

		const result = await submit(store, {
			appId: APP_ID,
			ordinary: { kind: "none" },
			operations: rootProgram(
				[
					envOp(
						operation({
							uuid: OP_A,
							id: "op_a",
							action: "create",
							caseType: "visit",
							target: { kind: "new" },
							name: term(literal("Conditional visit")),
							condition,
						}),
					),
					// The consumer inherits the producer's condition — a
					// skipped create never leaks its allocated id into a
					// dangling update.
					envOp(
						operation({
							uuid: OP_B,
							id: "op_b",
							action: "update",
							caseType: "visit",
							target: { kind: "op", opUuid: OP_A },
							writes: [
								{ property: "outcome", value: term(literal("visited")) },
							],
						}),
						{ guardConditions: [condition] },
					),
				],
				{ formFields: [[FLAG_FIELD, "no"]], sessionCaseId: null },
			),
		});

		expect(
			await store.query({ appId: APP_ID, caseType: "visit" }),
		).toHaveLength(0);
		expect(result.operations.map((entry) => entry.executed)).toEqual([
			false,
			false,
		]);
	});

	it("a skipped authored-key create holds its blank-key failure", async () => {
		const store = makeStore();
		await seedSchemas(store);

		// The wire never runs an irrelevant block's calculate, so a blank
		// key on a false-conditioned create must not reject the envelope
		// — the allocation holds the failure and discards it with the
		// skip.
		const result = await submit(store, {
			appId: APP_ID,
			ordinary: { kind: "none" },
			operations: rootProgram(
				[
					envOp(
						operation({
							uuid: OP_A,
							action: "create",
							caseType: "visit",
							target: { kind: "new", idFrom: KEY_FIELD },
							name: term(literal("Never made")),
							condition: eq(formField(FLAG_FIELD), literal("yes")),
						}),
					),
				],
				{
					formFields: [
						[KEY_FIELD, ""],
						[FLAG_FIELD, "no"],
					],
					sessionCaseId: null,
				},
			),
		});

		expect(result.operations).toEqual([
			expect.objectContaining({ executed: false }),
		]);
		expect(
			await store.query({ appId: APP_ID, caseType: "visit" }),
		).toHaveLength(0);
	});

	it("a true condition executes the chain", async () => {
		const store = makeStore();
		await seedSchemas(store);
		const condition = eq(formField(FLAG_FIELD), literal("yes"));

		const result = await submit(store, {
			appId: APP_ID,
			ordinary: { kind: "none" },
			operations: rootProgram(
				[
					envOp(
						operation({
							uuid: OP_A,
							id: "op_a",
							action: "create",
							caseType: "visit",
							target: { kind: "new" },
							name: term(literal("Conditional visit")),
							condition,
						}),
					),
					envOp(
						operation({
							uuid: OP_B,
							id: "op_b",
							action: "update",
							caseType: "visit",
							target: { kind: "op", opUuid: OP_A },
							writes: [
								{ property: "outcome", value: term(literal("visited")) },
							],
						}),
						{ guardConditions: [condition] },
					),
				],
				{ formFields: [[FLAG_FIELD, "yes"]], sessionCaseId: null },
			),
		});

		const visits = await store.query({ appId: APP_ID, caseType: "visit" });
		expect(visits).toHaveLength(1);
		expect(visits[0]?.properties).toMatchObject({ outcome: "visited" });
		expect(result.operations.map((entry) => entry.executed)).toEqual([
			true,
			true,
		]);
	});

	it("a false write condition skips just that write", async () => {
		const store = makeStore();
		await seedSchemas(store);
		await seedSessionPatient(store);

		await submit(store, {
			appId: APP_ID,
			ordinary: { kind: "none" },
			operations: rootProgram(
				[
					envOp(
						operation({
							uuid: OP_A,
							action: "update",
							caseType: "patient",
							target: { kind: "session" },
							writes: [
								{ property: "notes", value: term(literal("kept")) },
								{
									property: "copy",
									value: term(literal("dropped")),
									condition: eq(formField(FLAG_FIELD), literal("yes")),
								},
							],
						}),
					),
				],
				{ formFields: [[FLAG_FIELD, "no"]] },
			),
		});

		const row = await patientRow(store, SESSION_CASE_ID);
		expect(row?.properties).toMatchObject({ notes: "kept" });
		expect(row?.properties).not.toHaveProperty("copy");
	});
});

// ---------------------------------------------------------------
// Target reauthorization
// ---------------------------------------------------------------

describe("expression target reauthorization", () => {
	it("a foreign-Project id collapses to not-found", async () => {
		const storeB = makeStore(PROJECT_B, "worker-2");
		await seedSchemas(storeB, FOREIGN_APP_ID);
		const foreign = await storeB.insert({
			appId: FOREIGN_APP_ID,
			row: {
				case_type: "patient",
				case_name: "Foreign",
				status: "open",
				properties: "{}",
			},
		});

		const storeA = makeStore();
		await seedSchemas(storeA);
		const err = await rejection(
			submit(storeA, {
				appId: APP_ID,
				ordinary: { kind: "none" },
				operations: rootProgram(
					[
						envOp(
							operation({
								uuid: OP_A,
								action: "update",
								caseType: "patient",
								target: {
									kind: "expression",
									expr: term(literal(foreign.caseId)),
								},
								writes: [{ property: "notes", value: term(literal("x")) }],
							}),
							{
								expressionSnapshotTypes: {
									target: "patient",
									links: new Map(),
								},
							},
						),
					],
					{ sessionCaseId: null },
				),
			}),
		);
		expect(err.rejection).toMatchObject({
			kind: "target",
			reason: "not-found-or-out-of-scope",
		});
	});

	it("a wrong-type row reports case-type-mismatch after Project authorization", async () => {
		const store = makeStore();
		await seedSchemas(store);
		const visit = await store.insert({
			appId: APP_ID,
			row: {
				case_type: "visit",
				case_name: "V",
				status: "open",
				properties: "{}",
			},
		});

		const err = await rejection(
			submit(store, {
				appId: APP_ID,
				ordinary: { kind: "none" },
				operations: rootProgram(
					[
						envOp(
							operation({
								uuid: OP_A,
								action: "update",
								caseType: "patient",
								target: {
									kind: "expression",
									expr: term(literal(visit.caseId)),
								},
								writes: [{ property: "notes", value: term(literal("x")) }],
							}),
							{
								expressionSnapshotTypes: {
									target: "patient",
									links: new Map(),
								},
							},
						),
					],
					{ sessionCaseId: null },
				),
			}),
		);
		expect(err.rejection).toMatchObject({
			kind: "target",
			reason: "case-type-mismatch",
		});
	});

	it("a held case is unreachable as an expression target", async () => {
		const store = makeStore();
		await seedSchemas(store);
		await seedSessionPatient(store);
		// Park a value on the session case — an active kept entry HOLDS
		// the case out of every runtime read, this resolution included.
		await dbHandle.pool.query(
			`INSERT INTO parked_case_values (app_id, case_id, case_type, property, original_value, reason, from_type, to_type)
			 VALUES ($1, $2, 'patient', 'age', '"x"', 'test park', 'text', 'int')`,
			[APP_ID, SESSION_CASE_ID],
		);

		const err = await rejection(
			submit(store, {
				appId: APP_ID,
				ordinary: { kind: "none" },
				operations: rootProgram(
					[
						envOp(
							operation({
								uuid: OP_A,
								action: "update",
								caseType: "patient",
								target: {
									kind: "expression",
									expr: term(literal(SESSION_CASE_ID)),
								},
								writes: [{ property: "notes", value: term(literal("x")) }],
							}),
							{
								expressionSnapshotTypes: {
									target: "patient",
									links: new Map(),
								},
							},
						),
					],
					{ sessionCaseId: null },
				),
			}),
		);
		expect(err.rejection).toMatchObject({
			kind: "target",
			reason: "not-found-or-out-of-scope",
		});
	});
});

// ---------------------------------------------------------------
// Rolling type proof over the resolved sequence
// ---------------------------------------------------------------

describe("resolved sequence proof", () => {
	it("rejects a self-link", async () => {
		const store = makeStore();
		await seedSchemas(store);
		await seedSessionPatient(store);

		const err = await rejection(
			submit(store, {
				appId: APP_ID,
				ordinary: { kind: "none" },
				operations: rootProgram([
					envOp(
						operation({
							uuid: OP_A,
							action: "update",
							caseType: "patient",
							target: { kind: "session" },
							links: [
								{
									identifier: "buddy",
									targetType: "patient",
									target: { kind: "session" },
									relationship: "child",
								},
							],
						}),
					),
				]),
			}),
		);
		expect(err.rejection).toMatchObject({
			kind: "sequence",
			reason: "case-link-target-is-self",
			slot: "link:buddy",
		});
	});

	it("rejects a post-retype consumer expecting the old type", async () => {
		const store = makeStore();
		await seedSchemas(store);
		await seedSessionPatient(store);

		const err = await rejection(
			submit(store, {
				appId: APP_ID,
				ordinary: { kind: "none" },
				operations: rootProgram([
					envOp(
						operation({
							uuid: OP_A,
							id: "op_retype",
							action: "update",
							caseType: "patient",
							target: { kind: "session" },
							retype: "patient_v2",
						}),
					),
					envOp(
						operation({
							uuid: OP_B,
							id: "op_stale",
							action: "update",
							caseType: "patient",
							target: { kind: "session" },
							writes: [{ property: "notes", value: term(literal("x")) }],
						}),
					),
				]),
			}),
		);
		expect(err.rejection).toMatchObject({
			kind: "sequence",
			reason: "rolling-case-type-mismatch",
			operationUuid: OP_B,
		});
		// Nothing applied — the proof runs before the first effect.
		expect((await patientRow(store, SESSION_CASE_ID))?.case_type).toBe(
			"patient",
		);
	});

	it("rejects a retype of a merged duplicate-repeat authored identity", async () => {
		const store = makeStore();
		await seedSchemas(store);

		// Two iterations carrying the SAME key: both creates resolve to
		// one concrete id. The correlated retype then makes iteration
		// two's create meet a transitioned identity — exactly the
		// Core-vs-HQ divergence the resolved fold refuses. The authored
		// key's type-stability arm fires first, on the retype itself.
		const err = await rejection(
			submit(store, {
				appId: APP_ID,
				ordinary: { kind: "none" },
				operations: {
					formUuid: FORM_UUID,
					operations: [
						envOp(
							operation({
								uuid: OP_A,
								id: "op_make",
								action: "create",
								caseType: "patient",
								target: { kind: "new", idFrom: KEY_FIELD },
								name: term(literal("Made")),
								forEach: { repeat: REPEAT_UUID },
							}),
						),
						envOp(
							operation({
								uuid: OP_B,
								id: "op_retype",
								action: "update",
								caseType: "patient",
								target: { kind: "op", opUuid: OP_A },
								retype: "patient_v2",
								forEach: { repeat: REPEAT_UUID },
							}),
						),
					],
					scopes: [
						{ iterations: [{ formFields: new Map() }] },
						{
							repeat: REPEAT_UUID,
							iterations: [
								{ formFields: new Map([[KEY_FIELD, "same-key"]]) },
								{ formFields: new Map([[KEY_FIELD, "same-key"]]) },
							],
						},
					],
					caseTypeSchemas: SCHEMAS,
				},
			}),
		);
		expect(err.rejection).toMatchObject({
			kind: "sequence",
			reason: "authored-key-identity-is-type-stable",
		});
		expect(
			await store.query({ appId: APP_ID, caseType: "patient" }),
		).toHaveLength(0);
	});

	it("expands distinct iterations with their own bindings, iteration-major", async () => {
		const store = makeStore();
		await seedSchemas(store);

		// Two iterations with DISTINCT keys, values, and condition
		// outcomes: iteration one's consumer is skipped, iteration two's
		// executes. Pins per-iteration binding wiring, iteration-correlated
		// op-id resolution, and the iteration-major effect-record order
		// (A@0, B@0, A@1, B@1).
		const result = await submit(store, {
			appId: APP_ID,
			ordinary: { kind: "none" },
			operations: {
				formUuid: FORM_UUID,
				operations: [
					envOp(
						operation({
							uuid: OP_A,
							id: "op_make",
							action: "create",
							caseType: "visit",
							target: { kind: "new", idFrom: KEY_FIELD },
							name: term(formField(KEY_FIELD)),
							forEach: { repeat: REPEAT_UUID },
						}),
					),
					envOp(
						operation({
							uuid: OP_B,
							id: "op_note",
							action: "update",
							caseType: "visit",
							target: { kind: "op", opUuid: OP_A },
							condition: eq(formField(FLAG_FIELD), literal("yes")),
							writes: [
								{ property: "outcome", value: term(formField(MEDS_FIELD)) },
							],
							forEach: { repeat: REPEAT_UUID },
						}),
					),
				],
				scopes: [
					{ iterations: [{ formFields: new Map() }] },
					{
						repeat: REPEAT_UUID,
						iterations: [
							{
								formFields: new Map([
									[KEY_FIELD, "key-1"],
									[FLAG_FIELD, "no"],
									[MEDS_FIELD, "n1"],
								]),
							},
							{
								formFields: new Map([
									[KEY_FIELD, "key-2"],
									[FLAG_FIELD, "yes"],
									[MEDS_FIELD, "n2"],
								]),
							},
						],
					},
				],
				caseTypeSchemas: SCHEMAS,
			},
		});

		// Iteration-major physical order with per-iteration outcomes.
		expect(
			result.operations.map((entry) => ({
				uuid: entry.operationUuid,
				iteration: entry.iteration,
				executed: entry.executed,
			})),
		).toEqual([
			{ uuid: OP_A, iteration: 0, executed: true },
			{ uuid: OP_B, iteration: 0, executed: false },
			{ uuid: OP_A, iteration: 1, executed: true },
			{ uuid: OP_B, iteration: 1, executed: true },
		]);

		// Two rows, each named by ITS iteration's key; the conditional
		// write landed only on iteration two's correlated create.
		const visits = await store.query({ appId: APP_ID, caseType: "visit" });
		expect(visits).toHaveLength(2);
		const byName = new Map(visits.map((row) => [row.case_name, row]));
		expect(byName.get("key-1")?.properties).not.toHaveProperty("outcome");
		expect(byName.get("key-2")?.properties).toMatchObject({ outcome: "n2" });
		expect(byName.get("key-1")?.case_id).not.toBe(byName.get("key-2")?.case_id);
		// The correlated update addressed each iteration's own create.
		expect(result.operations[3]?.caseId).toBe(byName.get("key-2")?.case_id);
	});

	it("merges duplicate repeat keys without a type transition", async () => {
		const store = makeStore();
		await seedSchemas(store);

		const result = await submit(store, {
			appId: APP_ID,
			ordinary: { kind: "none" },
			operations: {
				formUuid: FORM_UUID,
				operations: [
					envOp(
						operation({
							uuid: OP_A,
							id: "op_make",
							action: "create",
							caseType: "patient",
							target: { kind: "new", idFrom: KEY_FIELD },
							name: term(literal("Made")),
							forEach: { repeat: REPEAT_UUID },
						}),
					),
				],
				scopes: [
					{ iterations: [{ formFields: new Map() }] },
					{
						repeat: REPEAT_UUID,
						iterations: [
							{ formFields: new Map([[KEY_FIELD, "same-key"]]) },
							{ formFields: new Map([[KEY_FIELD, "same-key"]]) },
						],
					},
				],
				caseTypeSchemas: SCHEMAS,
			},
		});

		// Duplicate keys for one create definition intentionally merge —
		// one row, two executed instances addressing it.
		expect(
			await store.query({ appId: APP_ID, caseType: "patient" }),
		).toHaveLength(1);
		expect(result.operations).toHaveLength(2);
		expect(new Set(result.operations.map((entry) => entry.caseId)).size).toBe(
			1,
		);
	});

	it("rejects an advanced retype under a type-sensitive ordinary action", async () => {
		const store = makeStore();
		await seedSchemas(store);
		await seedSessionPatient(store);

		const err = await rejection(
			submit(store, {
				appId: APP_ID,
				ordinary: followupOrdinary({ notes: "patched" }),
				operations: rootProgram([
					envOp(
						operation({
							uuid: OP_A,
							action: "update",
							caseType: "patient",
							target: { kind: "session" },
							retype: "patient_v2",
						}),
					),
				]),
			}),
		);
		// The ordinary followup still writes patient-shaped data to the
		// session case; the fold's final implicit step refuses the
		// transitioned type, mirroring the static analysis's `ordinary`
		// slot.
		expect(err.rejection).toMatchObject({
			kind: "sequence",
			reason: "rolling-case-type-mismatch",
		});
		const row = await patientRow(store, SESSION_CASE_ID);
		expect(row?.case_type).toBe("patient");
		expect(row?.properties).toMatchObject({ notes: "original" });
	});
});

// ---------------------------------------------------------------
// Text facets
// ---------------------------------------------------------------

describe("text facets", () => {
	it("rejects a whitespace-only create name before any DML", async () => {
		const store = makeStore();
		await seedSchemas(store);

		const err = await rejection(
			submit(store, {
				appId: APP_ID,
				ordinary: { kind: "none" },
				operations: rootProgram(
					[
						envOp(
							operation({
								uuid: OP_A,
								action: "create",
								caseType: "visit",
								target: { kind: "new" },
								name: term(literal("  \t\n  ")),
							}),
						),
					],
					{ sessionCaseId: null },
				),
			}),
		);
		expect(err.rejection).toMatchObject({
			kind: "text-value",
			facet: "name",
			reason: "blank",
		});
		expect(
			await store.query({ appId: APP_ID, caseType: "visit" }),
		).toHaveLength(0);
	});

	it("rejects an over-255-unit rename", async () => {
		const store = makeStore();
		await seedSchemas(store);
		await seedSessionPatient(store);

		const err = await rejection(
			submit(store, {
				appId: APP_ID,
				ordinary: { kind: "none" },
				operations: rootProgram([
					envOp(
						operation({
							uuid: OP_A,
							action: "update",
							caseType: "patient",
							target: { kind: "session" },
							rename: term(literal("x".repeat(256))),
						}),
					),
				]),
			}),
		);
		expect(err.rejection).toMatchObject({
			kind: "text-value",
			facet: "rename",
			reason: "too-long",
		});
		expect((await patientRow(store, SESSION_CASE_ID))?.case_name).toBe("Alice");
	});

	it("normalizes boundary whitespace exactly once, preserving the interior", async () => {
		const store = makeStore();
		await seedSchemas(store);
		await seedSessionPatient(store);

		await submit(store, {
			appId: APP_ID,
			ordinary: { kind: "none" },
			operations: rootProgram([
				envOp(
					operation({
						uuid: OP_A,
						action: "update",
						caseType: "patient",
						target: { kind: "session" },
						rename: term(literal("  Alice   B.  ")),
					}),
				),
			]),
		});
		expect((await patientRow(store, SESSION_CASE_ID))?.case_name).toBe(
			"Alice   B.",
		);
	});

	it("rejects an over-255-unit external_id before any effect", async () => {
		const store = makeStore();
		await seedSchemas(store);
		await seedSessionPatient(store);

		const err = await rejection(
			submit(store, {
				appId: APP_ID,
				ordinary: { kind: "none" },
				operations: rootProgram([
					envOp(
						operation({
							uuid: OP_A,
							action: "update",
							caseType: "patient",
							target: { kind: "session" },
							writes: [
								{
									property: "external_id",
									value: term(literal("x".repeat(256))),
								},
							],
						}),
					),
				]),
			}),
		);
		expect(err.rejection).toMatchObject({
			kind: "text-value",
			facet: "external_id",
			reason: "too-long",
		});
		expect((await patientRow(store, SESSION_CASE_ID))?.external_id).toBeNull();
	});
});

// ---------------------------------------------------------------
// Owner semantics
// ---------------------------------------------------------------

describe("owner stamping", () => {
	it("evaluates fixed and owner-relative place destinations in Preview", async () => {
		const store = makeStore();
		await seedSchemas(store);
		await seedSessionPatient(store);
		const regionUuid = testUuid("11111111-1111-4111-8111-111111111119");
		const facilityLevelUuid = testUuid("22222222-2222-4222-8222-222222222229");
		const regionLocationUuid = testUuid("33333333-3333-4333-8333-333333333339");
		const facilityLocationUuid = testUuid(
			"44444444-4444-4444-8444-444444444449",
		);
		const levels: Record<string, OrganizationLevel> = {
			[regionUuid]: {
				uuid: regionUuid,
				code: "region",
				name: "Region",
				caseFlow: { workers: "none", ownsCases: true },
				addressBook: { reach: "own-branch" },
			},
			[facilityLevelUuid]: {
				uuid: facilityLevelUuid,
				code: "facility",
				name: "Facility",
				parentLevelUuid: regionUuid,
				caseFlow: { workers: "none", ownsCases: false },
				addressBook: { reach: "own-branch" },
			},
		};
		await sql`
			INSERT INTO app_locations
				(id, app_id, level_uuid, parent_id, site_code, name, order_key)
			VALUES
				(${regionLocationUuid}, ${APP_ID}, ${regionUuid}, NULL,
					'region', 'Region', 'a'),
				(${facilityLocationUuid}, ${APP_ID}, ${facilityLevelUuid},
					${regionLocationUuid}, 'facility', 'Facility', 'a')
		`.execute(dbHandle.db);

		await submit(store, {
			appId: APP_ID,
			ordinary: { kind: "none" },
			operations: rootProgram(
				[
					envOp(
						operation({
							owner: term(fixedLocation(facilityLocationUuid)),
						}),
					),
				],
				{ organizationLevels: levels },
			),
		});
		expect((await patientRow(store, SESSION_CASE_ID))?.owner_id).toBe(
			facilityLocationUuid,
		);

		await sql`
			UPDATE cases
			SET owner_id = ${regionLocationUuid}
			WHERE app_id = ${APP_ID} AND case_id = ${SESSION_CASE_ID}
		`.execute(dbHandle.db);
		await submit(store, {
			appId: APP_ID,
			ordinary: { kind: "none" },
			operations: rootProgram(
				[
					envOp(
						operation({
							owner: term(ownerLocationAtLevel(facilityLevelUuid, "patient")),
						}),
					),
				],
				{ organizationLevels: levels },
			),
		});
		expect((await patientRow(store, SESSION_CASE_ID))?.owner_id).toBe(
			facilityLocationUuid,
		);
	});

	it("defaults a create's owner to the acting user and honors unowned", async () => {
		const store = makeStore();
		await seedSchemas(store);

		await submit(store, {
			appId: APP_ID,
			ordinary: { kind: "none" },
			operations: rootProgram(
				[
					envOp(
						operation({
							uuid: OP_A,
							id: "op_default",
							action: "create",
							caseType: "visit",
							target: { kind: "new" },
							name: term(literal("Owned")),
						}),
					),
					envOp(
						operation({
							uuid: OP_B,
							id: "op_unowned",
							action: "create",
							caseType: "patient",
							target: { kind: "new" },
							name: term(literal("Unowned")),
							owner: unowned(),
						}),
					),
				],
				{ sessionCaseId: null },
			),
		});

		const visits = await store.query({ appId: APP_ID, caseType: "visit" });
		expect(visits[0]?.owner_id).toBe(ACTOR);
		const patients = await store.query({ appId: APP_ID, caseType: "patient" });
		expect(patients[0]?.owner_id).toBe("-");
	});

	it("writes an explicit update owner and resolves acting-user as the worker, not the authorizing member", async () => {
		const workerId = "persona-asha";
		const store = makeStore(PROJECT_A, ACTOR, workerId);
		await seedSchemas(store);
		await seedSessionPatient(store);

		await submit(store, {
			appId: APP_ID,
			ordinary: { kind: "none" },
			operations: rootProgram([
				envOp(
					operation({
						uuid: OP_A,
						action: "update",
						caseType: "patient",
						target: { kind: "session" },
						owner: term(literal("supervisor-9")),
						writes: [{ property: "notes", value: actingUser() }],
					}),
				),
			]),
		});

		const row = await patientRow(store, SESSION_CASE_ID);
		expect(row?.owner_id).toBe("supervisor-9");
		expect(row?.properties).toMatchObject({ notes: workerId });
	});
});

// ---------------------------------------------------------------
// wirePortable retype
// ---------------------------------------------------------------

describe("retype", () => {
	it("executes the wirePortable subset: type flips, properties retained verbatim", async () => {
		const store = makeStore();
		await seedSchemas(store);
		await seedSessionPatient(store, { notes: "kept", age: 30 });

		await submit(store, {
			appId: APP_ID,
			ordinary: { kind: "none" },
			operations: rootProgram([
				envOp(
					operation({
						uuid: OP_A,
						action: "update",
						caseType: "patient",
						target: { kind: "session" },
						retype: "patient_v2",
					}),
				),
			]),
		});

		const rows = await store.query({ appId: APP_ID, caseType: "patient_v2" });
		expect(rows).toHaveLength(1);
		expect(rows[0]?.case_id).toBe(SESSION_CASE_ID);
		expect(rows[0]?.properties).toMatchObject({ notes: "kept", age: 30 });
	});

	it("applies destination-typed writes and the type change as one unit", async () => {
		const store = makeStore();
		await seedSchemas(store);
		await seedSessionPatient(store, { notes: "kept" });

		// `severity` is declared ONLY on the destination type — the
		// validator resolves a retyping operation's writes against the
		// destination, and the wire emits the write and the `case_type`
		// change in one <update> block the server applies together.
		await submit(store, {
			appId: APP_ID,
			ordinary: { kind: "none" },
			operations: rootProgram([
				envOp(
					operation({
						uuid: OP_A,
						action: "update",
						caseType: "patient",
						target: { kind: "session" },
						retype: "patient_v2",
						rename: term(literal("Alice v2")),
						writes: [
							{ property: "severity", value: term(literal("high")) },
							{
								property: "external_id",
								value: term(literal("  PATIENT-2  ")),
							},
						],
					}),
				),
			]),
		});

		const rows = await store.query({ appId: APP_ID, caseType: "patient_v2" });
		expect(rows).toHaveLength(1);
		expect(rows[0]?.case_id).toBe(SESSION_CASE_ID);
		expect(rows[0]?.case_name).toBe("Alice v2");
		expect(rows[0]?.external_id).toBe("PATIENT-2");
		expect(rows[0]?.properties).toMatchObject({
			notes: "kept",
			severity: "high",
		});
		expect(rows[0]?.properties).not.toHaveProperty("external_id");
	});

	it("rejects a retype whose retained document the destination schema cannot hold", async () => {
		const store = makeStore();
		await seedSchemas(store);
		// `age` survives the retype but `narrow` declares only `notes` —
		// executing it would need parking, which the wirePortable subset
		// forbids.
		await seedSessionPatient(store, { notes: "kept", age: 30 });

		const err = await rejection(
			submit(store, {
				appId: APP_ID,
				ordinary: { kind: "none" },
				operations: rootProgram([
					envOp(
						operation({
							uuid: OP_A,
							action: "update",
							caseType: "patient",
							target: { kind: "session" },
							retype: "narrow",
						}),
					),
				]),
			}),
		);
		expect(err.rejection).toMatchObject({
			kind: "retype-not-portable",
			toCaseType: "narrow",
		});
		expect((await patientRow(store, SESSION_CASE_ID))?.case_type).toBe(
			"patient",
		);
	});
});

// ---------------------------------------------------------------
// Links
// ---------------------------------------------------------------

describe("links", () => {
	it("upserts an identifier-keyed edge to an earlier create and removes it on null", async () => {
		const store = makeStore();
		await seedSchemas(store);
		await seedSessionPatient(store);

		const first = await submit(store, {
			appId: APP_ID,
			ordinary: { kind: "none" },
			operations: rootProgram([
				envOp(
					operation({
						uuid: OP_A,
						id: "op_make",
						action: "create",
						caseType: "visit",
						target: { kind: "new" },
						name: term(literal("Visit A")),
					}),
				),
				envOp(
					operation({
						uuid: OP_B,
						id: "op_link",
						action: "update",
						caseType: "patient",
						target: { kind: "session" },
						links: [
							{
								identifier: "recent_visit",
								targetType: "visit",
								target: { kind: "op", opUuid: OP_A },
								relationship: "extension",
							},
						],
					}),
				),
			]),
		});
		const createdId = first.operations[0]?.caseId;
		const edges = await dbHandle.pool.query(
			`SELECT ancestor_id, relationship FROM case_indices WHERE case_id = $1 AND identifier = 'recent_visit'`,
			[SESSION_CASE_ID],
		);
		expect(edges.rows).toEqual([
			{ ancestor_id: createdId, relationship: "extension" },
		]);

		// Null target removes the identifier's edge — the wire's
		// empty-index-value unlink.
		await submit(store, {
			appId: APP_ID,
			ordinary: { kind: "none" },
			operations: rootProgram([
				envOp(
					operation({
						uuid: OP_B,
						id: "op_unlink",
						action: "update",
						caseType: "patient",
						target: { kind: "session" },
						links: [
							{
								identifier: "recent_visit",
								targetType: "visit",
								target: null,
								relationship: "extension",
							},
						],
					}),
				),
			]),
		});
		const after = await dbHandle.pool.query(
			`SELECT 1 FROM case_indices WHERE case_id = $1 AND identifier = 'recent_visit'`,
			[SESSION_CASE_ID],
		);
		expect(after.rows).toHaveLength(0);
	});

	it("a link-only operation advances the case's modified time", async () => {
		const store = makeStore();
		await seedSchemas(store);
		await seedSessionPatient(store);
		const before = (await patientRow(store, SESSION_CASE_ID))?.modified_on;
		expect(before).not.toBeNull();

		// Every emitted case block carries @date_modified — a pure index
		// write still advances the case's modified time on device/HQ, and
		// `last_modified` is a queryable standard property.
		const visit = await store.insert({
			appId: APP_ID,
			row: {
				case_type: "visit",
				case_name: "V",
				status: "open",
				properties: "{}",
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 10));
		await submit(store, {
			appId: APP_ID,
			ordinary: { kind: "none" },
			operations: rootProgram([
				envOp(
					operation({
						uuid: OP_A,
						action: "update",
						caseType: "patient",
						target: { kind: "session" },
						links: [
							{
								identifier: "recent_visit",
								targetType: "visit",
								target: {
									kind: "expression",
									expr: term(literal(visit.caseId)),
								},
								relationship: "extension",
							},
						],
					}),
					{
						expressionSnapshotTypes: { links: new Map([[0, "visit"]]) },
					},
				),
			]),
		});

		const after = (await patientRow(store, SESSION_CASE_ID))?.modified_on;
		expect(after?.getTime()).toBeGreaterThan(before?.getTime() ?? 0);
	});

	it("a parent-identifier link maintains the denormalized first parent", async () => {
		const store = makeStore();
		await seedSchemas(store);
		await seedSessionPatient(store);
		const household = await store.insert({
			appId: APP_ID,
			row: {
				case_type: "patient_v2",
				case_name: "Household",
				status: "open",
				properties: "{}",
			},
		});

		await submit(store, {
			appId: APP_ID,
			ordinary: { kind: "none" },
			operations: rootProgram([
				envOp(
					operation({
						uuid: OP_A,
						action: "update",
						caseType: "patient",
						target: { kind: "session" },
						links: [
							{
								identifier: "parent",
								targetType: "patient_v2",
								target: {
									kind: "expression",
									expr: term(literal(household.caseId)),
								},
								relationship: "child",
							},
						],
					}),
					{
						expressionSnapshotTypes: {
							links: new Map([[0, "patient_v2"]]),
						},
					},
				),
			]),
		});
		expect((await patientRow(store, SESSION_CASE_ID))?.parent_case_id).toBe(
			household.caseId,
		);

		await submit(store, {
			appId: APP_ID,
			ordinary: { kind: "none" },
			operations: rootProgram([
				envOp(
					operation({
						uuid: OP_A,
						action: "update",
						caseType: "patient",
						target: { kind: "session" },
						links: [
							{
								identifier: "parent",
								targetType: "patient_v2",
								target: null,
								relationship: "child",
							},
						],
					}),
				),
			]),
		});
		expect(
			(await patientRow(store, SESSION_CASE_ID))?.parent_case_id,
		).toBeNull();
	});
});

// ---------------------------------------------------------------
// Multi-select serialization
// ---------------------------------------------------------------

describe("multi-select writes", () => {
	it("serializes a multi-select form answer to a JSONB array explicitly", async () => {
		const store = makeStore();
		await seedSchemas(store);
		await seedSessionPatient(store);

		await submit(store, {
			appId: APP_ID,
			ordinary: { kind: "none" },
			operations: rootProgram(
				[
					envOp(
						operation({
							uuid: OP_A,
							action: "update",
							caseType: "patient",
							target: { kind: "session" },
							writes: [
								{ property: "meds", value: term(formField(MEDS_FIELD)) },
							],
						}),
					),
				],
				{ formFields: [[MEDS_FIELD, ["rifampin", "isoniazid"]]] },
			),
		});

		const row = await patientRow(store, SESSION_CASE_ID);
		expect(row?.properties.meds).toEqual(["rifampin", "isoniazid"]);
	});
});

// ---------------------------------------------------------------
// Operations + ordinary action in one envelope
// ---------------------------------------------------------------

describe("combined submission", () => {
	it("lands operations before the ordinary followup, atomically", async () => {
		const store = makeStore();
		await seedSchemas(store);
		await seedSessionPatient(store);

		const result = await submit(store, {
			appId: APP_ID,
			ordinary: followupOrdinary({ notes: "from-form" }),
			operations: rootProgram([
				envOp(
					operation({
						uuid: OP_A,
						action: "create",
						caseType: "visit",
						target: { kind: "new" },
						name: term(literal("Companion visit")),
					}),
				),
			]),
		});

		expect(result.primaryCaseIds).toEqual([SESSION_CASE_ID]);
		expect(result.operations).toHaveLength(1);
		expect(result.operations[0]?.executed).toBe(true);
		const visits = await store.query({ appId: APP_ID, caseType: "visit" });
		expect(visits).toHaveLength(1);
		const row = await patientRow(store, SESSION_CASE_ID);
		expect(row?.properties).toMatchObject({ notes: "from-form" });
	});

	it("a missing session case fails the whole envelope with the ordinary not-found", async () => {
		const store = makeStore();
		await seedSchemas(store);

		const err = await rejection(
			submit(store, {
				appId: APP_ID,
				ordinary: { kind: "none" },
				operations: rootProgram([
					envOp(
						operation({
							uuid: OP_A,
							action: "update",
							caseType: "patient",
							target: { kind: "session" },
							writes: [{ property: "notes", value: term(literal("x")) }],
						}),
					),
				]),
			}),
		);
		expect(err.rejection).toMatchObject({
			kind: "selection",
			reason: "not-found-or-out-of-scope",
			caseId: SESSION_CASE_ID,
		});
	});
});

describe("transaction-captured case database patch", () => {
	it("includes the worker usercase and replays its accepted state after a later write", async () => {
		const store = makeStore();
		const usercaseType: CaseType = {
			name: USERCASE_CASE_TYPE,
			properties: [
				{ name: "role", label: proseText("Role"), data_type: "text" },
			],
		};
		const usercaseBlueprint = buildSimpleBlueprint([usercaseType], APP_ID);
		const roleUuid = testUuid("usercase-role-property");
		usercaseBlueprint.userProperties = {
			[roleUuid]: {
				uuid: roleUuid,
				slug: "role",
				label: "Role",
			},
		};
		usercaseBlueprint.userPropertyOrder = [roleUuid];
		await store.applySchemaChange({
			appId: APP_ID,
			caseType: USERCASE_CASE_TYPE,
			caseTypeSchemas: buildCaseTypeMap(usercaseBlueprint),
		});
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: ACTOR,
				case_type: USERCASE_CASE_TYPE,
				case_name: "Worker one",
				properties: JSON.stringify({ role: "nurse" }),
			},
		});
		const receipt: SubmissionReceiptClaim = {
			entryKey: "usercase-patch-entry",
			formUuid: FORM_UUID,
			expectedAppMutationSeq: 0,
			blueprintDigest: "0".repeat(64),
			requestDigest: "usercase-patch-request",
		};
		const args = {
			appId: APP_ID,
			ordinary: { kind: "none" } as const,
			usercase: { properties: { role: "supervisor" } },
			submissionReceipt: receipt,
		};

		const first = await store.applySubmission(args);
		expect(first.caseDatabasePatch?.rows).toHaveLength(1);
		expect(first.caseDatabasePatch?.rows[0]).toMatchObject({
			case_id: ACTOR,
			case_type: USERCASE_CASE_TYPE,
			properties: { role: "supervisor" },
		});
		expect(first.caseDatabasePatch?.indices).toEqual([]);

		await store.update({
			appId: APP_ID,
			caseId: ACTOR,
			patch: { properties: JSON.stringify({ role: "director" }) },
		});
		const replay = await store.applySubmission(args);
		expect(replay).toEqual(first);
		expect(replay.caseDatabasePatch?.rows[0]?.properties).toEqual({
			role: "supervisor",
		});
		const current = await store.query({
			appId: APP_ID,
			caseType: USERCASE_CASE_TYPE,
		});
		expect(current[0]?.properties).toEqual({ role: "director" });
	});
});

// ---------------------------------------------------------------
// Durable submission receipts
// ---------------------------------------------------------------

describe("durable text-only submission receipt", () => {
	it("claims the first registration, replays it without reallocating cases, and rejects a changed digest", async () => {
		const store = makeStore();
		await seedSchemas(store);
		const receipt: SubmissionReceiptClaim = {
			entryKey: "text-registration-entry",
			formUuid: FORM_UUID,
			expectedAppMutationSeq: 0,
			blueprintDigest: "0".repeat(64),
			requestDigest: "text-registration-request",
		};
		const first = await submit(store, {
			appId: APP_ID,
			submissionReceipt: receipt,
			ordinary: {
				kind: "registration",
				primary: {
					caseType: "patient",
					caseName: "First registration",
					properties: { notes: "accepted" },
				},
				children: [],
			},
		});

		const replay = await submit(store, {
			appId: APP_ID,
			submissionReceipt: receipt,
			ordinary: {
				kind: "registration",
				primary: {
					caseType: "patient",
					caseName: "must not run",
					properties: { notes: "must not run" },
				},
				children: [],
			},
		});
		expect(replay).toEqual(first);
		expect(first.primaryCaseIds).toEqual([expect.any(String)]);
		const primaryCaseId = first.primaryCaseIds[0];
		expect(primaryCaseId).toBeDefined();
		const patients = await store.query({
			appId: APP_ID,
			caseType: "patient",
		});
		expect(patients).toHaveLength(1);
		expect(patients[0]).toMatchObject({
			case_id: primaryCaseId,
			case_name: "First registration",
			properties: { notes: "accepted" },
		});

		const stored = await sql<{
			app_mutation_seq: string;
			result: unknown;
		}>`
			SELECT app_mutation_seq::text, result
			FROM form_submission_intents
			WHERE app_id = ${APP_ID}
				AND project_id = ${PROJECT_A}
				AND created_by = ${ACTOR}
				AND entry_key = ${receipt.entryKey}
		`.execute(dbHandle.db);
		expect(stored.rows).toEqual([
			{
				app_mutation_seq: "0",
				result: JSON.parse(JSON.stringify(first)),
			},
		]);

		await expect(
			submit(store, {
				appId: APP_ID,
				submissionReceipt: {
					...receipt,
					requestDigest: "changed-text-registration-request",
				},
				ordinary: {
					kind: "registration",
					primary: {
						caseType: "patient",
						caseName: "must not run",
						properties: {},
					},
					children: [],
				},
			}),
		).rejects.toBeInstanceOf(CaptureSubmissionRejectedError);
		expect(
			await store.query({ appId: APP_ID, caseType: "patient" }),
		).toHaveLength(1);
	});

	it("serializes concurrent first requests and allocates one generated advanced create", async () => {
		const store = makeStore();
		await seedSchemas(store);
		const receipt: SubmissionReceiptClaim = {
			entryKey: "text-advanced-create-entry",
			formUuid: FORM_UUID,
			expectedAppMutationSeq: 0,
			blueprintDigest: "0".repeat(64),
			requestDigest: "text-advanced-create-request",
		};
		const args: TestSubmissionArgs = {
			appId: APP_ID,
			submissionReceipt: receipt,
			ordinary: { kind: "none" },
			operations: rootProgram(
				[
					envOp(
						operation({
							uuid: OP_A,
							action: "create",
							caseType: "visit",
							target: { kind: "new" },
							name: term(literal("Generated visit")),
						}),
					),
				],
				{ sessionCaseId: null },
			),
		};

		const [first, concurrentRetry] = await Promise.all([
			submit(store, args),
			submit(store, args),
		]);
		expect(concurrentRetry).toEqual(first);
		expect(first.operations).toHaveLength(1);
		const createdCaseId = first.operations[0]?.caseId;
		expect(createdCaseId).toEqual(expect.any(String));
		const visits = await store.query({ appId: APP_ID, caseType: "visit" });
		expect(visits).toHaveLength(1);
		expect(visits[0]).toMatchObject({
			case_id: createdCaseId,
			case_name: "Generated visit",
		});
	});

	it("rolls back an uncompleted receipt and every earlier case effect", async () => {
		const store = makeStore();
		await seedSchemas(store);
		const receipt: SubmissionReceiptClaim = {
			entryKey: "text-rollback-entry",
			formUuid: FORM_UUID,
			expectedAppMutationSeq: 0,
			blueprintDigest: "0".repeat(64),
			requestDigest: "text-rollback-request",
		};
		await expect(
			submit(store, {
				appId: APP_ID,
				submissionReceipt: receipt,
				ordinary: {
					kind: "registration",
					primary: {
						caseType: "patient",
						caseName: "must roll back",
						properties: { notes: "must roll back" },
					},
					children: [
						{
							caseType: "visit",
							caseName: "invalid child",
							properties: { unknown: "reject" },
						},
					],
				},
			}),
		).rejects.toBeInstanceOf(CasePropertiesValidationError);

		expect(
			await store.query({ appId: APP_ID, caseType: "patient" }),
		).toHaveLength(0);
		expect(
			await store.query({ appId: APP_ID, caseType: "visit" }),
		).toHaveLength(0);
		const rows = await sql<{ count: string }>`
			SELECT count(*)::text AS count
			FROM form_submission_intents
			WHERE app_id = ${APP_ID} AND entry_key = ${receipt.entryKey}
		`.execute(dbHandle.db);
		expect(rows.rows[0]?.count).toBe("0");
	});
});

// ---------------------------------------------------------------
// Atomic form-capture intent
// ---------------------------------------------------------------

async function seedPreparedCapture() {
	const attachmentId = "55555555-5555-4555-8555-555555555555";
	const entryKey = "77777777-7777-4777-8777-777777777777";
	const fieldUuid = testUuid("88888888-8888-4888-8888-888888888888");
	await sql`
		INSERT INTO form_attachments (
			attachment_id,
			attachment_name,
			app_id,
			project_id,
			created_by,
			entry_key,
			field_uuid,
			instance_path,
			original_filename,
			extension,
			content_type,
			size_bytes,
			gcs_object_key,
			object_generation,
			object_checksum,
			prepared_generation,
			status,
			expires_at
		) VALUES (
			${attachmentId},
			${`${attachmentId}.png`},
			${APP_ID},
			${PROJECT_A},
			${ACTOR},
			${entryKey},
			${fieldUuid},
			'/data/photo',
			'photo.png',
			'.png',
			'image/png',
			3,
			${`captures-staged/${PROJECT_A}/${attachmentId}.png`},
			'generation-1',
			'checksum-1',
			'prepared-generation-1',
			'prepared',
			now() + interval '1 day'
		)
	`.execute(dbHandle.db);
	return {
		entryKey,
		attachmentId,
		fieldUuid,
		intent: {
			entryKey,
			formUuid: FORM_UUID,
			expectedAppMutationSeq: 0,
			requestDigest: "capture-request-a",
			attachments: [
				{
					attachmentName: `${attachmentId}.png`,
					fieldUuid,
					instancePath: "/data/photo",
				},
			],
			allowedAttachments: [
				{
					fieldUuid,
					instancePathTemplate: "/data/photo",
					captureKind: "image" as const,
					acceptedFormats: [
						{ extension: ".jpg", contentType: "image/jpeg" },
						{ extension: ".jpeg", contentType: "image/jpeg" },
						{ extension: ".png", contentType: "image/png" },
					],
				},
			],
		},
	};
}

describe("atomic form-capture intent", () => {
	it("replays a nonempty accepted submission after current capture/form removal before case effects", async () => {
		const store = makeStore();
		const capture = await seedPreparedCapture();
		await seedSchemas(store);
		await seedSessionPatient(store);
		const args = {
			appId: APP_ID,
			ordinary: followupOrdinary({ notes: "accepted" }),
			submissionReceipt: {
				entryKey: capture.intent.entryKey,
				formUuid: capture.intent.formUuid,
				expectedAppMutationSeq: capture.intent.expectedAppMutationSeq,
				blueprintDigest: "0".repeat(64),
				requestDigest: capture.intent.requestDigest,
			},
			captureIntent: capture.intent,
		};

		const first = await submit(store, args);
		const replay = await submit(store, {
			appId: APP_ID,
			ordinary: followupOrdinary({ notes: "must not replay" }),
			// Simulates a retry after the form or its final capture question was
			// deleted: no current capture intent survives, only durable identity.
			submissionReceipt: args.submissionReceipt,
		});
		expect(replay).toEqual(first);
		expect(
			(await patientRow(store, SESSION_CASE_ID))?.properties,
		).toMatchObject({ notes: "accepted" });

		const attachment = await sql<{
			status: string;
			object_generation: string | null;
			prepared_generation: string | null;
		}>`
			SELECT status, object_generation, prepared_generation
			FROM form_attachments
			WHERE attachment_id = ${capture.attachmentId}
		`.execute(dbHandle.db);
		expect(attachment.rows[0]).toMatchObject({
			status: "submitted",
			object_generation: "prepared-generation-1",
			prepared_generation: null,
		});
		const intents = await sql<{ count: string; result: unknown }>`
			SELECT count(*) OVER ()::text AS count, result
			FROM form_submission_intents
			WHERE app_id = ${APP_ID} AND entry_key = ${capture.entryKey}
		`.execute(dbHandle.db);
		expect(intents.rows).toHaveLength(1);
		expect(intents.rows[0]).toMatchObject({
			count: "1",
			result: JSON.parse(JSON.stringify(first)),
		});

		await expect(
			submit(store, {
				appId: APP_ID,
				ordinary: followupOrdinary({ notes: "must not replay" }),
				submissionReceipt: {
					...args.submissionReceipt,
					requestDigest: "capture-request-b",
				},
			}),
		).rejects.toBeInstanceOf(CaptureSubmissionRejectedError);
		expect(
			(await patientRow(store, SESSION_CASE_ID))?.properties,
		).toMatchObject({ notes: "accepted" });
	});

	it("replays an accepted submission after unrelated app mutations advance the fence", async () => {
		const store = makeStore();
		const capture = await seedPreparedCapture();
		const first = await submit(store, {
			appId: APP_ID,
			ordinary: { kind: "none" },
			captureIntent: capture.intent,
		});
		await sql`
			UPDATE apps
			SET mutation_seq = mutation_seq + 1
			WHERE id = ${APP_ID}
		`.execute(dbHandle.db);

		await expect(
			submit(store, {
				appId: APP_ID,
				ordinary: { kind: "none" },
				captureIntent: {
					...capture.intent,
					expectedAppMutationSeq: 1,
				},
			}),
		).resolves.toEqual(first);
	});

	it("refuses a confirmed image after the committed descriptor changes to audio", async () => {
		const store = makeStore();
		const capture = await seedPreparedCapture();

		await expect(
			submit(store, {
				appId: APP_ID,
				ordinary: { kind: "none" },
				captureIntent: {
					...capture.intent,
					allowedAttachments: [
						{
							fieldUuid: capture.fieldUuid,
							instancePathTemplate: "/data/photo",
							captureKind: "audio",
							acceptedFormats: [
								{ extension: ".mp3", contentType: "audio/mpeg" },
								{ extension: ".wav", contentType: "audio/wav" },
							],
						},
					],
				},
			}),
		).rejects.toBeInstanceOf(CaptureSubmissionRejectedError);

		const row = await sql<{ status: string }>`
			SELECT status
			FROM form_attachments
			WHERE attachment_id = ${capture.attachmentId}
		`.execute(dbHandle.db);
		expect(row.rows[0]?.status).toBe("prepared");
	});

	it("rolls the capture reservation and receipt back when the case envelope fails", async () => {
		const store = makeStore();
		const capture = await seedPreparedCapture();
		await seedSchemas(store);

		const err = await rejection(
			submit(store, {
				appId: APP_ID,
				ordinary: followupOrdinary({ notes: "never lands" }),
				captureIntent: capture.intent,
			}),
		);
		expect(err.rejection).toMatchObject({
			kind: "selection",
			reason: "not-found-or-out-of-scope",
			caseId: SESSION_CASE_ID,
		});

		const attachment = await sql<{ status: string }>`
			SELECT status
			FROM form_attachments
			WHERE attachment_id = ${capture.attachmentId}
		`.execute(dbHandle.db);
		expect(attachment.rows[0]?.status).toBe("prepared");
		const intent = await sql<{ count: string }>`
			SELECT count(*)::text AS count
			FROM form_submission_intents
			WHERE app_id = ${APP_ID} AND entry_key = ${capture.entryKey}
		`.execute(dbHandle.db);
		expect(intent.rows[0]?.count).toBe("0");
	});

	it("rejects two staged rows forged into one concrete answer slot", async () => {
		const store = makeStore();
		const capture = await seedPreparedCapture();
		const secondAttachmentId = "99999999-9999-4999-8999-999999999999";
		await sql`
			INSERT INTO form_attachments (
				attachment_id,
				attachment_name,
				app_id,
				project_id,
				created_by,
				entry_key,
				field_uuid,
				instance_path,
				original_filename,
				extension,
				content_type,
				size_bytes,
				gcs_object_key,
				object_generation,
				object_checksum,
				prepared_generation,
				status,
				expires_at
			) VALUES (
				${secondAttachmentId},
				${`${secondAttachmentId}.png`},
				${APP_ID},
				${PROJECT_A},
				${ACTOR},
				${capture.entryKey},
				${capture.fieldUuid},
				'/data/photo',
				'other.png',
				'.png',
				'image/png',
				3,
				${`captures-staged/${PROJECT_A}/${secondAttachmentId}.png`},
				'generation-2',
				'checksum-2',
				'prepared-generation-2',
				'prepared',
				now() + interval '1 day'
			)
		`.execute(dbHandle.db);

		await expect(
			submit(store, {
				appId: APP_ID,
				ordinary: { kind: "none" },
				captureIntent: {
					...capture.intent,
					requestDigest: "two-files-one-answer",
					attachments: [
						...capture.intent.attachments,
						{
							attachmentName: `${secondAttachmentId}.png`,
							fieldUuid: capture.fieldUuid,
							instancePath: "/data/photo",
						},
					],
				},
			}),
		).rejects.toBeInstanceOf(CaptureSubmissionRejectedError);

		const rows = await sql<{ status: string }>`
			SELECT status
			FROM form_attachments
			WHERE entry_key = ${capture.entryKey}
			ORDER BY attachment_id
		`.execute(dbHandle.db);
		expect(rows.rows.map((row) => row.status)).toEqual([
			"prepared",
			"prepared",
		]);
	});
});

// ---------------------------------------------------------------
// storageValueFromEvaluation — driver-shape → storage-lexical forms
// ---------------------------------------------------------------

describe("storageValueFromEvaluation", () => {
	it("recovers a pg date's lexical day from local calendar parts", () => {
		// node-postgres parses a `date` column at LOCAL midnight; reading
		// UTC parts back would shift the stored day for any process zone
		// east of UTC. The local-part read is the timezone-proof inverse.
		const parsedByPg = new Date(2026, 6, 24);
		expect(storageValueFromEvaluation(parsedByPg, "date")).toBe("2026-07-24");
	});

	it("canonicalizes a timestamptz to the stored ISO instant", () => {
		const instant = new Date("2026-07-24T05:12:11.400Z");
		expect(storageValueFromEvaluation(instant, "datetime")).toBe(
			"2026-07-24T05:12:11.400Z",
		);
	});

	it("tags an offset-less pg time for storage, keeping explicit offsets", () => {
		// The wire's time answer is a wall clock with three fractional
		// digits and no zone (`TimeData::uncast`); the `Z` is the tag the
		// strict `format: "time"` schema requires on top of it.
		expect(storageValueFromEvaluation("05:12:11", "time")).toBe(
			"05:12:11.000Z",
		);
		expect(storageValueFromEvaluation("05:12:11+02:00", "time")).toBe(
			"05:12:11.000+02:00",
		);
	});

	it("stamps a naive datetime answer with the submitting viewer's zone", () => {
		// A string (rather than a pg `Date`) is a form answer's wall clock,
		// and the device stamps the zone it was entered in. Without a zone
		// the caller gets the deterministic UTC reading.
		expect(
			storageValueFromEvaluation(
				"2026-07-24T05:12:11",
				"datetime",
				"America/New_York",
			),
		).toBe("2026-07-24T05:12:11.000-04:00");
		expect(storageValueFromEvaluation("2026-07-24T05:12:11", "datetime")).toBe(
			"2026-07-24T05:12:11.000Z",
		);
	});

	it("keeps numerics typed and coerces pg's numeric-string decimals", () => {
		expect(storageValueFromEvaluation(30, "int")).toBe(30);
		expect(storageValueFromEvaluation("2.5", "decimal")).toBe(2.5);
	});

	it("signals blank (SQL NULL, '', empty selection) as undefined for every type", () => {
		// The wire's calculate writes '' for a blank source; Nova's
		// storage projects that state as key-absent, so the executor
		// omits the key on create and removes it on update.
		expect(storageValueFromEvaluation(null, "text")).toBeUndefined();
		expect(storageValueFromEvaluation("", "text")).toBeUndefined();
		expect(storageValueFromEvaluation(null, "int")).toBeUndefined();
		expect(storageValueFromEvaluation(null, "date")).toBeUndefined();
		expect(storageValueFromEvaluation([], "multi_select")).toBeUndefined();
		expect(storageValueFromEvaluation(null, "single_select")).toBeUndefined();
	});

	it("keeps a multi-select array and space-joins one aimed at text", () => {
		expect(storageValueFromEvaluation(["a", "b"], "multi_select")).toEqual([
			"a",
			"b",
		]);
		// The XForms wire convention for a selection's string projection.
		expect(storageValueFromEvaluation(["a", "b"], "text")).toBe("a b");
	});
});
