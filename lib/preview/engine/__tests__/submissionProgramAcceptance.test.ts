// S07b acceptance: the ENGINE's collected answers flow through the
// PURE program builder into the REAL storage executor — proving the
// production supplier produces executor-compatible programs over a
// real committed-doc shape. Covers the roadmap's absent-value matrix
// (blank answer → absent JSONB key; blank authored key → typed
// whole-rollback rejection) and effect ordering (iteration-major
// repeat expansion; the ordinary action landing LAST with its
// caseType folded into the rolling proof).

import type { Kysely } from "kysely";
import { beforeEach, describe, expect, it } from "vitest";
import type { CaseStore } from "@/lib/case-store";
import { buildCaseTypeMap } from "@/lib/case-store";
import { SubmissionRejectedError } from "@/lib/case-store/errors";
import { runCaseStoreMigrations } from "@/lib/case-store/migrate";
import { PostgresCaseStore } from "@/lib/case-store/postgres/store";
import { HeuristicCaseGenerator } from "@/lib/case-store/sample/heuristic";
import { setupPerTestDatabase } from "@/lib/case-store/sql/__tests__/perTestDatabase";
import type { Database } from "@/lib/case-store/sql/database";
import type { BlueprintDoc, CaseOperation, Uuid } from "@/lib/domain";
import { asUuid } from "@/lib/domain";
import { formField, matchNone, term } from "@/lib/domain/predicate";
import { buildDoc, f } from "../../../__tests__/docHelpers";
import {
	buildCaseOperationProgramFromDoc,
	submissionEnvelopeArgs,
} from "../caseDataBindingHelpers";
import { FormEngine, type FormEngineInput } from "../formEngine";
import type { ResolvedPreviewIdentity } from "../identity";

const dbHandle = setupPerTestDatabase({
	databaseNamePrefix: "program_acceptance_",
});

beforeEach(async () => {
	await runCaseStoreMigrations(dbHandle.db);
});

const APP_ID = "app-program-acceptance";
const PROJECT = "project-acceptance";
const ACTOR = "worker-1";
const SESSION_CASE = "50000000-0000-0000-0000-000000000001";

const IDENTITY: ResolvedPreviewIdentity = {
	ownerId: ACTOR,
	session: {
		context: { userid: ACTOR, username: "ada" },
		user: { role: "supervisor" },
	},
};

function makeStore(): CaseStore {
	return new PostgresCaseStore({
		projectId: PROJECT,
		actorUserId: ACTOR,
		db: dbHandle.db as unknown as Kysely<Database>,
		sampleGenerator: new HeuristicCaseGenerator(),
	});
}

const OP_ROOT = asUuid("60000000-0000-7000-8000-00000000a001");
const OP_REPEAT = asUuid("60000000-0000-7000-8000-00000000a002");

/** One followup doc: a status writer (ordinary), a free root answer, and
 *  a repeat of visit notes — with `operations` built from the minted
 *  field uuids per test. */
