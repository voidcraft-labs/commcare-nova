/**
 * `nova.read_hq_changes`: what changed in CommCare HQ to an app Nova
 * publishes there, since Nova last published it, brought it in, or last
 * brought in changes from it, and whether those changes can come in.
 *
 * It calls the function the browser's review route calls
 * (`reviewHqChanges`), after the same authorization (`edit` on the app), with
 * the call's own cancellation signal and the call's progress for each stage.
 * There is no deadline of Nova's own. It writes nothing: the client holds the
 * `reading_id` and `review_digest` it returns and sends both to
 * `bring_in_hq_changes`. Every line of both lists is returned, and lists or
 * an account longer than one answer are paged as `read_hq_app` pages an
 * account, each page a fresh review held to the review the previous page was
 * cut from, so no host cuts an answer short in silence.
 *
 * The project space is the member's connection's, as `upload_app_to_hq`
 * resolves it: `domain` can be left out where the key reaches one.
 *
 * Scope: `nova.hq.read`, checked before any read. It changes nothing in Nova
 * or in CommCare HQ. Kept off the Solutions Architect, as every deployment
 * tool is.
 */

import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";
import { AppAccessError, resolveAppScope } from "@/lib/db/appAccess";
import { resolveHqTarget } from "@/lib/db/settings";
import {
	type HqChangesReview,
	reviewHqChanges,
} from "@/lib/deployment/hqChanges";
import { activeRemoteApp } from "@/lib/deployment/resources";
import {
	type DeploymentScope,
	type DeploymentTargetKey,
	readDeployment,
} from "@/lib/deployment/store";
import {
	deploymentAppIdSchema,
	deploymentTargetSchema,
} from "@/lib/deployment/types";
import type { Platform } from "@/lib/domain/platforms";
import { madeByLine } from "@/lib/publish/documentChangeCopy";
import type { DriftReference } from "@/lib/publish/driftReference";
import {
	CANNOT_BRING_IN_TOO_LARGE_LEAD,
	cannotBringInLead,
	hqChangesHeldLine,
	hqChangesLead,
	hqChangesUnavailableLine,
	NEXT_PUBLISH_LEAD,
	nothingToBringInLine,
	renamedInNovaLine,
	sincePhrase,
} from "@/lib/publish/hqChangesCopy";
import {
	BringInToolError,
	type McpToolErrorResult,
	type McpToolSuccessResult,
	toMcpErrorResult,
} from "../errors";
import { rethrowAsMcpAccess } from "../ownership";
import { createProgressEmitter, hqChangesProgressSink } from "../progress";
import { LARGE_RESULT_META } from "../resultSize";
import { assertScope, oauthScopeChallenge, SCOPES } from "../scopes";
import type { ToolContext } from "../types";
import {
	accountDigest,
	circumstanceContextFor,
	type ListedAccountProjection,
	listedAccountProjection,
	PAGE_LIMIT_CHARS,
	parseAccountPage,
	type StopProjection,
	stopProjection,
	tableProjection,
} from "./readingProjection";

// ---------------------------------------------------------------------------
// What both tools resolve before they act
// ---------------------------------------------------------------------------

/** The member's connection holds no CommCare HQ account. */
export const HQ_CHANGES_NOT_CONFIGURED =
	"CommCare HQ isn't connected for your account, so Nova can't read what changed there. You can add your CommCare HQ credentials in Settings.";

/** A `page` that is no cursor this tool gives, or one past the end of the account it names. */
const PAGE_NOT_GIVEN =
	"That page isn't one Nova gave for this app. You can call read_hq_changes without `page` to read it from the start.";

/**
 * After a `nothing` review that holds a digest: what sending it does. Until
 * it is sent the next upload still stops with `hq_changed`, since the
 * baseline it compares with is not CommCare HQ's save. Sending it moves only
 * the app's baseline, so a lookup table or a place changed in CommCare HQ
 * still stops the upload, and the sentence promises no more. It names the
 * tool's own parameters for a client, so it lives here and not in the
 * panel's copy.
 */
export const RECORD_NOTHING_NEXT =
	"Send this `reading_id` and `review_digest` to `bring_in_hq_changes` with `discard_nova_changes` false and `table_choices` {} to record what CommCare HQ holds now of this app. It changes nothing in this app, and the next upload here no longer stops for this app's change in CommCare HQ.";

