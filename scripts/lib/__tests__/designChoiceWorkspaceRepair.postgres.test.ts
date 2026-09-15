import { describe, expect, it } from "vitest";
import { inspectAuthorizedProjectData } from "@/lib/agent/build/designLoopRunner";
import { did, FIXTURE_THREAD_ID } from "@/lib/agent/design/__tests__/fixtures";
import { insertDesignSourcePackage } from "@/lib/agent/design/artifactStore";
import { designArtifactWorkspaceOperationSchema } from "@/lib/agent/design/artifactWorkspaceOperations";
import {
	openDesignArtifactWorkspace,
	stageDesignArtifactWorkspace,
} from "@/lib/agent/design/artifactWorkspaceStore";
import { buildDesignSourcePackage } from "@/lib/agent/design/sourcePackage";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { completeAndSettleDesignSessionRun } from "@/lib/db/designSessions";
import {
	createLookupRow,
	createLookupTable,
	readLookupFixtureDataInTransaction,
	updateLookupRow,
} from "@/lib/lookup/service";
import {
	resetDesignChoiceWorkspace,
	scanDesignChoiceWorkspaces,
} from "../designChoiceWorkspaceRepair";

const h = setupAppStateTestDb();
const runId = "choice-evidence-repair";
const nonce = "6a0a35a4-1111-4222-8333-944445555668";

