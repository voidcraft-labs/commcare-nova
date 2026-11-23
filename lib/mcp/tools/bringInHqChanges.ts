/**
 * `nova.bring_in_hq_changes`: bring the changes `read_hq_changes` listed in
 * to the Nova app.
 *
 * It calls the function the browser's bring-in route calls
 * (`bringInHqChanges`), after the same authorization (`edit` on the app),
 * with the call's progress for each stage and no cancellation signal: once
 * asked, a bring-in runs to its end. There is no deadline of Nova's own.
 * Nothing is kept between the two tools: the bring-in reads CommCare HQ
 * again and acts only where its digest is the one the read returned, so a
 * repeated call answers the commit the first one made, or the review as it
 * now stands.
 *
 * `discard_nova_changes` exists here and not on the browser's route. A person
 * presses a button under the list they read; a model sends a call. So the
 * field is the client's statement that the person said yes to the list of
 * changes made in Nova: true is refused where the review lists none, and
 * false where it lists some, before anything is taken.
 *
 * Scope: `nova.hq.import`, checked by its registration before anything runs:
 * every answer but `brought-in` and `recorded` can carry what CommCare HQ
 * holds of the app now (a changed review's first page, the gate's findings),
 * and it brings that into the app. Nothing is sent to CommCare HQ. Kept off the
 * Solutions Architect, as every deployment tool is.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { DeploymentView } from "@/lib/deployment/actions";
import {
	bringInHqChanges,
	HqChangesDiscardMismatchError,
	type HqChangesOutcome,
} from "@/lib/deployment/hqChanges";
import {
	LOOKUP_TABLE_CHOICES,
	OWNER_RULE_CHOICES,
} from "@/lib/deployment/reading/projectData/reviewTypes";
import { READING_ID_PATTERN } from "@/lib/deployment/reading/types";
import {
	deploymentAppIdSchema,
	deploymentTargetSchema,
} from "@/lib/deployment/types";
import { firstPublishLines } from "@/lib/publish/firstPublishCopy";
import {
	broughtInLine,
	HQ_CHANGES_GATE_LEAD,
	HQ_CHANGES_GATE_NEXT,
	HQ_CHANGES_NOTHING_TAKEN_LINE,
	hqChangesMovedLine,
} from "@/lib/publish/hqChangesCopy";
import {
	BringInToolError,
	type McpToolErrorResult,
	type McpToolSuccessResult,
	toMcpErrorResult,
} from "../errors";
import {
	arrayItemChars,
	cutPage,
	fitPiece,
	fitsReviewResult,
	toolResultChars,
	toolText,
} from "../paging";
import { LARGE_RESULT_META } from "../resultSize";
import { registerScopedTool } from "../scopedTool";
import type { ToolContext } from "../types";
import {
	type DeploymentProjection,
	describeDeployment,
	describeFirstPublish,
	type FirstPublishProjection,
} from "./deploymentProjection";
import { landedNovaRevisions, landedOrganizationLevels } from "./landedReads";
import {
	describeHqChangesReview,
	type HqChangesCall,
	type HqChangesReviewProjection,
	hqChangesProgress,
	liveRemoteAppId,
	openHqChangesCall,
	reviewHead,
} from "./readHqChanges";

/** `discard_nova_changes` true where the review lists no change made in Nova. */
export const NOTHING_TO_DISCARD =
	"The review lists no change made in Nova that bringing these changes in would remove, so Nova brought nothing in. Send `discard_nova_changes` false to bring them in.";

/** `discard_nova_changes` false where the review lists changes made in Nova. */
export const DISCARD_NOT_AGREED =
	"Bringing these changes in removes every change listed in `nova_changes`, and this call didn't say the user agreed to lose them, so Nova brought nothing in. Show the user every line of `nova_changes`, and send `discard_nova_changes` true only once they say yes.";