/** The fresh review is no longer the review the page was cut from. */
const CHANGES_RESTARTED_MESSAGE =
	"CommCare HQ's copy or this app changed since the last page, so Nova read it again. Here is what Nova found, from the start.";

/** What both tools of changes made in CommCare HQ resolve before they read. */
export interface HqChangesCall {
	readonly scope: DeploymentScope;
	readonly target: DeploymentTargetKey;
}

/**
 * The member's `edit` on the app, as both routes authorize, then the server
 * and project space from their connection, as `upload_app_to_hq` resolves
 * them. Each refusal is the tool error its circumstance takes: an app the
 * caller cannot edit is `not_found`, whoever holds it.
 */
export async function openHqChangesCall(
	userId: string,
	appId: string,
	domain: string | undefined,
): Promise<HqChangesCall> {
	let access: Awaited<ReturnType<typeof resolveAppScope>>;
	try {
		access = await resolveAppScope(appId, userId, "edit");
	} catch (err) {
		if (err instanceof AppAccessError) rethrowAsMcpAccess(err);
		throw err;
	}
	const resolved = await resolveHqTarget(userId, domain);
	if (!resolved.ok) {
		if (resolved.error === "not_configured")
			throw new BringInToolError(
				"hq_not_configured",
				HQ_CHANGES_NOT_CONFIGURED,
			);
		const reachable = resolved.available.map((space) => space.name).join(", ");
		if (resolved.error === "not_authorized")
			throw new BringInToolError(
				"domain_not_authorized",
				`Your stored CommCare HQ API key can't reach the “${domain}” project space. It reaches: ${reachable}. Pass one of those as \`domain\`, or update your key in Settings.`,
			);
		throw new BringInToolError(
			"domain_ambiguous",
			`Your CommCare HQ API key reaches ${resolved.available.length} project spaces (${reachable}). Pass \`domain\` to choose which one.`,
		);
	}
	return {
		scope: {
			appId,
			projectId: access.projectId,
			role: access.role,
			actorUserId: userId,
		},
		target: { server: resolved.server, domain: resolved.domain.name },
	};
}

/** The call's progress, as the one event sink a review and a bring-in of changes report by. */
export function hqChangesProgress(extra: ServerContext) {
	return hqChangesProgressSink(
		createProgressEmitter(
			extra.mcpReq.notify,
			extra.mcpReq._meta?.progressToken,
		),
	);
}

// ---------------------------------------------------------------------------
// The review, as a client reads it
// ---------------------------------------------------------------------------

/** What each answer of a review names first: the app and the project space. */
interface ReviewHead {
	readonly app_id: string;
	readonly server: DeploymentTargetKey["server"];
	readonly domain: string;
}

