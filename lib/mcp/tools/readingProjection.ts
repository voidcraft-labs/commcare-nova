/**
 * What `read_hq_app` and `bring_in_hq_app` answer about one read of a
 * CommCare HQ app: a stop, an account or a review, with every sentence the
 * bring-in screens show, from the same copy exports, and dates as ISO text or
 * the UTC day.
 *
 * An account longer than one answer is cut into pages, each under
 * `PAGE_LIMIT_CHARS` of JSON, below the tool's registered result ceiling.
 * Nothing is kept between calls, so a page's cursor carries the digest of the
 * account it was cut from, and a fresh read whose account has another digest
 * answers from its start rather than stitching two versions of an app into
 * one list.
 */

import { COMMCARE_SERVERS } from "@/lib/commcare/servers";
import { hqPlaceUrl } from "@/lib/deployment/hqPlaceUrl";
import type { AccountAnswer } from "@/lib/deployment/reading/answers";
import type {
	ReadingAnswer,
	ReadingDeclarationChoice,
	ReadingKey,
	ReadingRefusal,
	ReadingReview,
	ReviewTable,
} from "@/lib/deployment/reading/types";
import {
	PLATFORM_DECLARATION_LABELS,
	PLATFORM_DECLARATION_LINES,
	type Platform,
} from "@/lib/domain/platforms";
import {
	ANOTHER_SPACE_NEW_APP_LINE,
	platformOutBlock,
	READING_RESTARTED_MESSAGE,
	REVIEW_AFTER_DRIFT_LINE,
	REVIEW_CHANGE_LATER,
	REVIEW_RUNS_ON_WHY,
	REVIEW_WEB_APPS_ASKS_OFF,
	REVIEW_WEB_APPS_ASKS_ON,
	reviewAfterPublishLine,
	splitDatetimeLine,
} from "@/lib/publish/bringInCopy";
import { driftDate } from "@/lib/publish/driftReference";
import { firstPublishLines } from "@/lib/publish/firstPublishCopy";
import {
	ACCOUNT_CHECK_AGAIN_LINE,
	type CircumstanceContext,
	circumstanceBlock,
	FINDING_LABELS,
	FINDING_NEXT_STEPS,
	findingLine,
	placeLine,
} from "@/lib/publish/hqFindingCopy";
import type {
	CircumstanceFinding,
	Finding,
	FindingStanding,
} from "@/lib/publish/hqFindings";
import {
	moreFindingsLine,
	READING_REFUSAL_COPY,
} from "@/lib/publish/hqReadingCopy";
import {
	KEPT_FOLLOWS_LINE,
	KEPT_LABELS,
	keptLead,
} from "@/lib/publish/keptValues";
import {
	choiceNotOffered,
	columnsBecomeText,
	HQ_TABLE_ANSWER,
	hqTableAnswerConsequence,
	hqTableAnswerGoneColumns,
	MEDIA_CHECKED_LATER,
	projectTableAnswer,
	projectTableAnswerConsequence,
	reviewChoiceBody,
	reviewChoiceTitle,
	reviewManagedPlaces,
	reviewManagedTables,
	reviewMediaAdded,
	reviewMediaLeftOut,
	reviewSameEqualTable,
} from "@/lib/publish/managedData";
import { PLAN_FEATURES } from "@/lib/publish/planFeatures";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { BringInToolError } from "../errors";
import {
	describeFirstPublish,
	type FirstPublishProjection,
} from "./deploymentProjection";

/** The most characters of JSON one answer holds, under `MAX_RESULT_SIZE_CHARS`. */
export const PAGE_LIMIT_CHARS = 80_000;

type Standing = FindingStanding;

/** A circumstance's three strings, as the stop screen shows them. */
export interface StopProjection {
	readonly code: string;
	readonly title: string;
	readonly body: string;
	readonly next: string;
}

/** One finding of an account, as a client reads it. */
export interface FindingProjection {
	readonly code: string;
	readonly standing: Standing;
	/** placeLine(place). */
	readonly place: string;
	/** The page of CommCare HQ that holds the place, for the user to open. */
	readonly hq_url: string | null;
	/** findingLine's sentence for a manifest finding; a circumstance's body. */
	readonly sentence: string;
	/** The name as CommCare HQ shows it, or null. */
	readonly named: string | null;
	/** A circumstance's own title and next step. */
	readonly title?: string;
	readonly next?: string;
}

