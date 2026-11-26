// lib/case-store/postgres/__tests__/submissionEnvelope.postgres.test.ts
//
// Integration suite for `CaseStore.applySubmission`'s advanced
// case-operation program — the atomic submission envelope. Runs
// against per-test Postgres databases (the store's transaction-using
// methods reject the harness's outer BEGIN/ROLLBACK fixture).
//
// Every case change a form makes is an operation of its program, the form's
// own case first. This file owns the program's execution: the own case's
// lifecycle under the form's open and close conditions, writes through an
// index and writes saved only when changed, the worker's record, selected-case
// fan-out, in-transaction expression evaluation against the pre-submission
// snapshot, identity allocation (including the pinned TS↔XPath authored-id
// vector and the ids an entry's session minted), server-side target
// reauthorization, the resolved rolling-type proof, text-facet preparation,
// the wirePortable retype subset, identifier-keyed link CRUD with authored
// relationships, and whole-envelope rollback.

import { Kysely, PostgresDialect, type PostgresPool, sql } from "kysely";
import { Client, Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	type CaseOperation,
	type CaseOperationWrite,
	type CaseType,
	type OrganizationLevel,
	type OwnCaseOperation,
	type TargetedCaseOperation,
	USERCASE_CASE_TYPE,
	type Uuid,
} from "@/lib/domain";
import { entryDatumCaseId } from "@/lib/domain/entryCaseIdentity";
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
} from "@/lib/domain/expression";
import { SEARCH_READING } from "@/lib/domain/expression/temporalType";
import { proseText } from "@/lib/domain/prose";
import { buildSimpleBlueprint } from "../../__tests__/fixtures/simpleBlueprint";
import {
	CaptureSubmissionRejectedError,
	CasePropertiesValidationError,
	SubmissionRejectedError,
} from "../../errors";
import { HeuristicCaseGenerator } from "../../sample/heuristic";
import {
	buildIsolatedDb,
	setupPerTestDatabase,
} from "../../sql/__tests__/perTestDatabase";
import type { Database } from "../../sql/database";
import { buildCaseTypeMap } from "../../store";
import type {
	ApplySubmissionArgs,
	CaseOperationProgram,
	EnvelopeCaseOperation,
	OpeningReadSet,
	OwnCaseProgram,
	SubmissionReceiptClaim,
} from "../../submission";
import { PostgresCaseStore } from "../store";

// ---------------------------------------------------------------
// Per-test database + store construction
// ---------------------------------------------------------------