/** A review of the changes made in CommCare HQ, as an MCP client reads it. */
export type HqChangesReviewProjection = ReviewHead &
	(
		| {
				readonly kind: "nothing";
				readonly reason: "unchanged" | "reads-the-same" | "already-here";
				readonly since: DriftReference;
				/** Why there is nothing to bring in. */
				readonly message: string;
				/** What the next publish changes in CommCare HQ, each a sentence. */
				readonly publish_changes: readonly string[];
				/** The lead over `publish_changes`, where it holds any. */
				readonly publish_changes_lead: string | null;
				/** Sent to `bring_in_hq_changes` to record what CommCare HQ holds; null for `unchanged`. */
				readonly reading_id: string | null;
				readonly review_digest: string | null;
				/** What sending the digest does, where there is one to send. */
				readonly next: string | null;
		  }
		| {
				readonly kind: "changes";
				readonly since: DriftReference;
				/** The lead over `hq_changes`. */
				readonly message: string;
				/** This page's lines of what bringing the changes in changes in this app. */
				readonly hq_changes: readonly string[];
				/** This page's lines of what that removes of the changes made in Nova; empty where it removes nothing. */
				readonly nova_changes: readonly string[];
				/** How many lines each list holds in all, across every page. */
				readonly hq_changes_total: number;
				readonly nova_changes_total: number;
				/** The `page` that reads the lines after this page's; null on the last page. */
				readonly next_page: string | null;
				/**
				 * Where a line is too long for one answer, it is cut into parts
				 * and each part is a page of its own: this page's one line is
				 * part `part` of `parts` of a line of `list`, and the parts
				 * joined in order are the line. Null where every line on the
				 * page is whole.
				 */
				readonly cut_line: CutLine | null;
				/** True where the call sent `page` and Nova answered the fresh review from its start. */
				readonly restarted: boolean;
				readonly restarted_message: string | null;
				/** Who made the changes in Nova, by name. */
				readonly made_by: readonly string[];
				/** The sentence that names them, where any is named. */
				readonly made_by_line: string | null;
				/** What happens to case data saved in Nova. */
				readonly case_data: readonly string[];
				readonly publish_changes: readonly string[];
				readonly publish_changes_lead: string | null;
				/** The digest a publish over this change names in `discard_hq_changes`. */
				readonly observed_digest: string;
				/** Case properties renamed in Nova since: while any is listed, the changes can't come in. */
				readonly renamed_in_nova: readonly {
					readonly case_type: string;
					readonly from: string;
					readonly to: string;
				}[];
				/** The sentence that says so, where any is listed. */
				readonly renamed_in_nova_line: string | null;
				/** The lookup tables the changed app newly reads, as `read_hq_app` lists a review's. */
				readonly tables: readonly ReturnType<typeof tableProjection>[];
				readonly reading_id: string;
				readonly review_digest: string;
		  }
		| {
				readonly kind: "account";
				/** Why nothing can come in. */
				readonly message: string;
				readonly account: ListedAccountProjection;
				/** True where the call sent `page` and Nova answered the fresh review from its start. */
				readonly restarted: boolean;
				readonly restarted_message: string | null;
		  }
		| {
				readonly kind: "held";
				readonly reason: Extract<HqChangesReview, { kind: "held" }>["reason"];
				readonly runs: {
					readonly app: readonly Platform[];
					readonly hq: readonly Platform[];
				} | null;
				readonly message: string;
		  }
		| {
				readonly kind: "unavailable";
				readonly reason: Extract<
					HqChangesReview,
					{ kind: "unavailable" }
				>["reason"];
				readonly since: DriftReference | null;
				readonly message: string;
		  }
		| { readonly kind: "stop"; readonly stop: StopProjection }
	);

/** The lines that follow what the next publish changes, or none. */
function publishChangesOf(lines: readonly string[]) {
	return {
		publish_changes: lines,
		publish_changes_lead: lines.length > 0 ? NEXT_PUBLISH_LEAD : null,
	};
}

/**
 * S4's lead, as the panel chooses it: where the account's one finding is that
 * CommCare HQ's version is too large, Nova read nothing, and the lead says so.
 */
function cannotBringInLeadFor(
	review: Extract<HqChangesReview, { readonly kind: "account" }>,
): string {
	const [only] = review.findings;
	return review.findings.length === 1 &&
		review.more === 0 &&
		only !== undefined &&
		only.subject === null &&
		only.code === "too-large"
		? CANNOT_BRING_IN_TOO_LARGE_LEAD
		: cannotBringInLead(review.findings.length + review.more);
}

/**
 * What a page of a review is cut from, and the digest its cursor carries: an
 * account's findings, or the lines of both lists of changes, CommCare HQ's
 * first. Null for a review no page is cut from.
 */
function pagedOf(
	review: HqChangesReview,
): { readonly length: number; readonly digest: string } | null {
	switch (review.kind) {
		case "account":
			return { length: review.findings.length, digest: accountDigest(review) };
		case "changes":
			return {
				length: changePieces(review.hqChanges, review.novaChanges).length,
				digest: review.reviewDigest,
			};
		default:
			return null;
	}
}

/**
 * Where a fresh review starts for a call that sent `cursor`, as `read_hq_app`
 * decides it: at the cursor's index where the review is the one the cursor
 * was cut from, from the start and `restarted` where it is another, and null
 * for an index past the end of the very review the cursor names.
 */
export function changesPageFor(
	review: HqChangesReview,
	cursor: { readonly from: number; readonly digest: string } | null,
): { readonly from: number; readonly restarted: boolean } | null {
	if (cursor === null) return { from: 0, restarted: false };
	const paged = pagedOf(review);
	if (paged === null || paged.digest !== cursor.digest)
		return { from: 0, restarted: true };
	if (cursor.from >= paged.length) return null;
	return { from: cursor.from, restarted: false };
}

/** A cursor at its longest, so a page measured with it fits whatever cursor it holds. */
const LONGEST_CHANGES_CURSOR = `99999:${"0".repeat(64)}`;

