import type { Kysely, Transaction } from "kysely";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import {
	buildCaseTypeMap,
	type PreparedCasePropertyRenamePhaseB,
} from "@/lib/case-store";
import { PostgresCaseStore } from "@/lib/case-store/postgres/store";
import { HeuristicCaseGenerator } from "@/lib/case-store/sample/heuristic";
import type { Database } from "@/lib/case-store/sql/database";
import { commitGuardedBatchProposal } from "@/lib/db/__tests__/admittedWriterTestHelpers";
import type { Mutation } from "@/lib/doc/types";
import { setupAppStateTestDb } from "./appStateTestDb";

const OWNER = "rename-owner";
const PROJECT = "rename-project";
const CASE_ID = "rename-case";

const h = setupAppStateTestDb("rename_commit_");

function fixture() {
	return buildDoc({
		appName: "Rename app",
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: "Name", data_type: "text" },
					{ name: "a", label: "A", data_type: "text" },
					{ name: "b", label: "B", data_type: "text" },
				],
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Register patient",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "name_question",
								caseWrite: {
									caseType: "patient",
									property: "case_name",
								},
							}),
							f({
								kind: "text",
								id: "a_question",
								caseWrite: { caseType: "patient", property: "a" },
							}),
							f({
								kind: "text",
								id: "b_question",
								caseWrite: { caseType: "patient", property: "b" },
							}),
						],
					},
				],
			},
		],
	});
}

describe("case-property rename through the guarded writer", () => {
	it("atomically swaps live and parked keys with one exact accepted command", async () => {
		const initial = fixture();
		const appId = await h.seedAppWithBlueprint(initial, {
			owner: OWNER,
			projectId: PROJECT,
		});
		const caseStore = new PostgresCaseStore({
			projectId: PROJECT,
			actorUserId: OWNER,
			ownerId: OWNER,
			db: h.db() as unknown as Kysely<Database>,
			sampleGenerator: new HeuristicCaseGenerator(),
		});
		const caseDb = h.db() as unknown as Kysely<Database>;
		await caseStore.applySchemaChange({
			appId,
			caseType: "patient",
			caseTypeSchemas: buildCaseTypeMap(initial),
			syncedSeq: 0,
		});
		await caseStore.insert({
			appId,
			row: {
				case_id: CASE_ID,
				case_type: "patient",
				case_name: "Patient",
				modified_on: new Date("2025-01-02T03:04:05.000Z"),
				properties: { a: "alpha", b: "bravo" },
			},
		});
		await caseDb
			.insertInto("parked_case_values")
			.values([
				{
					id: testUuid("10000000-0000-4000-8000-000000000001"),
					app_id: appId,
					case_id: CASE_ID,
					case_type: "patient",
					property: "a",
					original_value: JSON.stringify({ source: "a" }),
					reason: "keep-a",
					from_type: "text",
					to_type: "int",
					dismissed_at: null,
					created_at: new Date("2025-02-01T00:00:00.000Z"),
				},
				{
					id: testUuid("10000000-0000-4000-8000-000000000002"),
					app_id: appId,
					case_id: CASE_ID,
					case_type: "patient",
					property: "b",
					original_value: JSON.stringify({ source: "b" }),
					reason: "keep-b",
					from_type: "text",
					to_type: "date",
					dismissed_at: new Date("2025-03-01T00:00:00.000Z"),
					created_at: new Date("2025-02-02T00:00:00.000Z"),
				},
			])
			.execute();

		const liveBefore = await caseDb
			.selectFrom("cases")
			.selectAll()
			.where("app_id", "=", appId)
			.where("case_id", "=", CASE_ID)
			.executeTakeFirstOrThrow();
		const parkedBefore = await caseDb
			.selectFrom("parked_case_values")
			.selectAll()
			.where("app_id", "=", appId)
			.orderBy("id")
			.execute();
		const command = {
			kind: "renameCaseProperties",
			renames: [
				{ caseType: "patient", from: "a", to: "b" },
				{ caseType: "patient", from: "b", to: "a" },
			],
		} satisfies Mutation;
		const batchId = crypto.randomUUID();
		let prepared: PreparedCasePropertyRenamePhaseB | undefined;

		const committed = await commitGuardedBatchProposal(
			{
				appId,
				expectedProjectId: PROJECT,
				batchId,
				mutations: [command],
				actorUserId: OWNER,
				kind: "autosave",
			},
			{
				beforeWrite: async ({ tx, nextDoc, seq, casePropertyRenamePlan }) => {
					if (casePropertyRenamePlan === undefined) {
						throw new Error("Guarded rename omitted its admitted plan.");
					}
					prepared = await caseStore.applyCasePropertyRenamePhaseA(
						tx as unknown as Transaction<Database>,
						{
							appId,
							desiredSeq: seq,
							caseTypeSchemas: buildCaseTypeMap(nextDoc),
							entries: casePropertyRenamePlan.entries,
						},
					);
				},
			},
		);
		if (prepared === undefined) {
			throw new Error("Guarded writer did not execute rename Phase A.");
		}
		await prepared.completeAfterCommit();

		expect(committed).toMatchObject({ seq: 1, deduped: false });
		const liveAfter = await caseDb
			.selectFrom("cases")
			.selectAll()
			.where("app_id", "=", appId)
			.where("case_id", "=", CASE_ID)
			.executeTakeFirstOrThrow();
		expect(liveAfter).toEqual({
			...liveBefore,
			properties: { a: "bravo", b: "alpha" },
		});
		const parkedAfter = await caseDb
			.selectFrom("parked_case_values")
			.selectAll()
			.where("app_id", "=", appId)
			.orderBy("id")
			.execute();
		expect(parkedAfter).toEqual([
			{ ...parkedBefore[0], property: "b" },
			{ ...parkedBefore[1], property: "a" },
		]);

		const fields = Object.values(committed.committedDoc.fields);
		const aField = fields.find((field) => field.id === "a_question");
		const bField = fields.find((field) => field.id === "b_question");
		expect(
			aField !== undefined && "caseWrite" in aField
				? aField.caseWrite
				: undefined,
		).toEqual({ caseType: "patient", property: "b" });
		expect(
			bField !== undefined && "caseWrite" in bField
				? bField.caseWrite
				: undefined,
		).toEqual({ caseType: "patient", property: "a" });

		const stream = await h
			.db()
			.selectFrom("app_changes")
			.select(["seq", "batch_id", "actor_id", "kind", "mutations"])
			.where("app_id", "=", appId)
			.execute();
		expect(stream).toEqual([
			{
				seq: "1",
				batch_id: batchId,
				actor_id: OWNER,
				kind: "autosave",
				mutations: [command],
			},
		]);
		expect((await h.readAppRow(appId))?.mutation_seq).toBe("1");
	});
});
