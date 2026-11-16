/**
 * `nova.bring_in_hq_app`: create the Nova app a person reviewed with
 * `read_hq_app`, from their answers to that review.
 *
 * It calls the function the browser's create route calls
 * (`createFromReview`), after the same authorization, with the call's
 * progress and no cancellation signal: once asked, a create runs to its end.
 * The Project, the project space and the app are arguments because nothing is
 * stored for a `reading_id` to stand for: the create reads the app again and
 * proves by the digest that it is what the person reviewed. A repeated call
 * with the same arguments answers the app the first one made. Every answer is
 * the person's, so no input is optional and none has a default.
 *
 * Scope: `nova.hq.write`, checked before any read: the create records a
 * deployment that authorizes later writes to that HQ app. Nothing is sent to
 * CommCare HQ.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { createFromReview } from "@/lib/deployment/reading";
import { accountOfOne } from "@/lib/deployment/reading/answers";
import {
	type BringInInput,
	type CreateAnswer,
	READING_ID_PATTERN,
	type ReadingAnswer,
	type ReadingKey,
} from "@/lib/deployment/reading/types";
import { AS_ORIGIN } from "@/lib/hostnames";
import { broughtInToolMessage } from "@/lib/publish/bringInCopy";
import { CREATE_ANSWER_LEADS } from "@/lib/publish/hqReadingCopy";
import {
	type McpToolErrorResult,
	type McpToolSuccessResult,
	toMcpErrorResult,
} from "../errors";
import { assertScope, oauthScopeChallenge, SCOPES } from "../scopes";
import type { ToolContext } from "../types";
import { bringInProgress, openBringInCall } from "./readHqApp";
import {
	circumstanceContextFor,
	describeReading,
	mapReadingRefusal,
	type ReadingProjection,
	type StopProjection,
	stopProjection,
} from "./readingProjection";

/** What a create answers, as a client reads it. A refusal is a tool error. */
type BringInBody =
	| {
			status: "created";
			app_id: string;
			project_id: string;
			app_name: string;
			url: string;
			brought_in_from: {
				server: ReadingKey["server"];
				domain: string;
				hq_app_id: string;
			};
			message: string;
	  }
	| { status: "changed"; message: string; reading: ReadingProjection }
	| { status: "read_again"; message: string }
	| { status: "check_failed"; message: string; reading: ReadingProjection }
	| { status: "held"; message: string; stop: StopProjection };

/** The lead the screen sets above a `changed` answer, by what stands now. */
function changedLead(now: ReadingAnswer): string {
	if (now.kind === "stop" && now.finding.code === "already-in-nova")
		return CREATE_ANSWER_LEADS.changed["already-in-nova"];
	return CREATE_ANSWER_LEADS.changed[now.kind];
}

function bodyOf(
	answer: Exclude<CreateAnswer, { kind: "refused" }>,
	key: ReadingKey,
	project: string,
): BringInBody {
	const fresh = { from: 0, restarted: false, project };
	switch (answer.kind) {
		case "created": {
			const { receipt } = answer;
			return {
				status: "created",
				app_id: receipt.appId,
				project_id: receipt.projectId,
				app_name: receipt.blueprint.appName,
				url: `${AS_ORIGIN}/build/${receipt.appId}`,
				/* The app's id derives from the key, so the receipt's adoption is the key's. */
				brought_in_from: {
					server: key.server,
					domain: key.domain,
					hq_app_id: key.remoteAppId,
				},
				message: broughtInToolMessage(receipt.blueprint.appName, key.domain),
			};
		}
		case "changed":
			return {
				status: "changed",
				message: changedLead(answer.now),
				reading: describeReading(answer.now, key, fresh),
			};
		case "read-again":
			return {
				status: "read_again",
				message: CREATE_ANSWER_LEADS["read-again"],
			};
		case "check-failed":
			return {
				status: "check_failed",
				message: CREATE_ANSWER_LEADS["check-failed"],
				reading: describeReading(
					accountOfOne(answer.finding, null),
					key,
					fresh,
				),
			};
		case "held":
			return {
				status: "held",
				message: CREATE_ANSWER_LEADS.held,
				stop: stopProjection(answer.finding, circumstanceContextFor(key, null)),
			};
	}
}