/** Which list a cut line is in, and which of its parts a page holds. */
export interface CutLine {
	readonly list: "hq_changes" | "nova_changes";
	/** 1-based. */
	readonly part: number;
	readonly parts: number;
}

/** A cut line's place at its longest, so a page measured with it fits whatever place it holds. */
const LONGEST_CUT_LINE: CutLine = {
	list: "nova_changes",
	part: 99_999,
	parts: 99_999,
};

/**
 * The most characters of JSON one part of a cut line takes, its quotes
 * included: a line longer than this is cut into parts no longer, each a page
 * of its own, so that part and the rest of the answer stay under
 * `PAGE_LIMIT_CHARS`. A line names menus, forms and questions by what the app
 * calls them, and no name or id has a length bound, so a line can be longer
 * than any answer.
 */
export const LINE_PART_MAX_CHARS = 60_000;

/** One line of a list, or one part of a line too long for one answer. */
interface ChangePiece {
	readonly list: CutLine["list"];
	readonly text: string;
	readonly part: number;
	readonly parts: number;
}

/** How many characters one code point takes in JSON, as `JSON.stringify` writes it. */
function jsonCharsOf(codePoint: number): number {
	if (codePoint === 0x22 || codePoint === 0x5c) return 2;
	if (codePoint < 0x20)
		return codePoint === 0x08 ||
			codePoint === 0x09 ||
			codePoint === 0x0a ||
			codePoint === 0x0c ||
			codePoint === 0x0d
			? 2
			: 6;
	/* A lone surrogate is written as an escape. */
	if (codePoint >= 0xd800 && codePoint <= 0xdfff) return 6;
	return codePoint > 0xffff ? 2 : 1;
}

/**
 * `line` cut into parts of at most `LINE_PART_MAX_CHARS` characters of JSON
 * each, never inside a code point; the line itself where it fits.
 */
export function lineParts(line: string): readonly string[] {
	if (JSON.stringify(line).length <= LINE_PART_MAX_CHARS) return [line];
	const budget = LINE_PART_MAX_CHARS - 2;
	const parts: string[] = [];
	let start = 0;
	let size = 0;
	let at = 0;
	for (const char of line) {
		const cost = jsonCharsOf(char.codePointAt(0) ?? 0);
		if (size + cost > budget) {
			parts.push(line.slice(start, at));
			start = at;
			size = 0;
		}
		size += cost;
		at += char.length;
	}
	parts.push(line.slice(start));
	return parts;
}

/** Every line of both lists, CommCare HQ's first, each line too long for one answer as its parts. */
function changePieces(
	hqLines: readonly string[],
	novaLines: readonly string[],
): readonly ChangePiece[] {
	const pieces: ChangePiece[] = [];
	for (const [list, lines] of [
		["hq_changes", hqLines],
		["nova_changes", novaLines],
	] as const) {
		for (const line of lines) {
			const parts = lineParts(line);
			for (const [index, text] of parts.entries())
				pieces.push({ list, text, part: index + 1, parts: parts.length });
		}
	}
	return pieces;
}

/**
 * The lines of both lists from `from`, as many as keep the whole answer
 * (`shell` with them) under `PAGE_LIMIT_CHARS`, and always one, so following
 * the cursors reaches the end. A line too long for one answer is cut into
 * parts (`lineParts`), each a page of its own that says which part it holds
 * (`cut_line`); the cursor counts parts, so no part is skipped or read twice.
 */
function changesPage(
	hqLines: readonly string[],
	novaLines: readonly string[],
	from: number,
	digest: string,
	measureShell: (lists: {
		readonly hq_changes: readonly string[];
		readonly nova_changes: readonly string[];
		readonly next_page: string | null;
		readonly cut_line: CutLine | null;
	}) => number,
) {
	const pieces = changePieces(hqLines, novaLines);
	const hq: string[] = [];
	const nova: string[] = [];
	let cutLine: CutLine | null = null;
	let size = measureShell({
		hq_changes: [],
		nova_changes: [],
		next_page: LONGEST_CHANGES_CURSOR,
		cut_line: LONGEST_CUT_LINE,
	});
	let end = from;
	while (end < pieces.length) {
		const piece = pieces[end] as ChangePiece;
		const cut = piece.parts > 1;
		/* A part of a cut line is a page of its own. */
		if (end > from && cut) break;
		const into = piece.list === "hq_changes" ? hq : nova;
		const added = JSON.stringify(piece.text).length + (into.length > 0 ? 1 : 0);
		if (end > from && size + added >= PAGE_LIMIT_CHARS) break;
		size += added;
		into.push(piece.text);
		end += 1;
		if (cut) {
			cutLine = { list: piece.list, part: piece.part, parts: piece.parts };
			break;
		}
	}
	return {
		hq_changes: hq,
		nova_changes: nova,
		next_page: end < pieces.length ? `${end}:${digest}` : null,
		cut_line: cutLine,
	};
}