/**
 * A `recorded` answer: what CommCare HQ holds of this app was recorded and
 * the app is as it was. Only the app's own baseline moves, so the sentence
 * promises no more than that the app's change stops no upload: a lookup table
 * or a place changed in CommCare HQ still stops the next one.
 */
export const RECORDED_LINE =
	"Nova recorded what CommCare HQ holds now of this app and changed nothing in it. The next upload here no longer stops for this app's change in CommCare HQ.";

/**
 * A `changed` answer whose `now` holds more lines than one answer carries:
 * `now` is its first page, and the client reads the rest with
 * `read_hq_changes` before it asks the person again, since the person may
 * agree to lose only changes they were shown.
 */
export const CHANGED_NOW_PAGED_NEXT =
	"`now` holds only the first page of what changed. Call `read_hq_changes` with `page` set to the `next_page` in `now`, and follow each answer's `next_page` until it is null. Show the user every line before you ask them again, and send the last answer's `reading_id` and `review_digest`.";

/** The deployment after a bring-in that landed, as `get_deployment` projects one. */
type LandedDeploymentProjection = DeploymentProjection & {
	readonly setup_artifact: DeploymentView["artifact"];
	/** What the next publish changes in CommCare HQ beyond the user's own edits, or null. */
	readonly first_publish: FirstPublishProjection | null;
};

/** What a bring-in answers, as a client reads it. */
export type HqChangesOutcomeProjection =
	| {
			readonly kind: "brought-in";
			/** The app's revision that holds the changes. */
			readonly seq: number;
			/** Whether changes made in Nova were removed. */
			readonly discarded: boolean;
			readonly message: string;
			/** Null where Nova could not read the record after the bring-in landed. */
			readonly deployment: LandedDeploymentProjection | null;
			/** Where to see the deployment when its details exceed one reply. */
			readonly next?: string;
	  }
	| {
			readonly kind: "recorded";
			readonly message: string;
			/** Null where Nova could not read the record after the record landed. */
			readonly deployment: LandedDeploymentProjection | null;
			/** Where to see the deployment when its details exceed one reply. */
			readonly next?: string;
	  }
	| {
			readonly kind: "changed";
			/** That the review moved while it was read (`hqChangesMovedLine`) over a list or nothing to
			 *  bring in; otherwise that nothing was brought in. */
			readonly message: string;
			/** The member whose edit moved the app, by name, where that is what changed. Present only
			 *  beside a `now` that lists changes or has nothing to bring in. */
			readonly edited_by?: string | null;
			/** The review as it now stands, to show the user before asking again. */
			readonly now: HqChangesReviewProjection;
			/** Where `now` is a first page, how to read the rest; otherwise null. */
			readonly next: string | null;
	  }
	| {
			readonly kind: "gate";
			readonly message: string;
			/** Each finding's own sentence, as many as one answer holds beside the rest. */
			readonly findings: readonly string[];
			/** How many findings the gate made, of which `findings` holds the first. */
			readonly findings_total: number;
			readonly next: string;
	  }
	| { readonly kind: "refused"; readonly message: string };

/**
 * The record a landed bring-in answers with, with its left-behind list as the
 * bring-in derived it and the revision CommCare HQ's copy now matches, left
 * out where Nova could not read it after the bring-in committed, and each
 * level a confirmation names read from the app as the bring-in left it; null
 * where the bring-in could not read the record itself.
 */
