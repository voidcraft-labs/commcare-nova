import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { emptyGenesisBase } from "@/lib/agent/change-set/baseLoader";
import { beginGenesisChangeSet } from "@/lib/agent/change-set/store";
import {
	beginPlanReview,
	finishPlanReview,
	writeAppPlan,
} from "@/lib/agent/planning/store";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { CommitReauthError, RunHolderLostError } from "@/lib/db/commitGuard";
import { createAndClaimDesignSessionRun } from "@/lib/db/designSessions";
import {
	applyAuthorizedLookupAuthoringBatch,
	readAuthorizedLookupCatalog,
} from "../agentService";
import type {
	LookupAgentWriteScope,
	LookupAuthoringBatchInput,
} from "../types";

const h = setupAppStateTestDb("lookup_agent_service_");
const APP_ID = "lookup-agent-app";
const PROJECT_ID = "lookup-agent-project";
const ACTOR_ID = "lookup-agent-user";
const RUN_ID = "lookup-agent-run";
const NONCE = "11111111-1111-4111-8111-111111111111";

async function seed(): Promise<LookupAgentWriteScope> {
	await h.seedApp({ id: APP_ID, owner: ACTOR_ID, project_id: PROJECT_ID });
	await h
		.db()
		.updateTable("apps")
		.set({
			lock_run_id: RUN_ID,
			lock_actor_user_id: ACTOR_ID,
			lock_expire_at: new Date(Date.now() + 60_000),
			run_holder_nonce: NONCE,
		})
		.where("id", "=", APP_ID)
		.execute();
	return {
		appId: APP_ID,
		projectId: PROJECT_ID,
		actorId: ACTOR_ID,
		runId: RUN_ID,
		requestId: "create-table",
		chatRunHolder: {
			source: "chat",
			mode: "edit",
			runId: RUN_ID,
			nonce: NONCE,
		},
	};
}

const createTable = {
	createTables: [
		{
			key: "table",
			name: "Table",
			tag: "table",
			columns: [
				{ key: "value", wireName: "value", label: "Value", dataType: "text" },
			],
			rows: [],
		},
	],
} satisfies LookupAuthoringBatchInput;

