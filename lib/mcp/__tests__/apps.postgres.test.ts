/** Saved-app discovery and deletion retain their independent authorization boundary. */
import { expect, it } from "vitest";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { loadApp } from "@/lib/db/apps";
import { registerDeleteApp } from "../tools/deleteApp";
import { registerGetApp } from "../tools/getApp";
import { registerListApps } from "../tools/listApps";
import { withMcpClient } from "./client";
import { resultContentText, resultText } from "./resultText";

const h = setupAppStateTestDb("mcp_apps_", { authSchema: "migrated" });
const ACTOR = "member";
const PROJECT = "shared-project";
const register: Parameters<typeof withMcpClient>[0] = (server) => {
	const context = {
		userId: ACTOR,
		scopes: ["nova.read", "nova.write"],
		authKind: "api-key" as const,
	};
	for (const tool of [registerDeleteApp, registerGetApp, registerListApps])
		tool(server, context);
};

it("reads and deletes a saved shared app while retaining its recoverable blueprint", async () => {
	const appId = await h.seedApp({ owner: "creator", project_id: PROJECT });
	await h.seedProjectMember(ACTOR, PROJECT, "admin");
	const before = await loadApp(appId);
	await withMcpClient(register, async (client) => {
		const read = await client.callTool({
			name: "get_app",
			arguments: { app_id: appId },
		});
		expect(read.isError).not.toBe(true);
		expect(JSON.parse(resultText(read))).toMatchObject({
			project: { id: PROJECT },
			app: { appId },
		});
		const deleted = await client.callTool({
			name: "delete_app",
			arguments: { app_id: appId },
		});
		expect(JSON.parse(resultText(deleted))).toMatchObject({
			stage: "app_deleted",
			app_id: appId,
			deleted: true,
		});
		expect((await h.readAppRow(appId))?.recoverable_until).toBeInstanceOf(Date);
		expect(
			await client.callTool({ name: "get_app", arguments: { app_id: appId } }),
		).toHaveProperty("isError", true);
		expect(
			JSON.parse(
				resultText(await client.callTool({ name: "list_apps", arguments: {} })),
			),
		).toEqual({ apps: [] });
	});
	expect((await loadApp(appId))?.blueprint).toEqual(before?.blueprint);
});

it("allows viewer reads, denies deletion, and conceals foreign and missing apps", async () => {
	const appId = await h.seedApp({ owner: "creator", project_id: PROJECT });
	await h.seedApp({
		id: "foreign",
		owner: "outsider",
		project_id: "foreign-project",
	});
	await h.seedProjectMember(ACTOR, PROJECT, "viewer");
	const before = await h.readAppRow(appId);
	await withMcpClient(register, async (client) => {
		expect(
			(await client.callTool({ name: "get_app", arguments: { app_id: appId } }))
				.isError,
		).not.toBe(true);
		for (const [name, id] of [
			["delete_app", appId],
			["get_app", "foreign"],
			["get_app", "missing"],
			["delete_app", "foreign"],
		]) {
			const result = await client.callTool({ name, arguments: { app_id: id } });
			expect(result.isError).toBe(true);
			expect(JSON.parse(resultContentText(result))).toMatchObject({
				error_type: "not_found",
				message: "App not found.",
			});
		}
	});
	expect(await h.readAppRow(appId)).toEqual(before);
});
