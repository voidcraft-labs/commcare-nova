/** Authorized app overview, with the app's migration notices the caller has not dismissed (`notices`). Detailed content is available through scoped reads. */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { appOverview } from "@/lib/agent/appOverview";
import {
	resolveAppScopeInTransaction,
	type TransactionalAppScope,
} from "@/lib/db/appAccess";
import { loadAppInTransaction } from "@/lib/db/apps";
import { withAppTx } from "@/lib/db/pg";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { ensureReferenceIndex } from "@/lib/doc/referenceIndex";
import type { BlueprintDoc } from "@/lib/domain/blueprint";
import { documentNoticeNames } from "@/lib/notices/documentNames";
import {
	type AppMigrationNotice,
	orderNoticeEntries,
} from "@/lib/notices/migrationNotice";
import { renderNoticeEntry } from "@/lib/notices/migrationNoticeCopy";
import { readAppNoticesInTransaction } from "@/lib/notices/store";
import { listUserProjects } from "@/lib/projects/membership";
import {
	type McpToolErrorResult,
	type McpToolSuccessResult,
	toMcpErrorResult,
} from "../errors";
import { McpAccessError, rethrowAsMcpAccess } from "../ownership";
import { LARGE_RESULT_META } from "../resultSize";
import type { ToolContext } from "../types";

/** The most lines one notice returns; `truncated` says when there are more. */
const NOTICE_LINE_LIMIT = 50;

/**
 * One notice as an MCP client receives it: a count per reason, and the
 * lines in the order the builder's dialog shows them, each the renderer's
 * own sentence over the app's document as it is now.
 */
export function noticeForMcp(notice: AppMigrationNotice, doc: BlueprintDoc) {
	const names = documentNoticeNames(doc);
	const ordered = orderNoticeEntries(notice.entries);
	const summary: Record<string, number> = {};
	for (const entry of ordered) {
		summary[entry.reason] = (summary[entry.reason] ?? 0) + 1;
	}
	return {
		id: notice.id,
		created_at: notice.createdAt,
		summary,
		lines: ordered.slice(0, NOTICE_LINE_LIMIT).map((entry) => ({
			reason: entry.reason,
			text: renderNoticeEntry(entry, names).text,
			...(entry.kind === "document" && entry.entity.uuid !== undefined
				? { entity_uuid: entry.entity.uuid }
				: {}),
			...(entry.kind === "deployment"
				? {
						deployment: {
							deployment_id: entry.deployment.deploymentId,
							server: entry.deployment.server,
							domain: entry.deployment.domain,
						},
					}
				: {}),
		})),
		truncated: ordered.length > NOTICE_LINE_LIMIT,
	};
}

/**
 * The app's document and the caller's undismissed notices, read under one
 * `view` resolution in one transaction, so the notices are those of the app
 * the caller was just authorized on. A read fault fails the call as any other
 * database fault does, so an empty `notices` always means there are none.
 */
async function loadAppWithNotices(appId: string, userId: string) {
	const loaded = await withAppTx(async (tx) => {
		let scope: TransactionalAppScope;
		try {
			scope = await resolveAppScopeInTransaction(tx, appId, userId, "view");
		} catch (err) {
			rethrowAsMcpAccess(err);
		}
		const app = await loadAppInTransaction(tx, appId);
		if (!app) throw new McpAccessError("not_found");
		const notices = await readAppNoticesInTransaction(tx, { appId, userId });
		return { projectId: scope.projectId, blueprint: app.blueprint, notices };
	});
	const doc = hydratePersistedBlueprint(loaded.blueprint);
	ensureReferenceIndex(doc);
	return { projectId: loaded.projectId, doc, notices: loaded.notices };
}

/**
 * Register the single-argument `get_app` tool on an `McpServer`.
 *
 * `loadAppWithNotices` gates and loads the doc and the notices in one
 * transaction, throwing `McpAccessError` on a cross-tenant probe or a
 * vanished row.
 */
export function registerGetApp(server: McpServer, ctx: ToolContext): void {
	server.registerTool(
		"get_app",
		{
			description:
				"Get an app overview: workflows, record model, languages, and configured capabilities. Read individual modules, forms or fields for their content and settings.",
			_meta: LARGE_RESULT_META,
			inputSchema: z.object({
				app_id: z.string().describe("App ID. Requires access to its Project."),
			}),
		},
		async (args): Promise<McpToolSuccessResult | McpToolErrorResult> => {
			const appId = args.app_id;
			try {
				const loaded = await loadAppWithNotices(appId, ctx.userId);
				/* Name the app's Project from the caller's own memberships —
				 * the access gate just proved they belong to it, so the
				 * lookup can only miss on a mid-request membership change. */
				const projects = await listUserProjects(ctx.userId);
				const projectName = projects.find(
					(p) => p.id === loaded.projectId,
				)?.name;
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								project: {
									id: loaded.projectId,
									name: projectName ?? null,
								},
								app: appOverview(loaded.doc),
								notices: loaded.notices.map((notice) =>
									noticeForMcp(notice, loaded.doc),
								),
							}),
						},
					],
				};
			} catch (err) {
				return toMcpErrorResult(err, {
					appId,
					userId: ctx.userId,
				});
			}
		},
	);
}
