// Submission-program acceptance: the ENGINE's collected answers flow
// through the PURE program builder into the REAL storage executor —
// proving the production supplier produces executor-compatible programs
// over a real committed-doc shape. Covers the form's own case (its
// creates under the ids its entry minted, its close under the committed
// close condition), the absent-value matrix (blank answer → absent JSONB
// key; blank authored key → typed whole-rollback rejection) and effect
// ordering (the own case first, as the array holds it; iteration-major
// repeat expansion).

import { type Kysely, sql } from "kysely";
import { beforeEach, describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import type { CaseStore, LookupTableSchemas } from "@/lib/case-store";
import { buildCaseTypeMap } from "@/lib/case-store";
import { SubmissionRejectedError } from "@/lib/case-store/errors";
import { PostgresCaseStore } from "@/lib/case-store/postgres/store";
import { HeuristicCaseGenerator } from "@/lib/case-store/sample/heuristic";
import { setupPerTestDatabase } from "@/lib/case-store/sql/__tests__/perTestDatabase";
import type { Database } from "@/lib/case-store/sql/database";
import { arithmeticFixture } from "@/lib/commcare/__tests__/arithmeticFixture";
import type { AppDatabase } from "@/lib/db/pg";
import type { BlueprintDoc, CaseOperation, Uuid } from "@/lib/domain";
import { entryDatumCaseId } from "@/lib/domain/entryCaseIdentity";
import {
	eq,
	formField,
	isIn,
	literal,
	matchNone,
	tableColumn,
	tableLookup,
	term,
} from "@/lib/domain/expression";
import { SEARCH_READING } from "@/lib/domain/expression/temporalType";
import { applyLookupAuthoringBatchInTransaction } from "@/lib/lookup/authoringBatch";
import { readLookupDefinitionsInTransaction } from "@/lib/lookup/definitionSnapshot";
import { webAppsDevice } from "@/lib/preview/engine/__tests__/fixtures/previewDevices";
import { validateCaptureSubmissionProjection } from "../captureSubmissionValidation";
import {
	buildCaseOperationProgramFromDoc,
	buildSubmissionReceiptIdentity,
	submissionEnvelopeArgs,
} from "../caseDataBindingHelpers";
import type { FormEngine } from "../formEngine";
import type { ResolvedPreviewIdentity } from "../identity";
import {
	acceptanceDoc,
	conditionalCloseDoc,
	engineFor,
	operationRelevanceDoc,
	ordinaryAuthorityDoc,
	ordinaryAuthorityMutation,
} from "./fixtures/submissionProgram";

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
		device: webAppsDevice(),
		blueprint: doc,
		mutation,
		projection,
		identity: IDENTITY,
	});
	expect(built.program?.ownCase?.caseType).toBe("patient");
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
	const rows = await store.query({
		reading: SEARCH_READING,
		appId: APP_ID,
		caseType: "patient",
	});
	return rows.find((row) => row.case_id === caseId);
}

