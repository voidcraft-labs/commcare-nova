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
 * `bring_in_hq_changes`. Every line of both lists is returned, with every
 * case property renamed in Nova since, every table the changed app newly
 * reads and every member who changed the app, and lists or an account longer
 * than one answer are paged as `read_hq_app` pages an account, each page a
 * fresh review held to the review the previous page was cut from, so no host
 * cuts an answer short in silence.
 *
 * The project space is the member's connection's, as `upload_app_to_hq`
 * resolves it: `domain` can be left out where the key reaches one.
 *
 * Scope: `nova.hq.import`, checked by its registration before anything runs:
 * its answer is what CommCare HQ holds of the app. It changes nothing in Nova
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
import type { ReviewTable } from "@/lib/deployment/reading/types";
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
	cannotBringInLead,
	hqChangesHeldLine,
	hqChangesLead,
	hqChangesUnavailableLine,
	NEXT_PUBLISH_LEAD,
	nothingToBringInLine,
	novaLimitLead,
	renamedInNovaLine,
	sincePhrase,
} from "@/lib/publish/hqChangesCopy";
import { cutFindingName } from "@/lib/publish/hqFindings";
import {
	BringInToolError,
	type McpToolErrorResult,
	type McpToolSuccessResult,
	toMcpErrorResult,
} from "../errors";
import { rethrowAsMcpAccess } from "../ownership";
import {
	arrayItemChars,
	cutPage,
	fitPiece,
	PIECE_MAX_CHARS,
	toolText,
} from "../paging";
import { createProgressEmitter, hqChangesProgressSink } from "../progress";
import { LARGE_RESULT_META } from "../resultSize";
import { registerScopedTool } from "../scopedTool";
import type { ToolContext } from "../types";
import {
	accountDigest,
	circumstanceContextFor,
	type ListedAccountProjection,
	listedAccountProjection,
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
				/**
				 * Where CommCare HQ now keeps what the app doesn't hold (a form's
				 * id, the case id a create keyed by an answer files under, a
				 * file's path), each a sentence, which recording the read
				 * follows; empty where nothing moved.
				 */
				readonly hq_changes: readonly string[];
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
				/** How many each list holds in all, across every page. */
				readonly hq_changes_total: number;
				readonly nova_changes_total: number;
				readonly renamed_in_nova_total: number;
				readonly tables_total: number;
				readonly made_by_total: number;
				/** The `page` that reads what follows this page's; null on the last page. */
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
				/** This page's names of who made the changes in Nova. */
				readonly made_by: readonly string[];
				/** The sentence that names them all, where any is named. */
				readonly made_by_line: string | null;
				/** What happens to case data saved in Nova. */
				readonly case_data: readonly string[];
				readonly publish_changes: readonly string[];
				readonly publish_changes_lead: string | null;
				/** The digest a publish over this change names in `discard_hq_changes`. */
				readonly observed_digest: string;
				/** This page's case properties renamed in Nova since: while any is listed, the changes can't come in. */
				readonly renamed_in_nova: readonly RenameProjection[];
				/** The sentence that names this page's, where it holds any. */
				readonly renamed_in_nova_line: string | null;
				/** This page's lookup tables the changed app newly reads, as `read_hq_app` lists a review's. */
				readonly tables: readonly TableProjection[];
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

/** One case property renamed in Nova, as a client reads it. */
interface RenameProjection {
	readonly case_type: string;
	readonly from: string;
	readonly to: string;
}

type TableProjection = ReturnType<typeof tableProjection>;

/** The lines that follow what the next publish changes, or none. */
function publishChangesOf(lines: readonly string[]) {
	return {
		publish_changes: lines,
		publish_changes_lead: lines.length > 0 ? NEXT_PUBLISH_LEAD : null,
	};
}

/**
 * The lead over an account of what Nova can't hold, as the panel chooses it: where the account's one finding is that
 * CommCare HQ's version is past a limit of Nova's own (its size, or the work of reading it), Nova
 * brought nothing in, and the lead says so.
 */
function cannotBringInLeadFor(
	review: Extract<HqChangesReview, { readonly kind: "account" }>,
): string {
	const [only] = review.findings;
	return review.findings.length === 1 &&
		review.more === 0 &&
		only !== undefined &&
		only.subject === null &&
		(only.code === "too-large" || only.code === "too-intricate")
		? novaLimitLead(only.code)
		: cannotBringInLead(review.findings.length + review.more);
}

/**
 * What a page of a review is cut from, and the digest its cursor carries: an
 * account's findings, or the pieces of a review of changes (`changePieces`).
 * Null for a review no page is cut from.
 */
function pagedOf(
	review: HqChangesReview,
): { readonly length: number; readonly digest: string } | null {
	switch (review.kind) {
		case "account":
			return { length: review.findings.length, digest: accountDigest(review) };
		case "changes":
			return {
				length:
					linePieces(review.hqChanges, review.novaChanges).length +
					review.renamedInNova.length +
					review.tables.length +
					review.madeBy.length,
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
 * of its own (`paging.ts`: a piece and its comma at most `PIECE_MAX_CHARS`).
 * A line names menus, forms and questions by what the app calls them, so a
 * line can be longer than any answer.
 */
export const LINE_PART_MAX_CHARS = PIECE_MAX_CHARS - 1;

/** One line of a list, or one part of a line too long for one answer. */
interface LinePiece {
	readonly kind: "line";
	readonly list: CutLine["list"];
	readonly text: string;
	readonly part: number;
	readonly parts: number;
}

/**
 * What one answer of a review of changes holds a share of: a line (or a part
 * of one), a case property renamed in Nova, a table the changed app newly
 * reads, or the name of a member who changed the app.
 */
type ChangePiece =
	| LinePiece
	| { readonly kind: "rename"; readonly rename: RenameProjection }
	| { readonly kind: "table"; readonly table: TableProjection }
	| { readonly kind: "name"; readonly name: string };

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
function linePieces(
	hqLines: readonly string[],
	novaLines: readonly string[],
): readonly LinePiece[] {
	const pieces: LinePiece[] = [];
	for (const [list, lines] of [
		["hq_changes", hqLines],
		["nova_changes", novaLines],
	] as const) {
		for (const line of lines) {
			const parts = lineParts(line);
			for (const [index, text] of parts.entries())
				pieces.push({
					kind: "line",
					list,
					text,
					part: index + 1,
					parts: parts.length,
				});
		}
	}
	return pieces;
}

/** Everything a review of changes pages, in the order its pages give it: both lists' lines,
 *  then the renames made in Nova, then the tables, then who made the changes. */
function changePieces(
	review: Extract<HqChangesReview, { readonly kind: "changes" }>,
	table: (one: ReviewTable) => TableProjection,
): readonly ChangePiece[] {
	return [
		...linePieces(review.hqChanges, review.novaChanges),
		...review.renamedInNova.map(
			(rename): ChangePiece => ({
				kind: "rename",
				rename: {
					case_type: rename.caseType,
					from: rename.from,
					to: rename.to,
				},
			}),
		),
		...review.tables.map(
			(one): ChangePiece => ({ kind: "table", table: table(one) }),
		),
		...review.madeBy.map((name): ChangePiece => ({ kind: "name", name })),
	];
}

/** The sentence over some renames, in the copy the panel shows; null over none. */
function renamesLine(renames: readonly RenameProjection[]): string | null {
	return renames.length === 0
		? null
		: renamedInNovaLine(
				renames.map((rename) => ({
					caseType: rename.case_type,
					from: rename.from,
					to: rename.to,
				})),
			);
}

/** What one page of a review of changes holds of its pieces. */
interface ChangesPage {
	readonly hq_changes: readonly string[];
	readonly nova_changes: readonly string[];
	readonly renamed_in_nova: readonly RenameProjection[];
	readonly renamed_in_nova_line: string | null;
	readonly tables: readonly TableProjection[];
	readonly made_by: readonly string[];
	readonly next_page: string | null;
	readonly cut_line: CutLine | null;
}

/**
 * The pieces from `from` (`changePieces`), as many as the one pager
 * (`paging.ts::cutPage`) gives the page beside its shell. A line too long for
 * one answer is cut into parts (`lineParts`), each a page of its own that says
 * which part it holds (`cut_line`); the cursor counts pieces, so none is
 * skipped or read twice. The sentence over the renames is over this page's,
 * so it grows with them and is measured with them, and a rename is fitted so
 * that it and its words in the sentence are one piece.
 */
function changesPage(
	pieces: readonly ChangePiece[],
	from: number,
	digest: string,
	measureShell: (page: ChangesPage) => number,
): ChangesPage {
	const hq: string[] = [];
	const nova: string[] = [];
	const renames: RenameProjection[] = [];
	const tables: TableProjection[] = [];
	const names: string[] = [];
	let cutLine: CutLine | null = null;
	/* The JSON of the sentence over some renames, where `null` is four characters. */
	const lineChars = (over: readonly RenameProjection[]) =>
		JSON.stringify(renamesLine(over)).length;
	/* Each piece as the page holds it: a rename, a table and a name fitted to a piece. */
	const fitted = (piece: ChangePiece): ChangePiece => {
		switch (piece.kind) {
			case "line":
				return piece;
			case "rename":
				return { ...piece, rename: fitPiece(piece.rename, RENAME_MAX_CHARS) };
			case "table":
				return { ...piece, table: fitPiece(piece.table) };
			case "name":
				return { ...piece, name: fitPiece(piece.name) };
		}
	};
	const at = (index: number) => fitted(pieces[index] as ChangePiece);
	const end = cutPage({
		count: pieces.length,
		from,
		shellChars: measureShell({
			hq_changes: [],
			nova_changes: [],
			renamed_in_nova: [],
			renamed_in_nova_line: null,
			tables: [],
			made_by: [],
			next_page: LONGEST_CHANGES_CURSOR,
			cut_line: LONGEST_CUT_LINE,
		}),
		alone: (index) => {
			const piece = pieces[index] as ChangePiece;
			return piece.kind === "line" && piece.parts > 1;
		},
		pieceChars: (index) => {
			const piece = at(index);
			switch (piece.kind) {
				case "line":
					return arrayItemChars(
						piece.text,
						(piece.list === "hq_changes" ? hq : nova).length,
					);
				case "rename":
					return (
						arrayItemChars(piece.rename, renames.length) +
						lineChars([...renames, piece.rename]) -
						lineChars(renames)
					);
				case "table":
					return arrayItemChars(piece.table, tables.length);
				case "name":
					return arrayItemChars(piece.name, names.length);
			}
		},
		take: (index) => {
			const piece = at(index);
			switch (piece.kind) {
				case "line":
					(piece.list === "hq_changes" ? hq : nova).push(piece.text);
					if (piece.parts > 1)
						cutLine = {
							list: piece.list,
							part: piece.part,
							parts: piece.parts,
						};
					return;
				case "rename":
					renames.push(piece.rename);
					return;
				case "table":
					tables.push(piece.table);
					return;
				case "name":
					names.push(piece.name);
					return;
			}
		},
	});
	return {
		hq_changes: hq,
		nova_changes: nova,
		renamed_in_nova: renames,
		renamed_in_nova_line: renamesLine(renames),
		tables,
		made_by: names,
		next_page: end < pieces.length ? `${end}:${digest}` : null,
		cut_line: cutLine,
	};
}

/** The most characters of JSON one rename takes: it is named again in the sentence over the
 *  renames, so a rename and its words there are one piece together. */
const RENAME_MAX_CHARS = Math.floor(PIECE_MAX_CHARS / 3);

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
		/**
		 * The whole answer this review goes out in, where it is part of a larger
		 * one (`bring_in_hq_changes`'s `changed`): a page is cut against that
		 * answer's text, never against the review's alone.
		 */
		readonly envelope?: (projected: HqChangesReviewProjection) => unknown;
	},
): HqChangesReviewProjection {
	const wrap = options.envelope ?? ((projected) => projected);
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
				/* Where CommCare HQ now keeps what the app doesn't hold, which
				 * recording the read follows; empty where nothing moved. */
				hq_changes: review.hqChanges,
				...publishChangesOf(review.publishChanges),
				reading_id: review.readingId,
				review_digest: review.reviewDigest,
				next: review.reviewDigest === null ? null : RECORD_NOTHING_NEXT,
			};
		case "changes": {
			const project = cutFindingName(review.projectName);
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
				renamed_in_nova_total: review.renamedInNova.length,
				tables_total: review.tables.length,
				made_by_total: review.madeBy.length,
				restarted: options.page.restarted,
				restarted_message: options.page.restarted
					? CHANGES_RESTARTED_MESSAGE
					: null,
				/* At most three names, then a count. */
				made_by_line:
					review.madeBy.length > 0 ? madeByLine(review.madeBy) : null,
				/* Each at most five names, then a count. */
				case_data: review.caseData,
				/* One sentence for each entry of a closed register. */
				...publishChangesOf(review.publishChanges),
				observed_digest: review.observedDigest,
				reading_id: review.readingId,
				review_digest: review.reviewDigest,
			};
			return {
				...shell,
				...changesPage(
					changePieces(review, (table) =>
						tableProjection(table, project, head.domain),
					),
					options.page.from,
					review.reviewDigest,
					(page) =>
						JSON.stringify(
							wrap({ ...shell, ...page } as HqChangesReviewProjection),
						).length,
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
				(page) =>
					JSON.stringify(
						wrap({ ...shell, account: page } as HqChangesReviewProjection),
					).length,
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
	registerScopedTool(
		server,
		ctx,
		"read_hq_changes",
		{
			description:
				"Read what changed in CommCare HQ since Nova last published this app to a project space, or brought it in or last brought in changes from it. Changes nothing. Call it when `upload_app_to_hq` answers `hq_changed` with `can_bring_in` true on the app's change, or when the user asks what changed there. `hq_changes` lists what bringing the changes in changes in this app. `nova_changes` lists what that would remove of changes made in Nova since then: it is empty when nothing would be removed. Where a review is longer than one answer, `next_page` is not null: call again with `page` set to it until it is, and if an answer says `restarted`, the lists changed and start again. Each answer holds its share of `hq_changes`, then `nova_changes`, then `renamed_in_nova` (with `renamed_in_nova_line` over the renames it holds), then `tables`, then `made_by`, and `hq_changes_total`, `nova_changes_total`, `renamed_in_nova_total`, `tables_total` and `made_by_total` say how many each holds in all. Where `cut_line` is not null, the answer's one line is part `part` of `parts` of a line too long for one answer: the next answers hold the rest, and the parts joined in order are that line. Show the user every line of both lists, every rename, every table and `made_by` before calling `bring_in_hq_changes` with the last answer's `reading_id` and `review_digest`. A `kind` of `nothing` with a `review_digest` means CommCare HQ saved the app and there is nothing to bring in: send that `reading_id` and `review_digest` to `bring_in_hq_changes` to record it, which changes nothing in the app, and the next upload no longer stops for this app's change in CommCare HQ. A `nothing` answer's `hq_changes` says where CommCare HQ now keeps something the app follows (a form's id, the case id a create files under, a file's path): show the user each line. A `kind` of `account`, `held`, `unavailable` or `stop` means Nova can't bring the changes in: relay its sentences, which say what the user can do instead. An `unavailable` answer whose `reason` is `not-published`, `publishing-stopped`, `app-deleted` or `hq-app-taken` means nothing in that project space is this app's.",
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
					content: [{ type: "text", text: toolText(projection) }],
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
