// Submission-program acceptance: the ENGINE's collected answers flow
// through the PURE program builder into the REAL storage executor —
// proving the production supplier produces executor-compatible programs
// over a real committed-doc shape. Covers the absent-value matrix
// (blank answer → absent JSONB key; blank authored key → typed
// whole-rollback rejection) and effect ordering (iteration-major
// repeat expansion; the ordinary action landing LAST with its
// caseType folded into the rolling proof).

import { type Kysely, sql } from "kysely";
import { beforeEach, describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { CaseStore, LookupTableSchemas } from "@/lib/case-store";
import { buildCaseTypeMap } from "@/lib/case-store";
import {
	CaptureSubmissionRejectedError,
	SubmissionRejectedError,
} from "@/lib/case-store/errors";
import { PostgresCaseStore } from "@/lib/case-store/postgres/store";
import { HeuristicCaseGenerator } from "@/lib/case-store/sample/heuristic";
import { setupPerTestDatabase } from "@/lib/case-store/sql/__tests__/perTestDatabase";
import type { Database } from "@/lib/case-store/sql/database";
import type {
	BlueprintDoc,
	CaseOperation,
	LookupColumnId,
	LookupTableId,
	Uuid,
} from "@/lib/domain";
import {
	eq,
	formField,
	literal,
	matchNone,
	tableColumn,
	tableLookup,
	term,
} from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";
import { buildDoc, caseListConfig, f } from "../../../__tests__/docHelpers";
import { validateCaptureSubmissionProjection } from "../captureSubmissionValidation";
import {
	buildCaseOperationProgramFromDoc,
	buildSubmissionReceiptIdentity,
	submissionEnvelopeArgs,
} from "../caseDataBindingHelpers";
import type { SubmissionMutation } from "../caseDataBindingTypes";
import { FormEngine, type FormEngineInput } from "../formEngine";
import type { ResolvedPreviewIdentity } from "../identity";

const dbHandle = setupPerTestDatabase({
	schema: "migrated",
	databaseNamePrefix: "program_acceptance_",
});

beforeEach(async () => {
	// Case rows are structurally tenant-bound to their authoritative app row.
	// Establish the real `(app, Project)` parent before materializing schemas
	// or data; bypassing it would exercise a state production cannot represent.
	await sql`
		INSERT INTO apps (id, owner, project_id, app_name, app_name_lower)
		VALUES (
			${APP_ID},
			${ACTOR},
			${PROJECT},
			'Submission program acceptance',
			'submission program acceptance'
		)
	`.execute(dbHandle.db);
});

const APP_ID = "app-program-acceptance";
const PROJECT = "project-acceptance";
const ACTOR = "worker-1";
const SESSION_CASE = "50000000-0000-0000-0000-000000000001";
const SECOND_SESSION_CASE = "50000000-0000-0000-0000-000000000002";
const ENTRY_KEY = "11111111-1111-4111-8111-111111111111";

const IDENTITY: ResolvedPreviewIdentity = {
	actorUserId: ACTOR,
	ownerId: ACTOR,
	session: {
		context: { userid: ACTOR, username: "ada" },
		user: { role: "supervisor" },
		userPropertySlugs: {},
	},
	usercase: { role: "supervisor" },
};

function makeStore(): CaseStore {
	return new PostgresCaseStore({
		projectId: PROJECT,
		actorUserId: ACTOR,
		ownerId: ACTOR,
		db: dbHandle.db as unknown as Kysely<Database>,
		sampleGenerator: new HeuristicCaseGenerator(),
	});
}

const OP_ROOT = testUuid("60000000-0000-7000-8000-00000000a001");
const OP_REPEAT = testUuid("60000000-0000-7000-8000-00000000a002");
const LOOKUP_TABLE = "70000000-0000-7000-8000-000000000001" as LookupTableId;
const LOOKUP_COLUMN = "70000000-0000-7000-8000-000000000002" as LookupColumnId;

/** One followup doc: an external-id writer (ordinary), a free root answer, and
 *  a repeat of visit notes — with `operations` built from the minted
 *  field uuids per test. */
function acceptanceDoc(
	operationsFor: (uuids: {
		externalCode: Uuid;
		note: Uuid;
		extra: Uuid;
		visits: Uuid;
		visitNote: Uuid;
	}) => CaseOperation[],
): {
	doc: BlueprintDoc;
	formUuid: Uuid;
	uuids: {
		externalCode: Uuid;
		note: Uuid;
		extra: Uuid;
		visits: Uuid;
		visitNote: Uuid;
	};
} {
	const doc = buildDoc({
		appName: "Acceptance",
		caseTypes: [
			{
				name: "patient",
				properties: [
					{
						name: "op_status",
						label: proseText("Op status"),
						data_type: "text",
					},
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
				uuid: "60000000-0000-4000-8000-00000000a010",
				name: "Mod",
				caseType: "patient",
				forms: [
					{
						uuid: "60000000-0000-4000-8000-00000000a011",
						name: "Follow up",
						type: "followup",
						fields: [
							f({
								kind: "text",
								id: "external_code",
								label: proseText("External code"),
								caseWrite: {
									caseType: "patient",
									property: "external_id",
								},
							}),
							f({ kind: "text", id: "note", label: proseText("Note") }),
							f({ kind: "text", id: "extra", label: proseText("Extra") }),
							f({
								kind: "repeat",
								id: "visits",
								label: proseText("Visits"),
								children: [
									f({
										kind: "text",
										id: "visit_note",
										label: proseText("Visit note"),
									}),
								],
							}),
						],
					},
				],
			},
		],
	});
	const formUuid = Object.keys(doc.forms)[0] as Uuid;
	const byId = new Map(
		Object.values(doc.fields).map((field) => [field.id, field.uuid]),
	);
	const uuids = {
		externalCode: byId.get("external_code") as Uuid,
		note: byId.get("note") as Uuid,
		extra: byId.get("extra") as Uuid,
		visits: byId.get("visits") as Uuid,
		visitNote: byId.get("visit_note") as Uuid,
	};
	const form = doc.forms[formUuid];
	return {
		doc: {
			...doc,
			forms: {
				...doc.forms,
				[formUuid]: { ...form, caseOperations: operationsFor(uuids) },
			},
		},
		formUuid,
		uuids,
	};
}

function conditionalCloseDoc(): {
	doc: BlueprintDoc;
	formUuid: Uuid;
	conditionFieldUuid: Uuid;
} {
	const baseList = caseListConfig([]);
	const doc = buildDoc({
		appName: "Conditional batch close",
		caseTypes: [{ name: "patient", properties: [] }],
		modules: [
			{
				uuid: "60000000-0000-4000-8000-00000000a020",
				name: "Patients",
				caseType: "patient",
				caseListConfig: {
					...baseList,
					selection: { kind: "multiple", maximum: 4 },
				},
				forms: [
					{
						uuid: "60000000-0000-4000-8000-00000000a021",
						name: "Close patients",
						type: "close",
						closeCondition: { field: "close_when", answer: "done" },
						fields: [
							f({
								kind: "text",
								id: "close_when",
								label: proseText("Close when"),
							}),
						],
					},
				],
			},
		],
	});
	const formUuid = Object.keys(doc.forms)[0] as Uuid;
	const conditionFieldUuid = Object.values(doc.fields).find(
		(field) => field.id === "close_when",
	)?.uuid;
	if (conditionFieldUuid === undefined) {
		throw new Error("Conditional-close fixture is missing close_when.");
	}
	return { doc, formUuid, conditionFieldUuid };
}

function ordinaryAuthorityDoc(): {
	doc: BlueprintDoc;
	formUuid: Uuid;
} {
	const doc = buildDoc({
		appName: "Ordinary write authority",
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "age", label: proseText("Age"), data_type: "int" },
					{ name: "nickname", label: proseText("Nickname") },
				],
			},
			{
				name: "visit",
				parent_type: "patient",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "notes", label: proseText("Notes") },
					{ name: "private_note", label: proseText("Private note") },
				],
			},
			{
				name: "medication_order",
				parent_type: "patient",
				properties: [{ name: "case_name", label: proseText("Name") }],
			},
			{
				name: "lab_result",
				parent_type: "patient",
				properties: [{ name: "case_name", label: proseText("Name") }],
			},
		],
		modules: [
			{
				uuid: "60000000-0000-4000-8000-00000000a030",
				name: "Patients",
				caseType: "patient",
				forms: [
					{
						uuid: "60000000-0000-4000-8000-00000000a031",
						name: "Register patient",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "patient_name",
								caseWrite: { caseType: "patient", property: "case_name" },
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
							f({
								kind: "repeat",
								id: "orders",
								children: [
									f({
										kind: "text",
										id: "medication_name",
										caseWrite: {
											caseType: "medication_order",
											property: "case_name",
										},
									}),
								],
							}),
						],
					},
				],
			},
		],
	});
	return { doc, formUuid: Object.keys(doc.forms)[0] as Uuid };
}