describe("engine → builder → executor acceptance", () => {
	it.each([false, true])(
		"operation reads and repeated effects inherit relevance: %s",
		async (participates) => {
			const { doc, formUuid } = operationRelevanceDoc();
			const store = makeStore();
			await seedSessionCase(store, doc);
			const engine = engineFor(doc, formUuid);
			engine.setValue("/data/external_code", participates ? "yes" : "no");
			const result = await submit(doc, engine, store);
			expect((await loadCase(store, SESSION_CASE))?.properties).toEqual({
				visit_note: "kept",
				...(participates ? { op_status: "pending" } : {}),
			});
			// The own case, the root read, and the repeat's create when the
			// repeat participates.
			expect(result.operations.filter((op) => op.executed)).toHaveLength(
				participates ? 3 : 2,
			);
			expect(
				await store.query({
					reading: SEARCH_READING,
					appId: APP_ID,
					caseType: "patient",
				}),
			).toHaveLength(participates ? 2 : 1);
		},
	);

	it.each([
		["10", "3", 3, 1],
		["-10", "3", -3, -1],
		["10", "-3", -3, 1],
		["-10", "-3", 3, -1],
	] as const)(
		"stores admitted arithmetic from %s and %s with declared answer types",
		async (numerator, denominator, quotient, remainder) => {
			const { doc, formUuid } = arithmeticFixture();
			const store = makeStore();
			await seedSessionCase(store, doc);
			const engine = engineFor(doc, formUuid);
			engine.setValue("/data/numerator", numerator);
			engine.setValue("/data/denominator", denominator);
			engine.setValue("/data/decimal", "10");
			await submit(doc, engine, store);
			const row = await loadCase(store, SESSION_CASE);
			expect(row?.properties).toEqual({
				quotient,
				remainder,
				mixed: 10 / Number(denominator),
				large: 715827882,
			});
		},
	);
	it("creates a registration's case and its children from the committed form, each named case under the id its entry minted", async () => {
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
		const projection = validateCaptureSubmissionProjection(mutation);
		const built = buildCaseOperationProgramFromDoc({
			device: webAppsDevice(),
			blueprint: doc,
			mutation,
			projection,
			identity: IDENTITY,
		});
		expect(built.ordinaryAction).toEqual({ kind: "registration" });
		const program = built.program;
		// The entry's session names the patient and its one visit, so both
		// are created with the ids the form read; the repeat's orders are
		// named by no datum.
		expect(
			program?.operations.map(({ operation }) => [
				operation.action,
				program.entryCaseKeys?.get(operation.uuid),
			]),
		).toEqual([
			["own", "new-case"],
			["create", "new-child-case:visit"],
			["create", undefined],
		]);
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

		const result = await store.applySubmission(envelope);
		const entryKey = envelope.submissionReceipt.entryKey;
		const patientId = entryDatumCaseId(APP_ID, entryKey, "new-case");
		const visitId = entryDatumCaseId(APP_ID, entryKey, "new-child-case:visit");
		expect(result.primaryCaseIds).toEqual([patientId]);
		expect(result.createdChildren).toEqual([]);
		const patients = await store.query({
			reading: SEARCH_READING,
			appId: APP_ID,
			caseType: "patient",
		});
		expect(
			patients.map((row) => [row.case_id, row.case_name, row.properties]),
		).toEqual([[patientId, "Ada", { age: 37 }]]);
		const [visit] = await store.query({
			reading: SEARCH_READING,
			appId: APP_ID,
			caseType: "visit",
		});
		expect(visit).toMatchObject({
			case_id: visitId,
			case_name: "First visit",
			parent_case_id: patientId,
			properties: { notes: "Checkup" },
		});
		const orders = await store.query({
			reading: SEARCH_READING,
			appId: APP_ID,
			caseType: "medication_order",
		});
		expect(orders.map((row) => row.case_name).sort()).toEqual([
			"Aspirin",
			"Hydrangea",
		]);
		for (const order of orders) {
			expect(order.parent_case_id).toBe(patientId);
		}
		const ids = new Set([
			patientId,
			visitId,
			...orders.map((row) => row.case_id),
		]);
		expect(ids.size).toBe(4);
	});

	it.each([
		["no", 0, undefined],
		["yes", 1, "open"],
		["yes and close", 1, "closed"],
	] as const)(
		"runs a registration's own case under its open and close conditions (%s)",
		async (answer, created, status) => {
			const doc = buildDoc(
				{
					appName: "Conditional registration",
					caseTypes: [{ name: "patient", properties: [] }],
					modules: [
						{
							name: "Patients",
							caseType: "patient",
							caseListConfig: caseListConfig([
								{ field: "case_name", header: "Name" },
							]),
							forms: [
								{
									name: "Register",
									type: "registration",
									fields: [
										f({
											kind: "text",
											id: "name",
											caseWrite: {
												caseType: "patient",
												property: "case_name",
											},
										}),
										f({ kind: "text", id: "consent" }),
									],
								},
							],
						},
					],
				},
				(draft) => {
					const [formUuid] = Object.keys(draft.forms);
					const consent = Object.values(draft.fields).find(
						(field) => field.id === "consent",
					);
					if (formUuid === undefined || consent === undefined) return;
					draft.forms[formUuid] = {
						...draft.forms[formUuid],
						// Create the case on consent; close it again at once when
						// the answer also says to close it.
						openCondition: isIn(
							formField(consent.uuid),
							literal("yes"),
							literal("yes and close"),
						),
						closeCondition: eq(
							formField(consent.uuid),
							literal("yes and close"),
						),
					};
				},
			);
			const formUuid = Object.keys(doc.forms)[0] as Uuid;
			const store = makeStore();
			await store.applySchemaChange({
				appId: APP_ID,
				caseType: "patient",
				caseTypeSchemas: buildCaseTypeMap(doc),
			});
			const engine = engineFor(doc, formUuid);
			engine.setValue("/data/name", "Amina");
			engine.setValue("/data/consent", answer);
			const mutation = engine.computeSubmissionMutation({
				entryKey: ENTRY_KEY,
			});
			const projection = validateCaptureSubmissionProjection(mutation);
			const built = buildCaseOperationProgramFromDoc({
				device: webAppsDevice(),
				blueprint: doc,
				mutation,
				projection,
				identity: IDENTITY,
			});
			await store.applySubmission(
				submissionEnvelopeArgs(mutation, APP_ID, {
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
				}),
			);
			const rows = await store.query({
				reading: SEARCH_READING,
				appId: APP_ID,
				caseType: "patient",
				includeHeld: true,
			});
			expect(rows).toHaveLength(created);
			if (status !== undefined) {
				expect(rows[0]).toMatchObject({ case_name: "Amina", status });
			}
		},
	);

	it("closes the complete ordered selection when the committed close condition holds", async () => {
		const { doc, formUuid } = conditionalCloseDoc();
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
		const built = buildCaseOperationProgramFromDoc({
			device: webAppsDevice(),
			blueprint: doc,
			mutation,
			projection,
			identity: IDENTITY,
		});
		expect(built).toMatchObject({
			ordinaryFormType: "close",
			ordinaryAction: {
				kind: "close",
				caseIds: [SECOND_SESSION_CASE, SESSION_CASE],
				caseType: "patient",
				selection: { kind: "multiple", maximum: 4 },
			},
		});
		expect(built.program?.ownCase).toEqual({
			caseType: "patient",
			formType: "close",
			closeCondition: doc.forms[formUuid]?.closeCondition,
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

		const result = await store.applySubmission(envelope);
		expect(result.primaryCaseIds).toEqual([SECOND_SESSION_CASE, SESSION_CASE]);
		const rows = await store.query({
			reading: SEARCH_READING,
			appId: APP_ID,
			caseType: "patient",
		});
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
			device: webAppsDevice(),
			blueprint: doc,
			mutation,
			projection,
			identity: IDENTITY,
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
		expect(envelope.ordinary.kind).toBe("close");

		await store.applySubmission(envelope);
		const rows = await store.query({
			reading: SEARCH_READING,
			appId: APP_ID,
			caseType: "patient",
		});
		expect(
			rows
				.filter((row) =>
					[SESSION_CASE, SECOND_SESSION_CASE].includes(row.case_id),
				)
				.map((row) => row.status),
		).toEqual(["open", "open"]);
	});

	it("the own case and a later root operation each write their own values", async () => {
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
				],
			} satisfies CaseOperation,
		]);
		const store = makeStore();
		await seedSessionCase(store, doc);

		const engine = engineFor(doc, formUuid);
		engine.setValue("/data/note", "from-operation");
		engine.setValue("/data/external_code", "from-own-case");

		const result = await submit(doc, engine, store);
		expect(result.primaryCaseIds).toEqual([SESSION_CASE]);
		// The own case first, as the array holds it.
		expect(
			result.operations.map(({ action, executed }) => [action, executed]),
		).toEqual([
			["own", true],
			["update", true],
		]);

		const row = await loadCase(store, SESSION_CASE);
		expect(row?.properties.op_status).toBe("from-operation");
		expect("visit_note" in (row?.properties ?? {})).toBe(false);
		expect(row?.external_id).toBe("from-own-case");
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
			} satisfies CaseOperation,
		]);
		const store = makeStore();
		await seedSessionCase(store, doc);

		const engine = engineFor(doc, formUuid);
		engine.addRepeat("/data/visits");
		engine.setValue("/data/visits[0]/visit_note", "first visit");
		engine.setValue("/data/visits[1]/visit_note", "second visit");

		const result = await submit(doc, engine, store);
		const executed = result.operations.filter(
			(op) => op.executed && op.operationUuid === OP_REPEAT,
		);
		expect(executed).toHaveLength(2);
		expect(executed.map((op) => op.iteration)).toEqual([0, 1]);

		const rows = await store.query({
			reading: SEARCH_READING,
			appId: APP_ID,
			caseType: "patient",
		});
		const created = rows.filter((row) => row.case_id !== SESSION_CASE);
		expect(created.map((row) => row.case_name).sort()).toEqual([
			"first visit",
			"second visit",
		]);
	});

	it("a blank authored key rejects before the own case's write can commit", async () => {
		const { doc, formUuid } = acceptanceDoc((ids) => [
			{
				uuid: OP_ROOT,
				id: "op_keyed",
				action: "create",
				caseType: "patient",
				target: { kind: "new", idFrom: ids.note },
				name: term(literal("Keyed case")),
			} satisfies CaseOperation,
		]);
		const store = makeStore();
		await seedSessionCase(store, doc);

		const engine = engineFor(doc, formUuid);
		// The authored key's source answer stays BLANK; the own case still
		// saves a scalar that must not survive the rollback.
		engine.setValue("/data/external_code", "should-roll-back");

		await expect(submit(doc, engine, store)).rejects.toThrow(
			SubmissionRejectedError,
		);
		const row = await loadCase(store, SESSION_CASE);
		expect(row?.external_id).toBe("seed-external");
		expect(row?.properties).not.toHaveProperty("external_id");
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
			} satisfies CaseOperation,
		]);
		const store = makeStore();
		await seedSessionCase(store, doc);

		const engine = engineFor(doc, formUuid);
		engine.setValue("/data/note", "never-lands");

		const result = await submit(doc, engine, store);
		expect(
			result.operations.find((op) => op.operationUuid === OP_ROOT)?.executed,
		).toBe(false);
		const row = await loadCase(store, SESSION_CASE);
		// The gated operation is skipped, while the own case's blank
		// `external_id` write still executes under scalar semantics: blank
		// explicitly clears that optional scalar rather than preserving it.
		expect(row?.external_id).toBe("");
		expect(row?.properties).not.toHaveProperty("external_id");
	});

	it("a lookup-backed false condition skips its operation while the own case's write commits", async () => {
		const appDb = dbHandle.db as Kysely<AppDatabase>;
		const seeded = await appDb.transaction().execute((tx) =>
			applyLookupAuthoringBatchInTransaction(
				tx,
				{ projectId: PROJECT, actorId: ACTOR, role: "owner" },
				{
					createTables: [
						{
							key: "operation_gate",
							name: "Operation gate",
							tag: "operation_gate",
							columns: [
								{
									key: "status",
									wireName: "status",
									label: "Status",
									dataType: "text",
								},
							],
							rows: [],
						},
					],
				},
			),
		);
		const table = seeded.tables[0];
		const columnId = table?.columnIds[0]?.id;
		if (!table || !columnId) throw new Error("Lookup seed is incomplete.");
		const { doc, formUuid } = acceptanceDoc((ids) => [
			{
				uuid: OP_ROOT,
				id: "op_lookup_gated",
				action: "update",
				caseType: "patient",
				target: { kind: "session" },
				condition: eq(
					tableLookup(
						table.tableId,
						columnId,
						eq(tableColumn(table.tableId, columnId), literal("enabled")),
					),
					literal("enabled"),
				),
				writes: [{ property: "op_status", value: term(formField(ids.note)) }],
			} satisfies CaseOperation,
		]);
		const store = makeStore();
		await seedSessionCase(store, doc);

		const lookupSnapshot = await appDb
			.transaction()
			.execute((tx) =>
				readLookupDefinitionsInTransaction(tx, PROJECT, [table.tableId]),
			);
		const engine = engineFor(doc, formUuid, {
			kind: "available",
			...lookupSnapshot,
		});
		engine.setValue("/data/note", "never-lands");
		engine.setValue("/data/external_code", "own-case-landed");
		const lookupTableSchemas: LookupTableSchemas = new Map(
			lookupSnapshot.definitions.map((definition) => [
				definition.id,
				new Map(
					definition.columns.map((column) => [column.id, column.dataType]),
				),
			]),
		);

		const result = await submit(doc, engine, store, lookupTableSchemas);
		expect(
			result.operations.find((op) => op.operationUuid === OP_ROOT),
		).toMatchObject({ executed: false });
		const row = await loadCase(store, SESSION_CASE);
		expect(row?.external_id).toBe("own-case-landed");
		expect(row?.properties).not.toHaveProperty("external_id");
		expect("op_status" in (row?.properties ?? {})).toBe(false);
	});
});