/** One answer to a table's choice, as the review offers it. */
export interface TableAnswerProjection {
	readonly answer: "use-commcare-hq" | "use-project";
	readonly offered: boolean;
	readonly label: string;
	readonly lines: readonly string[];
	/** Why the answer is not offered; null where it is. */
	readonly reason: string | null;
}

export interface ReviewProjection {
	readonly review_digest: string;
	readonly app_name: string;
	readonly read_at: string;
	readonly creates: {
		readonly menus: number;
		readonly forms: number;
		readonly questions: number;
		readonly case_types: readonly string[];
		readonly languages: number;
		readonly media_files: number;
	};
	readonly runs_on: readonly {
		readonly runs_only_on: Platform | null;
		readonly split_datetime: boolean;
		readonly preselected: boolean;
		readonly label: string;
		readonly line: string;
		readonly split_line: string | null;
		/** Labels of the plan features Nova records as already in use under this choice. */
		readonly recorded_features: readonly string[];
		/** What the first upload from Nova changes in CommCare HQ under this choice. */
		readonly first_publish: FirstPublishProjection;
	}[];
	/** Why Nova proposes the preselected choice, what the first upload will ask under it, and that it can change later. */
	readonly runs_on_notes: readonly string[];
	/** Each platform no choice runs on. */
	readonly cannot_run: readonly {
		readonly platform: Platform;
		readonly sentence: string;
		readonly features: readonly string[];
		readonly files: string | null;
	}[];
	readonly kept: {
		readonly lead: string;
		readonly labels: readonly string[];
		readonly note: string;
	};
	readonly tables: readonly {
		readonly tag: string;
		readonly standing: ReviewTable["standing"];
		/** The sentence for a table that asks nothing. */
		readonly sentence: string | null;
		readonly choice: null | {
			readonly title: string;
			readonly body: string;
			readonly answers: readonly TableAnswerProjection[];
		};
	}[];
	readonly places: { readonly count: number; readonly sentence: string } | null;
	readonly media: {
		readonly sentence: string | null;
		readonly left_out: string | null;
	};
	readonly after: readonly string[];
}

export interface AccountProjection {
	/** The answer's counts, over every finding the read met. */
	readonly counts: {
		readonly not_yet: number;
		readonly never: number;
		readonly fix_in_hq: number;
	};
	/** The label and next step of each standing the account holds. */
	readonly labels: readonly {
		readonly standing: Standing;
		readonly label: string;
		readonly next: string;
	}[];
	readonly findings: readonly FindingProjection[];
	/** How many findings the account lists, over every page. */
	readonly total: number;
	/** The cursor of the next page, or null on the last. */
	readonly next_page: string | null;
	/** A later read may find more. On every page. */
	readonly check_again: string;
	/** Where the read met more findings than it lists. */
	readonly more: string | null;
	readonly media_checked: boolean;
	/** Where media_checked is false. */
	readonly note: string | null;
}

/** One read's answer as an MCP client reads it. */
export interface ReadingProjection {
	readonly project_id: string;
	readonly server: ReadingKey["server"];
	readonly domain: string;
	readonly hq_app_id: string;
	/** CommCare HQ's name for the app, where the read learned it. */
	readonly hq_app_name: string | null;
	readonly state: "review" | "account" | "stop";
	/**
	 * True where the call sent `page` and the fresh read is now a review or an
	 * account with another digest, answered from its start. False without
	 * `page`, and for a stop, which answers as itself (`pageFor`).
	 */
	readonly restarted: boolean;
	/** The restart's sentence where `restarted` is true, else null. */
	readonly message: string | null;
	/** With `review`: sent back to bring_in_hq_app, beside review.review_digest. */
	readonly reading_id?: string;
	readonly stop?: StopProjection;
	readonly account?: AccountProjection;
	readonly review?: ReviewProjection;
}