function ordinaryAuthorityMutation(
	doc: BlueprintDoc,
	formUuid: Uuid,
): Extract<SubmissionMutation, { kind: "registration" }> {
	const engine = engineFor(doc, formUuid);
	engine.setValue("/data/patient_name", "Ada");
	engine.setValue("/data/age", "37");
	engine.setValue("/data/visit_name", "First visit");
	engine.setValue("/data/visit_notes", "Checkup");
	engine.setValue("/data/orders[0]/medication_name", "Hydrangea");
	engine.addRepeat("/data/orders");
	engine.setValue("/data/orders[1]/medication_name", "Aspirin");
	const mutation = engine.computeSubmissionMutation({ entryKey: ENTRY_KEY });
	if (mutation.kind !== "registration") {
		throw new Error("Ordinary-authority fixture did not produce registration.");
	}
	return mutation;
}

function engineFor(doc: BlueprintDoc, formUuid: Uuid): FormEngine {
	const input: FormEngineInput = {
		form: doc.forms[formUuid],
		formUuid,
		fields: doc.fields as FormEngineInput["fields"],
		fieldOrder: doc.fieldOrder as FormEngineInput["fieldOrder"],
		caseTypes: doc.caseTypes ?? [],
	};
	return new FormEngine(input, "patient", undefined, null);
}

