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
 * Scope: `nova.hq.import`, checked by its registration before anything runs:
 * a `changed`, `check_failed` or `held` answer carries a fresh read of the
 * app, and the create copies it into a Project. The create reads the app
 * again with the person's key and changes nothing in CommCare HQ.
 *
 * A `changed` answer carries a fresh read's first page, up to the 80,000
 * characters an account page fills, so the tool declares the large-result
 * ceiling `read_hq_app` declares for the same projection.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { createFromReview } from "@/lib/deployment/reading";
import { accountOfOne } from "@/lib/deployment/reading/answers";
import { OWNER_RULE_CHOICES } from "@/lib/deployment/reading/projectData/reviewTypes";
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
import { credentialWriteGrant, toolWriteGrant } from "../credentialWriteGrant";
import {
	type McpToolErrorResult,
	type McpToolSuccessResult,
	toMcpErrorResult,
} from "../errors";
import { fitPiece, toolText } from "../paging";
import { LARGE_RESULT_META } from "../resultSize";
import { registerScopedTool } from "../scopedTool";
import { SCOPES } from "../scopes";
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

/**
 * The two answers whose screen lead names something only the page does: the
 * page starts the next read itself and keeps the review on screen, while a
 * tool call has returned and the agent decides what comes next. Each says
 * what stands; the description says what to call.
 */
export const BRING_IN_TOOL_LEADS = {
	readAgain:
		"A lookup table this app reads changed in your Project while Nova was creating the app. No app was created. Any pictures and sounds Nova already added to your Project stay in its files, and bringing the app in uses them. Nova can read the app again and show you the review as it stands now.",
	held: "Nova stopped before creating anything. Your answers to the review still apply, so Nova can create the app from them once this is sorted.",
} as const;

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
			const appName = fitPiece(receipt.blueprint.appName);
			return {
				status: "created",
				app_id: receipt.appId,
				project_id: receipt.projectId,
				app_name: appName,
				url: `${AS_ORIGIN}/build/${receipt.appId}`,
				/* The app's id derives from the key, so the receipt's adoption is the key's. */
				brought_in_from: {
					server: key.server,
					domain: key.domain,
					hq_app_id: key.remoteAppId,
				},
				message: broughtInToolMessage(appName, key.domain),
			};
		}
		case "changed": {
			const message = changedLead(answer.now);
			return {
				status: "changed",
				message,
				reading: describeReading(answer.now, key, {
					...fresh,
					envelope: (reading) => ({ status: "changed", message, reading }),
				}),
			};
		}
		case "read-again":
			return {
				status: "read_again",
				message: BRING_IN_TOOL_LEADS.readAgain,
			};
		case "check-failed":
			return {
				status: "check_failed",
				message: CREATE_ANSWER_LEADS["check-failed"],
				reading: describeReading(accountOfOne(answer.finding, null), key, {
					...fresh,
					envelope: (reading) => ({
						status: "check_failed",
						message: CREATE_ANSWER_LEADS["check-failed"],
						reading,
					}),
				}),
			};
		case "held":
			return {
				status: "held",
				message: BRING_IN_TOOL_LEADS.held,
				stop: stopProjection(answer.finding, circumstanceContextFor(key, null)),
			};
	}
}

export function registerBringInHqApp(
	server: McpServer,
	ctx: ToolContext,
): void {
	registerScopedTool(
		server,
		ctx,
		"bring_in_hq_app",
		{
			description:
				"Create a Nova app from a CommCare HQ app that `read_hq_app` answered a review for. Call it only after the user has seen the review and answered it. Every answer is theirs: never choose the name, where the app runs, the date-and-time split, a lookup table's answer or an owner rule's answer for them, and never default to the preselected choice without saying so and hearing yes. Send the `project_id`, `domain` and `hq_app_id` the read was given, the `reading_id` it returned, and `review_digest`, the review they answered. `runs_only_on` and `split_datetime` together must be one of `review.runs_on`. `table_choices` holds one answer for each table whose review entry has a `choice`, on every page of the review, by tag, and `{}` where none has. `owner_rule_choices` holds one answer for each entry of `review.owner_rules`, by level: each names a level whose rule for which place owns a case can't find exactly one place in CommCare HQ's organization, and the user either gives those cases to the worker who fills in the form (`worker`) or changes the places in CommCare HQ and reads the app again; `{}` where it is empty. The result's `status` is `created` (the app exists, in that Project, and publishes back to the CommCare HQ app it came from); `changed` (something changed in CommCare HQ or the Project since the review, no app was created, and `reading` holds what stands now, to show the user again; where it is longer than one answer it is the first page, and `read_hq_app` with its `next_page` as `page` reads the rest); `read_again` (a lookup table the app reads changed in the Project while Nova was creating the app, and no app was created: call `read_hq_app` again and show the user the new review); `check_failed` (one of Nova's own checks stopped the create, no app was created, and `reading` holds what Nova reported); or `held` (no app was created and `stop` says why, such as a key CommCare HQ turned down). Creating changes nothing in CommCare HQ. A `bring_in_refused` error whose `refusal` is `publish_in_flight` means another Nova app's publish to that HQ app is still finishing, after someone stopped publishing it there: no app was created, the review stands, and the same call can be made again in a few minutes. If this call ends before you get an answer, call it again with the same arguments. It answers the app if it was created, and creates it if it was not. Before the first `upload_app_to_hq`, relay `first_publish`, from the chosen `review.runs_on` entry or from `check_project_space_compatibility`: `workers.lines` first, then `hq_only.lines`, each `sentence` as written, then `reassurance` where it is not null, then `note`.",
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
						"The app's name in Nova. review.app_name is CommCare HQ's, and empty where CommCare HQ holds none: ask the user whether to keep it, or for a name where it is empty.",
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
				owner_rule_choices: z
					.record(z.string(), z.enum(OWNER_RULE_CHOICES))
					.describe(
						'The user\'s answer for each entry of review.owner_rules, by its level. "worker" gives those cases to the worker who fills in the form. {} where review.owner_rules is empty.',
					),
			}),
			_meta: LARGE_RESULT_META,
		},
		async (args, extra): Promise<McpToolSuccessResult | McpToolErrorResult> => {
			try {
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
					ownerRuleChoices: args.owner_rule_choices,
				};
				const answer = await createFromReview(
					{
						...call.actor,
						requireOperation: toolWriteGrant(ctx, "bring_in_hq_app"),
					},
					input,
					{
						onEvent: bringInProgress(extra),
						requireInstallationManagement: credentialWriteGrant(
							ctx,
							"bring_in_hq_app",
							[SCOPES.hqImport, SCOPES.hqWrite],
						),
					},
				);
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
							text: toolText(bodyOf(answer, key, call.project)),
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