/**
 * An ISO instant as the UTC day, such as "10 November 2026": how every MCP
 * answer writes a date in a sentence, the drift and ended sentences of the
 * deployment tools included (`driftDate` with its default locale and zone).
 */
export function utcDay(iso: string): string {
	return driftDate(iso);
}

/** A name CommCare HQ holds, or null where it holds an empty one. */
function hqName(name: string | null): string | null {
	return name === null || name.trim() === "" ? null : name;
}

/** What `circumstanceBlock` fills a block from over MCP: the server's label, the project space, the app, the UTC day. */
export function circumstanceContextFor(
	target: { readonly server: ReadingKey["server"]; readonly domain: string },
	app: string | null,
): CircumstanceContext {
	return {
		server: COMMCARE_SERVERS[target.server].label,
		space: target.domain,
		app: hqName(app),
		formatDate: utcDay,
	};
}

/** A circumstance's three strings with its code. */
export function stopProjection(
	finding: CircumstanceFinding,
	context: CircumstanceContext,
): StopProjection {
	const block = circumstanceBlock(finding, context);
	return {
		code: finding.code,
		title: block.title,
		body: block.body,
		next: block.next,
	};
}

/** CommCare HQ's name for the app, where this answer learned it. */
function appNameOf(answer: ReadingAnswer): string | null {
	switch (answer.kind) {
		case "stop":
			return null;
		case "account":
			return hqName(answer.appName);
		case "review":
			return hqName(answer.review.appName);
	}
}

// ---------------------------------------------------------------------------
// The account, a page at a time
// ---------------------------------------------------------------------------

const STANDINGS: readonly Standing[] = ["not-yet", "never", "fix-in-hq"];

/** `canonicalJsonDigest` of an account's whole listed content: its `findings` and its `more`. */
export function accountDigest(
	answer: Pick<AccountAnswer, "findings" | "more">,
): string {
	return canonicalJsonDigest({
		findings: answer.findings,
		more: answer.more,
	});
}

/** The cursor of the page that starts at `from` of the account `digest` names. */
function pageCursor(from: number, digest: string): string {
	return `${from}:${digest}`;
}

/** A cursor at its longest, so a page measured with it fits whatever cursor it ends up holding. */
const LONGEST_CURSOR = pageCursor(99_999, "0".repeat(64));

const HEX_DIGEST = /^[0-9a-f]{64}$/;

/** The cursor's two halves, or null for text the schema let through and no account could give. */
export function parseAccountPage(
	page: string,
): { readonly from: number; readonly digest: string } | null {
	const colon = page.indexOf(":");
	if (colon < 1) return null;
	const index = page.slice(0, colon);
	const digest = page.slice(colon + 1);
	const from = Number(index);
	/* An index another cursor could spell differently ("007") is none Nova gave. */
	if (!Number.isSafeInteger(from) || String(from) !== index) return null;
	if (from < 1 || !HEX_DIGEST.test(digest)) return null;
	return { from, digest };
}

/**
 * Where a fresh read's answer starts for a call that sent `cursor`: at the
 * cursor's index where the read is the account the cursor was cut from; from
 * the start and `restarted` where the app is now a review or another account;
 * and null where the cursor names that very account at an index past its end,
 * which no answer gave. A stop is never `restarted`: it says nothing of the
 * app the cursor was cut from (a refused key, CommCare HQ busy or away), so it
 * answers as itself and the cursor still pages once the read gets through.
 */
export function pageFor(
	answer: ReadingAnswer,
	cursor: { readonly from: number; readonly digest: string } | null,
): { readonly from: number; readonly restarted: boolean } | null {
	if (cursor === null || answer.kind === "stop")
		return { from: 0, restarted: false };
	if (answer.kind !== "account" || accountDigest(answer) !== cursor.digest)
		return { from: 0, restarted: true };
	if (cursor.from >= answer.findings.length) return null;
	return { from: cursor.from, restarted: false };
}

