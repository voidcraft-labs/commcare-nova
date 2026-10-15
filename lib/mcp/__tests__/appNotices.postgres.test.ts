/** `get_app.notices` and `dismiss_app_notice` through the MCP SDK transport,
 * over real Postgres rows written as the cutover writes them. */
import { sql } from "kysely";
import { expect, it } from "vitest";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { registerDismissAppNotice } from "../tools/dismissAppNotice";
import { registerGetApp } from "../tools/getApp";
import { withMcpClient } from "./client";
import { resultContentText, resultText } from "./resultText";

const h = setupAppStateTestDb("mcp_app_notices_", { authSchema: "migrated" });
const PROJECT = "shared-project";
const CUTOVER = "hq-round-trip-emission";
const DEPLOYMENT_ID = "01992000-0000-7000-8000-000000000011";
const NO_SUCH_NOTICE =
	"This app has no notice with that ID. get_app lists the notices you can dismiss.";

const DEEP_LINKS = {
	kind: "deployment",
	reason: "deep-links-need-republish",
	deployment: {
		deploymentId: DEPLOYMENT_ID,
		server: "production",
		domain: "field-ops",
	},
};
const DISCARDED = {
	kind: "document",
	reason: "unsaved-assistant-work-discarded",
	entity: { type: "app", nameAtMigration: "Clinic visits" },
};

function registerAs(userId: string): Parameters<typeof withMcpClient>[0] {
	return (server) => {
		const context = {
			userId,
			scopes: ["nova.read", "nova.write"],
			authKind: "api-key" as const,
		};
		registerGetApp(server, context);
		registerDismissAppNotice(server, context);
	};
}

async function seedNotice(
	appId: string,
	entries: readonly unknown[],
): Promise<string> {
	const inserted = await sql<{ id: string }>`
		INSERT INTO app_migration_notices (app_id, cutover, entries)
		VALUES (${appId}, ${CUTOVER}, ${JSON.stringify(entries)}::jsonb)
		RETURNING id`.execute(h.db());
	const id = inserted.rows[0]?.id;
	if (id === undefined) throw new Error("No notice was inserted");
	return id;
}

async function dismissals(): Promise<number> {
	const result = await sql<{ count: number }>`
		SELECT count(*)::int AS count FROM app_migration_notice_dismissals`.execute(
		h.db(),
	);
	return result.rows[0]?.count ?? 0;
}

it("lists a notice's lines in the dialog's order, with its summary and truncation", async () => {
	const appId = await h.seedApp({ owner: "creator", project_id: PROJECT });
	await h.seedProjectMember("member", PROJECT, "editor");
	const discarded = Array.from({ length: 50 }, () => DISCARDED);
	const noticeId = await seedNotice(appId, [...discarded, DEEP_LINKS]);
	await withMcpClient(registerAs("member"), async (client) => {
		const read = JSON.parse(
			resultText(
				await client.callTool({
					name: "get_app",
					arguments: { app_id: appId },
				}),
			),
		);
		expect(read.notices).toHaveLength(1);
		const [notice] = read.notices;
		expect(notice).toMatchObject({
			id: noticeId,
			created_at: expect.any(String),
			summary: {
				"deep-links-need-republish": 1,
				"unsaved-assistant-work-discarded": 50,
			},
			truncated: true,
		});
		expect(notice.lines).toHaveLength(50);
		expect(notice.lines[0]).toEqual({
			reason: "deep-links-need-republish",
			text: "Links to field-ops that you already shared keep working. New ones are ready after the next publish there.",
			deployment: {
				deployment_id: DEPLOYMENT_ID,
				server: "production",
				domain: "field-ops",
			},
		});
		expect(notice.lines[1]).toEqual({
			reason: "unsaved-assistant-work-discarded",
			text: "Changes the assistant was still working on here were not saved before this update. The saved app is unchanged. Ask again to pick the work back up.",
		});
	});
});

it("dismisses a notice for the caller alone, a viewer included", async () => {
	const appId = await h.seedApp({ owner: "creator", project_id: PROJECT });
	await h.seedProjectMember("viewer", PROJECT, "viewer");
	await h.seedProjectMember("editor", PROJECT, "editor");
	const noticeId = await seedNotice(appId, [DEEP_LINKS]);
	await withMcpClient(registerAs("viewer"), async (client) => {
		const dismissed = await client.callTool({
			name: "dismiss_app_notice",
			arguments: { app_id: appId, notice_id: noticeId },
		});
		expect(JSON.parse(resultText(dismissed))).toEqual({
			dismissed: true,
			message: "Dismissed for you. Other members still see it.",
		});
		const read = JSON.parse(
			resultText(
				await client.callTool({
					name: "get_app",
					arguments: { app_id: appId },
				}),
			),
		);
		expect(read.notices).toEqual([]);
	});
	await withMcpClient(registerAs("editor"), async (client) => {
		const read = JSON.parse(
			resultText(
				await client.callTool({
					name: "get_app",
					arguments: { app_id: appId },
				}),
			),
		);
		expect(read.notices.map((notice: { id: string }) => notice.id)).toEqual([
			noticeId,
		]);
	});
});

it("answers a caller outside the Project as for any app, with no hint a notice exists", async () => {
	const appId = await h.seedApp({ owner: "creator", project_id: PROJECT });
	await h.seedProjectMember("outsider", "other-project", "owner");
	const noticeId = await seedNotice(appId, [DEEP_LINKS]);
	await withMcpClient(registerAs("outsider"), async (client) => {
		for (const call of [
			{ name: "get_app", arguments: { app_id: appId } },
			{
				name: "dismiss_app_notice",
				arguments: { app_id: appId, notice_id: noticeId },
			},
		]) {
			const result = await client.callTool(call);
			expect(result.isError).toBe(true);
			expect(JSON.parse(resultContentText(result))).toMatchObject({
				error_type: "not_found",
				message: "App not found.",
			});
		}
	});
	expect(await dismissals()).toBe(0);
});

it("refuses another app's notice id, or one that names no notice, and writes nothing", async () => {
	const appId = await h.seedApp({ owner: "creator", project_id: PROJECT });
	const otherAppId = await h.seedApp({
		id: "other-app",
		owner: "creator",
		project_id: PROJECT,
	});
	await h.seedProjectMember("member", PROJECT, "editor");
	await seedNotice(appId, [DEEP_LINKS]);
	const otherNoticeId = await seedNotice(otherAppId, [DEEP_LINKS]);
	await withMcpClient(registerAs("member"), async (client) => {
		for (const noticeId of [
			otherNoticeId,
			"01992000-0000-7000-8000-0000000000ff",
			"not-a-notice",
		]) {
			const result = await client.callTool({
				name: "dismiss_app_notice",
				arguments: { app_id: appId, notice_id: noticeId },
			});
			expect(result.isError).toBe(true);
			expect(JSON.parse(resultContentText(result))).toMatchObject({
				error_type: "invalid_input",
				message: NO_SUCH_NOTICE,
			});
		}
	});
	expect(await dismissals()).toBe(0);
});