async function landedDeployment(
	call: HqChangesCall,
	view: DeploymentView | null,
): Promise<LandedDeploymentProjection | null> {
	if (view === null) return null;
	const projected = describeDeployment(
		view.deployment,
		/* The view already names what was left behind, by each resource's
		 * name now, so the projection's own derivation is not asked for it. */
		null,
		view.kept,
		await landedNovaRevisions(call.scope, call.target.domain, "bring-in"),
		/* Only a worker-level confirmation reads the app's levels, so the app is
		 * read again only for a record that holds one. */
		view.deployment.confirmations.some(
			(confirmation) => confirmation.kind === "worker-level",
		)
			? await landedOrganizationLevels(
					call.scope,
					call.target.domain,
					"bring-in",
				)
			: [],
	);
	return {
		...projected,
		left_behind: view.leftBehind.map((resource) => ({
			kind: resource.kind,
			hq_id: resource.remoteId,
			hq_name: resource.pushedIdentity,
		})),
		setup_artifact: view.artifact,
		first_publish:
			view.firstPublish === null
				? null
				: describeFirstPublish(firstPublishLines(view.firstPublish, "publish")),
	};
}

/** The cursor that reads the rest of a projected review, where it is a first page. */
function nextPageOf(now: HqChangesReviewProjection): string | null {
	switch (now.kind) {
		case "nothing":
			return now.next_page ?? null;
		case "changes":
			return now.next_page;
		case "account":
			return now.account.next_page;
		default:
			return null;
	}
}

/** One bring-in's answer as a client reads it. */
export async function describeHqChangesOutcome(
	outcome: HqChangesOutcome,
	call: HqChangesCall,
): Promise<HqChangesOutcomeProjection> {
	switch (outcome.kind) {
		case "brought-in":
		case "recorded": {
			const receipt =
				outcome.kind === "recorded"
					? { kind: outcome.kind, message: RECORDED_LINE }
					: {
							kind: outcome.kind,
							seq: outcome.seq,
							discarded: outcome.discarded,
							message: broughtInLine(outcome.discarded),
						};
			const answer = {
				...receipt,
				deployment: await landedDeployment(call, outcome.deployment),
			};
			if (fitsReviewResult(answer)) return answer;
			return {
				...receipt,
				deployment: null,
				next: "The deployment details exceed one answer. Open Publishing in the Nova app to see them.",
			};
		}
		case "changed": {
			const editor =
				"editedBy" in outcome && outcome.editedBy
					? fitPiece(outcome.editedBy, 4096)
					: null;
			const changedMessage =
				"editedBy" in outcome
					? hqChangesMovedLine(editor)
					: HQ_CHANGES_NOTHING_TAKEN_LINE;
			const now = describeHqChangesReview(outcome.now, reviewHead(call), {
				projectId: call.scope.projectId,
				remoteAppId:
					outcome.now.kind === "account" ? await liveRemoteAppId(call) : null,
				page: { from: 0, restarted: false },
				/* The page is cut against the whole answer it goes out in. */
				envelope: (projected) => ({
					kind: "changed",
					message: changedMessage,
					...("editedBy" in outcome && { edited_by: editor }),
					now: projected,
					next: CHANGED_NOW_PAGED_NEXT,
				}),
			});
			return {
				kind: "changed",
				/* That the review moved stands only over a list or a standing
				 * with nothing to bring in. Over any other review (a failed read of CommCare
				 * HQ, an account, a held or unavailable change) nothing need
				 * have moved, and `now` says why nothing was brought in. */
				message: changedMessage,
				...("editedBy" in outcome && { edited_by: editor }),
				now,
				next: nextPageOf(now) === null ? null : CHANGED_NOW_PAGED_NEXT,
			};
		}
		case "gate": {
			/* A gate's answer is no list a client reads again, so it holds as
			 * many of the findings as one answer holds and says how many there
			 * are. */
			const shell = {
				kind: "gate" as const,
				message: HQ_CHANGES_GATE_LEAD,
				findings: [] as string[],
				findings_total: outcome.details.length,
				next: HQ_CHANGES_GATE_NEXT,
			};
			const findings: string[] = [];
			const fitted = (index: number) =>
				fitPiece(outcome.details[index] as string);
			cutPage({
				count: outcome.details.length,
				from: 0,
				shellChars: toolResultChars(shell),
				pieceChars: (index, taken) => arrayItemChars(fitted(index), taken),
				take: (index) => findings.push(fitted(index)),
			});
			return { ...shell, findings };
		}
		case "refused":
			return { kind: "refused", message: outcome.message };
	}
}