function acceptanceDoc(
	operationsFor: (uuids: {
		status: Uuid;
		note: Uuid;
		extra: Uuid;
		visits: Uuid;
		visitNote: Uuid;
	}) => CaseOperation[],
): {
	doc: BlueprintDoc;
	formUuid: Uuid;
	uuids: {
		status: Uuid;
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
					{ name: "status", label: "Status", data_type: "text" },
					{ name: "op_status", label: "Op status", data_type: "text" },
					{ name: "visit_note", label: "Visit note", data_type: "text" },
				],
			},
		],
		modules: [
			{
				name: "Mod",
				caseType: "patient",
				forms: [
					{
						name: "Follow up",
						type: "followup",
						fields: [
							f({
								kind: "text",
								id: "status",
								label: "Status",
								case_property_on: "patient",
							}),
							f({ kind: "text", id: "note", label: "Note" }),
							f({ kind: "text", id: "extra", label: "Extra" }),
							f({
								kind: "repeat",
								id: "visits",
								label: "Visits",
								children: [
									f({ kind: "text", id: "visit_note", label: "Visit note" }),
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
		status: byId.get("status") as Uuid,
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

function engineFor(doc: BlueprintDoc, formUuid: Uuid): FormEngine {
	const input: FormEngineInput = {
		form: doc.forms[formUuid],
		formUuid,
		fields: doc.fields as FormEngineInput["fields"],
		fieldOrder: doc.fieldOrder as FormEngineInput["fieldOrder"],
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
			status: "open",
			properties: { status: "open" },
		},
	});
}

async function submit(doc: BlueprintDoc, engine: FormEngine, store: CaseStore) {
	const mutation = engine.computeSubmissionMutation({
		caseId: SESSION_CASE,
		caseTypes: doc.caseTypes ?? [],
	});
	const built = buildCaseOperationProgramFromDoc({
		blueprint: doc,
		mutation,
		identity: IDENTITY,
	});
	expect(built.program).toBeDefined();
	expect(built.ordinaryCaseType).toBe("patient");
	return store.applySubmission(submissionEnvelopeArgs(mutation, APP_ID, built));
}

async function loadCase(store: CaseStore, caseId: string) {
	const rows = await store.query({ appId: APP_ID, caseType: "patient" });
	return rows.find((row) => row.case_id === caseId);
}

describe("engine → builder → executor acceptance", () => {
	it("a root operation writes the collected answer; a blank answer leaves the key absent; the ordinary action lands last", async () => {
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
					{ property: "status", value: term(formField(ids.note)) },
				],
			} as CaseOperation,
		]);
		const store = makeStore();
		await seedSessionCase(store, doc);

		const engine = engineFor(doc, formUuid);
		engine.setValue("/data/note", "from-operation");
		engine.setValue("/data/status", "from-ordinary");

		const result = await submit(doc, engine, store);
		expect(result.primaryCaseId).toBe(SESSION_CASE);
		expect(result.operations).toHaveLength(1);
		expect(result.operations[0]?.executed).toBe(true);

		const row = await loadCase(store, SESSION_CASE);
		expect(row?.properties.op_status).toBe("from-operation");
		expect("visit_note" in (row?.properties ?? {})).toBe(false);
		expect(row?.properties.status).toBe("from-ordinary");
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
		// still carries a status write that must not survive the rollback.
		engine.setValue("/data/status", "should-roll-back");

		await expect(submit(doc, engine, store)).rejects.toThrow(
			SubmissionRejectedError,
		);
		const row = await loadCase(store, SESSION_CASE);
		expect(row?.properties.status).toBe("open");
	});

	it("operations present but no collected answer bags submits ordinary-only (doc-snapshot skew)", async () => {
		const { doc, formUuid } = acceptanceDoc((ids) => [
			{
				uuid: OP_ROOT,
				id: "op_root",
				action: "update",
				caseType: "patient",
				target: { kind: "session" },
				writes: [{ property: "op_status", value: term(formField(ids.note)) }],
			} as CaseOperation,
		]);
		const engine = engineFor(doc, formUuid);
		engine.setValue("/data/note", "collected");
		const mutation = engine.computeSubmissionMutation({
			caseId: SESSION_CASE,
			caseTypes: doc.caseTypes ?? [],
		});
		// A client whose doc snapshot predates the operation add sends NO
		// answer bags; the builder must fall back to ordinary-only, never
		// run the program with blank bindings (a blank write projects to
		// key-absent and would silently strip stored properties).
		const built = buildCaseOperationProgramFromDoc({
			blueprint: doc,
			mutation: { ...mutation, operationAnswers: undefined },
			identity: IDENTITY,
		});
		expect(built.program).toBeUndefined();
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
		expect("op_status" in (row?.properties ?? {})).toBe(false);
	});
});
