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

import type { Kysely } from "kysely";
import { beforeEach, describe, expect, it } from "vitest";
import { asUuid, type CaseOperation, type CaseType } from "@/lib/domain";
import {
	actingUser,
	eq,
	formField,
	literal,
	prop,
	term,
	unowned,
} from "@/lib/domain/predicate";
import { buildSimpleBlueprint } from "../../__tests__/fixtures/simpleBlueprint";
import {
	CaseNotFoundError,
	CasePropertiesValidationError,
	SubmissionRejectedError,
} from "../../errors";
import { runCaseStoreMigrations } from "../../migrate";
import { HeuristicCaseGenerator } from "../../sample/heuristic";
import { setupPerTestDatabase } from "../../sql/__tests__/perTestDatabase";
import type { Database } from "../../sql/database";
import { buildCaseTypeMap } from "../../store";
import type {
	CaseOperationProgram,
	EnvelopeCaseOperation,
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
});

// `test-app` + the fixed form/operation uuids below reproduce the
// EXACT namespace tuple the domain identity suite pins, so the stored
// id can be asserted against the same literal UUIDv5 vector the XForm
// calculate implements.
const APP_ID = "test-app";
const PROJECT_A = "project-a";
const PROJECT_B = "project-b";
const ACTOR = "worker-1";
const FORM_UUID = asUuid("66666666-6666-4666-8666-666666666666");
const VECTOR_OP_UUID = asUuid("44444444-4444-4444-8444-444444444444");
const PINNED_VECTOR_PREFIX =
	"nova-case-v1:9ac52723-445f-54a7-8c1b-7e90c985637b:";

const OP_A = asUuid("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
const OP_B = asUuid("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
const OP_C = asUuid("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
const REPEAT_UUID = asUuid("99999999-9999-4999-8999-999999999999");
const KEY_FIELD = asUuid("11111111-1111-4111-8111-111111111111");
const FLAG_FIELD = asUuid("22222222-2222-4222-8222-222222222222");
const MEDS_FIELD = asUuid("33333333-3333-4333-8333-333333333333");

const SESSION_CASE_ID = "00000000-0000-7000-8000-00000000aaaa";

const PATIENT: CaseType = {
	name: "patient",
	properties: [
		{ name: "notes", label: "Notes", data_type: "text" },
		{ name: "copy", label: "Copy", data_type: "text" },
		{ name: "age", label: "Age", data_type: "int" },
		{ name: "meds", label: "Meds", data_type: "multi_select" },
	],
};
// Identical property shape to `patient` — the wirePortable retype
// destination (exact retained JSON property types, nothing parked).
const PATIENT_V2: CaseType = {
	name: "patient_v2",
	properties: PATIENT.properties,
};
const VISIT: CaseType = {
	name: "visit",
	properties: [{ name: "outcome", label: "Outcome", data_type: "text" }],
};
// Declares only `notes` — a patient row carrying `age` cannot retype
// here without parking, so the wirePortable runtime check rejects it.
const NARROW: CaseType = {
	name: "narrow",
	properties: [{ name: "notes", label: "Notes", data_type: "text" }],
};

const ALL_TYPES = [PATIENT, PATIENT_V2, VISIT, NARROW];
const SCHEMAS = buildCaseTypeMap(buildSimpleBlueprint(ALL_TYPES, APP_ID));

function makeStore(projectId = PROJECT_A, actorUserId = ACTOR) {
	return new PostgresCaseStore({
		projectId,
		actorUserId,
		db: dbHandle.db as unknown as Kysely<Database>,
		sampleGenerator: new HeuristicCaseGenerator(),
	});
}

async function seedSchemas(store: PostgresCaseStore): Promise<void> {
	for (const caseType of ALL_TYPES) {
		await store.applySchemaChange({
			appId: APP_ID,
			caseType: caseType.name,
			caseTypeSchemas: SCHEMAS,
		});
	}
}

async function seedSessionPatient(
	store: PostgresCaseStore,
	properties: Record<string, unknown> = { notes: "original" },
): Promise<void> {
	await store.insert({
		appId: APP_ID,
		row: {
			case_id: SESSION_CASE_ID,
			case_type: "patient",
			case_name: "Alice",
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
							(opts?.formFields ?? []).map(([k, v]) => [asUuid(k), v]),
						),
					},
				],
			},
		],
		...(sessionCaseId === undefined ? {} : { sessionCaseId }),
		caseTypeSchemas: SCHEMAS,
	};
}

