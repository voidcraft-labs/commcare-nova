/**
 * `nova.read_hq_app`: one whole read of a CommCare HQ app for a Nova Project,
 * answering whether it can be brought in: a review, an account of what Nova
 * cannot hold, or a stop.
 *
 * It calls the function the browser's read route calls
 * (`readHqAppForReview`), after the same authorization (`authorizeBringIn`),
 * with the call's own cancellation signal and the call's progress, through
 * the one event sink a bring-in reports by. Nothing is kept: the client holds
 * the `reading_id` and `review_digest` it returns and sends both to
 * `bring_in_hq_app`. An account longer than one answer is paged, each page a
 * fresh read held to the account the previous page was cut from.
 *
 * Scope: `nova.hq.read`, checked before any read. It writes nothing in Nova
 * or in CommCare HQ.
 */

import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";
import { isValidDomainSlug } from "@/lib/commcare/client";
import type { CommCareServer } from "@/lib/commcare/servers";
import { getCommCareSettings } from "@/lib/db/settings";
import {
	authorizeBringIn,
	type BringInActor,
	readHqAppForReview,
} from "@/lib/deployment/reading";
import type { ReadingKey } from "@/lib/deployment/reading/types";
import { listUserProjects } from "@/lib/projects/membership";
import { READ_HQ_APP_NOT_CONFIGURED } from "@/lib/publish/bringInCopy";
import {
	BringInToolError,
	type McpToolErrorResult,
	type McpToolSuccessResult,
	toMcpErrorResult,
} from "../errors";
import { createProgressEmitter, readingProgressSink } from "../progress";
import { LARGE_RESULT_META } from "../resultSize";
import { assertScope, oauthScopeChallenge, SCOPES } from "../scopes";
import type { ToolContext } from "../types";
import {
	describeReading,
	mapReadingRefusal,
	pageFor,
	parseAccountPage,
} from "./readingProjection";

/** A `page` that is no cursor this tool gives, or one past the end of the account it names. */
const PAGE_NOT_GIVEN =
	"That page isn't one Nova gave for this app. You can call read_hq_app without `page` to read it from the start.";

/** What both bring-in tools resolve before they read: the person, the server, the Project's name. */
export interface BringInCall {
	readonly actor: BringInActor;
	readonly server: CommCareServer;
	/** The name of the Project the app is added to. */
	readonly project: string;
}

/**
 * The server from the caller's connection, the project space held to a slug,
 * and the caller's `edit` in the Project, in that order: each refusal is the
 * tool error its circumstance takes.
 */
export async function openBringInCall(
	userId: string,
	projectId: string,
	domain: string,
): Promise<BringInCall> {
	const settings = await getCommCareSettings(userId);
	if (!settings.configured)
		throw new BringInToolError("hq_not_configured", READ_HQ_APP_NOT_CONFIGURED);
	if (!isValidDomainSlug(domain))
		throw mapReadingRefusal("invalid_input", projectId);
	const actor = await authorizeBringIn(userId, projectId);
	if (actor === null) throw mapReadingRefusal("no_project_access", projectId);
	const project = (await listUserProjects(userId)).find(
		(one) => one.id === projectId,
	);
	/* Edit was granted a moment ago; a membership gone since is the same refusal. */
	if (project === undefined)
		throw mapReadingRefusal("no_project_access", projectId);
	return { actor, server: settings.server, project: project.name };
}

/** The call's progress, as the one event sink a bring-in reports by. */
export function bringInProgress(extra: ServerContext) {
	return readingProgressSink(
		createProgressEmitter(
			extra.mcpReq.notify,
			extra.mcpReq._meta?.progressToken,
		),
	);
}

export function registerReadHqApp(server: McpServer, ctx: ToolContext): void {
	server.registerTool(
		"read_hq_app",
		{
			scopeChallenge: oauthScopeChallenge(ctx, SCOPES.hqRead),
			description:
				"Read one CommCare HQ app so it can be brought in to Nova, and say whether it can be. Nothing is created, nothing is kept and nothing changes in CommCare HQ. Send `project_id`, `domain` and `hq_app_id`: where the user can edit more than one Nova Project, ask which one the app should be added to and never choose it for them, because an app that reads lookup tables stays in the Project it is added to; where they can edit one, tell them which it is. One call is one whole read. `state` is one of: `review`, with `reading_id` and `review` (what will be created; `runs_on`, the ways the app can run, each with `first_publish`, what the first upload from Nova changes in CommCare HQ under that choice; what stays in CommCare HQ; and `review.review_digest`); `account`, with `account.findings`, each thing Nova cannot hold, where it is, and whether it is Nova's to build, something Nova does not bring in, or something to change in CommCare HQ; or `stop`, with `stop`, something that ended the read such as a permission, a plan without API access, or an app already in Nova. Relay titles, sentences and next steps as written, and do not summarize an account as a failure: it is everything Nova found on this read, and `check_again` says a later read may find more. For a `first_publish`, relay `workers.lines` first, then `hq_only.lines`, each `sentence` as written, then `reassurance` where it is not null, then `note`. To check again after a change in CommCare HQ or a Nova update, call this tool again. An account longer than one answer is paged: pass `page` with the `next_page` it gave. Each page reads the app again, and where the app changed since the last page the answer starts over with `restarted` true. An app with many pictures and sounds can take a few minutes, and Nova reports progress while it works. If your client stops waiting before the answer comes, the app can be read in Nova in a browser.",
			inputSchema: z.strictObject({
				project_id: z
					.string()
					.min(1)
					.max(255)
					.describe("The Nova Project the user chose to add the app to."),
				domain: z
					.string()
					.trim()
					.min(1)
					.describe("The exact CommCare HQ project space the app is in."),
				hq_app_id: z
					.string()
					.regex(/^[\w-]{1,255}$/)
					.describe("The app's hq_app_id from list_hq_apps."),
				page: z
					.string()
					.regex(/^\d{1,5}:[0-9a-f]{64}$/)
					.optional()
					.describe(
						"For an account longer than one answer: the next_page of the previous answer.",
					),
			}),
			_meta: LARGE_RESULT_META,
		},
		async (args, extra): Promise<McpToolSuccessResult | McpToolErrorResult> => {
			try {
				assertScope(ctx, SCOPES.hqRead, "read_hq_app");
				const page =
					args.page === undefined ? null : parseAccountPage(args.page);
				if (args.page !== undefined && page === null)
					throw new BringInToolError("invalid_input", PAGE_NOT_GIVEN);
				const call = await openBringInCall(
					ctx.userId,
					args.project_id,
					args.domain,
				);
				const key: ReadingKey = {
					projectId: args.project_id,
					server: call.server,
					domain: args.domain,
					remoteAppId: args.hq_app_id,
				};
				const answer = await readHqAppForReview(call.actor, key, {
					onEvent: bringInProgress(extra),
					cancel: extra.mcpReq.signal,
				});
				const start = pageFor(answer, page);
				if (start === null)
					throw new BringInToolError("invalid_input", PAGE_NOT_GIVEN);
				const projection = describeReading(answer, key, {
					...start,
					project: call.project,
				});
				return {
					content: [{ type: "text", text: JSON.stringify(projection) }],
				};
			} catch (err) {
				return toMcpErrorResult(err, {
					userId: ctx.userId,
					toolName: "read_hq_app",
				});
			}
		},
	);
}