// App/schema/index preconditions are built once using the production store,
// then cloned per scenario. Submission effects still use real COMMIT/ROLLBACK.
const dbHandle = setupPerTestDatabase({
	schema: "migrated",
	databaseNamePrefix: "envelope_test_",
	prepareTemplate: async (db) => {
		await sql`
		INSERT INTO apps (id, owner, project_id, app_name, app_name_lower)
		VALUES
			(${APP_ID}, ${ACTOR}, ${PROJECT_A}, 'Envelope app', 'envelope app'),
			(${FOREIGN_APP_ID}, 'worker-2', ${PROJECT_B},
			 'Foreign envelope app', 'foreign envelope app')
	`.execute(db);
		await seedSchemas(
			makeStore(PROJECT_A, ACTOR, ACTOR, db as Kysely<Database>),
		);
	},
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
const THIRD_SESSION_CASE_ID = "00000000-0000-7000-8000-00000000cccc";

const PATIENT: CaseType = {
	name: "patient",
	properties: [
		{ name: "notes", label: proseText("Notes"), data_type: "text" },
		{ name: "copy", label: proseText("Copy"), data_type: "text" },
		{ name: "age", label: proseText("Age"), data_type: "int" },
		{ name: "prior_age", label: proseText("Prior age"), data_type: "int" },
		{ name: "meds", label: proseText("Meds"), data_type: "multi_select" },
		{ name: "seen_at", label: proseText("Seen at"), data_type: "datetime" },
		{ name: "seen_on", label: proseText("Seen on"), data_type: "date" },
		{ name: "hq_user_id", label: proseText("Worker ID"), data_type: "text" },
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
	db: Kysely<Database> = dbHandle.db as Kysely<Database>,
) {
	return new PostgresCaseStore({
		projectId,
		actorUserId,
		ownerId,
		db,
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

function operation(partial: Partial<TargetedCaseOperation>): CaseOperation {
	return {
		uuid: OP_A,
		id: "op_a",
		action: "update",
		caseType: "patient",
		target: { kind: "session" },
		...partial,
	};
}

const OWN_UUID = testUuid("0000aaaa-0000-4000-8000-00000000a0a0");

/** The form's own case, first in the program: a registration's create or the
 * update of the case a follow-up or close form loaded. */
function ownOp(partial: Partial<OwnCaseOperation> = {}): EnvelopeCaseOperation {
	return envOp({ uuid: OWN_UUID, id: "patient", action: "own", ...partial });
}

/** Writes of literal values, in the order given. */
function literalWrites(
	values: Readonly<Record<string, string | number>>,
): CaseOperationWrite[] {
	return Object.entries(values).map(([property, value]) => ({
		property,
		value: term(literal(value)),
	}));
}

/** A follow-up, close or registration program whose own case is a patient. */
function ownProgram(
	formType: OwnCaseProgram["formType"],
	operations: EnvelopeCaseOperation[],
	opts?: Parameters<typeof rootProgram>[1] & {
		openCondition?: CaseOperationWrite["value"];
		closeCondition?: CaseOperationWrite["value"];
	},
): CaseOperationProgram {
	return {
		...rootProgram(operations, {
			...opts,
			...(formType === "registration" ? { sessionCaseId: null } : {}),
		}),
		ownCase: {
			caseType: "patient",
			formType,
			...(opts?.openCondition === undefined
				? {}
				: { openCondition: opts.openCondition }),
			...(opts?.closeCondition === undefined
				? {}
				: { closeCondition: opts.closeCondition }),
		},
	};
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
		workerPlaceIds?: readonly string[];
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
		...(opts?.workerPlaceIds === undefined
			? {}
			: { workerPlaceIds: opts.workerPlaceIds }),
	};
}

function followupOrdinary(
	kind: "followup" | "close" = "followup",
): Extract<ApplySubmissionArgs["ordinary"], { kind: "followup" | "close" }> {
	return {
		kind,
		caseIds: [SESSION_CASE_ID],
		selection: { kind: "single", maximum: 1 },
		caseType: "patient",
	};
}

async function rejection(
	promise: Promise<unknown>,
): Promise<SubmissionRejectedError> {
	try {
		await promise;
	} catch (err) {
		if (!(err instanceof SubmissionRejectedError)) throw err;
		return err;
	}
	throw new Error("expected the envelope to reject, but it resolved");
}

async function patientRow(store: PostgresCaseStore, caseId: string) {
	const rows = await store.query({
		reading: SEARCH_READING,
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
		const visits = await store.query({
			reading: SEARCH_READING,
			appId: APP_ID,
			caseType: "visit",
		});
		expect(visits).toHaveLength(1);
		expect(visits[0]?.case_id).toBe(`${PINNED_VECTOR_PREFIX}external-123`);
		expect(visits[0]?.case_name).toBe("Visit A");
		expect(visits[0]?.owner_id).toBe(ACTOR);
		expect(visits[0]?.status).toBe("open");
	});

	it("rejects a blank authored key without committing effects", async () => {
		const store = makeStore();

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
			await store.query({
				reading: SEARCH_READING,
				appId: APP_ID,
				caseType: "visit",
			}),
		).toHaveLength(0);
	});

	it("rejects an over-205-unit authored key without committing effects", async () => {
		const store = makeStore();

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
			await store.query({
				reading: SEARCH_READING,
				appId: APP_ID,
				caseType: "visit",
			}),
		).toHaveLength(0);
	});

	it("merges a duplicate authored id onto the existing row (create-of-existing)", async () => {
		const store = makeStore();
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
		const visits = await store.query({
			reading: SEARCH_READING,
			appId: APP_ID,
			caseType: "visit",
		});
		expect(visits).toHaveLength(1);
		expect(visits[0]?.case_id).toBe(`${PINNED_VECTOR_PREFIX}repeat-key`);
		expect(visits[0]?.case_name).toBe("Second");
		expect(visits[0]?.external_id).toBe("external-Second");
		expect(visits[0]?.properties).toMatchObject({ outcome: "finished" });
		expect(visits[0]?.properties).not.toHaveProperty("external_id");
	});

	it("carries a non-UUID authored id through update, link, and close", async () => {
		const store = makeStore();
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
			reading: SEARCH_READING,
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
	it("an unresolved target rejects the whole three-operation program", async () => {
		const store = makeStore();
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
			await store.query({
				reading: SEARCH_READING,
				appId: APP_ID,
				caseType: "visit",
			}),
		).toHaveLength(0);
		expect(
			(await patientRow(store, SESSION_CASE_ID))?.properties,
		).toMatchObject({ notes: "original" });
	});

	it("rolls the whole program back when a child create after the close form's own case fails", async () => {
		const store = makeStore();
		await seedSessionPatient(store);

		await expect(
			submit(store, {
				appId: APP_ID,
				ordinary: followupOrdinary("close"),
				operations: ownProgram("close", [
					ownOp({ writes: literalWrites({ notes: "final" }) }),
					envOp(
						operation({
							uuid: OP_A,
							action: "create",
							caseType: "visit",
							target: { kind: "new" },
							name: term(literal("Visit A")),
						}),
					),
					envOp(
						operation({
							uuid: OP_B,
							id: "bad_child",
							action: "create",
							caseType: "visit",
							target: { kind: "new" },
							name: term(literal("Bad child")),
							// `outcome` is text; an unknown property fails the
							// schema's additionalProperties check.
							writes: literalWrites({ unknown_property: "boom" }),
						}),
					),
				]),
			}),
		).rejects.toThrow(CasePropertiesValidationError);

		// NOTHING landed: not the creates, not the own case's write, not the
		// lifecycle transition.
		expect(
			await store.query({
				reading: SEARCH_READING,
				appId: APP_ID,
				caseType: "visit",
			}),
		).toHaveLength(0);
		const row = await patientRow(store, SESSION_CASE_ID);
		expect(row?.properties).toMatchObject({ notes: "original" });
		expect(row?.status).toBe("open");
		expect(row?.closed_on).toBeNull();
	});
});

describe("ordered selected-case batches", () => {
	it("applies the own case's shared answers to every selected case, then each later operation", async () => {
		const store = makeStore();
		await seedPatient(store, SESSION_CASE_ID, "Alice", { notes: "alice" });
		await seedPatient(store, SECOND_SESSION_CASE_ID, "Bob", { notes: "bob" });
		await seedPatient(store, THIRD_SESSION_CASE_ID, "Carol", {
			notes: "carol",
		});
		const caseIds = [
			THIRD_SESSION_CASE_ID,
			SESSION_CASE_ID,
			SECOND_SESSION_CASE_ID,
		];
		const submissionReceipt: SubmissionReceiptClaim = {
			entryKey: "shared-primary-patch",
			formUuid: FORM_UUID,
			expectedAppMutationSeq: 0,
			blueprintDigest: "0".repeat(64),
			requestDigest: "shared-primary-patch-request",
		};
		const args = {
			appId: APP_ID,
			submissionReceipt,
			ordinary: {
				kind: "followup" as const,
				caseIds,
				selection: { kind: "multiple" as const, maximum: 3 },
				caseType: "patient",
			},
			operations: {
				...ownProgram("followup", [
					ownOp({
						name: term(literal("Shared name")),
						writes: literalWrites({
							notes: "from-form",
							age: 33,
							external_id: "shared-external-id",
						}),
					}),
					envOp(
						operation({
							action: "update",
							caseType: "patient",
							target: { kind: "session" },
							writes: [{ property: "copy", value: term(literal("advanced")) }],
						}),
					),
				]),
				sessionCaseIds: caseIds,
			},
		};

		const result = await submit(store, args);
		expect(await submit(store, args)).toEqual(result);
		expect(result.primaryCaseIds).toEqual(caseIds);
		// Each selected case takes the own case's change and then the
		// operation after it, in selection order.
		expect(
			result.operations.map(({ action, selection, caseId }) => ({
				action,
				selection,
				caseId,
			})),
		).toEqual(
			caseIds.flatMap((caseId, selection) => [
				{ action: "own", selection, caseId },
				{ action: "update", selection, caseId },
			]),
		);
		for (const caseId of caseIds) {
			const row = await patientRow(store, caseId);
			expect(row?.case_name).toBe("Shared name");
			expect(row?.external_id).toBe("shared-external-id");
			expect(row?.properties).toMatchObject({
				notes: "from-form",
				age: 33,
				copy: "advanced",
			});
			expect(row?.properties).not.toHaveProperty("case_name");
			expect(row?.properties).not.toHaveProperty("external_id");
		}
		const receiptCount = await sql<{ count: string }>`
			SELECT count(*)::text AS count
			FROM form_submission_intents
			WHERE app_id = ${APP_ID} AND entry_key = ${submissionReceipt.entryKey}
		`.execute(dbHandle.db);
		expect(receiptCount.rows[0]?.count).toBe("1");
	});

	it("saves nothing to any selected case from a blank shared answer", async () => {
		const store = makeStore();
		await seedPatient(store, SESSION_CASE_ID, "Alice", { notes: "alice" });
		await seedPatient(store, SECOND_SESSION_CASE_ID, "Bob", { notes: "bob" });
		await store.update({
			appId: APP_ID,
			caseId: SESSION_CASE_ID,
			patch: { external_id: "alice-external" },
		});
		await store.update({
			appId: APP_ID,
			caseId: SECOND_SESSION_CASE_ID,
			patch: { external_id: "bob-external" },
		});
		const before = new Map(
			(
				await store.query({
					reading: SEARCH_READING,
					appId: APP_ID,
					caseType: "patient",
					caseIds: [SESSION_CASE_ID, SECOND_SESSION_CASE_ID],
				})
			).map((row) => [row.case_id, row]),
		);

		// One shared blank must not erase a value on every selected case,
		// so the own case saves nothing from it, as CommCare HQ writes such
		// an update only when the answer is present and not empty.
		await submit(store, {
			appId: APP_ID,
			ordinary: {
				kind: "followup",
				caseIds: [SECOND_SESSION_CASE_ID, SESSION_CASE_ID],
				selection: { kind: "multiple", maximum: 2 },
				caseType: "patient",
			},
			operations: {
				...ownProgram(
					"followup",
					[
						ownOp({
							name: term(formField(KEY_FIELD)),
							writes: [
								{ property: "external_id", value: term(formField(FLAG_FIELD)) },
								{ property: "notes", value: term(literal("")) },
								{ property: "meds", value: term(formField(MEDS_FIELD)) },
							],
						}),
					],
					{
						formFields: [
							["11111111-1111-4111-8111-111111111111", " \t\n"],
							// A control character Java's trim removes (no form answer
							// holds U+0000, which XML cannot carry).
							["22222222-2222-4222-8222-222222222222", "\u0001 \r"],
							["33333333-3333-4333-8333-333333333333", []],
						],
					},
				),
				sessionCaseIds: [SECOND_SESSION_CASE_ID, SESSION_CASE_ID],
			},
		});

		for (const caseId of [SESSION_CASE_ID, SECOND_SESSION_CASE_ID]) {
			const prior = before.get(caseId);
			const row = await patientRow(store, caseId);
			expect(row).toEqual(prior);
		}
	});

	it("rolls every selected case's own change back when a child create fails", async () => {
		const store = makeStore();
		await seedPatient(store, SESSION_CASE_ID, "Alice", { notes: "alice" });
		await seedPatient(store, SECOND_SESSION_CASE_ID, "Bob", { notes: "bob" });
		const submissionReceipt: SubmissionReceiptClaim = {
			entryKey: "shared-primary-patch-rollback",
			formUuid: FORM_UUID,
			expectedAppMutationSeq: 0,
			blueprintDigest: "0".repeat(64),
			requestDigest: "shared-primary-patch-rollback-request",
		};

		await expect(
			submit(store, {
				appId: APP_ID,
				submissionReceipt,
				ordinary: {
					kind: "followup",
					caseIds: [SECOND_SESSION_CASE_ID, SESSION_CASE_ID],
					selection: { kind: "multiple", maximum: 2 },
					caseType: "patient",
				},
				operations: {
					...ownProgram("followup", [
						ownOp({
							name: term(literal("Must roll back")),
							writes: literalWrites({
								external_id: "must-roll-back",
								notes: "must roll back",
							}),
						}),
						envOp(
							operation({
								uuid: OP_B,
								id: "invalid_child",
								action: "create",
								caseType: "visit",
								target: { kind: "new" },
								name: term(literal("Invalid child")),
								writes: literalWrites({ unknown_property: "boom" }),
							}),
						),
					]),
					sessionCaseIds: [SECOND_SESSION_CASE_ID, SESSION_CASE_ID],
				},
			}),
		).rejects.toThrow(CasePropertiesValidationError);

		expect(await patientRow(store, SESSION_CASE_ID)).toMatchObject({
			case_name: "Alice",
			external_id: null,
			properties: { notes: "alice" },
		});
		expect(await patientRow(store, SECOND_SESSION_CASE_ID)).toMatchObject({
			case_name: "Bob",
			external_id: null,
			properties: { notes: "bob" },
		});
		expect(
			await store.query({
				reading: SEARCH_READING,
				appId: APP_ID,
				caseType: "visit",
			}),
		).toHaveLength(0);
		const receiptCount = await sql<{ count: string }>`
			SELECT count(*)::text AS count
			FROM form_submission_intents
			WHERE app_id = ${APP_ID} AND entry_key = ${submissionReceipt.entryKey}
		`.execute(dbHandle.db);
		expect(receiptCount.rows[0]?.count).toBe("0");
	});

	it("rejects a retype of any selected case before the own case's change lands", async () => {
		const store = makeStore();
		await seedPatient(store, SESSION_CASE_ID, "Alice", { notes: "alice" });
		await seedPatient(store, SECOND_SESSION_CASE_ID, "Bob", { notes: "bob" });
		const caseIds = [SESSION_CASE_ID, SECOND_SESSION_CASE_ID];

		const err = await rejection(
			submit(store, {
				appId: APP_ID,
				ordinary: {
					kind: "followup",
					caseIds,
					selection: { kind: "multiple", maximum: 2 },
					caseType: "patient",
				},
				operations: {
					...ownProgram("followup", [
						ownOp({ writes: literalWrites({ notes: "must not land" }) }),
						envOp(
							operation({
								action: "update",
								caseType: "patient",
								target: {
									kind: "expression",
									expr: term(literal(SECOND_SESSION_CASE_ID)),
								},
								retype: "patient_v2",
							}),
							{
								expressionSnapshotTypes: {
									target: "patient",
									links: new Map(),
								},
							},
						),
					]),
					sessionCaseIds: caseIds,
				},
			}),
		);

		expect(err.rejection).toMatchObject({
			kind: "sequence",
			reason: "rolling-case-type-mismatch",
		});
		for (const [caseId, notes] of [
			[SESSION_CASE_ID, "alice"],
			[SECOND_SESSION_CASE_ID, "bob"],
		] as const) {
			const row = await patientRow(store, caseId);
			expect(row?.case_type).toBe("patient");
			expect(row?.properties).toMatchObject({ notes });
		}
	});

	it("runs form-level creates once per repeat before selected-case operations", async () => {
		const store = makeStore();
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
			await store.query({
				reading: SEARCH_READING,
				appId: APP_ID,
				caseType: "visit",
			}),
		).toHaveLength(2);
		for (const caseId of caseIds) {
			expect((await patientRow(store, caseId))?.properties).toMatchObject({
				copy: createdCaseIds[1],
			});
		}
	});

	it("separates a childless close's server history from an active close and an absent block", async () => {
		const store = makeStore();
		await seedSessionPatient(store);
		const older = new Date("2025-01-01T00:00:00Z");
		await (dbHandle.db as Kysely<Database>)
			.updateTable("cases")
			.set({ modified_on: older })
			.where("case_id", "=", SESSION_CASE_ID)
			.execute();
		const existingTarget = {
			kind: "expression",
			expr: term(literal(SESSION_CASE_ID)),
		} as const;
		const predicate = (matches: boolean) =>
			eq(literal(matches ? "yes" : "no"), literal("yes"));
		const close: TargetedCaseOperation = {
			uuid: OP_A,
			id: "close_patient",
			action: "close",
			caseType: "patient",
			target: existingTarget,
			closeCondition: predicate(false),
		};
		const request = (
			targeted: TargetedCaseOperation,
			opening?: OpeningReadSet,
		): TestSubmissionArgs => ({
			appId: APP_ID,
			ordinary: { kind: "none" },
			operations: {
				...rootProgram([envOp(targeted)], { sessionCaseId: null }),
				...(opening && { openingReads: opening }),
			},
		});
		const absent = await submit(
			store,
			request({ ...close, condition: predicate(false) }),
		);
		expect(absent.operations).toEqual([
			expect.objectContaining({ caseId: "", executed: false }),
		]);
		expect(absent.operations[0]).not.toHaveProperty("childlessBlock");
		expect((await patientRow(store, SESSION_CASE_ID))?.modified_on).toEqual(
			older,
		);

		const opening: OpeningReadSet = {
			cases: { rows: [], indices: [], propertyTypes: {} },
			currentOwnerIds: [ACTOR],
			lookupRows: [],
		};
		await expect(
			submit(
				store,
				request(
					{
						...close,
						target: { kind: "expression", expr: term(literal("unknown-case")) },
					},
					opening,
				),
			),
		).rejects.toMatchObject({
			rejection: { kind: "target", reason: "not-found-or-out-of-scope" },
		});
		expect(await patientRow(store, "unknown-case")).toBeUndefined();

		const childlessRequest = request(close, opening);
		const childlessClaim = {
			...childlessRequest,
			submissionReceipt: receiptFor(childlessRequest),
		};
		const childless = await store.applySubmission(childlessClaim);
		expect(childless.operations).toEqual([
			expect.objectContaining({
				caseId: SESSION_CASE_ID,
				executed: false,
				childlessBlock: true,
			}),
		]);
		expect(childless.caseDatabasePatch?.rows).toEqual([]);
		const afterChildless = await patientRow(store, SESSION_CASE_ID);
		expect(afterChildless?.status).toBe("open");
		expect(afterChildless?.modified_on?.getTime()).toBeGreaterThan(
			older.getTime(),
		);
		expect(await store.applySubmission(childlessClaim)).toEqual(childless);

		const activeRequest = request(
			{ ...close, closeCondition: predicate(true) },
			opening,
		);
		const activeClaim = {
			...activeRequest,
			submissionReceipt: receiptFor(activeRequest),
		};
		await expect(store.applySubmission(activeClaim)).rejects.toMatchObject({
			rejection: { kind: "target", reason: "not-found-or-out-of-scope" },
		});
		expect((await patientRow(store, SESSION_CASE_ID))?.modified_on).toEqual(
			afterChildless?.modified_on,
		);
		if (!activeClaim.operations || !afterChildless?.modified_on)
			throw new Error("Expected case and program");
		// Retry the same claim with the signed device row restored.
		const recovered = await store.applySubmission({
			...activeClaim,
			operations: {
				...activeClaim.operations,
				openingReads: {
					...opening,
					cases: { ...opening.cases, rows: [afterChildless] },
				},
			},
		});
		expect(recovered.operations).toEqual([
			expect.objectContaining({ caseId: SESSION_CASE_ID, executed: true }),
		]);
		expect(recovered.operations[0]).not.toHaveProperty("childlessBlock");
		expect(recovered.caseDatabasePatch?.rows[0]?.status).toBe("closed");
		expect(
			recovered.caseDatabasePatch?.rows[0]?.modified_on?.getTime(),
		).toBeGreaterThan(afterChildless.modified_on.getTime());

		const irrelevantUpdate = await submit(
			store,
			request({
				...close,
				closeCondition: predicate(false),
				writes: literalWrites({ notes: "never saved" }).map((write) => ({
					...write,
					condition: predicate(false),
				})),
			}),
		);
		expect(irrelevantUpdate.caseDatabasePatch?.rows[0]).toMatchObject({
			status: "closed",
			properties: { notes: "original" },
		});
		expect(
			irrelevantUpdate.caseDatabasePatch?.rows[0]?.modified_on?.getTime(),
		).toBeGreaterThan(
			recovered.caseDatabasePatch?.rows[0]?.modified_on?.getTime() ?? 0,
		);

		const writtenAndClosed = await submit(
			store,
			request({
				...close,
				action: "update",
				closeAfter: true,
				closeCondition: predicate(true),
				writes: literalWrites({ notes: "saved before closing" }),
				rename: term(literal("Renamed before closing")),
			}),
		);
		expect(writtenAndClosed.caseDatabasePatch?.rows[0]).toMatchObject({
			status: "closed",
			case_name: "Renamed before closing",
			properties: { notes: "saved before closing" },
		});
	});

	it("applies nested repeat case effects within each enclosing row and replays that state", async () => {
		const store = makeStore();
		await seedSessionPatient(store);
		const inner = testUuid("nested-iteration");
		const record = (
			uuid: Uuid,
			repeat: Uuid,
			id: string,
			condition?: TargetedCaseOperation["condition"],
		) =>
			operation({
				uuid,
				id,
				action: "update",
				caseType: "patient",
				target: { kind: "session" },
				forEach: { repeat },
				...(condition !== undefined && { condition }),
				writes: [{ property: "notes", value: term(formField(KEY_FIELD)) }],
			});
		const program = rootProgram([
			envOp(record(OP_A, inner, "inner_notes")),
			envOp(
				record(
					OP_B,
					REPEAT_UUID,
					"outer_notes",
					eq(formField(KEY_FIELD), literal("outer row one")),
				),
			),
		]);
		const request = {
			appId: APP_ID,
			ordinary: followupOrdinary(),
			operations: {
				...program,
				scopes: [
					...program.scopes,
					{
						repeat: inner,
						iterations: ["inner row one", "inner row two"].map((value) => ({
							formFields: new Map([[KEY_FIELD, value]]),
						})),
					},
					{
						repeat: REPEAT_UUID,
						iterations: ["outer row one", "skip outer row two"].map(
							(value) => ({ formFields: new Map([[KEY_FIELD, value]]) }),
						),
					},
				],
				scopeOrder: [
					{ iteration: 0 },
					{ repeat: inner, iteration: 0 },
					{ repeat: REPEAT_UUID, iteration: 0 },
					{ repeat: inner, iteration: 1 },
					{ repeat: REPEAT_UUID, iteration: 1 },
				],
			},
		};
		const claim = { ...request, submissionReceipt: receiptFor(request) };
		await expect(
			store.applySubmission({
				...claim,
				operations: {
					...claim.operations,
					scopeOrder: claim.operations.scopeOrder.slice(0, -1),
				},
			}),
		).rejects.toThrow("schedule each live row once");
		expect(
			(await patientRow(store, SESSION_CASE_ID))?.properties,
		).toMatchObject({
			notes: "original",
		});
		const saved = await store.applySubmission(claim);
		expect(
			saved.operations.map((effect) => [
				effect.operationUuid,
				effect.iteration,
				effect.executed,
			]),
		).toEqual([
			[OP_A, 0, true],
			[OP_B, 0, true],
			[OP_A, 1, true],
			[OP_B, 1, false],
		]);
		expect(
			(await patientRow(store, SESSION_CASE_ID))?.properties,
		).toMatchObject({
			notes: "inner row two",
		});
		expect(await store.applySubmission(claim)).toEqual(saved);
	});

	it("commits a root's opening ID even after the answer changes", async () => {
		const store = makeStore();
		const exact = operation({
			uuid: OP_A,
			id: "opened_patient",
			action: "create",
			caseType: "patient",
			target: { kind: "new", expr: term(formField(KEY_FIELD)) },
			name: term(literal("Opened patient")),
		});
		const program = rootProgram([envOp(exact)], {
			sessionCaseId: null,
			formFields: [[KEY_FIELD, "later-worker-answer"]],
		});
		const request: TestSubmissionArgs = {
			appId: APP_ID,
			ordinary: { kind: "none" },
			operations: {
				...program,
				openingCreateIds: new Map([[OP_A, "opened-case-id"]]),
			},
		};
		const claim = { ...request, submissionReceipt: receiptFor(request) };
		const result = await store.applySubmission(claim);
		expect(result.operations[0]).toMatchObject({
			caseId: "opened-case-id",
			operationUuid: OP_A,
			executed: true,
		});
		expect(await patientRow(store, "later-worker-answer")).toBeUndefined();
		expect(await store.applySubmission(claim)).toEqual(result);
	});

	it("evaluates exact create IDs for each live repeat row and reuses only authorized cases", async () => {
		const store = makeStore();
		await seedSessionPatient(store);
		const known = await patientRow(store, SESSION_CASE_ID);
		if (!known) throw new Error("Expected the authorized case.");
		const condition = eq(formField(FLAG_FIELD), literal("create"));
		const operationWithExactId = operation({
			uuid: OP_A,
			id: "exact_patient",
			action: "create",
			caseType: "patient",
			target: { kind: "new", expr: term(formField(KEY_FIELD)) },
			name: term(literal("New name")),
			forEach: { repeat: REPEAT_UUID },
			condition,
		});
		const program = rootProgram([envOp(operationWithExactId)], {
			sessionCaseId: null,
		});
		const request: TestSubmissionArgs = {
			appId: APP_ID,
			ordinary: { kind: "none" },
			operations: {
				...program,
				openingReads: {
					cases: { rows: [], indices: [], propertyTypes: {} },
					currentOwnerIds: [ACTOR],
					lookupRows: [],
				},
				scopes: [
					...program.scopes,
					{
						repeat: REPEAT_UUID,
						iterations: [
							{
								formFields: new Map([
									[KEY_FIELD, "raw-exact-id"],
									[FLAG_FIELD, "create"],
								]),
							},
							{
								formFields: new Map([
									[KEY_FIELD, SESSION_CASE_ID],
									[FLAG_FIELD, "create"],
								]),
							},
							{
								formFields: new Map([
									[KEY_FIELD, ""],
									[FLAG_FIELD, "skip"],
								]),
							},
						],
					},
				],
			},
		};
		const claim = { ...request, submissionReceipt: receiptFor(request) };
		await expect(store.applySubmission(claim)).rejects.toMatchObject({
			rejection: { kind: "target", reason: "not-found-or-out-of-scope" },
		});
		expect(await patientRow(store, "raw-exact-id")).toBeUndefined();
		expect((await patientRow(store, SESSION_CASE_ID))?.case_name).toBe("Alice");

		const operations = request.operations;
		if (!operations?.openingReads)
			throw new Error("Expected the form's signed opening reads.");
		const withKnown = {
			...claim,
			operations: {
				...operations,
				openingReads: {
					...operations.openingReads,
					cases: { ...operations.openingReads.cases, rows: [known] },
				},
			},
		};
		const saved = await store.applySubmission(withKnown);
		expect(
			saved.operations.map(({ caseId, executed }) => [caseId, executed]),
		).toEqual([
			["raw-exact-id", true],
			[SESSION_CASE_ID, true],
			["", false],
		]);
		expect((await patientRow(store, SESSION_CASE_ID))?.case_name).toBe(
			"New name",
		);
		expect((await patientRow(store, "raw-exact-id"))?.case_name).toBe(
			"New name",
		);
		expect(await store.applySubmission(withKnown)).toEqual(saved);
	});

	it("omits a conditional create owner before evaluation and keeps each row's resolved owner on replay", async () => {
		const store = makeStore();
		const root = operation({
			uuid: OP_A,
			id: "group_patient",
			action: "create",
			caseType: "patient",
			target: { kind: "new" },
			name: term(literal("Group patient")),
		});
		const repeating = operation({
			uuid: OP_B,
			id: "repeat_patient",
			action: "create",
			caseType: "patient",
			target: { kind: "new" },
			name: term(literal("Repeated patient")),
			forEach: { repeat: REPEAT_UUID },
			owner: term(formField(KEY_FIELD)),
			ownerCondition: eq(formField(FLAG_FIELD), literal("assign")),
		});
		const program = rootProgram([envOp(root), envOp(repeating)], {
			sessionCaseId: null,
		});
		const request: TestSubmissionArgs = {
			appId: APP_ID,
			ordinary: { kind: "none" },
			operations: {
				...program,
				groupDefaults: { owner: "team-1", operations: [OP_A, OP_B] },
				scopes: [
					...program.scopes,
					{
						repeat: REPEAT_UUID,
						iterations: [
							{ formFields: new Map([[FLAG_FIELD, "skip"]]) },
							{
								formFields: new Map([
									[FLAG_FIELD, "assign"],
									[KEY_FIELD, "supervisor-9"],
								]),
							},
						],
					},
				],
			},
		};
		const claim = { ...request, submissionReceipt: receiptFor(request) };
		const saved = await store.applySubmission(claim);
		expect(
			saved.operations.map(({ operationUuid, iteration }) => [
				operationUuid,
				iteration,
			]),
		).toEqual([
			[OP_A, 0],
			[OP_B, 0],
			[OP_B, 1],
		]);
		const rows = await Promise.all(
			saved.operations.map(({ caseId }) => patientRow(store, caseId)),
		);
		expect(rows.map((row) => row?.owner_id)).toEqual([
			"team-1",
			ACTOR,
			"supervisor-9",
		]);
		expect(await store.applySubmission(claim)).toEqual(saved);
	});

	it("applies authored case changes within a row and omits absent positions on replay", async () => {
		const store = makeStore();
		await seedSessionPatient(store);
		const write = (uuid: Uuid, id: string) =>
			envOp(
				operation({
					uuid,
					id,
					action: "update",
					caseType: "patient",
					target: { kind: "session" },
					forEach: { repeat: REPEAT_UUID },
					writes: [{ property: "notes", value: term(literal(id)) }],
				}),
			);
		const program = rootProgram([
			write(OP_A, "generated"),
			write(OP_B, "positioned"),
		]);
		const request: TestSubmissionArgs = {
			appId: APP_ID,
			ordinary: followupOrdinary(),
			operations: {
				...program,
				scopes: [
					...program.scopes,
					{
						repeat: REPEAT_UUID,
						iterations: [{ formFields: new Map() }, { formFields: new Map() }],
					},
				],
				effectOrder: [
					{ repeat: REPEAT_UUID, iteration: 0, operationUuids: [OP_B] },
					{ repeat: REPEAT_UUID, iteration: 0, operationUuids: [OP_A] },
					{
						repeat: REPEAT_UUID,
						iteration: 1,
						operationUuids: [OP_B],
						absent: true,
					},
					{ repeat: REPEAT_UUID, iteration: 1, operationUuids: [OP_A] },
				],
			},
		};
		const claim = { ...request, submissionReceipt: receiptFor(request) };
		const effects = await store.applySubmission(claim);
		expect(
			effects.operations.map((effect) => [
				effect.operationUuid,
				effect.iteration,
			]),
		).toEqual([
			[OP_B, 0],
			[OP_A, 0],
			[OP_A, 1],
		]);
		expect(await patientRow(store, SESSION_CASE_ID)).toMatchObject({
			properties: { notes: "generated" },
		});
		expect(await store.applySubmission(claim)).toEqual(effects);
	});

	it("runs repeat outer by selected case inner with one session anchor per case", async () => {
		const store = makeStore();
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

	it("closes every selected case in selection order after its own change", async () => {
		const store = makeStore();
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
			},
			operations: {
				...ownProgram("close", [
					ownOp({ writes: literalWrites({ notes: "final" }) }),
				]),
				sessionCaseIds: caseIds,
			},
		});

		expect(result.primaryCaseIds).toEqual(caseIds);
		expect(result.createdChildren).toEqual([]);
		expect(
			result.operations.map(({ action, selection, caseId, executed }) => ({
				action,
				selection,
				caseId,
				executed,
			})),
		).toEqual(
			caseIds.map((caseId, selection) => ({
				action: "own",
				selection,
				caseId,
				executed: true,
			})),
		);
		for (const caseId of caseIds) {
			const row = await patientRow(store, caseId);
			expect(row?.status).toBe("closed");
			expect(row?.properties).toMatchObject({ notes: "final" });
		}
	});

	it("rolls back the receipt on stale selection and accepts an exact retry", async () => {
		const store = makeStore();
		await seedPatient(store, SESSION_CASE_ID, "Alice");
		const submissionReceipt: SubmissionReceiptClaim = {
			entryKey: "multi-selection-retry",
			formUuid: FORM_UUID,
			expectedAppMutationSeq: 0,
			blueprintDigest: "0".repeat(64),
			requestDigest: "multi-selection-retry-request",
		};
		const caseIds = [SESSION_CASE_ID, SECOND_SESSION_CASE_ID];
		const args = {
			appId: APP_ID,
			submissionReceipt,
			ordinary: {
				kind: "close" as const,
				caseIds,
				selection: { kind: "multiple" as const, maximum: 2 },
				caseType: "patient",
			},
			operations: {
				...ownProgram("close", [
					ownOp({ writes: literalWrites({ notes: "done" }) }),
				]),
				sessionCaseIds: caseIds,
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
		const acceptedReceipt = await sql<{ result: unknown }>`
			SELECT result
			FROM form_submission_intents
			WHERE app_id = ${APP_ID} AND entry_key = ${submissionReceipt.entryKey}
		`.execute(dbHandle.db);
		expect(acceptedReceipt.rows[0]?.result).toMatchObject({
			createdChildren: [],
			operations: accepted.operations,
		});
		expect(acceptedReceipt.rows[0]?.result).not.toHaveProperty("childCaseIds");
		for (const caseId of caseIds) {
			expect((await patientRow(store, caseId))?.status).toBe("closed");
		}
	});
});

// ---------------------------------------------------------------
// Pre-submission snapshot semantics
// ---------------------------------------------------------------

describe("pre-submission snapshot", () => {
	it("keeps one selected case in scope for every operation and preserves authored order", async () => {
		const store = makeStore();
		await seedSessionPatient(store, { notes: "original" });
		const result = await submit(store, {
			appId: APP_ID,
			ordinary: followupOrdinary(),
			operations: rootProgram([
				envOp(
					operation({
						uuid: OP_A,
						writes: [{ property: "notes", value: term(literal("first")) }],
					}),
				),
				envOp(
					operation({
						uuid: OP_B,
						id: "create_visit",
						action: "create",
						caseType: "visit",
						target: { kind: "new" },
						condition: eq(prop("patient", "notes"), literal("original")),
						name: term(prop("patient", "case_name")),
						writes: [
							{ property: "outcome", value: term(prop("patient", "notes")) },
						],
						links: [
							{
								identifier: "parent",
								targetType: "patient",
								target: { kind: "session" },
								relationship: "child",
							},
						],
					}),
				),
				envOp(
					operation({
						uuid: OP_C,
						id: "last_write",
						target: {
							kind: "expression",
							expr: term(literal(SESSION_CASE_ID)),
						},
						writes: [{ property: "notes", value: term(literal("last")) }],
					}),
					{ expressionSnapshotTypes: { target: "patient", links: new Map() } },
				),
			]),
		});
		expect(result.operations.map((item) => item.operationUuid)).toEqual([
			OP_A,
			OP_B,
			OP_C,
		]);
		expect((await patientRow(store, SESSION_CASE_ID))?.properties.notes).toBe(
			"last",
		);
		const visits = await store.query({
			reading: SEARCH_READING,
			appId: APP_ID,
			caseType: "visit",
		});
		expect(visits).toHaveLength(1);
		expect(visits[0]).toMatchObject({
			case_name: "Alice",
			parent_case_id: SESSION_CASE_ID,
			properties: { outcome: "original" },
		});
	});

	it("makes one child under each selected case for a create linked to the loaded case", async () => {
		const store = makeStore();
		await seedPatient(store, SESSION_CASE_ID, "Alice", { notes: "alice" });
		await seedPatient(store, SECOND_SESSION_CASE_ID, "Bob", { notes: "bob" });
		const caseIds = [SECOND_SESSION_CASE_ID, SESSION_CASE_ID];
		const result = await submit(store, {
			appId: APP_ID,
			ordinary: {
				kind: "followup",
				caseIds,
				selection: { kind: "multiple", maximum: 2 },
				caseType: "patient",
			},
			operations: {
				...rootProgram([
					envOp(
						operation({
							uuid: OP_A,
							id: "visit",
							action: "create",
							caseType: "visit",
							target: { kind: "new" },
							name: term(literal("Visit")),
							links: [
								{
									identifier: "parent",
									targetType: "patient",
									target: { kind: "session" },
									relationship: "child",
								},
							],
						}),
					),
				]),
				sessionCaseIds: caseIds,
			},
		});
		expect(result.operations.map((item) => item.operationUuid)).toEqual([
			OP_A,
			OP_A,
		]);
		const visits = await store.query({
			reading: SEARCH_READING,
			appId: APP_ID,
			caseType: "visit",
		});
		expect(visits.map((visit) => visit.parent_case_id).sort()).toEqual(
			[...caseIds].sort(),
		);
		expect(new Set(visits.map((visit) => visit.case_id)).size).toBe(2);
	});

	it("refuses a link to the loaded case on a batch operation that runs once for the form", async () => {
		const store = makeStore();
		await seedSessionPatient(store);
		const ordinary = followupOrdinary();
		const error = await rejection(
			submit(store, {
				appId: APP_ID,
				ordinary: { ...ordinary, selection: { kind: "multiple", maximum: 2 } },
				operations: rootProgram([
					envOp(
						operation({
							action: "update",
							caseType: "patient",
							target: {
								kind: "expression",
								expr: term(literal(SESSION_CASE_ID)),
							},
							writes: [{ property: "notes", value: term(literal("linked")) }],
							links: [
								{
									identifier: "parent",
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
		expect(error.rejection).toMatchObject({
			kind: "selection",
			reason: "session-link-not-supported",
		});
		expect((await patientRow(store, SESSION_CASE_ID))?.properties.notes).toBe(
			"original",
		);
	});

	it("every expression evaluates against pre-effect values", async () => {
		const store = makeStore();
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

		const visits = await store.query({
			reading: SEARCH_READING,
			appId: APP_ID,
			caseType: "visit",
		});
		expect(visits).toHaveLength(1);
		expect(visits[0]?.properties).not.toHaveProperty("outcome");
	});

	it("a create's write saved only when changed saves a given answer and nothing for a blank one", async () => {
		// HQ's `edit` compares the new case's casedb leaf, which a new case
		// lacks, so its empty text differs from any answer but a blank one
		// (`XFormCaseBlock.add_case_updates`).
		const store = makeStore();
		const create = (name: string, outcome: string) =>
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
								name: term(literal(name)),
								writes: [
									{
										property: "outcome",
										value: term(literal(outcome)),
										onlyIfChanged: true,
									},
								],
							}),
						),
					],
					{ sessionCaseId: null },
				),
			});
		await create("Blank", "");
		await create("Seen", "seen");
		const visits = await store.query({
			reading: SEARCH_READING,
			appId: APP_ID,
			caseType: "visit",
		});
		const byName = new Map(visits.map((row) => [row.case_name, row]));
		expect(byName.get("Blank")?.properties).not.toHaveProperty("outcome");
		expect(byName.get("Seen")?.properties.outcome).toBe("seen");
	});
});

// ---------------------------------------------------------------
// Conditions and guards
// ---------------------------------------------------------------

describe("conditions", () => {
	it("a false condition skips the operation and its guarded consumers", async () => {
		const store = makeStore();
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
			await store.query({
				reading: SEARCH_READING,
				appId: APP_ID,
				caseType: "visit",
			}),
		).toHaveLength(0);
		expect(result.operations.map((entry) => entry.executed)).toEqual([
			false,
			false,
		]);
	});

	it("a skipped authored-key create holds its blank-key failure", async () => {
		const store = makeStore();

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
			await store.query({
				reading: SEARCH_READING,
				appId: APP_ID,
				caseType: "visit",
			}),
		).toHaveLength(0);
	});

	it("a true condition executes the chain", async () => {
		const store = makeStore();
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

		const visits = await store.query({
			reading: SEARCH_READING,
			appId: APP_ID,
			caseType: "visit",
		});
		expect(visits).toHaveLength(1);
		expect(visits[0]?.properties).toMatchObject({ outcome: "visited" });
		expect(result.operations.map((entry) => entry.executed)).toEqual([
			true,
			true,
		]);
	});

	it("a false write condition skips just that write", async () => {
		const store = makeStore();
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
			await store.query({
				reading: SEARCH_READING,
				appId: APP_ID,
				caseType: "patient",
			}),
		).toHaveLength(0);
	});

	it("expands distinct iterations with their own bindings, iteration-major", async () => {
		const store = makeStore();

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
		const visits = await store.query({
			reading: SEARCH_READING,
			appId: APP_ID,
			caseType: "visit",
		});
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
			await store.query({
				reading: SEARCH_READING,
				appId: APP_ID,
				caseType: "patient",
			}),
		).toHaveLength(1);
		expect(result.operations).toHaveLength(2);
		expect(new Set(result.operations.map((entry) => entry.caseId)).size).toBe(
			1,
		);
	});

	it("rejects a later retype of the case the form's own case writes", async () => {
		const store = makeStore();
		await seedSessionPatient(store);

		const err = await rejection(
			submit(store, {
				appId: APP_ID,
				ordinary: followupOrdinary(),
				operations: ownProgram("followup", [
					ownOp({ writes: literalWrites({ notes: "patched" }) }),
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
		// The own case writes patient-shaped data to the session case from
		// Case Management's block, which runs after every other change, so
		// the proof refuses the retyped case there, as the validator refuses
		// a retype of the own case where its target is proven.
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
	it("rejects a whitespace-only create name without committing effects", async () => {
		const store = makeStore();

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
			await store.query({
				reading: SEARCH_READING,
				appId: APP_ID,
				caseType: "visit",
			}),
		).toHaveLength(0);
	});

	it("rejects an over-255-unit rename", async () => {
		const store = makeStore();
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

	it("normalizes boundary whitespace while preserving the interior", async () => {
		const store = makeStore();
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
				// The worker's own places, as its `locations` fixture holds them:
				// a device picks the destination among these.
				{ organizationLevels: levels, workerPlaceIds: [facilityLocationUuid] },
			),
		});
		expect((await patientRow(store, SESSION_CASE_ID))?.owner_id).toBe(
			facilityLocationUuid,
		);
	});

	it("defaults a create's owner to the acting user and honors unowned", async () => {
		const store = makeStore();

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

		const visits = await store.query({
			reading: SEARCH_READING,
			appId: APP_ID,
			caseType: "visit",
		});
		expect(visits[0]?.owner_id).toBe(ACTOR);
		const patients = await store.query({
			reading: SEARCH_READING,
			appId: APP_ID,
			caseType: "patient",
		});
		expect(patients[0]?.owner_id).toBe("-");
	});

	it("writes an explicit update owner and resolves acting-user as the worker, not the authorizing member", async () => {
		const workerId = "persona-asha";
		const store = makeStore(PROJECT_A, ACTOR, workerId);
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

		const rows = await store.query({
			reading: SEARCH_READING,
			appId: APP_ID,
			caseType: "patient_v2",
		});
		expect(rows).toHaveLength(1);
		expect(rows[0]?.case_id).toBe(SESSION_CASE_ID);
		expect(rows[0]?.properties).toMatchObject({ notes: "kept", age: 30 });
	});

	it("applies destination-typed writes and the type change as one unit", async () => {
		const store = makeStore();
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

		const rows = await store.query({
			reading: SEARCH_READING,
			appId: APP_ID,
			caseType: "patient_v2",
		});
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
		await seedSessionPatient(store);
		const before = new Date("2001-01-01T00:00:00Z");
		await sql`UPDATE cases SET modified_on=${before} WHERE case_id=${SESSION_CASE_ID}`.execute(
			dbHandle.db,
		);

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
		expect(after?.getTime()).toBeGreaterThan(before.getTime());
	});

	it("a parent-identifier link maintains the denormalized first parent", async () => {
		const store = makeStore();
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
// The form's own case
// ---------------------------------------------------------------

describe("the form's own case", () => {
	async function patients(store: PostgresCaseStore) {
		return store.query({
			reading: SEARCH_READING,
			appId: APP_ID,
			caseType: "patient",
			includeHeld: true,
		});
	}

	it.each([
		["false", false],
		["true", true],
	] as const)(
		"creates a registration's case only when its open condition holds (%s)",
		async (_label, holds) => {
			const store = makeStore();
			const result = await submit(store, {
				appId: APP_ID,
				ordinary: { kind: "registration" },
				operations: ownProgram(
					"registration",
					[
						ownOp({
							name: term(literal("Amina")),
							writes: literalWrites({ notes: "registered" }),
						}),
					],
					{
						openCondition: eq(formField(FLAG_FIELD), literal("yes")),
						formFields: [
							["22222222-2222-4222-8222-222222222222", holds ? "yes" : "no"],
						],
					},
				),
			});

			expect(result.operations).toEqual([
				expect.objectContaining({
					operationUuid: OWN_UUID,
					action: "own",
					executed: holds,
				}),
			]);
			const rows = await patients(store);
			expect(rows).toHaveLength(holds ? 1 : 0);
			if (holds) {
				expect(rows[0]).toMatchObject({
					case_name: "Amina",
					status: "open",
					properties: { notes: "registered" },
				});
				expect(result.primaryCaseIds).toEqual([rows[0]?.case_id]);
			}
		},
	);

	it("skips every operation that names a registration's case when its open condition fails", async () => {
		const store = makeStore();
		const result = await submit(store, {
			appId: APP_ID,
			ordinary: { kind: "registration" },
			operations: ownProgram(
				"registration",
				[
					ownOp({ name: term(literal("Amina")) }),
					envOp(
						operation({
							uuid: OP_B,
							id: "first_visit",
							action: "create",
							caseType: "visit",
							target: { kind: "new" },
							name: term(literal("First visit")),
							links: [
								{
									identifier: "parent",
									targetType: "patient",
									target: { kind: "op", opUuid: OWN_UUID },
									relationship: "child",
								},
							],
						}),
						{
							guardConditions: [eq(formField(FLAG_FIELD), literal("yes"))],
						},
					),
				],
				{
					openCondition: eq(formField(FLAG_FIELD), literal("yes")),
					formFields: [["22222222-2222-4222-8222-222222222222", "no"]],
				},
			),
		});

		expect(result.operations.map((record) => record.executed)).toEqual([
			false,
			false,
		]);
		expect(await patients(store)).toHaveLength(0);
		expect(
			await store.query({
				reading: SEARCH_READING,
				appId: APP_ID,
				caseType: "visit",
			}),
		).toHaveLength(0);
	});

	it("creates a registration's case under the id its entry minted, and refuses an id already taken", async () => {
		const store = makeStore();
		const receipt = (entryKey: string): SubmissionReceiptClaim => ({
			entryKey,
			formUuid: FORM_UUID,
			expectedAppMutationSeq: 0,
			blueprintDigest: "0".repeat(64),
			requestDigest: `${entryKey}-request`,
		});
		const program = (name: string): CaseOperationProgram => ({
			...ownProgram("registration", [ownOp({ name: term(literal(name)) })]),
			entryCaseKeys: new Map([[OWN_UUID, "new-case"]]),
		});

		const minted = entryDatumCaseId(APP_ID, "entry-named", "new-case");
		const result = await submit(store, {
			appId: APP_ID,
			ordinary: { kind: "registration" },
			operations: program("Amina"),
			submissionReceipt: receipt("entry-named"),
		});
		expect(result.primaryCaseIds).toEqual([minted]);
		expect((await patientRow(store, minted))?.case_name).toBe("Amina");

		// A case already holding the id the next entry minted refuses that
		// submission rather than merging onto it.
		const taken = entryDatumCaseId(APP_ID, "entry-taken", "new-case");
		await seedPatient(store, taken, "Already here");
		const err = await rejection(
			submit(store, {
				appId: APP_ID,
				ordinary: { kind: "registration" },
				operations: program("Someone else"),
				submissionReceipt: receipt("entry-taken"),
			}),
		);
		expect(err.rejection).toMatchObject({
			kind: "new-case",
			reason: "case-id-taken",
			caseId: taken,
		});
		expect((await patientRow(store, taken))?.case_name).toBe("Already here");
	});

	it("creates the externally named case once and rejects a second entry with the same supplied ID", async () => {
		const store = makeStore();
		const caseId = "registration-record-224";
		const program = (name: string): CaseOperationProgram => ({
			...ownProgram("registration", [ownOp({ name: term(literal(name)) })]),
			entryCaseKeys: new Map([[OWN_UUID, "new-case"]]),
			suppliedCaseIds: new Map([[OWN_UUID, caseId]]),
		});
		const receipt = (entryKey: string): SubmissionReceiptClaim => ({
			entryKey,
			formUuid: FORM_UUID,
			expectedAppMutationSeq: 0,
			blueprintDigest: "0".repeat(64),
			requestDigest: `${entryKey}-request`,
		});
		const first = {
			appId: APP_ID,
			ordinary: { kind: "registration" as const },
			operations: program("Amina"),
			submissionReceipt: receipt("first-supplied-entry"),
		};
		expect((await submit(store, first)).primaryCaseIds).toEqual([caseId]);
		expect((await submit(store, first)).primaryCaseIds).toEqual([caseId]);
		const other = await rejection(
			submit(store, {
				...first,
				operations: program("Second entry"),
				submissionReceipt: receipt("second-supplied-entry"),
			}),
		);
		expect(other.rejection).toMatchObject({
			kind: "new-case",
			reason: "case-id-taken",
			caseId,
		});
		expect((await patientRow(store, caseId))?.case_name).toBe("Amina");
	});

	it("refuses a resumed entry when a concurrent save took the new ID its form also reads", async () => {
		const caseId = "registration-after-form-open";
		const store = makeStore();
		expect(await patientRow(store, caseId)).toBeUndefined();
		const winner = receiptFor({
			appId: APP_ID,
			ordinary: { kind: "registration" },
		});
		const resumed = receiptFor({
			appId: APP_ID,
			ordinary: { kind: "registration" },
		});
		const creation = (
			name: string,
			operations: EnvelopeCaseOperation[] = [],
		): CaseOperationProgram => ({
			...ownProgram(
				"registration",
				[ownOp({ name: term(literal(name)) }), ...operations],
				{
					formFields: [[KEY_FIELD, caseId]],
				},
			),
			entryCaseKeys: new Map([[OWN_UUID, "new-case"]]),
			suppliedCaseIds: new Map([[OWN_UUID, caseId]]),
		});
		const raced = buildIsolatedDb<Database>(dbHandle.uri);
		const gate = new Client({ connectionString: dbHandle.uri });
		let pending: Promise<PromiseSettledResult<unknown>[]> | undefined;
		try {
			await gate.connect();
			const scope = `nova-form-attachment-entry:${APP_ID}:${ACTOR}:${resumed.entryKey}`;
			await gate.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [
				scope,
			]);
			const otherStore = makeStore(PROJECT_A, ACTOR, ACTOR, raced.db);
			pending = Promise.allSettled([
				submit(otherStore, {
					appId: APP_ID,
					ordinary: { kind: "registration" },
					operations: creation("Resumed form", [
						envOp(
							operation({
								target: {
									kind: "expression",
									expr: term(formField(KEY_FIELD)),
								},
								writes: literalWrites({ notes: "Should not be saved" }),
							}),
							{
								expressionSnapshotTypes: {
									target: "patient",
									links: new Map(),
								},
							},
						),
					]),
					submissionReceipt: resumed,
				}),
			]);
			await vi.waitFor(async () => {
				const waiters = await gate.query<{ count: number }>(`
					SELECT count(*)::int AS count FROM pg_stat_activity
					WHERE datname = current_database() AND pg_backend_pid() = ANY(pg_blocking_pids(pid))
				`);
				expect(waiters.rows[0]?.count).toBe(1);
			});
			const first = await submit(store, {
				appId: APP_ID,
				ordinary: { kind: "registration" },
				operations: creation("Concurrent winner"),
				submissionReceipt: winner,
			});
			expect(first.primaryCaseIds).toEqual([caseId]);
			const saved = await patientRow(store, caseId);
			await gate.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
				scope,
			]);

			const [other] = await pending;
			expect(other).toMatchObject({
				status: "rejected",
				reason: {
					rejection: { kind: "new-case", reason: "case-id-taken", caseId },
				},
			});
			expect(await patientRow(store, caseId)).toEqual(saved);
			const receipts = await dbHandle.pool.query(
				"SELECT entry_key FROM form_submission_intents WHERE app_id = $1",
				[APP_ID],
			);
			expect(receipts.rows).toEqual([{ entry_key: winner.entryKey }]);
		} finally {
			try {
				await gate.end();
				await pending;
			} finally {
				await raced.destroy();
			}
		}
	});

	it.each(["before", "after"] as const)(
		"refuses a new entry ID that equals a keyed create %s it in the same submission",
		async (placement) => {
			const store = makeStore();
			const key = "same-envelope";
			const caseId = `${PINNED_VECTOR_PREFIX}${key}`;
			const named = envOp(
				operation({
					action: "create",
					caseType: "visit",
					target: { kind: "new" },
					name: term(literal("Named visit")),
				}),
			);
			const keyed = envOp(
				operation({
					uuid: VECTOR_OP_UUID,
					id: "keyed_visit",
					action: "create",
					caseType: "visit",
					target: { kind: "new", idFrom: KEY_FIELD },
					name: term(literal("Keyed visit")),
				}),
			);
			const operations =
				placement === "before" ? [keyed, named] : [named, keyed];
			const refused = await rejection(
				submit(store, {
					appId: APP_ID,
					ordinary: { kind: "none" },
					operations: {
						...rootProgram(operations, {
							formFields: [[KEY_FIELD, key]],
							sessionCaseId: null,
						}),
						entryCaseKeys: new Map([[OP_A, "new-child-case:visit"]]),
						suppliedCaseIds: new Map([[OP_A, caseId]]),
					},
				}),
			);
			expect(refused.rejection).toEqual({
				kind: "new-case",
				reason: "case-id-taken",
				caseId,
			});
			expect(
				await store.query({
					reading: SEARCH_READING,
					appId: APP_ID,
					caseType: "visit",
				}),
			).toEqual([]);
			expect(
				(
					await dbHandle.pool.query(
						"SELECT entry_key FROM form_submission_intents WHERE app_id = $1",
						[APP_ID],
					)
				).rows,
			).toEqual([]);
		},
	);

	it("creates every case the entry gives a datum under its own minted id, an advanced open action's extension included", async () => {
		// An advanced registration: its own case and two visits made as its
		// extensions, each an open action outside a repeat with a datum of its
		// own (`new-child-case:visit`, then `new-child-case:visit:1`), and a
		// third visit no datum names.
		const store = makeStore();
		const entryKey = "entry-open-actions";
		const visit = (uuid: Uuid, id: string, name: string) =>
			envOp(
				operation({
					uuid,
					id,
					action: "create",
					caseType: "visit",
					target: { kind: "new" },
					name: term(literal(name)),
					links: [
						{
							identifier: "host",
							targetType: "patient",
							target: { kind: "op", opUuid: OWN_UUID },
							relationship: "extension",
						},
					],
				}),
			);
		const result = await submit(store, {
			appId: APP_ID,
			ordinary: { kind: "registration" },
			operations: {
				...ownProgram("registration", [
					ownOp({ name: term(literal("Amina")) }),
					visit(OP_A, "first_visit", "First visit"),
					visit(OP_B, "second_visit", "Second visit"),
					visit(OP_C, "unnamed_visit", "Unnamed visit"),
				]),
				entryCaseKeys: new Map([
					[OWN_UUID, "new-case"],
					[OP_A, "new-child-case:visit"],
					[OP_B, "new-child-case:visit:1"],
				]),
			},
			submissionReceipt: {
				entryKey,
				formUuid: FORM_UUID,
				expectedAppMutationSeq: 0,
				blueprintDigest: "0".repeat(64),
				requestDigest: `${entryKey}-request`,
			},
		});

		const household = entryDatumCaseId(APP_ID, entryKey, "new-case");
		const first = entryDatumCaseId(APP_ID, entryKey, "new-child-case:visit");
		const second = entryDatumCaseId(APP_ID, entryKey, "new-child-case:visit:1");
		const ids = result.operations.map((record) => record.caseId);
		expect(ids.slice(0, 3)).toEqual([household, first, second]);
		// The create no datum names keeps a fresh id of its own.
		expect(ids[3]).toEqual(expect.any(String));
		expect(new Set(ids).size).toBe(4);

		const visits = await store.query({
			reading: SEARCH_READING,
			appId: APP_ID,
			caseType: "visit",
		});
		const byId = new Map(visits.map((row) => [row.case_id, row]));
		expect(byId.get(first)?.case_name).toBe("First visit");
		expect(byId.get(second)?.case_name).toBe("Second visit");
		// Preview owns each carried extension by the worker, as the device's
		// `nova_owner_<op>` node does.
		expect(byId.get(first)?.owner_id).toBe(ACTOR);
		expect(byId.get(second)?.owner_id).toBe(ACTOR);
		const edges = await dbHandle.pool.query(
			`SELECT case_id, ancestor_id, relationship FROM case_indices WHERE identifier = 'host' AND case_id = ANY($1) ORDER BY case_id`,
			[[first, second]],
		);
		expect(edges.rows).toEqual(
			[first, second].sort().map((caseId) => ({
				case_id: caseId,
				ancestor_id: household,
				relationship: "extension",
			})),
		);
	});

	it("closes the case a registration creates when its close condition holds", async () => {
		const store = makeStore();
		await submit(store, {
			appId: APP_ID,
			ordinary: { kind: "registration" },
			operations: ownProgram(
				"registration",
				[ownOp({ name: term(literal("Closed at once")) })],
				{
					closeCondition: eq(formField(FLAG_FIELD), literal("yes")),
					formFields: [["22222222-2222-4222-8222-222222222222", "yes"]],
				},
			),
		});
		const rows = await patients(store);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			case_name: "Closed at once",
			status: "closed",
		});
		expect(rows[0]?.closed_on).not.toBeNull();
	});

	it.each([
		["holds", "done", "closed"],
		["fails", "pending", "open"],
	] as const)(
		"closes a close form's case after its writes only when its close condition %s",
		async (_label, answer, status) => {
			const store = makeStore();
			await seedSessionPatient(store);
			await submit(store, {
				appId: APP_ID,
				ordinary: followupOrdinary("close"),
				operations: ownProgram(
					"close",
					[ownOp({ writes: literalWrites({ notes: "final" }) })],
					{
						closeCondition: eq(formField(FLAG_FIELD), literal("done")),
						formFields: [["22222222-2222-4222-8222-222222222222", answer]],
					},
				),
			});
			const row = await patientRow(store, SESSION_CASE_ID);
			// The writes land either way; only the close follows the condition.
			expect(row?.properties).toMatchObject({ notes: "final" });
			expect(row?.status).toBe(status);
		},
	);

	it("closes a close form's case on every submission when it has no close condition", async () => {
		const store = makeStore();
		await seedSessionPatient(store);
		await submit(store, {
			appId: APP_ID,
			ordinary: followupOrdinary("close"),
			operations: ownProgram("close", [ownOp()]),
		});
		expect((await patientRow(store, SESSION_CASE_ID))?.status).toBe("closed");
	});

	it("saves a write through its index to the case the index reaches, and nothing where none is indexed", async () => {
		const store = makeStore();
		const HOUSEHOLD_ID = "00000000-0000-7000-8000-00000000dddd";
		await seedPatient(store, HOUSEHOLD_ID, "The household", {
			notes: "household",
		});
		await seedSessionPatient(store);
		await submit(store, {
			appId: APP_ID,
			ordinary: { kind: "none" },
			operations: rootProgram([
				envOp(
					operation({
						uuid: OP_A,
						id: "index_household",
						action: "update",
						caseType: "patient",
						target: { kind: "session" },
						links: [
							{
								identifier: "parent",
								targetType: "patient",
								target: {
									kind: "expression",
									expr: term(literal(HOUSEHOLD_ID)),
								},
								relationship: "child",
							},
						],
					}),
					{
						expressionSnapshotTypes: {
							links: new Map([[0, "patient"]]),
						},
					},
				),
			]),
		});

		const viaParent = (value: string): EnvelopeCaseOperation =>
			ownOp({
				writes: [
					{
						property: "notes",
						value: term(literal(value)),
						via: [{ identifier: "parent" }],
					},
					{ property: "copy", value: term(literal(value)) },
				],
			});
		const withVia = (program: CaseOperationProgram) => ({
			...program,
			operations: program.operations.map((entry) =>
				entry.operation.uuid === OWN_UUID
					? { ...entry, viaCaseTypes: new Map([[0, "patient"]]) }
					: entry,
			),
		});
		const request = {
			appId: APP_ID,
			ordinary: followupOrdinary(),
			operations: withVia(ownProgram("followup", [viaParent("from child")])),
		};
		const claim = { ...request, submissionReceipt: receiptFor(request) };
		const saved = await store.applySubmission(claim);
		expect(saved.caseDatabasePatch?.rows).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					case_id: HOUSEHOLD_ID,
					properties: expect.objectContaining({ notes: "from child" }),
				}),
			]),
		);
		expect((await store.applySubmission(claim)).caseDatabasePatch).toEqual(
			saved.caseDatabasePatch,
		);
		expect((await patientRow(store, HOUSEHOLD_ID))?.properties).toMatchObject({
			notes: "from child",
		});
		expect(
			(await patientRow(store, SESSION_CASE_ID))?.properties,
		).toMatchObject({ notes: "original", copy: "from child" });

		// The household itself has no parent index: its write through one
		// saves nothing, and its own write still lands.
		await submit(store, {
			appId: APP_ID,
			ordinary: { ...followupOrdinary(), caseIds: [HOUSEHOLD_ID] },
			operations: {
				...withVia(ownProgram("followup", [viaParent("nowhere")])),
				sessionCaseIds: [HOUSEHOLD_ID],
			},
		});
		expect((await patientRow(store, HOUSEHOLD_ID))?.properties).toMatchObject({
			notes: "from child",
			copy: "nowhere",
		});
	});

	it("saves the name and the owner of the case its index reaches as that case's, and refuses a blank name", async () => {
		// HQ's build writes `parent/name` and `parent/owner_id` into the parent's
		// block as its `case_name` and `owner_id` (`XFormCaseBlock.add_case_updates`),
		// which Core and HQ's server set as the case's name and owner.
		const store = makeStore();
		const HOUSEHOLD_ID = "00000000-0000-7000-8000-00000000dde1";
		await seedPatient(store, HOUSEHOLD_ID, "The household", {});
		await seedSessionPatient(store);
		await submit(store, {
			appId: APP_ID,
			ordinary: { kind: "none" },
			operations: rootProgram([
				envOp(
					operation({
						uuid: OP_A,
						id: "index_household",
						action: "update",
						caseType: "patient",
						target: { kind: "session" },
						links: [
							{
								identifier: "parent",
								targetType: "patient",
								target: {
									kind: "expression",
									expr: term(literal(HOUSEHOLD_ID)),
								},
								relationship: "child",
							},
						],
					}),
					{ expressionSnapshotTypes: { links: new Map([[0, "patient"]]) } },
				),
			]),
		});
		const facets = (name: string, owner: string) =>
			ownProgram("followup", [
				{
					...ownOp({
						writes: [
							{
								property: "case_name",
								value: term(literal(name)),
								via: [{ identifier: "parent" }],
							},
							{
								property: "owner_id",
								value: term(literal(owner)),
								via: [{ identifier: "parent" }],
							},
						],
					}),
					viaCaseTypes: new Map([
						[0, "patient"],
						[1, "patient"],
					]),
				},
			]);
		// A blank name is refused as every case name is, and nothing lands.
		expect(
			(
				await rejection(
					submit(store, {
						appId: APP_ID,
						ordinary: followupOrdinary(),
						operations: facets("   ", "group-a"),
					}),
				)
			).rejection,
		).toMatchObject({ kind: "text-value", facet: "rename" });
		expect((await patientRow(store, HOUSEHOLD_ID))?.case_name).toBe(
			"The household",
		);

		await submit(store, {
			appId: APP_ID,
			ordinary: followupOrdinary(),
			operations: facets("  Renamed household ", "group-a"),
		});
		const household = await patientRow(store, HOUSEHOLD_ID);
		expect(household?.case_name).toBe("Renamed household");
		expect(household?.owner_id).toBe("group-a");
		expect(household?.properties).not.toHaveProperty("case_name");
		expect(household?.properties).not.toHaveProperty("owner_id");
		const own = await patientRow(store, SESSION_CASE_ID);
		expect(own?.case_name).not.toBe("Renamed household");
		expect(own?.owner_id).toBe(ACTOR);
	});

	it("compares edited answers with the opening leaf and writes to the original authorized parent after a relink", async () => {
		const store = makeStore();
		const first = "00000000-0000-7000-8000-000000001001";
		const second = "00000000-0000-7000-8000-000000001002";
		await seedSessionPatient(store);
		await seedPatient(store, first, "First household", { notes: "A" });
		await seedPatient(store, second, "Second household", { notes: "neighbor" });
		const link = (target: string) =>
			submit(store, {
				appId: APP_ID,
				ordinary: { kind: "none" },
				operations: rootProgram([
					envOp(
						operation({
							uuid: OP_A,
							id: "choose_household",
							action: "update",
							caseType: "patient",
							target: { kind: "session" },
							links: [
								{
									identifier: "parent",
									targetType: "patient",
									relationship: "child",
									target: { kind: "expression", expr: term(literal(target)) },
								},
							],
						}),
						{ expressionSnapshotTypes: { links: new Map([[0, "patient"]]) } },
					),
				]),
			});
		const opening = async () => ({
			currentOwnerIds: [ACTOR],
			lookupRows: [],
			cases: await store.readDeviceCaseDatabase({
				appId: APP_ID,
				restoreScope: { ownerIds: [ACTOR] },
			}),
		});
		const missing = await opening();
		await link(first);
		const entered = await opening();
		await link(second);
		await submit(store, {
			appId: APP_ID,
			ordinary: { ...followupOrdinary(), caseIds: [first] },
			operations: {
				...ownProgram("followup", [
					ownOp({ writes: literalWrites({ notes: "B" }) }),
				]),
				sessionCaseIds: [first],
			},
		});
		const visit = (value: string, view: OpeningReadSet) => {
			const own = ownOp({
				writes: [
					{
						property: "notes",
						via: [{ identifier: "parent" }],
						value: term(literal(value)),
						onlyIfChanged: true,
					},
					{ property: "copy", value: term(literal(value)) },
					{ property: "age", value: term(literal("42")), onlyIfChanged: true },
				],
			});
			return submit(store, {
				appId: APP_ID,
				ordinary: followupOrdinary(),
				operations: {
					...ownProgram("followup", [
						{ ...own, viaCaseTypes: new Map([[0, "patient"]]) },
					]),
					openingReads: view,
				},
			});
		};
		await visit("A", entered);
		expect((await patientRow(store, first))?.properties.notes).toBe("B");
		await visit("C", entered);
		expect((await patientRow(store, first))?.properties.notes).toBe("C");
		expect((await patientRow(store, second))?.properties.notes).toBe(
			"neighbor",
		);
		// The case never saved `age`. A device compares the empty leaf as "",
		// which differs from "42", so it saves the answer.
		expect(
			String((await patientRow(store, SESSION_CASE_ID))?.properties.age),
		).toBe("42");
		expect(
			(await rejection(visit("missing", missing))).rejection,
		).toMatchObject({ kind: "target", reason: "missing-connection" });
		await sql`UPDATE cases SET owner_id='other-worker' WHERE app_id=${APP_ID} AND case_id=${first}`.execute(
			dbHandle.db,
		);
		expect(
			(await rejection(visit("inaccessible", entered))).rejection,
		).toMatchObject({ kind: "target", reason: "not-found-or-out-of-scope" });
		expect((await patientRow(store, SESSION_CASE_ID))?.properties.copy).toBe(
			"C",
		);
		// A case this actor's own unsynced submission left on the device is
		// still the device's to write, though the current restore omits it.
		await visit("held", { ...entered, submittedCaseIds: [first] });
		expect((await patientRow(store, first))?.properties.notes).toBe("held");
	});

	it("saves an only-if-changed write only when the answer differs from the case's value", async () => {
		const store = makeStore();
		await seedSessionPatient(store, { notes: "same", age: 30 });
		const before = await patientRow(store, SESSION_CASE_ID);
		const changedOnly = (notes: string, age: string) =>
			ownProgram(
				"followup",
				[
					ownOp({
						writes: [
							{
								property: "notes",
								value: term(formField(KEY_FIELD)),
								onlyIfChanged: true,
							},
							{
								property: "age",
								value: term(formField(FLAG_FIELD)),
								onlyIfChanged: true,
							},
						],
					}),
				],
				{
					formFields: [
						["11111111-1111-4111-8111-111111111111", notes],
						["22222222-2222-4222-8222-222222222222", age],
					],
				},
			);

		// Both answers equal what the case holds, compared as text: nothing
		// is written.
		await submit(store, {
			appId: APP_ID,
			ordinary: followupOrdinary(),
			operations: changedOnly("same", "30"),
		});
		const unchanged = await patientRow(store, SESSION_CASE_ID);
		expect(unchanged?.properties).toEqual(before?.properties);

		await submit(store, {
			appId: APP_ID,
			ordinary: followupOrdinary(),
			operations: changedOnly("different", "30"),
		});
		expect((await patientRow(store, SESSION_CASE_ID))?.properties).toEqual({
			notes: "different",
			age: 30,
		});
	});

	it("saves a rename only when it differs from the name the form opened on, and an owner only when one is given", async () => {
		// HQ's `edit` on `name` compares the casedb `case_name` with the
		// answer, and on `owner_id` a leaf a case holds as an attribute, so
		// "" (`XFormCaseBlock.add_case_updates`, `XPathNodeset.unpack`).
		const store = makeStore();
		await seedSessionPatient(store);
		const entered = {
			currentOwnerIds: [ACTOR],
			lookupRows: [],
			cases: await store.readDeviceCaseDatabase({
				appId: APP_ID,
				restoreScope: { ownerIds: [ACTOR] },
			}),
		};
		// Another submission renames the case after this form opened on "Alice".
		await submit(store, {
			appId: APP_ID,
			ordinary: followupOrdinary(),
			operations: ownProgram("followup", [
				ownOp({ name: term(literal("Bob")) }),
			]),
		});
		const facets = (name: string, owner: string, flagged: boolean) =>
			submit(store, {
				appId: APP_ID,
				ordinary: followupOrdinary(),
				operations: {
					...ownProgram("followup", [
						ownOp({
							name: term(literal(name)),
							owner: term(literal(owner)),
							...(flagged && {
								nameOnlyIfChanged: true as const,
								ownerOnlyIfChanged: true as const,
							}),
						}),
					]),
					openingReads: entered,
				},
			});
		// The answer equals the name the form opened on, and the owner is
		// blank: neither is saved, so the other submission's name stands.
		await facets("Alice", "", true);
		let row = await patientRow(store, SESSION_CASE_ID);
		expect(row?.case_name).toBe("Bob");
		expect(row?.owner_id).toBe(ACTOR);
		// Saved every time, the same answers rename the case and a blank owner
		// is refused, as a blank owner always is.
		expect(
			(await rejection(facets("Alice", "", false))).rejection,
		).toMatchObject({ kind: "text-value", facet: "owner" });
		await facets("Carol", "group-a", true);
		row = await patientRow(store, SESSION_CASE_ID);
		expect(row?.case_name).toBe("Carol");
		expect(row?.owner_id).toBe("group-a");
	});

	it("leaves a new case with no owner where its owner saved only when given is blank", async () => {
		// HQ's build gives the create block `-` beside an `owner_id` update
		// (`autoset_owner_id_for_open_case`), which the update's leaf
		// overwrites only when the answer is given.
		const store = makeStore();
		const register = (name: string, owner: string) =>
			submit(store, {
				appId: APP_ID,
				ordinary: { kind: "none" },
				operations: ownProgram("registration", [
					ownOp({
						name: term(literal(name)),
						owner: term(literal(owner)),
						ownerOnlyIfChanged: true,
					}),
				]),
			});
		await register("Unowned", "");
		await register("Owned", "group-a");
		const patients = await store.query({
			reading: SEARCH_READING,
			appId: APP_ID,
			caseType: "patient",
		});
		const byName = new Map(patients.map((one) => [one.case_name, one]));
		expect(byName.get("Unowned")?.owner_id).toBe("-");
		expect(byName.get("Owned")?.owner_id).toBe("group-a");
	});

	it("updates the acting worker's own record through the worker-record target", async () => {
		const store = makeStore();
		const usercaseBlueprint = buildSimpleBlueprint(
			[
				{
					name: USERCASE_CASE_TYPE,
					properties: [
						{ name: "visits", label: proseText("Visits"), data_type: "text" },
					],
				},
			],
			APP_ID,
		);
		const visitsUuid = testUuid("worker-record-visits-property");
		usercaseBlueprint.userProperties = {
			[visitsUuid]: { uuid: visitsUuid, slug: "visits", label: "Visits" },
		};
		usercaseBlueprint.userPropertyOrder = [visitsUuid];
		const workerSchemas = buildCaseTypeMap(usercaseBlueprint);
		await store.applySchemaChange({
			appId: APP_ID,
			caseType: USERCASE_CASE_TYPE,
			caseTypeSchemas: workerSchemas,
		});
		const WORKER_RECORD_ID = "00000000-0000-7000-8000-00000000eeee";
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: WORKER_RECORD_ID,
				case_type: USERCASE_CASE_TYPE,
				case_name: "Worker one",
				status: "open",
				properties: JSON.stringify({ hq_user_id: ACTOR, visits: "1" }),
			},
		});

		const result = await submit(store, {
			appId: APP_ID,
			ordinary: { kind: "none" },
			operations: {
				...rootProgram(
					[
						envOp(
							operation({
								uuid: OP_A,
								id: "count_visit",
								action: "update",
								caseType: USERCASE_CASE_TYPE,
								target: { kind: "worker-record" },
								writes: [
									{ property: "visits", value: term(formField(KEY_FIELD)) },
								],
							}),
						),
					],
					{
						sessionCaseId: null,
						formFields: [["11111111-1111-4111-8111-111111111111", "2"]],
					},
				),
				caseTypeSchemas: workerSchemas,
			},
		});

		expect(result.operations).toEqual([
			expect.objectContaining({ caseId: WORKER_RECORD_ID, executed: true }),
		]);
		const [record] = await store.query({
			reading: SEARCH_READING,
			appId: APP_ID,
			caseType: USERCASE_CASE_TYPE,
		});
		expect(record?.properties).toEqual({ hq_user_id: ACTOR, visits: "2" });
		expect(result.caseDatabasePatch?.rows.map((row) => row.case_id)).toEqual([
			WORKER_RECORD_ID,
		]);

		// The case type or spelling of a source ID cannot turn another worker’s
		// record into an eligible target. Exercise each conjunct separately.
		const writeById = (caseId: string, property = "visits") =>
			submit(store, {
				appId: APP_ID,
				ordinary: { kind: "none" },
				operations: {
					...rootProgram(
						[
							envOp(
								operation({
									uuid: OP_A,
									id: "update_by_id",
									action: "update",
									caseType: USERCASE_CASE_TYPE,
									target: { kind: "expression", expr: term(literal(caseId)) },
									writes: [{ property, value: term(literal("3")) }],
								}),
								{
									expressionSnapshotTypes: {
										target: USERCASE_CASE_TYPE,
										links: new Map(),
									},
								},
							),
						],
						{ sessionCaseId: null },
					),
					caseTypeSchemas: workerSchemas,
				},
			});
		expect((await writeById(WORKER_RECORD_ID)).operations).toEqual([
			expect.objectContaining({ caseId: WORKER_RECORD_ID, executed: true }),
		]);
		for (const property of [
			"hq_user_id",
			"username",
			"undeclared_profile_value",
		]) {
			expect(
				(await rejection(writeById(WORKER_RECORD_ID, property))).rejection,
			).toMatchObject({
				kind: "target",
				reason: "managed-worker-record",
				slot: "write:0",
			});
		}
		const [unchangedProfile] = await store.query({
			reading: SEARCH_READING,
			appId: APP_ID,
			caseType: USERCASE_CASE_TYPE,
		});
		expect(unchangedProfile?.properties).toEqual({
			hq_user_id: ACTOR,
			visits: "3",
		});
		for (const [owner, profile, status] of [
			["another-worker", ACTOR, "open"],
			[ACTOR, "another-worker", "open"],
			[ACTOR, ACTOR, "closed"],
		] as const) {
			const other = await makeStore(PROJECT_A, ACTOR, owner).insert({
				appId: APP_ID,
				row: {
					case_type: USERCASE_CASE_TYPE,
					case_name: "Other record",
					status,
					properties: JSON.stringify({ hq_user_id: profile, visits: "1" }),
				},
			});
			expect(
				(await rejection(writeById(other.caseId))).rejection,
			).toMatchObject({
				kind: "target",
				reason: "not-found-or-out-of-scope",
			});
			const held = await (dbHandle.db as Kysely<Database>)
				.selectFrom("cases")
				.select("properties")
				.where("case_id", "=", other.caseId)
				.where("app_id", "=", APP_ID)
				.executeTakeFirstOrThrow();
			expect(held.properties).toMatchObject({ visits: "1" });
		}
	});
});

