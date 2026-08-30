import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { makeCanonicalGenesisDoc } from "@/lib/agent/__tests__/fixtures";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { CommitReauthError, RunHolderLostError } from "@/lib/db/commitGuard";
import {
	applyAuthorizedLookupAuthoringBatch,
	readAuthorizedLookupCatalog,
} from "../agentService";
import type { LookupAgentWriteScope } from "../types";

const h = setupAppStateTestDb("lookup_agent_service_");
const APP_ID = "lookup-agent-app";
const PROJECT_ID = "lookup-agent-project";
const ACTOR_ID = "lookup-agent-user";
const RUN_ID = "lookup-agent-run";
const NONCE = "11111111-1111-4111-8111-111111111111";

async function seed(): Promise<LookupAgentWriteScope> {
	await h.seedAppWithBlueprint(
		makeCanonicalGenesisDoc("Lookup agent", APP_ID),
		{
			id: APP_ID,
			owner: ACTOR_ID,
			projectId: PROJECT_ID,
		},
	);
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
		chatRunHolder: {
			source: "chat",
			mode: "edit",
			runId: RUN_ID,
			nonce: NONCE,
		},
	};
}

describe("lookup agent service authority", () => {
	it("holds the app authority proof through a catalog read", async () => {
		const scope = await seed();
		expect((await readAuthorizedLookupCatalog(scope)).definitions).toEqual([]);
		await h
			.db()
			.updateTable("apps")
			.set({
				run_holder_nonce: "22222222-2222-4222-8222-222222222222",
			})
			.where("id", "=", APP_ID)
			.execute();
		await expect(readAuthorizedLookupCatalog(scope)).rejects.toBeInstanceOf(
			RunHolderLostError,
		);
	});

	it("makes a chat loss of edit capability terminal before writing", async () => {
		const scope = await seed();
		await h.seedProjectMember(ACTOR_ID, PROJECT_ID, "viewer");
		await expect(readAuthorizedLookupCatalog(scope)).rejects.toBeInstanceOf(
			CommitReauthError,
		);
		await expect(
			applyAuthorizedLookupAuthoringBatch(scope, {
				createTables: [
					{
						key: "table",
						name: "Table",
						tag: "table",
						columns: [
							{
								key: "value",
								wireName: "value",
								label: "Value",
								dataType: "text",
							},
						],
						rows: [],
					},
				],
			}),
		).rejects.toBeInstanceOf(CommitReauthError);
	});

	it("fails closed for stale MCP Project and membership authority", async () => {
		const chatScope = await seed();
		const mcpScope: LookupAgentWriteScope = {
			appId: chatScope.appId,
			projectId: chatScope.projectId,
			actorId: chatScope.actorId,
			runId: chatScope.runId,
		};
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