/**
 * One review as a client reads it, every sentence the panel shows from the
 * same copy, dates as the UTC day. `remoteAppId` is the HQ app the
 * deployment's live mapping names, which an account's links open, in the
 * app's Project; `page` is where the account's page starts.
 */
export function describeHqChangesReview(
	review: HqChangesReview,
	head: ReviewHead,
	options: {
		readonly projectId: string;
		readonly remoteAppId: string | null;
		readonly page: { readonly from: number; readonly restarted: boolean };
	},
): HqChangesReviewProjection {
	const since = (reference: DriftReference) =>
		sincePhrase(reference, head.domain);
	switch (review.kind) {
		case "nothing":
			return {
				...head,
				kind: "nothing",
				reason: review.reason,
				since: review.since,
				message: nothingToBringInLine(review.reason, since(review.since)),
				...publishChangesOf(review.publishChanges),
				reading_id: review.readingId,
				review_digest: review.reviewDigest,
				next: review.reviewDigest === null ? null : RECORD_NOTHING_NEXT,
			};
		case "changes": {
			const project = review.projectName;
			const shell = {
				...head,
				kind: "changes" as const,
				since: review.since,
				message: hqChangesLead(
					since(review.since),
					review.novaChanges.length > 0,
				),
				hq_changes_total: review.hqChanges.length,
				nova_changes_total: review.novaChanges.length,
				restarted: options.page.restarted,
				restarted_message: options.page.restarted
					? CHANGES_RESTARTED_MESSAGE
					: null,
				made_by: review.madeBy,
				made_by_line:
					review.madeBy.length > 0 ? madeByLine(review.madeBy) : null,
				case_data: review.caseData,
				...publishChangesOf(review.publishChanges),
				observed_digest: review.observedDigest,
				renamed_in_nova: review.renamedInNova.map((rename) => ({
					case_type: rename.caseType,
					from: rename.from,
					to: rename.to,
				})),
				renamed_in_nova_line:
					review.renamedInNova.length > 0
						? renamedInNovaLine(review.renamedInNova)
						: null,
				tables: review.tables.map((table) =>
					tableProjection(table, project, head.domain),
				),
				reading_id: review.readingId,
				review_digest: review.reviewDigest,
			};
			return {
				...shell,
				...changesPage(
					review.hqChanges,
					review.novaChanges,
					options.page.from,
					review.reviewDigest,
					(lists) => JSON.stringify({ ...shell, ...lists }).length,
				),
			};
		}
		case "account": {
			const shell = {
				...head,
				kind: "account" as const,
				message: cannotBringInLeadFor(review),
				restarted: options.page.restarted,
				restarted_message: options.page.restarted
					? CHANGES_RESTARTED_MESSAGE
					: null,
			};
			/* A link into CommCare HQ needs the app's id there; with none, an
			 * account's places are named and not linked. */
			const key = {
				projectId: options.projectId,
				server: head.server,
				domain: head.domain,
				remoteAppId: options.remoteAppId ?? "",
			};
			const account = listedAccountProjection(
				review,
				key,
				circumstanceContextFor(head, null),
				options.page.from,
				(page) => JSON.stringify({ ...shell, account: page }).length,
			);
			return {
				...shell,
				account:
					options.remoteAppId === null
						? {
								...account,
								findings: account.findings.map((finding) => ({
									...finding,
									hq_url: null,
								})),
							}
						: account,
			};
		}
		case "held":
			return {
				...head,
				kind: "held",
				reason: review.reason,
				runs: review.runs,
				message: hqChangesHeldLine(review.reason, review.runs),
			};
		case "unavailable":
			return {
				...head,
				kind: "unavailable",
				reason: review.reason,
				since: review.since,
				message: hqChangesUnavailableLine(review.reason, {
					domain: head.domain,
					/* Every reason whose sentence names what the change is measured
					 * against carries it; the others name none. */
					since: review.since ?? { kind: "published" },
				}),
			};
		case "stop":
			return {
				...head,
				kind: "stop",
				stop: stopProjection(
					review.finding,
					circumstanceContextFor(head, null),
				),
			};
	}
}