export function registerBringInHqChanges(
	server: McpServer,
	ctx: ToolContext,
): void {
	registerScopedTool(
		server,
		ctx,
		"bring_in_hq_changes",
		{
			description:
				"Bring the changes `read_hq_changes` listed in to this Nova app. Send back its `reading_id` and `review_digest`. Set `discard_nova_changes` to false when `nova_changes` was empty. When it was not empty, bringing the changes in removes every change listed there and Nova can't put them back: set it to true only after the user has read that list and said yes. It also records a `nothing` review that holds a `review_digest`: the answer is `recorded`, and the app is unchanged. An answer of `changed` brought nothing in: `now` is the review as it stands now, and its own message says why (CommCare HQ or the app moved since the read, or reading CommCare HQ again stopped). Show the user `message` and `now`, and ask again. Where `next` is not null, `now` is only the first page of its lists: read the rest with `read_hq_changes`, passing the `next_page` in `now` as `page`, and show the user every line before you ask again. `gate` lists what would stop working; the user can change that in Nova and you can read again.",
			inputSchema: z.strictObject({
				app_id: deploymentAppIdSchema.describe(
					"The Nova app: the app_id read_hq_changes was given.",
				),
				domain: deploymentTargetSchema.shape.domain
					.optional()
					.describe(
						"The CommCare HQ project space: the domain read_hq_changes was given. Omit only when the key reaches a single space.",
					),
				reading_id: z
					.string()
					.regex(READING_ID_PATTERN)
					.describe("The reading_id read_hq_changes returned."),
				review_digest: z
					.string()
					.regex(/^[0-9a-f]{64}$/)
					.describe("The review_digest read_hq_changes returned."),
				discard_nova_changes: z
					.boolean()
					.describe(
						"True only where nova_changes was not empty and the user agreed to lose every change listed there; false where it was empty.",
					),
				table_choices: z
					.record(z.string(), z.enum(LOOKUP_TABLE_CHOICES))
					.describe(
						"The user's answer for each lookup table in the review's tables whose entry has a choice, by tag. {} where none has.",
					),
				owner_rule_choices: z
					.record(z.string(), z.enum(OWNER_RULE_CHOICES))
					.optional()
					.describe(
						"The user's answer for each entry of the review's owner_rules, by its level. \"worker\" gives those cases to the worker who fills in the form. Omit, or send {}, where owner_rules is empty.",
					),
			}),
			_meta: LARGE_RESULT_META,
		},
		async (args, extra): Promise<McpToolSuccessResult | McpToolErrorResult> => {
			try {
				const call = await openHqChangesCall(
					ctx.userId,
					args.app_id,
					args.domain,
				);
				let outcome: HqChangesOutcome;
				try {
					outcome = await bringInHqChanges(
						call.scope,
						call.target,
						{
							readingId: args.reading_id,
							reviewDigest: args.review_digest,
							tableChoices: args.table_choices,
							ownerRuleChoices: args.owner_rule_choices ?? {},
							discardNovaChanges: args.discard_nova_changes,
						},
						{ onEvent: hqChangesProgress(extra) },
					);
				} catch (err) {
					if (err instanceof HqChangesDiscardMismatchError)
						throw new BringInToolError(
							"invalid_input",
							err.reviewRemoves ? DISCARD_NOT_AGREED : NOTHING_TO_DISCARD,
						);
					throw err;
				}
				return {
					content: [
						{
							type: "text",
							text: toolText(await describeHqChangesOutcome(outcome, call)),
						},
					],
				};
			} catch (err) {
				return toMcpErrorResult(err, {
					appId: args.app_id,
					userId: ctx.userId,
					toolName: "bring_in_hq_changes",
				});
			}
		},
	);
}
