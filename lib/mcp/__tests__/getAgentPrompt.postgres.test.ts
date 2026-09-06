/** Real stored documents, Project authorization, mutation commits and MCP
 * dispatch. A continuation rechecks both membership and the current snapshot. */
import { sql } from "kysely";
import { expect, it } from "vitest";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { commitGuardedBatch } from "@/lib/db/apps";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import type { AgentPromptPage } from "../promptDelivery";
import { renderAgentPrompt } from "../prompts";
import { registerGetAgentPrompt } from "../tools/getAgentPrompt";
import { withMcpClient } from "./client";
import { readPrompt, resultText } from "./promptClient";
import { promptDoc } from "./promptFixtures";

const h = setupAppStateTestDb("mcp_prompt_", { authSchema: "migrated" });
const PROJECT = "shared-project";
const OWNER = "author";
const VIEWER = "reader";
function register(userId = VIEWER): Parameters<typeof withMcpClient>[0] {
	return (server) =>
		registerGetAgentPrompt(server, {
			userId,
			scopes: ["nova.read", "nova.write"],
			authKind: "api-key",
		});
}
async function seed(large = false) {
	const doc = promptDoc(large);
	await h.seedAppWithBlueprint(doc, {
		id: doc.appId,
		owner: OWNER,
		projectId: PROJECT,
	});
	await h.seedProjectMember(VIEWER, PROJECT, "viewer");
	return doc;
}
function notFound(app_id: string) {
	return {
		isError: true,
		content: [
			{
				type: "text",
				text: JSON.stringify({
					error_type: "not_found",
					message: "App not found.",
					app_id,
				}),
			},
		],
	};
}

it("lets a Project viewer read the complete stored app without writing app state or events", async () => {
	const doc = await seed();
	const before = await h.readAppRow(doc.appId);
	await withMcpClient(register(), async (client) => {
		const prompt = await readPrompt((cursor) =>
			client.callTool({
				name: "get_agent_prompt",
				arguments: {
					mode: "edit",
					app_id: doc.appId,
					...(cursor ? { cursor } : {}),
				},
			}),
		);
		expect(prompt).toBe(renderAgentPrompt(true, doc));
		expect(prompt).toContain('Module "Clinic visits"');
		expect(prompt).toContain("patient_name");
	});
	expect(await h.readAppRow(doc.appId)).toEqual(before);
	expect(await h.db().selectFrom("events").selectAll().execute()).toEqual([]);
	expect(await h.db().selectFrom("app_changes").selectAll().execute()).toEqual(
		[],
	);
});
it("makes foreign-Project and nonexistent app probes indistinguishable", async () => {
	const doc = await seed();
	await withMcpClient(register("outsider"), async (client) => {
		for (const app_id of [doc.appId, "missing-app"]) {
			expect(
				await client.callTool({
					name: "get_agent_prompt",
					arguments: { mode: "edit", app_id },
				}),
			).toEqual(notFound(app_id));
		}
	});
});
it("reassembles a large stored app, refuses stale pages after a real commit, and restarts on the new snapshot", async () => {
	const doc = await seed(true);
	const expected = renderAgentPrompt(true, doc);
	expect(Buffer.byteLength(expected)).toBeGreaterThan(100_000);
	await withMcpClient(register(), async (client) => {
		const call = (cursor?: string) =>
			client.callTool({
				name: "get_agent_prompt",
				arguments: {
					mode: "edit",
					app_id: doc.appId,
					...(cursor ? { cursor } : {}),
				},
			});
		expect(await readPrompt(call)).toBe(expected);
		const first = JSON.parse(resultText(await call())) as AgentPromptPage;
		expect(first.complete).toBe(false);
		expect(first.next_cursor).toEqual(expect.any(String));
		const committed = await commitGuardedBatch({
			appId: doc.appId,
			expectedProjectId: PROJECT,
			actorUserId: OWNER,
			batchId: crypto.randomUUID(),
			kind: "autosave",
			mutations: admitMutationBatch([
				{ kind: "setAppName", name: "Updated tracker" },
			]),
		});
		expect(committed.seq).toBe(1);
		const stale = await call(first.next_cursor);
		expect(stale.isError).toBe(true);
		expect(stale.content).toEqual([
			{
				type: "text",
				text: JSON.stringify({
					error_type: "invalid_input",
					message:
						"The app or served prompt changed during get_agent_prompt pagination. Restart without cursor so pages cannot be mixed across snapshots.",
					app_id: doc.appId,
				}),
			},
		]);
		expect(await readPrompt(call)).toBe(
			renderAgentPrompt(true, { ...doc, appName: "Updated tracker" }),
		);
	});
});
it("refuses an already-issued continuation after membership is removed", async () => {
	const doc = await seed(true);
	await withMcpClient(register(), async (client) => {
		const args = { mode: "edit", app_id: doc.appId };
		const first = JSON.parse(
			resultText(
				await client.callTool({ name: "get_agent_prompt", arguments: args }),
			),
		) as AgentPromptPage;
		expect(first.next_cursor).toEqual(expect.any(String));
		await sql`DELETE FROM auth_member WHERE "userId" = ${VIEWER} AND "organizationId" = ${PROJECT}`.execute(
			h.db(),
		);
		expect(
			await client.callTool({
				name: "get_agent_prompt",
				arguments: { ...args, cursor: first.next_cursor },
			}),
		).toEqual(notFound(doc.appId));
	});
});