describe("lookup agent service authority", () => {
	it("reads during planning, writes only during construction, and replays an exact Project transaction", async () => {
		await h.seedProjectMember(ACTOR_ID, PROJECT_ID, "owner");
		const claim = await createAndClaimDesignSessionRun({
			projectId: PROJECT_ID,
			actorUserId: ACTOR_ID,
			runId: RUN_ID,
			cost: 1,
		});
		const authority = {
			sessionId: claim.designSessionId,
			projectId: PROJECT_ID,
			actorUserId: ACTOR_ID,
			runId: RUN_ID,
			holderNonce: claim.holderNonce,
		};
		const scope: LookupAgentWriteScope = {
			designSessionId: claim.designSessionId,
			projectId: PROJECT_ID,
			actorId: ACTOR_ID,
			runId: RUN_ID,
			requestId: "create-table",
			chatRunHolder: {
				source: "chat",
				mode: "build",
				runId: RUN_ID,
				nonce: claim.holderNonce,
			},
		};
		expect((await readAuthorizedLookupCatalog(scope)).definitions).toEqual([]);
		await expect(
			applyAuthorizedLookupAuthoringBatch(scope, createTable),
		).rejects.toThrow();
		await writeAppPlan({
			authority,
			writer: { editor: "architect" },
			requestId: "plan",
			expectedRevision: 0,
			change: { markdown: "Use a Project table for the lending catalog." },
		});
		const peer = await beginPlanReview(authority, "review");
		await finishPlanReview(authority, peer.reviewId);
		await expect(
			applyAuthorizedLookupAuthoringBatch(scope, createTable),
		).rejects.toMatchObject({ code: "invalid_input" });
		await beginGenesisChangeSet({
			lineage: { designSessionId: claim.designSessionId, planRevision: 1 },
			ownerUserId: ACTOR_ID,
			ownerRunId: RUN_ID,
			holderNonce: claim.holderNonce,
			proposedAppId: claim.proposedAppId,
			projectId: PROJECT_ID,
			baseSnapshotDigest: emptyGenesisBase(claim.proposedAppId).digest,
		});
		const created = await applyAuthorizedLookupAuthoringBatch(
			scope,
			createTable,
		);
		expect(
			await applyAuthorizedLookupAuthoringBatch(scope, createTable),
		).toEqual(created);
		expect(
			await h.db().selectFrom("lookup_tables").select("id").execute(),
		).toHaveLength(1);
		expect(await h.db().selectFrom("apps").select("id").execute()).toHaveLength(
			0,
		);
		await expect(
			applyAuthorizedLookupAuthoringBatch(scope, {
				createTables: [
					{ ...createTable.createTables[0], name: "Another table" },
				],
			}),
		).rejects.toMatchObject({ code: "invalid_input" });
		await beginPlanReview(authority, "another-review");
		await expect(
			applyAuthorizedLookupAuthoringBatch(scope, createTable),
		).rejects.toThrow();
	});

	it("rolls back a Project write when its receipt cannot commit", async () => {
		const scope = await seed();
		await expect(
			applyAuthorizedLookupAuthoringBatch(
				{ ...scope, requestId: "" },
				createTable,
			),
		).rejects.toThrow();
		expect(
			await h.db().selectFrom("lookup_tables").select("id").execute(),
		).toEqual([]);
		expect(
			await h
				.db()
				.selectFrom("lookup_authoring_receipts")
				.selectAll()
				.execute(),
		).toEqual([]);
	});
	it.each(["superseded", "expired"])(
		"checks the live chat holder before reads, writes and receipt replay after %s",
		async (reason) => {
			const scope = await seed();
			expect((await readAuthorizedLookupCatalog(scope)).definitions).toEqual(
				[],
			);
			const created = await applyAuthorizedLookupAuthoringBatch(
				scope,
				createTable,
			);
			expect(
				(await readAuthorizedLookupCatalog(scope)).definitions.map(
					(table) => table.id,
				),
			).toEqual([created.tables[0].tableId]);
			const before = await h
				.db()
				.selectFrom("lookup_tables")
				.selectAll()
				.execute();
			await h
				.db()
				.updateTable("apps")
				.set({
					...(reason === "superseded"
						? { run_holder_nonce: "22222222-2222-4222-8222-222222222222" }
						: { lock_expire_at: new Date(0) }),
				})
				.where("id", "=", APP_ID)
				.execute();
			await expect(readAuthorizedLookupCatalog(scope)).rejects.toBeInstanceOf(
				RunHolderLostError,
			);
			await expect(
				applyAuthorizedLookupAuthoringBatch(scope, createTable),
			).rejects.toBeInstanceOf(RunHolderLostError);
			expect(
				await h.db().selectFrom("lookup_tables").selectAll().execute(),
			).toEqual(before);
		},
	);

	it("makes a chat loss of edit capability terminal before writing", async () => {
		const scope = await seed();
		await h.seedProjectMember(ACTOR_ID, PROJECT_ID, "viewer");
		await expect(readAuthorizedLookupCatalog(scope)).rejects.toBeInstanceOf(
			CommitReauthError,
		);
		await expect(
			applyAuthorizedLookupAuthoringBatch(scope, createTable),
		).rejects.toBeInstanceOf(CommitReauthError);
		expect(
			await h.db().selectFrom("lookup_tables").selectAll().execute(),
		).toEqual([]);
	});

	it("fails closed for stale MCP Project and membership authority", async () => {
		const chatScope = await seed();
		const mcpScope: LookupAgentWriteScope = {
			appId: APP_ID,
			projectId: chatScope.projectId,
			actorId: chatScope.actorId,
			runId: chatScope.runId,
			requestId: "mcp-call",
		};
		expect((await readAuthorizedLookupCatalog(mcpScope)).definitions).toEqual(
			[],
		);
		await expect(
			readAuthorizedLookupCatalog({
				...mcpScope,
				projectId: "stale-project-id",
			}),
		).rejects.toMatchObject({ code: "not_found" });

		await sql`
			DELETE FROM auth_member
			WHERE "userId" = ${ACTOR_ID}
				AND "organizationId" = ${PROJECT_ID}
		`.execute(h.db());
		await expect(readAuthorizedLookupCatalog(mcpScope)).rejects.toMatchObject({
			code: "not_found",
		});
	});
});