function followupOrdinary(patchProperties: Record<string, unknown> = {}): {
	kind: "followup";
	caseId: string;
	caseType: string;
	patch: { properties: Record<string, never> };
	children: [];
} {
	return {
		kind: "followup",
		caseId: SESSION_CASE_ID,
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

		await store.applySubmission({
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
			store.applySubmission({
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
			store.applySubmission({
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
		const submit = (name: string, notes: string) =>
			store.applySubmission({
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
								writes: [{ property: "outcome", value: term(literal(notes)) }],
							}),
						),
					],
					{ formFields: [[KEY_FIELD, "repeat-key"]], sessionCaseId: null },
				),
			});

		await submit("First", "started");
		await submit("Second", "finished");

		// One row, the retry's facets applied over it — the same merge
		// Core and HQ perform for a create naming a known id.
		const visits = await store.query({ appId: APP_ID, caseType: "visit" });
		expect(visits).toHaveLength(1);
		expect(visits[0]?.case_id).toBe(`${PINNED_VECTOR_PREFIX}repeat-key`);
		expect(visits[0]?.case_name).toBe("Second");
		expect(visits[0]?.properties).toMatchObject({ outcome: "finished" });
	});

	it("carries a non-UUID authored id through update, link, and close", async () => {
		const store = makeStore();
		await seedSchemas(store);
		await seedSessionPatient(store);
		const authoredId = `${PINNED_VECTOR_PREFIX}url unsafe/&?id`;

		await store.applySubmission({
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
		await store.applySubmission({
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
			store.applySubmission({
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
			store.applySubmission({
				appId: APP_ID,
				ordinary: {
					kind: "close",
					caseId: SESSION_CASE_ID,
					caseType: "patient",
					patch: { properties: { notes: "final" } },
					children: [
						{
							caseType: "visit",
							caseName: "Bad child",
							// `outcome` is text; an unknown property fails the
							// schema's additionalProperties check.
							properties: { unknown_property: "boom" },
							parentCaseId: SESSION_CASE_ID,
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

// ---------------------------------------------------------------
// Pre-submission snapshot semantics
// ---------------------------------------------------------------

describe("pre-submission snapshot", () => {
	it("every expression evaluates against pre-effect values", async () => {
		const store = makeStore();
		await seedSchemas(store);
		await seedSessionPatient(store, { notes: "original" });

		await store.applySubmission({
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
// Conditions and guards
// ---------------------------------------------------------------

describe("conditions", () => {
	it("a false condition skips the operation and its guarded consumers", async () => {
		const store = makeStore();
		await seedSchemas(store);
		const condition = eq(formField(FLAG_FIELD), literal("yes"));

		const result = await store.applySubmission({
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

	it("a true condition executes the chain", async () => {
		const store = makeStore();
		await seedSchemas(store);
		const condition = eq(formField(FLAG_FIELD), literal("yes"));

		const result = await store.applySubmission({
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

		await store.applySubmission({
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
		await seedSchemas(storeB);
		const foreign = await storeB.insert({
			appId: APP_ID,
			row: {
				case_type: "patient",
				case_name: "Foreign",
				status: "open",
				properties: "{}",
			},
		});

		const storeA = makeStore();
		const err = await rejection(
			storeA.applySubmission({
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
			store.applySubmission({
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
			store.applySubmission({
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
			store.applySubmission({
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
			store.applySubmission({
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
			store.applySubmission({
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

	it("merges duplicate repeat keys without a type transition", async () => {
		const store = makeStore();
		await seedSchemas(store);

		const result = await store.applySubmission({
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
			store.applySubmission({
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
			store.applySubmission({
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
			store.applySubmission({
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

		await store.applySubmission({
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
});

// ---------------------------------------------------------------
// Owner semantics
// ---------------------------------------------------------------

describe("owner stamping", () => {
	it("defaults a create's owner to the acting user and honors unowned", async () => {
		const store = makeStore();
		await seedSchemas(store);

		await store.applySubmission({
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

	it("writes an explicit update owner and resolves acting-user in write values", async () => {
		const store = makeStore();
		await seedSchemas(store);
		await seedSessionPatient(store);

		await store.applySubmission({
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
		expect(row?.properties).toMatchObject({ notes: ACTOR });
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

		await store.applySubmission({
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

	it("rejects a retype whose retained document the destination schema cannot hold", async () => {
		const store = makeStore();
		await seedSchemas(store);
		// `age` survives the retype but `narrow` declares only `notes` —
		// executing it would need parking, which the wirePortable subset
		// forbids.
		await seedSessionPatient(store, { notes: "kept", age: 30 });

		const err = await rejection(
			store.applySubmission({
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

		const first = await store.applySubmission({
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
		await store.applySubmission({
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

		await store.applySubmission({
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

		await store.applySubmission({
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

		await store.applySubmission({
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

		const result = await store.applySubmission({
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

		expect(result.primaryCaseId).toBe(SESSION_CASE_ID);
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

		await expect(
			store.applySubmission({
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
		).rejects.toThrow(CaseNotFoundError);
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

	it("suffixes an offset-less pg time as UTC, keeping explicit offsets", () => {
		expect(storageValueFromEvaluation("05:12:11", "time")).toBe("05:12:11Z");
		expect(storageValueFromEvaluation("05:12:11+02:00", "time")).toBe(
			"05:12:11+02:00",
		);
	});

	it("keeps numerics typed and coerces pg's numeric-string decimals", () => {
		expect(storageValueFromEvaluation(30, "int")).toBe(30);
		expect(storageValueFromEvaluation("2.5", "decimal")).toBe(2.5);
	});

	it("maps SQL NULL to the wire's blank for text-family destinations", () => {
		expect(storageValueFromEvaluation(null, "text")).toBe("");
		expect(storageValueFromEvaluation(null, "single_select")).toBe("");
		expect(storageValueFromEvaluation(null, "multi_select")).toEqual([]);
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