async function seedSessionCase(store: CaseStore, doc: BlueprintDoc) {
	await store.applySchemaChange({
		appId: APP_ID,
		caseType: "patient",
		caseTypeSchemas: buildCaseTypeMap(doc),
	});
	await store.insert({
		appId: APP_ID,
		row: {
			case_id: SESSION_CASE,
			case_type: "patient",
			case_name: "Ada",
			external_id: "seed-external",
			status: "open",
			properties: {},
		},
	});
}

async function seedSecondSessionCase(store: CaseStore) {
	await store.insert({
		appId: APP_ID,
		row: {
			case_id: SECOND_SESSION_CASE,
			case_type: "patient",
			case_name: "Grace",
			external_id: "seed-external-2",
			status: "open",
			properties: {},
		},
	});
}

async function submit(
	doc: BlueprintDoc,
	engine: FormEngine,
	store: CaseStore,
	lookupTableSchemas?: LookupTableSchemas,
) {
	const mutation = engine.computeSubmissionMutation({
		caseIds: [SESSION_CASE],
		entryKey: ENTRY_KEY,
	});
	const projection = validateCaptureSubmissionProjection(mutation);
	const built = buildCaseOperationProgramFromDoc({
		blueprint: doc,
		mutation,
		projection,
		identity: IDENTITY,
	});
	expect(built.program).toBeDefined();
	expect(built.ordinaryCaseType).toBe("patient");
	const withLookupSchemas =
		built.program === undefined || lookupTableSchemas === undefined
			? built
			: {
					...built,
					program: { ...built.program, lookupTableSchemas },
				};
	return store.applySubmission(
		submissionEnvelopeArgs(mutation, APP_ID, {
			...withLookupSchemas,
			submissionReceipt: {
				...buildSubmissionReceiptIdentity({
					appId: APP_ID,
					identity: IDENTITY,
					mutation,
					projection,
				}),
				expectedAppMutationSeq: 0,
				blueprintDigest: "0".repeat(64),
			},
		}),
	);
}

async function loadCase(store: CaseStore, caseId: string) {
	const rows = await store.query({ appId: APP_ID, caseType: "patient" });
	return rows.find((row) => row.case_id === caseId);
}

