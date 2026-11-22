import { sql } from "kysely";
import { v7 } from "uuid";
import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { appTestNamespace } from "@/lib/case-store/appTestNamespace";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { listAppTests, readAppTestSteps } from "@/lib/db/appTests";
import { withAppTx } from "@/lib/db/pg";
import {
	lookupColumnIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import { applyLookupAuthoringBatchInTransaction } from "@/lib/lookup/authoringBatch";
import { authorizeLookupWriteInTransaction } from "@/lib/lookup/writerTransaction";
import { withCurrentAppTestProof } from "../lookupAccess";
import { continueAppTest, startAppTest } from "../service";

const h = setupAppStateTestDb("app_test_worker_lookup_", {
	authSchema: "migrated",
});
it("captures assigned rows per identity, reopens the original receipt under a current grant and withdraws all saved evidence when assignment changes", async () => {
	const scope = {
		appId: "visits",
		projectId: "health",
		actorUserId: "author",
		workerGrant: { kind: "session" as const, sessionId: "working-session" },
	};
	const { appId, projectId, actorUserId } = scope;
	const kaia = testUuid("app-test-kaia"),
		jo = testUuid("app-test-jo");
	await h.seedProjectMember(actorUserId, projectId, "owner");
	await h.seedProjectMember("colleague", projectId, "viewer");
	const save = (
		changes: Parameters<typeof applyLookupAuthoringBatchInTransaction>[2],
	) =>
		withAppTx(async (tx) =>
			applyLookupAuthoringBatchInTransaction(
				tx,
				await authorizeLookupWriteInTransaction(
					tx,
					{ projectId, actorId: actorUserId },
					"edit",
				),
				changes,
			),
		);
	const created = await save({
		createTables: [
			{
				key: "clinics",
				name: "Clinics",
				tag: "clinics",
				columns: [
					{ key: "name", wireName: "name", label: "Name", dataType: "text" },
				],
				rows: ["Lakeside", "Hilltop"].map((key) => ({
					key,
					cells: [{ columnKey: "name", value: key }],
				})),
			},
		],
	});
	const table = created.tables[0],
		tableId = lookupTableIdSchema.parse(table.tableId),
		col = lookupColumnIdSchema.parse(table.columnIds[0].id);
	const doc = {
		...buildDoc({
			modules: [
				{
					name: "Visits",
					forms: [
						{
							name: "Log visit",
							type: "survey",
							fields: [
								{
									kind: "single_select",
									id: "clinic",
									uuid: testUuid("app-test-clinic"),
									optionsSource: {
										kind: "lookup",
										tableId,
										valueColumnId: col,
										labelColumnId: col,
									},
								},
							],
						},
					],
				},
			],
		}),
		personas: {
			[kaia]: { uuid: kaia, name: "Kaia" },
			[jo]: { uuid: jo, name: "Jo" },
		},
		personaOrder: [kaia, jo],
	};
	await h.seedAppWithBlueprint(doc, {
		id: appId,
		projectId,
		owner: actorUserId,
	});
	await sql`INSERT INTO auth_session(id,token,"userId","expiresAt","createdAt","updatedAt") VALUES (${scope.workerGrant.sessionId},'local-test-token',${actorUserId},now()+interval '1 hour',now(),now())`.execute(
		h.db(),
	);
	const publicInput={requestId:"global",expectedBlueprintSeq:0,input:{purpose:"Check shared clinics"}};
	const wasPublic=await startAppTest(scope,publicInput);
	const viewer={...scope,actorUserId:"colleague"};
	expect((await readAppTestSteps({...viewer,testId:wasPublic.testId})).steps.length).toBeGreaterThan(0);
	const revision = table.revisions?.tableRevision;
	if (!revision) throw new Error("Missing created table revision.");
	const assigned = await save({
		operationId: v7(),
		updateTables: [
			{
				tableId,
				expectedTableRevision: revision,
				workerAccess: "assigned",
				rowOperations: table.rowIds.map((row, i) => ({
					kind: "assign" as const,
					rowId: row.id,
					assignments: [
						{ kind: "worker" as const, appId, id: i === 0 ? kaia : jo },
					],
				})),
			},
		],
	});
	const input = {
		requestId: "begin",
		expectedBlueprintSeq: 0,
		input: {
			purpose: "Visit a worker’s assigned clinic",
			sessions: [{ id: "field", personaUuid: "Kaia" }],
		},
	};
	await expect(startAppTest(scope,publicInput)).rejects.toThrow(/no longer available that way/);
	await expect(readAppTestSteps({...viewer,testId:wasPublic.testId})).rejects.toThrow(/no longer available that way/);
	expect(JSON.stringify(await listAppTests(viewer))).not.toContain(wasPublic.testId);
	const start = await startAppTest(scope, input);
	const { testId } = start;
	expect(await startAppTest(scope, input)).toEqual(start);
	const read = async (caller: typeof scope) =>
		readAppTestSteps({
			...(await withCurrentAppTestProof(caller, { testId })),
			testId,
		});
	expect((await read(scope)).steps.length).toBeGreaterThan(0);
	const other = { ...scope, actorUserId: "colleague" };
	await expect(read(other)).rejects.toThrow(/another author/);
	expect(JSON.stringify(await listAppTests(other))).not.toContain(testId);
	const initialRows = await sql<{
		lookup: unknown;
	}>`SELECT snapshot -> 'lookup' AS lookup FROM app_test_sessions WHERE id=${testId}`.execute(
		h.db(),
	);
	expect(JSON.stringify(initialRows.rows[0].lookup)).toContain("Lakeside");
	expect(JSON.stringify(initialRows.rows[0].lookup)).not.toContain("Hilltop");
	const inShared = await sql<{
		count: string;
	}>`SELECT count(*)::text AS count FROM ${sql.id(appTestNamespace(testId), "lookup_rows")}`.execute(
		h.db(),
	);
	expect(inShared.rows[0].count).toBe("0");
	const changeWorker = {
		testId,
		requestId: "change-worker",
		expectedStep: start.step,
		action: { kind: "identity", personaUuid: "Jo" },
	};
	const switched = await continueAppTest(scope, changeWorker);
	expect(switched.observation).toMatchObject({
		sessions: [{ personaUuid: jo }],
	});
	const retained = await sql<{
		workers: {
			personaUuid: string;
			rows: [string, { values: Record<string, string> }[]][];
		}[];
	}>`SELECT snapshot #> '{lookup,workers}' AS workers FROM app_test_sessions WHERE id=${testId}`.execute(
		h.db(),
	);
	expect(
		retained.rows[0].workers.map((worker) => [
			worker.personaUuid,
			worker.rows[0][1].map((row) => row.values[col]),
		]),
	).toEqual([
		[kaia, ["Lakeside"]],
		[jo, ["Hilltop"]],
	]);
	const nextRevision = assigned.tables[0].revisions?.tableRevision;
	if (!nextRevision) throw new Error("Missing assigned table revision.");
	await save({
		operationId: v7(),
		updateTables: [
			{
				tableId,
				expectedTableRevision: nextRevision,
				rowOperations: [
					{ kind: "assign", rowId: table.rowIds[0].id, assignments: [] },
				],
			},
		],
	});
	await expect(startAppTest(scope, input)).rejects.toThrow(
		/reconnect the original worker/,
	);
	await expect(continueAppTest(scope, changeWorker)).rejects.toThrow(
		/reconnect the original worker/,
	);
	await expect(read(scope)).rejects.toThrow(/reconnect the original worker/);
});