function findingProjection(
	finding: Finding,
	key: ReadingKey,
	context: CircumstanceContext,
): FindingProjection {
	const { sentence, named } = findingLine(finding);
	const base = {
		code: finding.code,
		standing: finding.standing as Standing,
		place: placeLine(finding.place),
		hq_url: hqPlaceUrl(key, finding.place),
		named,
	};
	if (finding.subject !== null) return { ...base, sentence };
	const block = circumstanceBlock(finding, context);
	return {
		...base,
		sentence: block.body,
		title: block.title,
		next: block.next,
	};
}

function accountProjection(
	answer: AccountAnswer,
	key: ReadingKey,
	context: CircumstanceContext,
	from: number,
	measure: (account: AccountProjection) => number,
): AccountProjection {
	const of: Readonly<Record<Standing, number>> = {
		"not-yet": answer.counts.notYet,
		never: answer.counts.never,
		"fix-in-hq": answer.counts.fixInHq,
	};
	const shell: AccountProjection = {
		counts: {
			not_yet: answer.counts.notYet,
			never: answer.counts.never,
			fix_in_hq: answer.counts.fixInHq,
		},
		labels: STANDINGS.filter((standing) => of[standing] > 0).map(
			(standing) => ({
				standing,
				label: FINDING_LABELS[standing],
				next: FINDING_NEXT_STEPS[standing],
			}),
		),
		findings: [],
		total: answer.findings.length,
		next_page: LONGEST_CURSOR,
		check_again: ACCOUNT_CHECK_AGAIN_LINE,
		more: answer.more > 0 ? moreFindingsLine(answer.more) : null,
		media_checked: answer.mediaChecked,
		note: answer.mediaChecked ? null : MEDIA_CHECKED_LATER,
	};
	/* The whole answer's JSON with no finding, then each finding's own JSON and
	 * the comma before it: the page takes findings while their sum stays under
	 * the limit, and always one, so following the cursors reaches the end. */
	let size = measure(shell);
	const findings: FindingProjection[] = [];
	let end = from;
	while (end < answer.findings.length) {
		const finding = answer.findings[end] as Finding;
		const projected = findingProjection(finding, key, context);
		const added =
			JSON.stringify(projected).length + (findings.length > 0 ? 1 : 0);
		if (findings.length > 0 && size + added >= PAGE_LIMIT_CHARS) break;
		size += added;
		findings.push(projected);
		end += 1;
	}
	return {
		...shell,
		findings,
		next_page:
			end < answer.findings.length
				? pageCursor(end, accountDigest(answer))
				: null,
	};
}

/** An account's findings, counts and paging, as `account` holds them, with no word of its files. */
export type ListedAccountProjection = Omit<
	AccountProjection,
	"media_checked" | "note"
>;

/**
 * The page of an account that starts at `from`, cut as `read_hq_app` cuts
 * one, for an account that says nothing of whether its files were checked:
 * a review of the changes made in CommCare HQ answers one of those. `measure`
 * is the JSON length of the whole answer that holds the page.
 */
export function listedAccountProjection(
	account: Pick<AccountAnswer, "findings" | "more" | "counts">,
	key: ReadingKey,
	context: CircumstanceContext,
	from: number,
	measure: (account: ListedAccountProjection) => number,
): ListedAccountProjection {
	const listed = (page: AccountProjection): ListedAccountProjection => ({
		counts: page.counts,
		labels: page.labels,
		findings: page.findings,
		total: page.total,
		next_page: page.next_page,
		check_again: page.check_again,
		more: page.more,
	});
	/* The files' two keys are cut from every page, the one measured included,
	 * so what they would hold never reaches a client or the page's size. */
	return listed(
		accountProjection(
			{ kind: "account", appName: null, mediaChecked: true, ...account },
			key,
			context,
			from,
			(page) => measure(listed(page)),
		),
	);
}

// ---------------------------------------------------------------------------
// The review
// ---------------------------------------------------------------------------

/** Labels of the plan features Nova records as already in use under a choice. */
function recordedFeatureLabels(
	choice: ReadingDeclarationChoice,
): readonly string[] {
	return choice.recordedFeatures.flatMap((key) =>
		key.kind === "plan-feature" ? [PLAN_FEATURES[key.subject].label] : [],
	);
}