// ---------------------------------------------------------------
// One envelope's selection
// ---------------------------------------------------------------

describe("combined submission", () => {
	it("a missing session anchor rejects the operation-only envelope", async () => {
		const store = makeStore();

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
	it("includes the worker record its update writes and replays its accepted state after a later write", async () => {
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
				status: "open",
				properties: JSON.stringify({ hq_user_id: ACTOR, role: "nurse" }),
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
			operations: {
				...rootProgram(
					[
						envOp(
							operation({
								uuid: OP_A,
								id: "worker_role",
								action: "update",
								caseType: USERCASE_CASE_TYPE,
								target: { kind: "worker-record" },
								writes: literalWrites({ role: "supervisor" }),
							}),
						),
					],
					{ sessionCaseId: null },
				),
				caseTypeSchemas: buildCaseTypeMap(usercaseBlueprint),
			},
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
			hq_user_id: ACTOR,
			role: "supervisor",
		});
		const current = await store.query({
			reading: SEARCH_READING,
			appId: APP_ID,
			caseType: USERCASE_CASE_TYPE,
		});
		expect(current[0]?.properties).toEqual({
			hq_user_id: ACTOR,
			role: "director",
		});
	});
});

// ---------------------------------------------------------------
// Durable submission receipts
// ---------------------------------------------------------------