describe("historical design choice evidence repair", () => {
	it("detects bad evidence after source removal, blocks held runs, and retires only the private workspace", async () => {
		const sessionId = await h.seedDesignSession({
			owner_user_id: "owner-test",
			project_id: "proj-1",
			run_id: runId,
			run_holder_nonce: nonce,
			run_actor_user_id: "owner-test",
			run_lease_expires_at: new Date(Date.now() + 60_000),
			reservation: {
				period: "2026-08",
				reserved: 1,
				settled: false,
				userId: "owner-test",
				runId,
			},
		});
		const authority = {
			actorUserId: "owner-test",
			runId,
			holderNonce: nonce,
			expectedProjectId: "proj-1",
		};
		const pkg = await buildDesignSourcePackage({
			designSessionId: sessionId,
			projectId: "proj-1",
			threadId: FIXTURE_THREAD_ID,
			messages: [
				{
					id: "source",
					role: "user",
					parts: [{ type: "text", text: "Track patient priorities." }],
				},
			],
			deps: {
				loadAssets: async () => [],
				readExtract: async () => {
					throw new Error("No attachment");
				},
				loadImage: async () => {
					throw new Error("No image");
				},
			},
		});
		await insertDesignSourcePackage({ pkg, authority });
		const lineage = {
			schemaVersion: 1,
			artifactKind: "contract",
			sourcePackageDigest: pkg.packageDigest,
			reviewArtifacts: [],
		} as const;
		const workspace = await openDesignArtifactWorkspace({
			designSessionId: sessionId,
			lineage: { ...lineage, reviewArtifacts: [] },
			authority,
		});
		const scope = {
			projectId: "proj-1",
			actorId: "owner-test",
			role: "owner",
		} as const;
		const table = await createLookupTable(scope, {
			name: "Priorities",
			tag: "priorities",
			columns: [{ label: "Priority", wireName: "priority", dataType: "text" }],
		});
		const column = table.columns[0];
		if (column === undefined) throw new Error("Missing priority column");
		const row = await createLookupRow(scope, {
			tableId: table.id,
			expectedTableRevision: table.tableRevision,
			toIndex: 0,
			values: { [column.id]: "routine" },
		});
		const operationFor = (projectionDigest: string) =>
			designArtifactWorkspaceOperationSchema.parse({
				kind: "contract",
				collections: [
					{
						collection: "records",
						upserts: [
							{
								id: did(900),
								name: "Patient",
								purpose: "Track priorities",
								lifecycleStates: ["active"],
								properties: [
									{
										id: did(901),
										name: "priority",
										meaning: "Care priority",
										dataShape: "single-choice",
										sensitivity: "ordinary",
										choiceSource: {
											kind: "existing-project-lookup",
											tableId: table.id,
											valueColumnId: column.id,
											labelColumnId: column.id,
											inspection: {
												tableRevision: row.tableRevision,
												tableName: table.name,
												valueColumnLabel: column.label,
												labelColumnLabel: column.label,
												rowCount: 1,
												distinctValueCount: 1,
												invalidValueCount: 0,
												blankLabelCount: 0,
												duplicateValueCount: 0,
												projectionDigest,
											},
										},
									},
								],
							},
						],
						removeIds: [],
					},
				],
			});
		const snapshot = async () => ({
			workspaces: await h
				.db()
				.selectFrom("design_artifact_workspaces")
				.selectAll()
				.orderBy("id")
				.execute(),
			steps: await h
				.db()
				.selectFrom("design_artifact_workspace_steps")
				.selectAll()
				.orderBy("workspace_id")
				.orderBy("revision")
				.execute(),
			bindings: await h
				.db()
				.selectFrom("design_identity_handles")
				.selectAll()
				.orderBy("handle")
				.execute(),
			data: await h
				.db()
				.transaction()
				.execute((tx) =>
					readLookupFixtureDataInTransaction(tx, "proj-1", [table.id]),
				),
		});
		const inspected = await inspectAuthorizedProjectData(
			{
				actorUserId: "owner-test",
				designSessionId: sessionId,
				holderNonce: nonce,
				projectId: "proj-1",
				runId,
			},
			{
				tableId: table.id,
				choiceProjection: {
					valueColumnId: column.id,
					labelColumnId: column.id,
				},
			},
		);
		if (inspected.kind !== "rows" || inspected.choiceProjection === undefined)
			throw new Error("Missing inspected evidence");
		await stageDesignArtifactWorkspace({
			designSessionId: sessionId,
			lineage: { ...lineage, reviewArtifacts: [] },
			authority,
			toolCallId: "valid-source",
			expectedRevision: 0,
			operation: operationFor(
				inspected.choiceProjection.inspection.projectionDigest,
			),
		});
		const clean = await snapshot();
		expect(await scanDesignChoiceWorkspaces()).toMatchObject([
			{ standing: "clean", invalidProofs: 0 },
		]);
		expect(
			await resetDesignChoiceWorkspace(workspace.workspace.id),
		).toMatchObject({ standing: "clean", invalidProofs: 0 });
		expect(await snapshot()).toEqual(clean);
		// This was the pre-cutover path: the canonical store admitted structured
		// evidence from the model, while finalization checked it against data.
		await stageDesignArtifactWorkspace({
			designSessionId: sessionId,
			lineage: { ...lineage, reviewArtifacts: [] },
			authority,
			toolCallId: "old-source",
			expectedRevision: 1,
			operation: operationFor("0".repeat(64)),
			handleBindings: [
				{ handle: "@patient", designId: did(900), entityKind: "record" },
				{ handle: "@priority", designId: did(901), entityKind: "property" },
			],
		});
		await stageDesignArtifactWorkspace({
			designSessionId: sessionId,
			lineage: { ...lineage, reviewArtifacts: [] },
			authority,
			toolCallId: "remove-source",
			expectedRevision: 2,
			operation: {
				kind: "contract",
				collections: [
					{ collection: "records", upserts: [], removeIds: [did(900)] },
				],
			},
		});
		const before = await snapshot();
		expect(await scanDesignChoiceWorkspaces()).toMatchObject([
			{
				workspaceId: workspace.workspace.id,
				standing: "busy",
				invalidProofs: 1,
			},
		]);
		expect(
			await resetDesignChoiceWorkspace(workspace.workspace.id),
		).toMatchObject({ standing: "busy", invalidProofs: 1 });
		expect(await snapshot()).toEqual(before);
		expect(
			await completeAndSettleDesignSessionRun(sessionId, runId, nonce),
		).toBe("owned");
		expect(await scanDesignChoiceWorkspaces()).toMatchObject([
			{ standing: "repairable", invalidProofs: 1 },
		]);
		expect(await snapshot()).toEqual(before);
		expect(
			await resetDesignChoiceWorkspace(workspace.workspace.id),
		).toMatchObject({ standing: "reset", invalidProofs: 1 });
		const after = await snapshot();
		expect(after.steps).toEqual(before.steps);
		expect(after.bindings).toEqual(before.bindings);
		expect(after.data).toEqual(before.data);
		expect(after.workspaces).toEqual(
			before.workspaces.map((entry) => ({
				...entry,
				status: "superseded",
				updated_at: expect.any(Date),
			})),
		);
		expect(await scanDesignChoiceWorkspaces()).toEqual([]);
		expect(
			await resetDesignChoiceWorkspace(workspace.workspace.id),
		).toMatchObject({ standing: "superseded" });
		await updateLookupRow(scope, {
			tableId: table.id,
			expectedTableRevision: row.tableRevision,
			rowId: row.rowId,
			values: { [column.id]: "urgent" },
		});
		expect(await scanDesignChoiceWorkspaces()).toEqual([]);
	});
});