/** That the first upload asks before changing Web Apps under `choice`, or null where it asks nothing. */
function firstUploadAsks(
	review: ReadingReview,
	choice: ReadingDeclarationChoice,
): string | null {
	const runsInWebApps = choice.runsOnlyOn !== "android";
	if (!runsInWebApps && review.webAppsOnInHq) return REVIEW_WEB_APPS_ASKS_OFF;
	if (runsInWebApps && !review.webAppsOnInHq) return REVIEW_WEB_APPS_ASKS_ON;
	return null;
}

/** One table of a review, as `review.tables` holds it: its standing, its sentence, or its choice. */
export function tableProjection(
	table: ReviewTable,
	project: string,
	domain: string,
): ReviewProjection["tables"][number] {
	const { choice } = table;
	const base = { tag: table.tag, standing: table.standing };
	switch (table.standing) {
		case "new":
		case "same-managed":
			return {
				...base,
				sentence: reviewManagedTables([table.tag], domain),
				choice: null,
			};
		case "same-equal":
			return {
				...base,
				sentence: reviewSameEqualTable(table.tag, project, domain),
				choice: null,
			};
		case "choice": {
			if (choice === null)
				throw new Error(
					`The lookup table ${table.tag} stands as a choice in the review and carries none. A table whose standing is "choice" always carries what differs and each answer's offer. Look at lib/deployment/reading/projectData::projectDataReview.`,
				);
			const fromHq = choice.options["use-commcare-hq"];
			const own = choice.options["use-project"];
			const hqLines = [
				hqTableAnswerConsequence(project, table.tag, choice.apps),
				...(fromHq.offered
					? [
							columnsBecomeText(fromHq.retypedColumns),
							hqTableAnswerGoneColumns(choice.apps, fromHq.goneColumns),
						]
					: []),
			].filter((line): line is string => line !== null);
			return {
				...base,
				sentence: null,
				choice: {
					title: reviewChoiceTitle(table.tag, project, choice),
					body: reviewChoiceBody(table.tag, project, domain, choice),
					answers: [
						{
							answer: "use-commcare-hq",
							offered: fromHq.offered,
							label: HQ_TABLE_ANSWER,
							lines: hqLines,
							reason: fromHq.offered ? null : choiceNotOffered(fromHq, project),
						},
						{
							answer: "use-project",
							offered: own.offered,
							label: projectTableAnswer(project),
							lines: [projectTableAnswerConsequence(project, domain)],
							reason: own.offered ? null : choiceNotOffered(own, project),
						},
					],
				},
			};
		}
	}
}

function reviewProjection(
	review: ReadingReview,
	reviewDigest: string,
	project: string,
	domain: string,
): ReviewProjection {
	const preselected = review.runsOn.find((choice) => choice.preselected);
	if (preselected === undefined)
		throw new Error(
			"A review answered with no preselected way to run. A review offers at least one, exactly one of them preselected. Look at lib/deployment/reading/gather.ts::gatherReading.",
		);
	const asks = firstUploadAsks(review, preselected);
	return {
		review_digest: reviewDigest,
		app_name: review.appName,
		read_at: review.readAt,
		creates: {
			menus: review.creates.menus,
			forms: review.creates.forms,
			questions: review.creates.questions,
			case_types: review.creates.caseTypes,
			languages: review.creates.languages.length,
			media_files: review.creates.mediaFiles,
		},
		runs_on: review.runsOn.map((choice) => ({
			runs_only_on: choice.runsOnlyOn,
			split_datetime: choice.splitDatetime,
			preselected: choice.preselected,
			label: PLATFORM_DECLARATION_LABELS[choice.runsOnlyOn ?? "both"],
			line: PLATFORM_DECLARATION_LINES[choice.runsOnlyOn ?? "both"],
			split_line: choice.splitDatetime
				? splitDatetimeLine(review.datetimeQuestions)
				: null,
			recorded_features: recordedFeatureLabels(choice),
			first_publish: describeFirstPublish(
				firstPublishLines(choice.firstPublish, "review"),
			),
		})),
		runs_on_notes: [
			REVIEW_RUNS_ON_WHY[review.runsOnWhy],
			...(asks === null ? [] : [asks]),
			REVIEW_CHANGE_LATER,
		],
		cannot_run: review.platformsOut.map((entry) => {
			const block = platformOutBlock(entry);
			/* A platform only files keep the app off is said by the files' sentence alone. */
			const sentence = block.lead ?? block.files;
			if (sentence === null)
				throw new Error(
					`The review keeps the app off ${entry.platform} for no feature and no file. A platform is kept out for at least one of the two. Look at lib/deployment/reading/gather.ts::gatherReading.`,
				);
			return {
				platform: entry.platform,
				sentence,
				features: block.features,
				files: block.lead === null ? null : block.files,
			};
		}),
		kept: {
			lead: keptLead(utcDay(review.readAt), review.kept.length > 0),
			labels: review.kept.map((id) => KEPT_LABELS[id]),
			note: KEPT_FOLLOWS_LINE,
		},
		tables: review.tables.map((table) =>
			tableProjection(table, project, domain),
		),
		places:
			review.places === null
				? null
				: {
						count: review.places.count,
						sentence: reviewManagedPlaces(review.places.count, domain),
					},
		media: {
			sentence:
				review.creates.mediaFiles > 0
					? reviewMediaAdded(review.creates.mediaFiles, project)
					: null,
			left_out:
				review.mediaLeftOut > 0
					? reviewMediaLeftOut(review.mediaLeftOut)
					: null,
		},
		after: [
			reviewAfterPublishLine(domain),
			REVIEW_AFTER_DRIFT_LINE,
			ANOTHER_SPACE_NEW_APP_LINE,
		],
	};
}