describe("durable text-only submission receipt", () => {
	it("claims the first registration, replays it without reallocating cases, and rejects a changed digest", async () => {
		const store = makeStore();
		const receipt: SubmissionReceiptClaim = {
			entryKey: "text-registration-entry",
			formUuid: FORM_UUID,
			expectedAppMutationSeq: 0,
			blueprintDigest: "0".repeat(64),
			requestDigest: "text-registration-request",
		};
		const location = { latitude: 12, longitude: -73, altitude: 7, accuracy: 4 };
		const first = await submit(store, {
			submissionLocation: location,
			appId: APP_ID,
			submissionReceipt: receipt,
			ordinary: { kind: "registration" },
			operations: ownProgram("registration", [
				ownOp({
					name: term(literal("First registration")),
					writes: literalWrites({ notes: "accepted" }),
				}),
			]),
		});

		const replay = await submit(store, {
			appId: APP_ID,
			submissionReceipt: receipt,
			ordinary: { kind: "registration" },
			operations: ownProgram("registration", [
				ownOp({
					name: term(literal("must not run")),
					writes: literalWrites({ notes: "must not run" }),
				}),
			]),
		});
		expect(first.submissionLocation).toEqual(location);
		expect(replay).toEqual(first);
		expect(first.primaryCaseIds).toEqual([expect.any(String)]);
		const primaryCaseId = first.primaryCaseIds[0];
		expect(primaryCaseId).toBeDefined();
		const patients = await store.query({
			reading: SEARCH_READING,
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
				ordinary: { kind: "registration" },
				operations: ownProgram("registration", [
					ownOp({
						name: term(literal("must not run")),
					}),
				]),
			}),
		).rejects.toBeInstanceOf(CaptureSubmissionRejectedError);
		expect(
			await store.query({
				reading: SEARCH_READING,
				appId: APP_ID,
				caseType: "patient",
			}),
		).toHaveLength(1);
	});

	it("serializes concurrent first requests and allocates one generated advanced create", async () => {
		const store = makeStore();
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

		const pool = new Pool({ connectionString: dbHandle.uri, max: 3 });
		const errors: Error[] = [];
		pool.on("error", (error) => errors.push(error));
		const db = new Kysely<Database>({
			dialect: new PostgresDialect({ pool: pool as unknown as PostgresPool }),
		});
		const gate = new Client({ connectionString: dbHandle.uri });
		const pending: Promise<PromiseSettledResult<unknown>[]>[] = [];
		try {
			await gate.connect();
			const scope = `nova-form-attachment-entry:${APP_ID}:${ACTOR}:${receipt.entryKey}`;
			await gate.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [
				scope,
			]);
			const concurrentStore = makeStore(PROJECT_A, ACTOR, ACTOR, db);
			const work = Promise.allSettled([
				submit(concurrentStore, args),
				submit(concurrentStore, args),
			]);
			pending.push(work);
			await vi.waitFor(async () => {
				const waiters = await gate.query<{
					count: number;
				}>(`SELECT count(*)::int AS count FROM pg_stat_activity
                    WHERE datname=current_database() AND cardinality(pg_blocking_pids(pid))>0`);
				expect(waiters.rows[0]?.count).toBe(2);
			});
			await gate.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
				scope,
			]);
			const results = (await work).map((result) => {
				if (result.status === "rejected") throw result.reason;
				return result.value;
			});
			const [first, retry] = results;
			expect(retry).toEqual(first);
			expect(first.operations).toHaveLength(1);
			expect(
				await store.query({
					reading: SEARCH_READING,
					appId: APP_ID,
					caseType: "visit",
				}),
			).toEqual([
				expect.objectContaining({
					case_id: first.operations[0]?.caseId,
					case_name: "Generated visit",
				}),
			]);
			const receipts = await dbHandle.pool.query(
				"SELECT entry_key FROM form_submission_intents WHERE app_id=$1",
				[APP_ID],
			);
			expect(receipts.rows).toEqual([{ entry_key: receipt.entryKey }]);
		} finally {
			await gate.end();
			await Promise.all(pending);
			await db.destroy();
		}
		expect(errors).toEqual([]);
	});

	it("rolls back an uncompleted receipt and every earlier case effect", async () => {
		const store = makeStore();
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
				ordinary: { kind: "registration" },
				operations: ownProgram("registration", [
					ownOp({
						name: term(literal("must roll back")),
						writes: literalWrites({ notes: "must roll back" }),
					}),
					envOp(
						operation({
							uuid: OP_B,
							id: "invalid_child",
							action: "create",
							caseType: "visit",
							target: { kind: "new" },
							name: term(literal("invalid child")),
							writes: literalWrites({ unknown: "reject" }),
							links: [
								{
									identifier: "parent",
									targetType: "patient",
									target: { kind: "op", opUuid: OWN_UUID },
									relationship: "child",
								},
							],
						}),
					),
				]),
			}),
		).rejects.toBeInstanceOf(CasePropertiesValidationError);

		expect(
			await store.query({
				reading: SEARCH_READING,
				appId: APP_ID,
				caseType: "patient",
			}),
		).toHaveLength(0);
		expect(
			await store.query({
				reading: SEARCH_READING,
				appId: APP_ID,
				caseType: "visit",
			}),
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
		await seedSessionPatient(store);
		const args = {
			appId: APP_ID,
			ordinary: followupOrdinary(),
			operations: ownProgram("followup", [
				ownOp({ writes: literalWrites({ notes: "accepted" }) }),
			]),
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
			ordinary: followupOrdinary(),
			operations: ownProgram("followup", [
				ownOp({ writes: literalWrites({ notes: "must not replay" }) }),
			]),
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
				ordinary: followupOrdinary(),
				operations: ownProgram("followup", [
					ownOp({ writes: literalWrites({ notes: "must not replay" }) }),
				]),
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

		const err = await rejection(
			submit(store, {
				appId: APP_ID,
				ordinary: followupOrdinary(),
				operations: ownProgram("followup", [
					ownOp({ writes: literalWrites({ notes: "never lands" }) }),
				]),
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
// A date and time saved to a case
// ---------------------------------------------------------------

describe("a date and time saved to a case", () => {
	const SEEN_FIELD = testUuid("seen-at-field");
	const seenWrite = (): CaseOperationWrite[] => [
		{ property: "seen_at", value: term(formField(SEEN_FIELD)) },
	];

	it.for([
		// A wall clock entered in Nairobi (+03:00).
		["2026-01-02T12:30:00.000", "2026-01-02T09:30:00.000000Z"],
		// The device's own spelling of the same moment.
		["2026-01-02T12:30:00.000+03:00", "2026-01-02T09:30:00.000000Z"],
		// Text CommCare HQ already stored, kept exactly.
		["2026-01-02T09:30:00.123456Z", "2026-01-02T09:30:00.123456Z"],
	] as const)(
		"stores %s as CommCare HQ stores its moment, never in the viewer's offset",
		async ([answer, stored]) => {
			const store = makeStore();
			await seedSessionPatient(store);
			await submit(store, {
				appId: APP_ID,
				ordinary: followupOrdinary(),
				operations: {
					...ownProgram("followup", [ownOp({ writes: seenWrite() })], {
						formFields: [["seen-at-field", answer]],
					}),
					formFieldTypes: new Map([[SEEN_FIELD, "datetime"]]),
					viewerTimeZone: "Africa/Nairobi",
				},
			});
			const row = await patientRow(store, SESSION_CASE_ID);
			expect(row?.properties.seen_at).toBe(stored);
		},
	);

	// A date-and-time question saved to a `date` property keeps its day where
	// the device is (`Recalculate.wrapData` wraps the moment as `DateData`):
	// late evening in Los Angeles is already the next day in UTC.
	it.for([
		["2026-01-02T23:30:00.000", "2026-01-02"],
		["2026-01-02T23:30:00.000-08:00", "2026-01-02"],
		["2026-01-03T07:30:00.000Z", "2026-01-02"],
	] as const)(
		"stores %s saved to a day as its day in the viewer's zone",
		async ([answer, stored]) => {
			const store = makeStore();
			await seedSessionPatient(store);
			await submit(store, {
				appId: APP_ID,
				ordinary: followupOrdinary(),
				operations: {
					...ownProgram(
						"followup",
						[
							ownOp({
								writes: [
									{ property: "seen_on", value: term(formField(SEEN_FIELD)) },
								],
							}),
						],
						{ formFields: [["seen-at-field", answer]] },
					),
					formFieldTypes: new Map([[SEEN_FIELD, "datetime"]]),
					viewerTimeZone: "America/Los_Angeles",
				},
			});
			const row = await patientRow(store, SESSION_CASE_ID);
			expect(row?.properties.seen_on).toBe(stored);
		},
	);
});

// ---------------------------------------------------------------
// The keys CommCare HQ's server stores apart from a case's properties
// ---------------------------------------------------------------

// HQ's server applies a block's `<update>` key by key
// (`update_strategy.py::SqlCaseUpdateStrategy._apply_update_action`):
// `location_id` sets the case's location column and is no property, and
// `hq_user_id` is a property whose value it also copies into the external id,
// after the block's known keys (`external_id` among them). A device applies
// both as properties alone (`CaseXmlParser.updateCase`), so until its next
// sync it keeps its own external id. The plausible failures: the location
// saved as a JSONB property, the copy missing from the stored external id, or
// the submission's device patch showing the server's copy before a sync.
describe("location_id and hq_user_id", () => {
	const update = (writes: CaseOperationWrite[]) =>
		rootProgram([envOp(operation({ uuid: OP_A, writes }))]);
	const text = (value: string) => term(literal(value));

	it("stores the location in its column and copies hq_user_id into the external id the device keeps", async () => {
		const store = makeStore();
		await seedSessionPatient(store);
		await store.update({
			appId: APP_ID,
			caseId: SESSION_CASE_ID,
			patch: { external_id: "before" },
		});

		const result = await submit(store, {
			appId: APP_ID,
			ordinary: { kind: "none" },
			operations: update([
				{ property: "location_id", value: text("district-7") },
				{ property: "hq_user_id", value: text("worker-9") },
			]),
		});

		const row = await patientRow(store, SESSION_CASE_ID);
		expect(row?.location_id).toBe("district-7");
		expect(row?.properties).not.toHaveProperty("location_id");
		expect(row?.properties).toMatchObject({ hq_user_id: "worker-9" });
		expect(row?.external_id).toBe("worker-9");
		const patched = result.caseDatabasePatch?.rows.find(
			(one) => one.case_id === SESSION_CASE_ID,
		);
		expect(patched?.external_id).toBe("before");
		expect(patched?.location_id).toBe("district-7");
		expect(patched?.properties).toMatchObject({ hq_user_id: "worker-9" });

		const found = await store.query({
			reading: SEARCH_READING,
			appId: APP_ID,
			caseType: "patient",
			predicate: eq(prop("patient", "location_id"), literal("district-7")),
		});
		expect(found.map((one) => one.case_id)).toEqual([SESSION_CASE_ID]);
	});

	it("keeps the block's own external_id on the device and the hq_user_id copy on the server", async () => {
		const store = makeStore();
		await seedSessionPatient(store);

		const result = await submit(store, {
			appId: APP_ID,
			ordinary: { kind: "none" },
			operations: update([
				{ property: "external_id", value: text("written") },
				{ property: "hq_user_id", value: text("copied") },
			]),
		});

		expect((await patientRow(store, SESSION_CASE_ID))?.external_id).toBe(
			"copied",
		);
		expect(
			result.caseDatabasePatch?.rows.find(
				(one) => one.case_id === SESSION_CASE_ID,
			)?.external_id,
		).toBe("written");
	});

	it("gives a created case the hq_user_id copy on the server and no external id on the device", async () => {
		const store = makeStore();
		const result = await submit(store, {
			appId: APP_ID,
			ordinary: { kind: "none" },
			operations: rootProgram(
				[
					envOp(
						operation({
							uuid: OP_A,
							action: "create",
							target: { kind: "new" },
							name: text("Bea"),
							writes: [
								{ property: "hq_user_id", value: text("worker-3") },
								{ property: "location_id", value: text("") },
							],
						}),
					),
				],
				{ sessionCaseId: null },
			),
		});
		const created = result.operations[0]?.caseId;
		if (created === undefined) throw new Error("The create ran.");
		const row = await patientRow(store, created);
		expect(row?.external_id).toBe("worker-3");
		// A blank location is a real blank write, which reads as blank.
		expect(row?.location_id).toBe("");
		const patched = result.caseDatabasePatch?.rows.find(
			(one) => one.case_id === created,
		);
		expect(patched?.external_id).toBeNull();
	});

	it("rejects a location past 255 characters before any effect", async () => {
		const store = makeStore();
		await seedSessionPatient(store);
		const err = await rejection(
			submit(store, {
				appId: APP_ID,
				ordinary: { kind: "none" },
				operations: update([
					{ property: "notes", value: text("changed") },
					{ property: "location_id", value: text("x".repeat(256)) },
				]),
			}),
		);
		expect(err.rejection).toMatchObject({
			kind: "text-value",
			facet: "location_id",
			reason: "too-long",
		});
		const row = await patientRow(store, SESSION_CASE_ID);
		expect(row?.location_id).toBeNull();
		expect(row?.properties).toMatchObject({ notes: "original" });
	});

	it("keeps the hq_user_id copy on a parent written through an index, whatever the authored order", async () => {
		// HQ's build gathers a form's writes through `parent` into one block,
		// so the copy lands after the block's known `external_id`.
		const store = makeStore();
		const parent = "00000000-0000-7000-8000-000000004601";
		await seedSessionPatient(store);
		await seedPatient(store, parent, "Household");
		await submit(store, {
			appId: APP_ID,
			ordinary: { kind: "none" },
			operations: rootProgram([
				envOp(
					operation({
						uuid: OP_A,
						id: "link_household",
						action: "update",
						caseType: "patient",
						target: { kind: "session" },
						links: [
							{
								identifier: "parent",
								targetType: "patient",
								relationship: "child",
								target: { kind: "expression", expr: text(parent) },
							},
						],
					}),
					{ expressionSnapshotTypes: { links: new Map([[0, "patient"]]) } },
				),
			]),
		});
		const opening = {
			currentOwnerIds: [ACTOR],
			lookupRows: [],
			cases: await store.readDeviceCaseDatabase({
				appId: APP_ID,
				restoreScope: { ownerIds: [ACTOR] },
			}),
		};
		const own = ownOp({
			writes: [
				{
					property: "hq_user_id",
					via: [{ identifier: "parent" }],
					value: text("worker-7"),
				},
				{
					property: "external_id",
					via: [{ identifier: "parent" }],
					value: text("explicit"),
				},
			],
		});
		await submit(store, {
			appId: APP_ID,
			ordinary: followupOrdinary(),
			operations: {
				...ownProgram("followup", [
					{
						...own,
						viaCaseTypes: new Map([
							[0, "patient"],
							[1, "patient"],
						]),
					},
				]),
				openingReads: opening,
			},
		});
		const row = await patientRow(store, parent);
		expect(row?.external_id).toBe("worker-7");
		expect(row?.properties).toMatchObject({ hq_user_id: "worker-7" });
	});
});

// One choice saved to a list of choices: the writers agree on the list
// (`ruleSets.ts::isValueStorageAssignable`), and the stored list is the one a
// device reads from the text it stores, the values split on spaces. The
// plausible failure: the scalar refused at storage, or stored as one string a
// several-choice read takes apart differently.
describe("a single choice saved to a list of choices", () => {
	it("stores the choice as a one-element list and a blank one as nothing", async () => {
		const store = makeStore();
		await seedSessionPatient(store, { notes: "original", meds: ["old"] });
		await submit(store, {
			appId: APP_ID,
			ordinary: { kind: "none" },
			operations: rootProgram([
				envOp(
					operation({
						uuid: OP_A,
						writes: [{ property: "meds", value: term(literal("aspirin")) }],
					}),
				),
			]),
		});
		expect(
			(await patientRow(store, SESSION_CASE_ID))?.properties,
		).toMatchObject({ meds: ["aspirin"] });
		await submit(store, {
			appId: APP_ID,
			ordinary: { kind: "none" },
			operations: rootProgram([
				envOp(
					operation({
						uuid: OP_A,
						writes: [{ property: "meds", value: term(literal("")) }],
					}),
				),
			]),
		});
		expect(
			(await patientRow(store, SESSION_CASE_ID))?.properties,
		).not.toHaveProperty("meds");
	});
});