export function registerBringInHqApp(
	server: McpServer,
	ctx: ToolContext,
): void {
	server.registerTool(
		"bring_in_hq_app",
		{
			scopeChallenge: oauthScopeChallenge(ctx, SCOPES.hqWrite),
			description:
				"Create a Nova app from a CommCare HQ app that `read_hq_app` answered a review for. Call it only after the user has seen the review and answered it. Every answer is theirs: never choose the name, where the app runs, the date-and-time split or a lookup table's answer for them, and never default to the preselected choice without saying so and hearing yes. Send the `project_id`, `domain` and `hq_app_id` the read was given, the `reading_id` it returned, and `review_digest`, the review they answered. `runs_only_on` and `split_datetime` together must be one of `review.runs_on`. `table_choices` holds one answer for each table whose review entry has a `choice`, by tag, and `{}` where none has. The result's `status` is `created` (the app exists, in that Project, and publishes back to the CommCare HQ app it came from); `changed` (something changed in CommCare HQ or the Project since the review, no app was created, and `reading` holds what stands now, to show the user again); `read_again` (a lookup table the app reads changed in the Project while Nova was creating the app, and no app was created: call `read_hq_app` again and show the user the new review); `check_failed` (one of Nova's own checks stopped the create, no app was created, and `reading` holds what Nova reported); or `held` (no app was created and `stop` says why, such as a key CommCare HQ turned down). Creating changes nothing in CommCare HQ. If this call ends before you get an answer, call it again with the same arguments. It answers the app if it was created, and creates it if it was not. Before the first `upload_app_to_hq`, relay `first_publish`, from the chosen `review.runs_on` entry or from `check_project_space_compatibility`: `workers.lines` first, then `hq_only.lines`, each `sentence` as written, then `reassurance` where it is not null, then `note`.",
			inputSchema: z.strictObject({
				project_id: z
					.string()
					.min(1)
					.max(255)
					.describe(
						"The Nova Project the app is added to: the project_id read_hq_app was given.",
					),
				domain: z
					.string()
					.trim()
					.min(1)
					.describe(
						"The CommCare HQ project space: the domain read_hq_app was given.",
					),
				hq_app_id: z
					.string()
					.regex(/^[\w-]{1,255}$/)
					.describe("The app: the hq_app_id read_hq_app was given."),
				reading_id: z
					.string()
					.regex(READING_ID_PATTERN)
					.describe("The reading_id read_hq_app returned with the review."),
				review_digest: z
					.string()
					.regex(/^[0-9a-f]{64}$/)
					.describe("review.review_digest of the review the user answered."),
				app_name: z
					.string()
					.trim()
					.min(1)
					.max(255)
					.describe(
						"The app's name in Nova. review.app_name is CommCare HQ's; ask the user whether to keep it.",
					),
				runs_only_on: z
					.enum(["web-apps", "android"])
					.nullable()
					.describe(
						"Where the app runs: null for Web Apps and Android, or one platform. The user's choice among review.runs_on.",
					),
				split_datetime: z
					.boolean()
					.describe(
						"Whether date and time questions are asked as a date and a time. Must match the chosen review.runs_on entry.",
					),
				table_choices: z
					.record(z.string(), z.enum(["use-commcare-hq", "use-project"]))
					.describe(
						"The user's answer for each lookup table whose review entry has a choice, by tag. {} where none has.",
					),
			}),
		},
		async (args, extra): Promise<McpToolSuccessResult | McpToolErrorResult> => {
			try {
				assertScope(ctx, SCOPES.hqWrite, "bring_in_hq_app");
				const call = await openBringInCall(
					ctx.userId,
					args.project_id,
					args.domain,
				);
				const input: BringInInput = {
					projectId: args.project_id,
					server: call.server,
					domain: args.domain,
					remoteAppId: args.hq_app_id,
					readingId: args.reading_id,
					reviewDigest: args.review_digest,
					appName: args.app_name,
					runsOnlyOn: args.runs_only_on,
					splitDatetime: args.split_datetime,
					tableChoices: args.table_choices,
				};
				const answer = await createFromReview(call.actor, input, {
					onEvent: bringInProgress(extra),
				});
				if (answer.kind === "refused")
					throw mapReadingRefusal(answer.refusal, args.project_id);
				const key: ReadingKey = {
					projectId: input.projectId,
					server: input.server,
					domain: input.domain,
					remoteAppId: input.remoteAppId,
				};
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(bodyOf(answer, key, call.project)),
						},
					],
				};
			} catch (err) {
				return toMcpErrorResult(err, {
					userId: ctx.userId,
					toolName: "bring_in_hq_app",
				});
			}
		},
	);
}