// ---------------------------------------------------------------------------
// The answer
// ---------------------------------------------------------------------------

/** One read's answer as an MCP client reads it. */
export function describeReading(
	answer: ReadingAnswer,
	key: ReadingKey,
	options: {
		/** The first finding of the page: 0 unless the call sent a `page` that still stands. */
		readonly from: number;
		/** True where the call sent a `page` and the app is no longer what that page was cut from. */
		readonly restarted: boolean;
		/** The name of the Project the app is added to, which the review's sentences name. */
		readonly project: string;
	},
): ReadingProjection {
	const appName = appNameOf(answer);
	const context = circumstanceContextFor(key, appName);
	const head = {
		project_id: key.projectId,
		server: key.server,
		domain: key.domain,
		hq_app_id: key.remoteAppId,
		hq_app_name: appName,
		state: answer.kind,
		restarted: options.restarted,
		message: options.restarted ? READING_RESTARTED_MESSAGE : null,
	};
	switch (answer.kind) {
		case "stop":
			return { ...head, stop: stopProjection(answer.finding, context) };
		case "account":
			return {
				...head,
				account: accountProjection(
					answer,
					key,
					context,
					options.from,
					(account) => JSON.stringify({ ...head, account }).length,
				),
			};
		case "review":
			return {
				...head,
				reading_id: answer.readingId,
				review: reviewProjection(
					answer.review,
					answer.reviewDigest,
					options.project,
					key.domain,
				),
			};
	}
}

/** How each refusal reaches a client: its error tag, and whether it names the Project. */
const READING_REFUSAL_ERRORS = {
	no_project_access: { errorType: "permission_denied", namesProject: true },
	invalid_input: { errorType: "invalid_input", namesProject: false },
	name_missing: { errorType: "invalid_input", namesProject: false },
	choice_not_offered: { errorType: "invalid_input", namesProject: false },
	choice_missing: { errorType: "invalid_input", namesProject: false },
	project_changed: { errorType: "bring_in_refused", namesProject: false },
	app_unavailable: { errorType: "bring_in_refused", namesProject: false },
} as const satisfies Record<
	ReadingRefusal,
	{
		readonly errorType: BringInToolError["errorType"];
		readonly namesProject: boolean;
	}
>;

/** The tool error for one refusal of a read or a create, worded as the screen words it. */
export function mapReadingRefusal(
	refusal: ReadingRefusal,
	projectId: string,
): BringInToolError {
	const { errorType, namesProject } = READING_REFUSAL_ERRORS[refusal];
	return new BringInToolError(errorType, READING_REFUSAL_COPY[refusal], {
		refusal,
		...(namesProject && { projectId }),
	});
}
