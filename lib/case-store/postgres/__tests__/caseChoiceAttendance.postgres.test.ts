import type { Kysely } from "kysely";
import { expect, it } from "vitest";
import {
	CLINIC_A,
	CLINIC_B,
	caseChoiceDoc,
	caseChoiceInput,
	caseChoiceSnapshot,
	choiceUuid,
	memberId,
} from "@/lib/__tests__/caseChoiceFixture";
import { assertAdmittedPreviewDoc } from "@/lib/preview/__tests__/fixtures/admittedDoc";
import { validateCaptureSubmissionProjection } from "@/lib/preview/engine/captureSubmissionValidation";
import {
	buildCaseOperationProgramFromDoc,
	submissionEnvelopeArgs,
} from "@/lib/preview/engine/caseDataBindingHelpers";
import { FormEngine } from "@/lib/preview/engine/formEngine";
import { previewAsMe } from "@/lib/preview/engine/identity";
import { HeuristicCaseGenerator } from "../../sample/heuristic";
import { setupPerTestDatabase } from "../../sql/__tests__/perTestDatabase";
import type { Database } from "../../sql/database";
import { buildCaseTypeMap } from "../../store";
import { PostgresCaseStore } from "../store";

const h = setupPerTestDatabase({
	schema: "migrated",
	databaseNamePrefix: "case_choices_",
});

it("offers only restored cases, includes relationship closure, and updates only final checklist membership", async () => {
	const doc = assertAdmittedPreviewDoc(caseChoiceDoc());
	const appId = doc.appId;
	const projectId = "case-choice-project";
	await h.pool.query(
		"INSERT INTO apps (id, owner, project_id, app_name, app_name_lower) VALUES ($1, 'worker-a', $2, 'Attendance', 'attendance')",
		[appId, projectId],
	);
	const store = new PostgresCaseStore({
		projectId,
		actorUserId: "worker-a",
		ownerId: "worker-a",
		db: h.db as Kysely<Database>,
		sampleGenerator: new HeuristicCaseGenerator(),
	});
	for (const caseType of doc.caseTypes ?? [])
		await store.applySchemaChange({
			appId,
			caseType: caseType.name,
			caseTypeSchemas: buildCaseTypeMap(doc),
		});
	const all = caseChoiceSnapshot();
	for (const row of all.rows) {
		// East's children belong to the worker's location; their parent is
		// retained by restore closure despite having a different owner.
		const owner =
			row.case_type === "member" && row.parent_case_id === CLINIC_A
				? "location-east"
				: "location-west";
		await h.pool.query(
			"INSERT INTO cases (case_id, app_id, project_id, owner_id, case_type, case_name, status, parent_case_id, properties) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'{}'::jsonb)",
			[
				row.case_id,
				appId,
				projectId,
				owner,
				row.case_type,
				row.case_name,
				row.status,
				row.parent_case_id,
			],
		);
	}
	for (const edge of all.indices)
		await h.pool.query(
			"INSERT INTO case_indices (case_id, ancestor_id, target_case_type, identifier, relationship, depth) VALUES ($1,$2,$3,$4,$5,$6)",
			[
				edge.case_id,
				edge.ancestor_id,
				edge.target_case_type,
				edge.identifier,
				edge.relationship,
				edge.depth,
			],
		);
	const cases = await store.readDeviceCaseDatabase({
		appId,
		restoreScope: { ownerIds: ["worker-a", "location-east"] },
	});
	expect(cases.rows.map((row) => row.case_id)).toContain(CLINIC_A);
	expect(cases.rows.map((row) => row.case_id)).not.toContain(CLINIC_B);
	const directory = new FormEngine(
		caseChoiceInput(doc),
		undefined,
		undefined,
		undefined,
		undefined,
		cases,
	);
	expect(
		directory.getState("/data/clinic").choices?.map((c) => c.value),
	).toEqual([CLINIC_A]);
	const identity = previewAsMe({ id: "worker-a", name: "Worker" }, doc);
	if (!identity) throw new Error("Expected a worker identity");
	const engine = new FormEngine(
		caseChoiceInput(doc, choiceUuid("attendance")),
		"clinic",
		new Map([["clinic", new Map([["case_id", CLINIC_A]])]]),
		identity,
		undefined,
		cases,
	);
	expect(engine.getState("/data/entry/attendees").choices).toHaveLength(30);
	engine.setValue("/data/entry/attendees", `${memberId(0)} ${memberId(1)}`);
	engine.enterSection(choiceUuid("review"));
	engine.enterSection(choiceUuid("entry"));
	engine.setValue("/data/entry/attendees", `${memberId(1)} ${memberId(29)}`);
	engine.enterSection(choiceUuid("review"));
	const mutation = engine.computeSubmissionMutation({
		caseIds: [CLINIC_A],
		entryKey: choiceUuid("submit"),
	});
	const built = buildCaseOperationProgramFromDoc({
		blueprint: doc,
		mutation,
		projection: validateCaptureSubmissionProjection(mutation),
		identity,
	});
	await store.applySubmission(
		submissionEnvelopeArgs(mutation, appId, {
			...built,
			submissionReceipt: {
				entryKey: choiceUuid("submit"),
				formUuid: choiceUuid("attendance"),
				expectedAppMutationSeq: 0,
				blueprintDigest: "0".repeat(64),
				requestDigest: "attendance-final",
			},
		}),
	);
	const persisted = await store.query({ appId, caseType: "member" });
	expect(persisted).toHaveLength(32);
	for (const row of persisted)
		expect(row.properties).toEqual(
			new Set<string>([memberId(1), memberId(29)]).has(row.case_id)
				? { attendance: "present" }
				: {},
		);
});