describe("engine → builder → executor acceptance", () => {
	it("projects committed registration destinations and preserves authored child receipt indices", async () => {
		const { doc, formUuid } = ordinaryAuthorityDoc();
		const store = makeStore();
		const schemas = buildCaseTypeMap(doc);
		for (const caseType of doc.caseTypes ?? []) {
			await store.applySchemaChange({
				appId: APP_ID,
				caseType: caseType.name,
				caseTypeSchemas: schemas,
			});
		}

		const mutation = ordinaryAuthorityMutation(doc, formUuid);
		expect(mutation.ordinaryChildBuckets).toEqual([
			{ caseType: "visit" },
			{
				caseType: "medication_order",
				repeatUuid: expect.any(String),
				repeatInstanceKey: "/data/orders[0]",
			},
			{
				caseType: "medication_order",
				repeatUuid: expect.any(String),
				repeatInstanceKey: "/data/orders[1]",
			},
		]);
		const projection = validateCaptureSubmissionProjection(mutation);
		const built = buildCaseOperationProgramFromDoc({
			blueprint: doc,
			mutation,
			projection,
			identity: IDENTITY,
		});
		expect(built.ordinaryAction).toEqual({
			kind: "registration",
			primary: {
				caseType: "patient",
				caseName: "Ada",
				properties: { age: 37 },
			},
			children: [
				{
					caseType: "visit",
					caseName: "First visit",
					properties: { notes: "Checkup" },
					parentRelationship: "child",
				},
				{
					caseType: "medication_order",
					caseName: "Hydrangea",
					properties: {},
					parentRelationship: "child",
				},
				{
					caseType: "medication_order",
					caseName: "Aspirin",
					properties: {},
					parentRelationship: "child",
				},
			],
		});
		const envelope = submissionEnvelopeArgs(mutation, APP_ID, {
			...built,
			submissionReceipt: {
				...buildSubmissionReceiptIdentity({
					appId: APP_ID,
					identity: IDENTITY,
					mutation,
					projection,
				}),
				expectedAppMutationSeq: 0,
				blueprintDigest: "0".repeat(64),
			},
		});
		expect(envelope.ordinary).toEqual(built.ordinaryAction);

		const result = await store.applySubmission(envelope);
		expect(result.primaryCaseIds).toHaveLength(1);
		expect(result.createdChildren).toEqual(
			[0, 1, 2].map((authoredChildIndex) => ({
				authoredChildIndex,
				parentCaseId: result.primaryCaseIds[0],
				caseId: expect.any(String),
			})),
		);
	});

	it("rejects every uncommitted ordinary case structure before effects", () => {
		const { doc, formUuid } = ordinaryAuthorityDoc();
		const mutation = ordinaryAuthorityMutation(doc, formUuid);
		const reject = (forged: SubmissionMutation, committed = doc) => {
			const projection = validateCaptureSubmissionProjection(forged);
			expect(() =>
				buildCaseOperationProgramFromDoc({
					blueprint: committed,
					mutation: forged,
					projection,
					identity: IDENTITY,
				}),
			).toThrow(CaptureSubmissionRejectedError);
		};
		const [rootChild, repeatedChild] = mutation.children;
		const [rootBucket, repeatedBucket] = mutation.ordinaryChildBuckets ?? [];
		if (
			rootChild === undefined ||
			repeatedChild === undefined ||
			rootBucket === undefined ||
			repeatedBucket === undefined
		) {
			throw new Error("Ordinary-authority fixture is missing child buckets.");
		}

		reject({
			...mutation,
			primary: { ...mutation.primary, caseType: "visit" },
		});
		reject({
			...mutation,
			primary: {
				...mutation.primary,
				properties: {
					...mutation.primary.properties,
					nickname: "The Countess",
				},
			},
		});
		reject({
			...mutation,
			children: [
				{ ...rootChild, caseType: "lab_result", properties: {} },
				...mutation.children.slice(1),
			],
			ordinaryChildBuckets: [
				{ caseType: "lab_result" },
				...(mutation.ordinaryChildBuckets ?? []).slice(1),
			],
		});
		reject({
			...mutation,
			children: [
				{
					...rootChild,
					properties: { ...rootChild.properties, private_note: "hidden" },
				},
				...mutation.children.slice(1),
			],
		});
		reject({
			...mutation,
			children: [rootChild, rootChild, ...mutation.children.slice(1)],
			ordinaryChildBuckets: [
				rootBucket,
				rootBucket,
				...(mutation.ordinaryChildBuckets ?? []).slice(1),
			],
		});
		reject({
			...mutation,
			children: [...mutation.children, repeatedChild],
			ordinaryChildBuckets: [
				...(mutation.ordinaryChildBuckets ?? []),
				repeatedBucket,
			],
		});
		reject({
			...mutation,
			primary: { ...mutation.primary, externalId: "forged-external" },
		});

		const close = conditionalCloseDoc();
		const closeEngine = engineFor(close.doc, close.formUuid);
		closeEngine.setValue("/data/close_when", "done");
		const closeMutation = closeEngine.computeSubmissionMutation({
			caseIds: [SESSION_CASE, SECOND_SESSION_CASE],
			entryKey: ENTRY_KEY,
		});
		if (closeMutation.kind !== "close") {
			throw new Error("Conditional-close fixture did not produce close.");
		}
		reject(
			{
				...closeMutation,
				patch: { ...closeMutation.patch, caseName: "Forged name" },
			},
			close.doc,
		);
	});

	it("evaluates one committed close condition and closes the complete ordered selection", async () => {
		const { doc, formUuid, conditionFieldUuid } = conditionalCloseDoc();
		const store = makeStore();
		await seedSessionCase(store, doc);
		await seedSecondSessionCase(store);

		const engine = engineFor(doc, formUuid);
		engine.setValue("/data/close_when", "done");
		const mutation = engine.computeSubmissionMutation({
			caseIds: [SECOND_SESSION_CASE, SESSION_CASE],
			entryKey: ENTRY_KEY,
		});
		const projection = validateCaptureSubmissionProjection(mutation);
		expect(projection.closeConditionAnswers).toEqual({
			fieldUuid: conditionFieldUuid,
			values: ["done"],
		});
		const built = buildCaseOperationProgramFromDoc({
			blueprint: doc,
			mutation,
			projection,
			identity: IDENTITY,
		});
		expect(built).toMatchObject({
			ordinaryFormType: "close",
			ordinaryCloseCase: true,
			ordinaryCaseType: "patient",
			ordinarySelection: { kind: "multiple", maximum: 4 },
		});
		const envelope = submissionEnvelopeArgs(mutation, APP_ID, {
			...built,
			submissionReceipt: {
				...buildSubmissionReceiptIdentity({
					appId: APP_ID,
					identity: IDENTITY,
					mutation,
					projection,
				}),
				expectedAppMutationSeq: 0,
				blueprintDigest: "0".repeat(64),
			},
		});
		expect(envelope.ordinary).toMatchObject({
			kind: "close",
			caseIds: [SECOND_SESSION_CASE, SESSION_CASE],
		});

		const result = await store.applySubmission(envelope);
		expect(result.primaryCaseIds).toEqual([SECOND_SESSION_CASE, SESSION_CASE]);
		const rows = await store.query({ appId: APP_ID, caseType: "patient" });
		expect(
			rows
				.filter((row) =>
					[SESSION_CASE, SECOND_SESSION_CASE].includes(row.case_id),
				)
				.map((row) => row.status),
		).toEqual(["closed", "closed"]);
	});

	it("keeps every selected case open when the committed close condition is false", async () => {
		const { doc, formUuid } = conditionalCloseDoc();
		const store = makeStore();
		await seedSessionCase(store, doc);
		await seedSecondSessionCase(store);

		const engine = engineFor(doc, formUuid);
		engine.setValue("/data/close_when", "not yet");
		const mutation = engine.computeSubmissionMutation({
			caseIds: [SESSION_CASE, SECOND_SESSION_CASE],
			entryKey: ENTRY_KEY,
		});
		const projection = validateCaptureSubmissionProjection(mutation);
		const built = buildCaseOperationProgramFromDoc({
			blueprint: doc,
			mutation,
			projection,
			identity: IDENTITY,
		});
		expect(built.ordinaryCloseCase).toBe(false);
		const envelope = submissionEnvelopeArgs(mutation, APP_ID, {
			...built,
			submissionReceipt: {
				...buildSubmissionReceiptIdentity({
					appId: APP_ID,
					identity: IDENTITY,
					mutation,
					projection,
				}),
				expectedAppMutationSeq: 0,
				blueprintDigest: "0".repeat(64),
			},
		});
		expect(envelope.ordinary.kind).toBe("followup");

		await store.applySubmission(envelope);
		const rows = await store.query({ appId: APP_ID, caseType: "patient" });
		expect(
			rows
				.filter((row) =>
					[SESSION_CASE, SECOND_SESSION_CASE].includes(row.case_id),
				)
				.map((row) => row.status),
		).toEqual(["open", "open"]);
	});

	it("rejects a forged batch-close discriminator against a committed followup form before effects", () => {
		const { doc, formUuid } = acceptanceDoc(() => []);
		const engine = engineFor(doc, formUuid);
		const authored = engine.computeSubmissionMutation({
			caseIds: [SESSION_CASE, SECOND_SESSION_CASE],
			entryKey: ENTRY_KEY,
		});
		expect(authored.kind).toBe("followup");
		const forged = { ...authored, kind: "close" } as SubmissionMutation;
		const projection = validateCaptureSubmissionProjection(forged);

		expect(() =>
			buildCaseOperationProgramFromDoc({
				blueprint: doc,
				mutation: forged,
				projection,
				identity: IDENTITY,
			}),
		).toThrow(CaptureSubmissionRejectedError);
	});

	it("a root operation writes custom and scalar values; the ordinary scalar action lands last", async () => {
		const { doc, formUuid } = acceptanceDoc((ids) => [
			{
				uuid: OP_ROOT,
				id: "op_root",
				action: "update",
				caseType: "patient",
				target: { kind: "session" },
				writes: [
					// Written from the free root answer.
					{ property: "op_status", value: term(formField(ids.note)) },
					// Written from a BLANK root answer — must land as an ABSENT
					// key, never null or "". (A root operation may read root
					// answers only — the validator's correlation rule.)
					{ property: "visit_note", value: term(formField(ids.extra)) },
					// Contends with the ordinary patch — the ordinary action
					// executes LAST, so its value must win.
					{ property: "external_id", value: term(formField(ids.note)) },
				],
			} as CaseOperation,
		]);
		const store = makeStore();
		await seedSessionCase(store, doc);

		const engine = engineFor(doc, formUuid);
		engine.setValue("/data/note", "from-operation");
		engine.setValue("/data/external_code", "from-ordinary");

		const result = await submit(doc, engine, store);
		expect(result.primaryCaseIds).toEqual([SESSION_CASE]);
		expect(result.operations).toHaveLength(1);
		expect(result.operations[0]?.executed).toBe(true);

		const row = await loadCase(store, SESSION_CASE);
		expect(row?.properties.op_status).toBe("from-operation");
		expect("visit_note" in (row?.properties ?? {})).toBe(false);
		expect(row?.external_id).toBe("from-ordinary");
		expect(row?.properties).not.toHaveProperty("external_id");
	});

	it("a repeat-scoped create runs per live iteration with that iteration's answers", async () => {
		const { doc, formUuid } = acceptanceDoc((ids) => [
			{
				uuid: OP_REPEAT,
				id: "op_repeat",
				action: "create",
				caseType: "patient",
				target: { kind: "new" },
				forEach: { repeat: ids.visits },
				name: term(formField(ids.visitNote)),
				writes: [
					{ property: "visit_note", value: term(formField(ids.visitNote)) },
				],
			} as CaseOperation,
		]);
		const store = makeStore();
		await seedSessionCase(store, doc);

		const engine = engineFor(doc, formUuid);
		engine.addRepeat("/data/visits");
		engine.setValue("/data/visits[0]/visit_note", "first visit");
		engine.setValue("/data/visits[1]/visit_note", "second visit");

		const result = await submit(doc, engine, store);
		const executed = result.operations.filter((op) => op.executed);
		expect(executed).toHaveLength(2);
		expect(executed.map((op) => op.iteration)).toEqual([0, 1]);

		const rows = await store.query({ appId: APP_ID, caseType: "patient" });
		const created = rows.filter((row) => row.case_id !== SESSION_CASE);
		expect(created.map((row) => row.case_name).sort()).toEqual([
			"first visit",
			"second visit",
		]);
	});

	it("a blank authored key rejects the WHOLE submission — the ordinary patch rolls back too", async () => {
		const { doc, formUuid } = acceptanceDoc((ids) => [
			{
				uuid: OP_ROOT,
				id: "op_keyed",
				action: "create",
				caseType: "patient",
				target: { kind: "new", idFrom: ids.note },
			} as CaseOperation,
		]);
		const store = makeStore();
		await seedSessionCase(store, doc);

		const engine = engineFor(doc, formUuid);
		// The authored key's source answer stays BLANK; the ordinary patch
		// still carries a scalar write that must not survive the rollback.
		engine.setValue("/data/external_code", "should-roll-back");

		await expect(submit(doc, engine, store)).rejects.toThrow(
			SubmissionRejectedError,
		);
		const row = await loadCase(store, SESSION_CASE);
		expect(row?.external_id).toBe("seed-external");
		expect(row?.properties).not.toHaveProperty("external_id");
	});

	it("operations present but no collected answer bags rejects the final protocol", async () => {
		const { doc, formUuid } = acceptanceDoc((ids) => [
			{
				uuid: OP_ROOT,
				id: "op_root",
				action: "update",
				caseType: "patient",
				target: { kind: "session" },
				writes: [{ property: "external_id", value: term(formField(ids.note)) }],
			} as CaseOperation,
		]);
		const engine = engineFor(doc, formUuid);
		engine.setValue("/data/note", "collected");
		const mutation = engine.computeSubmissionMutation({
			caseIds: [SESSION_CASE],
			entryKey: ENTRY_KEY,
		});
		const missingAnswers = { ...mutation, operationAnswers: undefined };
		const projection = validateCaptureSubmissionProjection(missingAnswers);
		// A stale client must neither run blank bindings nor silently skip the
		// committed operation program.
		expect(() =>
			buildCaseOperationProgramFromDoc({
				blueprint: doc,
				mutation: missingAnswers,
				projection,
				identity: IDENTITY,
			}),
		).toThrow(CaptureSubmissionRejectedError);
	});

	it("a false condition skips the effect and records executed: false", async () => {
		const { doc, formUuid } = acceptanceDoc((ids) => [
			{
				uuid: OP_ROOT,
				id: "op_gated",
				action: "update",
				caseType: "patient",
				target: { kind: "session" },
				condition: matchNone(),
				writes: [{ property: "op_status", value: term(formField(ids.note)) }],
			} as CaseOperation,
		]);
		const store = makeStore();
		await seedSessionCase(store, doc);

		const engine = engineFor(doc, formUuid);
		engine.setValue("/data/note", "never-lands");

		const result = await submit(doc, engine, store);
		expect(result.operations[0]?.executed).toBe(false);
		const row = await loadCase(store, SESSION_CASE);
		// The gated operation is skipped, while the form's ordinary blank
		// `external_id` writer still executes under scalar semantics: blank
		// explicitly clears that optional scalar rather than preserving it.
		expect(row?.external_id).toBe("");
		expect(row?.properties).not.toHaveProperty("external_id");
	});

	it("a lookup-backed false condition skips its operation while the ordinary effect commits", async () => {
		const { doc, formUuid } = acceptanceDoc((ids) => [
			{
				uuid: OP_ROOT,
				id: "op_lookup_gated",
				action: "update",
				caseType: "patient",
				target: { kind: "session" },
				condition: eq(
					tableLookup(
						LOOKUP_TABLE,
						LOOKUP_COLUMN,
						eq(tableColumn(LOOKUP_TABLE, LOOKUP_COLUMN), literal("enabled")),
					),
					literal("enabled"),
				),
				writes: [{ property: "op_status", value: term(formField(ids.note)) }],
			} as CaseOperation,
		]);
		const store = makeStore();
		await seedSessionCase(store, doc);

		const engine = engineFor(doc, formUuid);
		engine.setValue("/data/note", "never-lands");
		engine.setValue("/data/external_code", "ordinary-landed");
		const lookupTableSchemas: LookupTableSchemas = new Map([
			[LOOKUP_TABLE, new Map([[LOOKUP_COLUMN, "text" as const]])],
		]);

		const result = await submit(doc, engine, store, lookupTableSchemas);
		expect(result.operations).toEqual([
			expect.objectContaining({
				operationUuid: OP_ROOT,
				executed: false,
			}),
		]);
		const row = await loadCase(store, SESSION_CASE);
		expect(row?.external_id).toBe("ordinary-landed");
		expect(row?.properties).not.toHaveProperty("external_id");
		expect("op_status" in (row?.properties ?? {})).toBe(false);
	});
});