/** The HQ app the deployment's live mapping names, which an account's links open. */
export async function liveRemoteAppId(
	call: HqChangesCall,
): Promise<string | null> {
	const deployment = await readDeployment(call.scope, call.target);
	return deployment === null
		? null
		: (activeRemoteApp(deployment)?.remoteId ?? null);
}

/** What each answer names first. */
export function reviewHead(call: HqChangesCall): ReviewHead {
	return {
		app_id: call.scope.appId,
		server: call.target.server,
		domain: call.target.domain,
	};
}

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

export function registerReadHqChanges(
	server: McpServer,
	ctx: ToolContext,
): void {
	server.registerTool(
		"read_hq_changes",
		{
			scopeChallenge: oauthScopeChallenge(ctx, SCOPES.hqRead),
			description:
				"Read what changed in CommCare HQ since Nova last published this app to a project space, or brought it in or last brought in changes from it. Changes nothing. Call it when `upload_app_to_hq` answers `hq_changed` with `can_bring_in` true on the app's change, or when the user asks what changed there. `hq_changes` lists what bringing the changes in changes in this app. `nova_changes` lists what that would remove of changes made in Nova since then: it is empty when nothing would be removed. Where the lists are longer than one answer, `next_page` is not null: call again with `page` set to it until it is, and if an answer says `restarted`, the lists changed and start again. Where `cut_line` is not null, the answer's one line is part `part` of `parts` of a line too long for one answer: the next answers hold the rest, and the parts joined in order are that line. Show the user every line of both lists and `made_by` before calling `bring_in_hq_changes` with the last answer's `reading_id` and `review_digest`. A `kind` of `nothing` with a `review_digest` means CommCare HQ saved the app and there is nothing to bring in: send that `reading_id` and `review_digest` to `bring_in_hq_changes` to record it, which changes nothing in the app, and the next upload no longer stops for this app's change in CommCare HQ. A `kind` of `account`, `held`, `unavailable` or `stop` means Nova can't bring the changes in: relay its sentences, which say what the user can do instead. An `unavailable` answer whose `reason` is `not-published`, `publishing-stopped` or `app-deleted` means nothing in that project space is this app's.",
			inputSchema: z.strictObject({
				app_id: deploymentAppIdSchema.describe(
					"The Nova app whose changes in CommCare HQ to read. Must be an app the user can edit.",
				),
				domain: deploymentTargetSchema.shape.domain
					.optional()
					.describe(
						"The CommCare HQ project space the app is published to, one of get_hq_connection's available_domains. Omit only when the key reaches a single space.",
					),
				page: z
					.string()
					.regex(/^\d{1,5}:[0-9a-f]{64}$/)
					.optional()
					.describe(
						"For lists or an account longer than one answer: the next_page of the previous answer.",
					),
			}),
			_meta: LARGE_RESULT_META,
		},
		async (args, extra): Promise<McpToolSuccessResult | McpToolErrorResult> => {
			try {
				assertScope(ctx, SCOPES.hqRead, "read_hq_changes");
				const cursor =
					args.page === undefined ? null : parseAccountPage(args.page);
				if (args.page !== undefined && cursor === null)
					throw new BringInToolError("invalid_input", PAGE_NOT_GIVEN);
				const call = await openHqChangesCall(
					ctx.userId,
					args.app_id,
					args.domain,
				);
				const review = await reviewHqChanges(call.scope, call.target, {
					onEvent: hqChangesProgress(extra),
					cancel: extra.mcpReq.signal,
				});
				const page = changesPageFor(review, cursor);
				if (page === null)
					throw new BringInToolError("invalid_input", PAGE_NOT_GIVEN);
				const projection = describeHqChangesReview(review, reviewHead(call), {
					projectId: call.scope.projectId,
					remoteAppId:
						review.kind === "account" ? await liveRemoteAppId(call) : null,
					page,
				});
				return {
					content: [{ type: "text", text: JSON.stringify(projection) }],
				};
			} catch (err) {
				return toMcpErrorResult(err, {
					appId: args.app_id,
					userId: ctx.userId,
					toolName: "read_hq_changes",
				});
			}
		},
	);
}
