/**
 * What `read_hq_app` and `bring_in_hq_app` serve of one read, as data: the
 * three answers, every sentence the screen's copy export, the account and a
 * review's lookup tables cut into pages a client can follow to the end, and
 * every refusal with its tag.
 *
 * It would catch: an answer the client truncates in silence; two versions of
 * an app stitched into one list; MCP and the screen saying different things;
 * an agent relaying the proposed row's list for the row the user chose.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { COMMCARE_SERVERS } from "@/lib/commcare/servers";
import { hqPlaceUrl } from "@/lib/deployment/hqPlaceUrl";
import type { AccountAnswer } from "@/lib/deployment/reading/answers";
import {
	READING_REFUSALS,
	type ReadingAnswer,
	type ReadingDeclarationChoice,
	type ReadingKey,
	type ReadingReview,
	type ReviewTable,
} from "@/lib/deployment/reading/types";
import {
	PLATFORM_DECLARATION_LABELS,
	PLATFORM_DECLARATION_LINES,
	PLATFORM_FEATURES,
} from "@/lib/domain/platforms";
import {
	ANOTHER_SPACE_NEW_APP_LINE,
	platformOutBlock,
	READING_RESTARTED_MESSAGE,
	REVIEW_AFTER_DRIFT_LINE,
	REVIEW_CHANGE_LATER,
	REVIEW_RUNS_ON_WHY,
	REVIEW_WEB_APPS_ASKS_OFF,
	reviewAfterPublishLine,
	splitDatetimeLine,
} from "@/lib/publish/bringInCopy";
import {
	FIRST_PUBLISH_TOUCHES_WORKERS,
	type FirstPublishChangeId,
	type FirstPublishView,
} from "@/lib/publish/firstPublishChangeIds";
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
import {
	circumstanceFinding,
	FINDING_NAME_MAX_LENGTH,
	type Finding,
	type HqPlace,
	type ManifestFinding,
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
	HQ_TABLE_ANSWER,
	hqTableAnswerConsequence,
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
import { BringInToolError } from "../errors";
import { PAGE_LIMIT_CHARS, reviewedPageDigest } from "../paging";
import {
	accountDigest,
	birthPageSubject,
	describeReading,
	mapReadingRefusal,
	pageFor,
	parseAccountPage,
	type ReadingProjection,
	tableProjection,
} from "../tools/readingProjection";

const KEY: ReadingKey = {
	projectId: "project-1",
	server: "india",
	domain: "clinic",
	remoteAppId: "a1b2c3d4e5f6",
};
const PROJECT = "Field team";
const PAGE_CONTEXT = { project: PROJECT, domain: KEY.domain };
const READING_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const DIGEST = "a".repeat(64);
const FIRST_PAGE = { from: 0, restarted: false, project: PROJECT } as const;

const UTC_DAY = new Intl.DateTimeFormat("en-GB", {
	day: "numeric",
	month: "long",
	year: "numeric",
	timeZone: "UTC",
});

/** The context the screen would build for this key, with the UTC day as every MCP answer spells it. */
function context(app: string | null): CircumstanceContext {
	return {
		server: COMMCARE_SERVERS[KEY.server].label,
		space: KEY.domain,
		app,
		formatDate: (iso) => UTC_DAY.format(new Date(iso)),
	};
}

function view(ids: readonly FirstPublishChangeId[]): FirstPublishView {
	return {
		ids,
		touchesWorkers: ids.some((id) => FIRST_PUBLISH_TOUCHES_WORKERS[id]),
		of: "first-publish",
	};
}

function choice(
	runsOnlyOn: ReadingDeclarationChoice["runsOnlyOn"],
	splitDatetime: boolean,
	preselected: boolean,
	ids: readonly FirstPublishChangeId[],
): ReadingDeclarationChoice {
	return {
		runsOnlyOn,
		splitDatetime,
		preselected,
		recordedFeatures: [{ kind: "plan-feature", subject: "web-apps" }],
		firstPublish: view(ids),
	};
}

const CHOICE_TABLE: ReviewTable = {
	tag: "district",
	standing: "choice",
	hqDigest: "d".repeat(64),
	projectTable: null,
	choice: {
		differs: ["rows"],
		apps: [
			{ appId: "app-reading-it", appName: "Registration", deleted: false },
		],
		options: {
			"use-commcare-hq": {
				offered: true,
				goneColumns: [],
				retypedColumns: [],
			},
			"use-project": { offered: false, why: "needs-admin", name: null },
		},
	},
};

function review(): ReadingReview {
	const runsOn = [
		choice(null, true, true, [
			"forms-and-settings-rewritten",
			"date-and-time-questions-split",
		]),
		choice("android", false, false, [
			"forms-and-settings-rewritten",
			"web-apps-turned-off",
		]),
	];
	return {
		appName: "Household visits",
		readAt: "2026-11-15T23:30:00.000Z",
		creates: {
			menus: 2,
			forms: 5,
			questions: 40,
			caseTypes: ["household", "member"],
			languages: ["en", "fra"],
			mediaFiles: 3,
		},
		runsOn,
		runsOnWhy: "keeps-web-apps",
		webAppsOnInHq: true,
		datetimeQuestions: 2,
		platformsOut: [
			{ platform: "web-apps", features: ["datetime-question"], media: true },
		],
		kept: ["automatic-app-updates", "device-logging"],
		tables: [
			{
				tag: "village",
				standing: "new",
				hqDigest: "e".repeat(64),
				projectTable: null,
				choice: null,
			},
			{
				tag: "clinic",
				standing: "same-equal",
				hqDigest: "f".repeat(64),
				projectTable: null,
				choice: null,
			},
			CHOICE_TABLE,
		],
		ownerRules: [],
		places: { count: 12, digest: "c".repeat(64) },
		mediaLeftOut: 1,
		firstPublish: runsOn[0]?.firstPublish as FirstPublishView,
	};
}

function reviewAnswer(body: ReadingReview = review()): ReadingAnswer {
	return {
		kind: "review",
		readingId: READING_ID,
		reviewDigest: DIGEST,
		review: body,
	};
}

const QUESTION: HqPlace = {
	kind: "question",
	menu: 0,
	form: 1,
	menuName: "Households",
	formName: "Visit",
	path: "visit_time",
};

function manifest(place: HqPlace, name?: string): ManifestFinding {
	return {
		code: "questions/itemset-filter-outside-predicate",
		standing: "not-yet",
		place,
		subject: "question-choices",
		detail: name === undefined ? {} : { name },
	};
}

function account(
	findings: readonly Finding[],
	options: Partial<AccountAnswer> = {},
): AccountAnswer {
	const count = (standing: string) =>
		findings.filter((finding) => finding.standing === standing).length;
	return {
		kind: "account",
		appName: "Household visits",
		findings,
		more: 0,
		counts: {
			notYet: count("not-yet"),
			never: count("never"),
			fixInHq: count("fix-in-hq"),
		},
		mediaChecked: true,
		...options,
	};
}

/** The projection as a client parses it: JSON, every undefined key gone. */
function served(projection: ReadingProjection): ReadingProjection {
	return JSON.parse(JSON.stringify(projection));
}

describe("describeReading", () => {
	it("serves a stop as the stop screen's three strings, with the UTC day of an app held elsewhere", () => {
		const finding = circumstanceFinding(
			"already-in-nova",
			{ kind: "app" },
			{
				claim: {
					kind: "elsewhere",
					at: "2026-03-04T23:59:00.000Z",
					contact: { role: "person", names: ["Ana"] },
				},
			},
		);
		const projection = served(
			describeReading({ kind: "stop", finding }, KEY, FIRST_PAGE),
		);
		const block = circumstanceBlock(finding, context(null));
		expect(projection).toStrictEqual({
			project_id: KEY.projectId,
			server: KEY.server,
			domain: KEY.domain,
			hq_app_id: KEY.remoteAppId,
			hq_app_name: null,
			state: "stop",
			restarted: false,
			message: null,
			stop: {
				code: "already-in-nova",
				title: block.title,
				body: block.body,
				next: block.next,
			},
		});
		expect(projection.stop?.next).toContain("4 March 2026");
	});

	it("serves an account's findings with the screen's words, a circumstance's block, and the check-again line", () => {
		const split = circumstanceFinding("no-platform-runs-everything", QUESTION, {
			name: "Visit time",
			reason: "split-refused",
		});
		const shadow = circumstanceFinding("shadow-disagrees", QUESTION, {
			name: "visit_time_shadow",
		});
		const plain = manifest(QUESTION, "visit_time");
		const answer = account([plain, split, shadow], {
			more: 3,
			mediaChecked: false,
		});
		const projection = served(describeReading(answer, KEY, FIRST_PAGE));
		expect(projection.state).toBe("account");
		expect(projection.hq_app_name).toBe("Household visits");
		const listed = projection.account;
		if (listed === undefined) throw new Error("no account");
		expect(listed.counts).toEqual({ not_yet: 1, never: 0, fix_in_hq: 2 });
		expect(listed.labels).toEqual(
			(["not-yet", "fix-in-hq"] as const).map((standing) => ({
				standing,
				label: FINDING_LABELS[standing],
				next: FINDING_NEXT_STEPS[standing],
			})),
		);
		expect(listed.total).toBe(3);
		expect(listed.next_page).toBeNull();
		expect(listed.check_again).toBe(ACCOUNT_CHECK_AGAIN_LINE);
		expect(listed.more).toBe(moreFindingsLine(3));
		expect(listed.media_checked).toBe(false);
		expect(listed.note).toBe(MEDIA_CHECKED_LATER);

		const [first, second, third] = listed.findings;
		expect(first).toStrictEqual({
			code: plain.code,
			standing: "not-yet",
			place: placeLine(QUESTION),
			hq_url: hqPlaceUrl(KEY, QUESTION),
			sentence: findingLine(plain).sentence,
			named: "visit_time",
		});
		const splitBlock = circumstanceBlock(split, context("Household visits"));
		expect(second).toMatchObject({
			code: "no-platform-runs-everything",
			standing: "fix-in-hq",
			sentence: splitBlock.body,
			title: splitBlock.title,
			next: splitBlock.next,
			named: null,
		});
		expect(second?.next).toContain("visit_time");
		/* A row that holds `name: "line"` shows the name on its own line. */
		expect(third?.named).toBe("visit_time_shadow");
		expect(third?.title).toBe(
			circumstanceBlock(shadow, context("Household visits")).title,
		);
	});

	it("serves a review with the screen's sentences and each way to run with its own first-publish list", () => {
		const body = review();
		const projection = served(
			describeReading(reviewAnswer(body), KEY, FIRST_PAGE),
		);
		expect(projection.state).toBe("review");
		expect(projection.reading_id).toBe(READING_ID);
		const shown = projection.review;
		if (shown === undefined) throw new Error("no review");
		expect(shown.review_digest).toBe(DIGEST);
		expect(shown.app_name).toBe("Household visits");
		expect(shown.read_at).toBe(body.readAt);
		expect(shown.creates).toEqual({
			menus: 2,
			forms: 5,
			questions: 40,
			case_types: ["household", "member"],
			languages: 2,
			media_files: 3,
		});

		const [both, android] = shown.runs_on;
		expect(both).toMatchObject({
			runs_only_on: null,
			split_datetime: true,
			preselected: true,
			label: PLATFORM_DECLARATION_LABELS.both,
			line: PLATFORM_DECLARATION_LINES.both,
			split_line: splitDatetimeLine(2),
			recorded_features: [PLAN_FEATURES["web-apps"].label],
		});
		expect(android).toMatchObject({
			runs_only_on: "android",
			split_line: null,
			label: PLATFORM_DECLARATION_LABELS.android,
		});
		body.runsOn.forEach((entry, index) => {
			const lines = firstPublishLines(entry.firstPublish, "review");
			expect(shown.runs_on[index]?.first_publish).toStrictEqual({
				heading: lines.heading,
				lead: lines.lead,
				workers: { label: lines.workers.label, lines: lines.workers.lines },
				hq_only: { label: lines.hqOnly.label, lines: lines.hqOnly.lines },
				reassurance: lines.reassurance,
				note: lines.note,
			});
		});
		/* Two ways to run that differ in declaration differ in list. */
		expect(both?.first_publish).not.toEqual(android?.first_publish);
		expect(Object.keys(shown)).not.toContain("first_publish");
		expect(JSON.stringify(projection)).not.toContain("touches_workers");
		expect(JSON.stringify(projection)).not.toContain("touchesWorkers");

		expect(shown.runs_on_notes).toEqual([
			REVIEW_RUNS_ON_WHY["keeps-web-apps"],
			REVIEW_CHANGE_LATER,
		]);
		const [platformOut] = body.platformsOut;
		if (platformOut === undefined) throw new Error("no platform out");
		const out = platformOutBlock(platformOut);
		const label = PLATFORM_FEATURES["datetime-question"].label;
		expect(shown.cannot_run).toEqual([
			{
				platform: "web-apps",
				sentence: out.lead,
				features: [label],
				files: out.files,
			},
		]);
		expect(shown.cannot_run[0]?.sentence).not.toContain(label);

		expect(shown.kept).toEqual({
			lead: keptLead("15 November 2026", true),
			labels: [
				KEPT_LABELS["automatic-app-updates"],
				KEPT_LABELS["device-logging"],
			],
			note: KEPT_FOLLOWS_LINE,
		});

		const [village, clinic, district] = shown.tables;
		expect(village).toEqual({
			tag: "village",
			standing: "new",
			sentence: reviewManagedTables(["village"], KEY.domain),
			choice: null,
		});
		expect(clinic?.sentence).toBe(
			reviewSameEqualTable("clinic", PROJECT, KEY.domain),
		);
		const tableChoice = CHOICE_TABLE.choice;
		if (tableChoice === null) throw new Error("no choice");
		expect(district).toEqual({
			tag: "district",
			standing: "choice",
			sentence: null,
			choice: {
				title: reviewChoiceTitle("district", PROJECT, tableChoice),
				body: reviewChoiceBody("district", PROJECT, KEY.domain, tableChoice),
				answers: [
					{
						answer: "use-commcare-hq",
						offered: true,
						label: HQ_TABLE_ANSWER,
						lines: [
							hqTableAnswerConsequence(PROJECT, "district", tableChoice.apps),
						],
						reason: null,
					},
					{
						answer: "use-project",
						offered: false,
						label: projectTableAnswer(PROJECT),
						lines: [projectTableAnswerConsequence(PROJECT, KEY.domain)],
						reason: choiceNotOffered(
							{ offered: false, why: "needs-admin", name: null },
							PROJECT,
						),
					},
				],
			},
		});

		expect(shown.tables_total).toBe(3);
		expect(shown.next_page).toBeNull();

		expect(shown.places).toEqual({
			count: 12,
			sentence: reviewManagedPlaces(12, KEY.domain),
		});
		expect(shown.media).toEqual({
			sentence: reviewMediaAdded(3, PROJECT),
			left_out: reviewMediaLeftOut(1),
		});
		expect(shown.after).toEqual([
			reviewAfterPublishLine(KEY.domain),
			REVIEW_AFTER_DRIFT_LINE,
			ANOTHER_SPACE_NEW_APP_LINE,
		]);
	});

	it("serves each owner-rule question by its level with the one answer, in a page however many forms use the rule", () => {
		const LONG = "Ž".repeat(255);
		const levels = ["clinic", "district", "ward"];
		const body: ReadingReview = {
			...review(),
			ownerRules: levels.map((level) => ({
				level,
				levelName: `${level}${LONG}`,
				conflict: {
					kind: "two-places",
					source: `East${LONG}`,
					places: [`East A${LONG}`, `East B${LONG}`],
				},
				forms: Array.from({ length: 600 }, (_, form) => `${form}${LONG}`),
			})),
		};
		const projection = served(
			describeReading(reviewAnswer(body), KEY, FIRST_PAGE),
		);
		expect(JSON.stringify(projection).length).toBeLessThan(PAGE_LIMIT_CHARS);
		const rules = projection.review?.owner_rules ?? [];
		expect(rules.map((rule) => rule.level)).toEqual(levels);
		for (const rule of rules) {
			expect(rule.answer.value).toBe("worker");
			expect(rule.body).toContain("and 597 other forms");
		}
	});

	it("says what the first upload asks under the preselected way to run", () => {
		const body = review();
		const androidFirst: ReadingReview = {
			...body,
			runsOn: body.runsOn.map((entry) => ({
				...entry,
				preselected: entry.runsOnlyOn === "android",
			})),
		};
		const shown = describeReading(
			reviewAnswer(androidFirst),
			KEY,
			FIRST_PAGE,
		).review;
		expect(shown?.runs_on_notes).toEqual([
			REVIEW_RUNS_ON_WHY["keeps-web-apps"],
			REVIEW_WEB_APPS_ASKS_OFF,
			REVIEW_CHANGE_LATER,
		]);
	});
});

describe("an account a page at a time", () => {
	const LONG = "Ž".repeat(FINDING_NAME_MAX_LENGTH);

	function longest(index: number): Finding {
		return manifest(
			{
				kind: "question",
				menu: 999,
				form: 999,
				menuName: LONG,
				formName: LONG,
				path: `${index}/${LONG}`,
			},
			`${index}${LONG}`.slice(0, FINDING_NAME_MAX_LENGTH),
		);
	}

	it("cuts 2,000 findings at their longest into pages under the limit that give every finding once", () => {
		const answer = account(
			Array.from({ length: 2000 }, (_, index) => longest(index)),
			{ more: 12_345 },
		);
		const seen: string[] = [];
		let cursor: string | null = null;
		let pages = 0;
		do {
			const parsed = cursor === null ? null : parseAccountPage(cursor);
			if (cursor !== null && parsed === null)
				throw new Error(`An unreadable cursor: ${cursor}`);
			const start = pageFor(answer, parsed, PAGE_CONTEXT);
			if (start === null) throw new Error("The cursor named no page.");
			expect(start.restarted).toBe(false);
			const projection = describeReading(answer, KEY, {
				...start,
				project: PROJECT,
			});
			expect(JSON.stringify(projection).length).toBeLessThan(PAGE_LIMIT_CHARS);
			const listed = projection.account;
			if (listed === undefined) throw new Error("no account");
			expect(listed.check_again).toBe(ACCOUNT_CHECK_AGAIN_LINE);
			expect(listed.total).toBe(2000);
			expect(listed.findings.length).toBeGreaterThan(0);
			for (const finding of listed.findings) seen.push(finding.named ?? "");
			cursor = listed.next_page;
			pages += 1;
		} while (cursor !== null);
		expect(pages).toBeGreaterThan(1);
		expect(seen).toEqual(
			answer.findings.map((finding) => finding.detail.name ?? ""),
		);
	});

	it("holds a first page under the limit where one finding's place is longer than a page, and within it the whole answer it goes out in", () => {
		const huge = "M".repeat(200_000);
		const answer = account([
			manifest(
				{
					kind: "question",
					menu: 0,
					form: 0,
					menuName: huge,
					formName: huge,
					path: huge,
				},
				huge,
			),
			longest(1),
		]);
		const envelope = (reading: unknown) => ({
			status: "changed",
			message: "x".repeat(20_000),
			reading,
		});
		const projection = describeReading(answer, KEY, {
			...FIRST_PAGE,
			envelope,
		});
		expect(JSON.stringify(envelope(projection)).length).toBeLessThanOrEqual(
			PAGE_LIMIT_CHARS,
		);
		expect(projection.account?.findings.length).toBeGreaterThan(0);
	});

	it("answers a page cut from another account from the fresh account's start, restarted", () => {
		const before = account(
			Array.from({ length: 300 }, (_, index) => longest(index)),
		);
		const first = describeReading(before, KEY, FIRST_PAGE).account?.next_page;
		if (first == null) throw new Error("one page held the whole account");
		const cursor = parseAccountPage(first);
		const now = account(
			Array.from({ length: 300 }, (_, index) => longest(index + 1)),
		);
		expect(accountDigest(now)).not.toBe(accountDigest(before));
		const start = pageFor(now, cursor, PAGE_CONTEXT);
		expect(start).toEqual({ from: 0, restarted: true });
		const projection = describeReading(now, KEY, {
			...(start as NonNullable<typeof start>),
			project: PROJECT,
		});
		expect(projection.restarted).toBe(true);
		expect(projection.message).toBe(READING_RESTARTED_MESSAGE);
		expect(projection.account?.findings[0]?.named).toBe(
			now.findings[0]?.detail.name,
		);
	});

	it("answers a page against a read that is now a review with the review, restarted", () => {
		const before = account(
			Array.from({ length: 300 }, (_, index) => longest(index)),
		);
		const first = describeReading(before, KEY, FIRST_PAGE).account?.next_page;
		if (first == null) throw new Error("one page held the whole account");
		const start = pageFor(
			reviewAnswer(),
			parseAccountPage(first),
			PAGE_CONTEXT,
		);
		expect(start).toEqual({ from: 0, restarted: true });
		const projection = describeReading(reviewAnswer(), KEY, {
			...(start as NonNullable<typeof start>),
			project: PROJECT,
		});
		expect(projection).toMatchObject({
			state: "review",
			restarted: true,
			message: READING_RESTARTED_MESSAGE,
		});
	});

	it("answers a page that meets a stop with the stop alone, never as an app that changed", () => {
		const before = account(
			Array.from({ length: 300 }, (_, index) => longest(index)),
		);
		const first = describeReading(before, KEY, FIRST_PAGE).account?.next_page;
		if (first == null) throw new Error("one page held the whole account");
		const cursor = parseAccountPage(first);
		const busy: ReadingAnswer = {
			kind: "stop",
			finding: circumstanceFinding("rate-limited", { kind: "app" }, {}),
		};
		const start = pageFor(busy, cursor, PAGE_CONTEXT);
		expect(start).toEqual({ from: 0, restarted: false });
		const projection = describeReading(busy, KEY, {
			...(start as NonNullable<typeof start>),
			project: PROJECT,
		});
		expect(projection).toMatchObject({
			state: "stop",
			restarted: false,
			message: null,
			stop: { code: "rate-limited" },
		});
		/* The same cursor still pages the account once CommCare HQ answers. */
		expect(pageFor(before, cursor, PAGE_CONTEXT)).toEqual({
			from: cursor?.from,
			restarted: false,
		});
	});

	it("reads only a cursor Nova gives", () => {
		expect(parseAccountPage(`12:${DIGEST}`)).toEqual({
			from: 12,
			digest: DIGEST,
		});
		for (const page of [`0:${DIGEST}`, `012:${DIGEST}`, `12:${"A".repeat(64)}`])
			expect(parseAccountPage(page)).toBeNull();
		const short = account([manifest(QUESTION)]);
		expect(
			pageFor(short, { from: 5, digest: accountDigest(short) }, PAGE_CONTEXT),
		).toBeNull();
	});
});

describe("a review's lookup tables a page at a time", () => {
	const LONG = "Ž".repeat(255);

	/** A table whose choice names many apps at their longest. */
	function longTable(index: number): ReviewTable {
		const choice = CHOICE_TABLE.choice;
		if (choice === null) throw new Error("no choice");
		return {
			...CHOICE_TABLE,
			tag: `table_${index}`,
			choice: {
				...choice,
				apps: Array.from({ length: 20 }, (_, app) => ({
					appId: `app-${index}-${app}`,
					appName: `${app}${LONG}`,
					deleted: false,
				})),
			},
		};
	}

	function manyTables(count: number, digest: string = DIGEST): ReadingAnswer {
		return {
			kind: "review",
			readingId: READING_ID,
			reviewDigest: digest,
			review: {
				...review(),
				tables: Array.from({ length: count }, (_, index) => longTable(index)),
			},
		};
	}

	it("pages every lookup choice, case type and physical file before offering approval", () => {
		const answer = reviewAnswer();
		if (answer.kind !== "review") throw new Error("Expected a review");
		const shortTables = manyTables(250);
		if (shortTables.kind !== "review")
			throw new Error("Expected lookup tables");
		const file = `/jr/media/${'Door "visits" \\ '.repeat(19000)}`;
		const files: string[] = [];
		const tables: string[] = [];
		const columns = Array.from(
			{ length: 250 },
			(_, i) => String(i).padStart(3, "0") + "x".repeat(117),
		);
		const shared = longTable(0);
		if (!shared.choice) throw new Error("Expected table choice");
		const table = {
			...shared,
			tag: "regional_households",
			choice: {
				...shared.choice,
				options: {
					...shared.choice.options,
					"use-commcare-hq": {
						offered: true as const,
						goneColumns: columns.slice(0, 125),
						retypedColumns: columns.slice(125),
					},
				},
			},
		};
		const caseTypes = Array.from(
			{ length: 3500 },
			(_, i) => `family_member_${i}`,
		);
		const tableText: string[] = [];
		const receivedTypes: string[] = [];

		const input = {
			...answer,
			review: {
				...answer.review,
				tables: [table, ...shortTables.review.tables],
				creates: { ...answer.review.creates, caseTypes },
				runsOn: answer.review.runsOn.map((choice, i) => ({
					...choice,
					...(i === 0 && { removesFiles: [file] }),
				})),
			},
		};
		let from = 0;
		for (;;) {
			const body = describeReading(input, KEY, { ...FIRST_PAGE, from });
			expect(
				JSON.stringify({
					content: [{ type: "text", text: JSON.stringify(body) }],
				}).length,
			).toBeLessThanOrEqual(PAGE_LIMIT_CHARS);
			const next = body.review;
			if (!next) throw new Error("Missing review");
			for (const detail of next.publish_details ?? []) {
				expect(detail.runs_only_on).toEqual(
					answer.review.runsOn[0]?.runsOnlyOn,
				);
				files.push(detail.text);
			}
			tables.push(...next.tables.map((t) => t.tag));
			receivedTypes.push(...next.creates.case_types);
			for (const fragment of next.table_parts ?? []) {
				expect(fragment.answers.map((option) => option.offered)).toEqual([
					true,
					false,
				]);
				expect(fragment.tag).toBe(table.tag);
				tableText.push(fragment.text);
			}
			if (!next.next_page) {
				expect(next.review_digest).toBe(DIGEST);
				break;
			}
			expect(next.review_digest).toBeNull();
			expect(next.next_page).not.toContain(DIGEST);
			const page = pageFor(input, parseAccountPage(next.next_page), {
				project: PROJECT,
				domain: KEY.domain,
			});
			if (!page || page.restarted) throw new Error("Expected a stable cursor");
			from = page.from;
		}
		expect(files.join("")).toBe(file);
		expect(receivedTypes).toEqual(caseTypes);
		expect(JSON.parse(tableText.join(""))).toEqual(
			tableProjection(table, PROJECT, KEY.domain),
		);
		for (const column of columns) expect(tableText.join("")).toContain(column);
		expect(tables).toEqual(shortTables.review.tables.map((t) => t.tag));
	});

	it("restarts from the first table when a Project name changes the pieces of its choices", () => {
		const wide = `Project ${"x".repeat(48)}`,
			short = "Visits";
		const answer = reviewAnswer();
		if (answer.kind !== "review") throw new Error("Expected a review");
		const tables: ReviewTable[] = Array.from({ length: 7 }, (_, i) => ({
			...CHOICE_TABLE,
			tag: `table_${i}`,
			choice: {
				differs: ["rows"],
				apps: [{ appId: "other", appName: "Registration", deleted: false }],
				options: {
					"use-commcare-hq": {
						offered: true,
						goneColumns: [],
						retypedColumns: Array.from(
							{ length: 238 },
							(_, j) => `column_${j}_${"x".repeat(108)}`,
						),
					},
					"use-project": { offered: false, why: "needs-admin", name: null },
				},
			},
		}));
		const all = { ...answer, review: { ...answer.review, tables } };
		const first = describeReading(all, KEY, {
			...FIRST_PAGE,
			project: wide,
		}).review;
		if (!first?.next_page) throw new Error("Expected split table choices");
		expect(first.table_parts?.map((x) => [x.item, x.part])).toEqual([
			[0, 1],
			[0, 2],
			[1, 1],
			[1, 2],
		]);
		const context = { project: short, domain: KEY.domain };
		let step = pageFor(all, parseAccountPage(first.next_page), context);
		expect(step).toEqual({ from: 0, restarted: true });
		const seen: string[] = [];
		while (step) {
			const view = describeReading(all, KEY, {
				...step,
				project: short,
			}).review;
			if (!view) throw new Error("Expected reconstruction");
			seen.push(...view.tables.map((row) => row.tag));
			if (!view.next_page) {
				expect(view.review_digest).toBe(answer.reviewDigest);
				break;
			}
			expect(view.review_digest).toBeNull();
			step = pageFor(all, parseAccountPage(view.next_page), context);
		}
		expect(seen).toEqual(tables.map((t) => t.tag));
	});
	it("retains every project search detail across escaped names and table choices before issuing the birth digest", () => {
		const text = '"\\🪴'.repeat(30000);
		const base = review();
		const answer = reviewAnswer({
			...base,
			projectSearches: [
				{
					searchUuid: testUuid("directory"),
					name: text,
					endpointId: 17,
					menus: [
						{
							menuUuid: testUuid("followup"),
							name: "Visits",
							parameters: ["area"],
							results: [{ name: "case_id", type: "text" }],
						},
					],
				},
			],
		});
		let page: string | null = null;
		const fragments: string[] = [];
		const tables: string[] = [];
		let calls = 0;
		do {
			const start = pageFor(answer, page ? parseAccountPage(page) : null, {
				project: FIRST_PAGE.project,
				domain: KEY.domain,
			});
			if (!start || start.restarted)
				throw new Error("The source review lost its place.");
			const shown = describeReading(answer, KEY, { ...FIRST_PAGE, ...start });
			const projection = shown.review;
			if (!projection) throw new Error("Expected a review.");
			const serialized = JSON.stringify({
				content: [{ type: "text", text: JSON.stringify(shown) }],
			});
			expect(serialized.length).toBeLessThanOrEqual(100000);
			for (const row of projection.project_search_details ?? [])
				if (row.kind === "search") {
					expect(row.endpointId).toBe(17);
					fragments.push(row.text);
				}
			tables.push(...projection.tables.map((t) => t.tag));
			page = projection.next_page;
			expect(projection.review_digest).toBe(page === null ? DIGEST : null);
			if (page) expect(page.includes(DIGEST)).toBe(false);
			calls++;
			if (calls > 30) throw new Error("The review did not finish.");
		} while (page);
		expect(calls).toBeGreaterThan(1);
		expect(fragments.join("")).toBe(text);
		expect(tables).toEqual(base.tables.map((t) => t.tag));
	});
	it("pages every named installation together with the lookup tables before initial adoption", () => {
		const installations = Array.from({ length: 450 }, (_, i) => ({
			key: `site-${i}`,
			name: `Installation ${i} ${"Team ".repeat(50)}`,
			languages: ["eng", "fra"],
			requiresPracticeWorker: true,
			worker: `practice-${i}`,
		}));
		const answer = reviewAnswer({ ...review(), installations });
		const ids: string[] = [];
		const tables: string[] = [];
		let cursor: string | null = null;
		let pages = 0;
		do {
			const parsed = cursor === null ? null : parseAccountPage(cursor);
			const start = pageFor(answer, parsed, {
				project: PROJECT,
				domain: KEY.domain,
			});
			if (!start || start.restarted)
				throw new Error("The reviewed installation changed across pages");
			const body = describeReading(answer, KEY, { ...start, project: PROJECT });
			expect(JSON.stringify(body).length).toBeLessThanOrEqual(PAGE_LIMIT_CHARS);
			if (!body.review) throw new Error("Missing adoption review");
			expect(body.review.installations_total).toBe(installations.length);
			for (const row of body.review.installations ?? [])
				ids.push(row.profile_id);
			for (const row of body.review.tables) tables.push(row.tag);
			cursor = body.review.next_page;
			pages++;
		} while (cursor !== null);
		expect(pages).toBeGreaterThan(1);
		expect(ids).toEqual(installations.map((p) => p.key));
		expect(tables).toEqual(review().tables.map((t) => t.tag));
	});
	it("discloses long destination identities completely before returning an adoption digest", () => {
		const answer = reviewAnswer();
		if (answer.kind !== "review") throw new Error("Expected a review");
		const file = `/jr/media/${'Door "visits" \\ '.repeat(19000)}`;
		const files: string[] = [];
		const tables: string[] = [];
		const key = "⌂".repeat(90_000);
		const columns = Array.from(
			{ length: 250 },
			(_, i) => String(i).padStart(3, "0") + "x".repeat(117),
		);
		const shared = longTable(0);
		if (!shared.choice) throw new Error("Expected table choice");
		const table = {
			...shared,
			choice: {
				...shared.choice,
				options: {
					...shared.choice.options,
					"use-commcare-hq": {
						offered: true as const,
						goneColumns: columns.slice(0, 125),
						retypedColumns: columns.slice(125),
					},
				},
			},
		};
		const caseTypes = Array.from(
			{ length: 3500 },
			(_, i) => `family_member_${i}`,
		);
		const tableText: string[] = [];
		const receivedTypes: string[] = [];

		const input = {
			...answer,
			review: {
				...answer.review,
				tables: [table, ...answer.review.tables],
				creates: { ...answer.review.creates, caseTypes },
				runsOn: answer.review.runsOn.map((choice, i) => ({
					...choice,
					...(i === 0 && { removesFiles: [file] }),
				})),
				installations: [
					{
						key,
						name: "Long installation",
						languages: ["eng"],
						worker: "worker",
						requiresPracticeWorker: true,
					},
				],
			},
		};
		let from = 0;
		const chunks: string[] = [];
		for (;;) {
			const body = describeReading(input, KEY, { ...FIRST_PAGE, from });
			expect(
				JSON.stringify({
					content: [{ type: "text", text: JSON.stringify(body) }],
				}).length,
			).toBeLessThanOrEqual(PAGE_LIMIT_CHARS);
			const next = body.review;
			if (!next) throw new Error("Missing review");
			for (const detail of next.publish_details ?? []) {
				expect(detail.runs_only_on).toEqual(
					answer.review.runsOn[0]?.runsOnlyOn,
				);
				files.push(detail.text);
			}
			tables.push(...next.tables.map((t) => t.tag));
			receivedTypes.push(...next.creates.case_types);
			for (const fragment of next.table_parts ?? []) {
				expect(fragment.answers.map((option) => option.offered)).toEqual([
					true,
					false,
				]);
				expect(fragment.tag).toBe(table.tag);
				tableText.push(fragment.text);
			}
			for (const piece of next.installation_parts ?? [])
				chunks.push(piece.text);
			if (!next.next_page) {
				expect(next.review_digest).toBe(DIGEST);
				break;
			}
			expect(next.review_digest).toBeNull();
			const page = pageFor(input, parseAccountPage(next.next_page), {
				project: PROJECT,
				domain: KEY.domain,
			});
			if (!page || page.restarted) throw new Error("Expected a stable cursor");
			from = page.from;
		}
		expect(files.join("")).toBe(file);
		expect(receivedTypes).toEqual(caseTypes);
		expect(JSON.parse(tableText.join(""))).toEqual(
			tableProjection(table, PROJECT, KEY.domain),
		);
		for (const column of columns) expect(tableText.join("")).toContain(column);
		expect(tables).toEqual(answer.review.tables.map((t) => t.tag));
		expect(JSON.parse(chunks.join(""))).toEqual({
			profile_id: key,
			name: "Long installation",
			languages: [{ language: "eng" }],
			practice_worker_id: "worker",
		});
	});

	it("cuts 2,000 tables at their longest into pages under the limit that give every table once", () => {
		const answer = manyTables(2000);
		const seen: string[] = [];
		let cursor: string | null = null;
		let pages = 0;
		do {
			const parsed = cursor === null ? null : parseAccountPage(cursor);
			if (cursor !== null && parsed === null)
				throw new Error(`An unreadable cursor: ${cursor}`);
			const start = pageFor(answer, parsed, PAGE_CONTEXT);
			if (start === null) throw new Error("The cursor named no page.");
			expect(start.restarted).toBe(false);
			const projection = describeReading(answer, KEY, {
				...start,
				project: PROJECT,
			});
			expect(JSON.stringify(projection).length).toBeLessThan(PAGE_LIMIT_CHARS);
			const shown = projection.review;
			if (shown === undefined) throw new Error("no review");
			expect(shown.tables_total).toBe(2000);
			expect(shown.review_digest).toBe(
				shown.next_page === null ? DIGEST : null,
			);
			if (shown.next_page)
				expect(shown.next_page.endsWith(READING_ID)).toBe(true);
			expect(shown.tables.length).toBeGreaterThan(0);
			for (const table of shown.tables) seen.push(table.tag);
			cursor = shown.next_page;
			pages += 1;
		} while (cursor !== null);
		expect(pages).toBeGreaterThan(1);
		expect(seen).toEqual(
			Array.from({ length: 2000 }, (_, index) => `table_${index}`),
		);
	});

	it("answers a page cut from another review from the fresh review's start, restarted", () => {
		const first = describeReading(manyTables(300), KEY, FIRST_PAGE).review
			?.next_page;
		if (first == null) throw new Error("one page held every table");
		const now = manyTables(300, "b".repeat(64));
		const start = pageFor(now, parseAccountPage(first), PAGE_CONTEXT);
		expect(start).toEqual({ from: 0, restarted: true });
		const projection = describeReading(now, KEY, {
			...(start as NonNullable<typeof start>),
			project: PROJECT,
		});
		expect(projection).toMatchObject({
			restarted: true,
			message: READING_RESTARTED_MESSAGE,
		});
		expect(projection.review?.tables[0]?.tag).toBe("table_0");
	});

	it("answers a page against a read that is now an account with the account, restarted", () => {
		const first = describeReading(manyTables(300), KEY, FIRST_PAGE).review
			?.next_page;
		if (first == null) throw new Error("one page held every table");
		expect(
			pageFor(
				account([manifest(QUESTION)]),
				parseAccountPage(first),
				PAGE_CONTEXT,
			),
		).toEqual({ from: 0, restarted: true });
	});

	it("reads no cursor past the review's last table", () => {
		expect(
			pageFor(
				reviewAnswer(),
				{
					from: 3,
					digest: reviewedPageDigest(
						"birth",
						birthPageSubject(DIGEST, PROJECT, KEY.domain),
						3,
					),
					readingId: READING_ID,
				},
				PAGE_CONTEXT,
			),
		).toBeNull();
		expect(
			pageFor(
				reviewAnswer(),
				{
					from: 2,
					digest: reviewedPageDigest(
						"birth",
						birthPageSubject(DIGEST, PROJECT, KEY.domain),
						2,
					),
					readingId: READING_ID,
				},
				PAGE_CONTEXT,
			),
		).toEqual({
			from: 2,
			restarted: false,
		});
	});
});

describe("mapReadingRefusal", () => {
	it("gives every refusal its tag and the screen's sentence, and names the Project only for access", () => {
		const tags = Object.fromEntries(
			READING_REFUSALS.map((refusal) => {
				const error = mapReadingRefusal(refusal, KEY.projectId);
				expect(error).toBeInstanceOf(BringInToolError);
				expect(error.message).toBe(READING_REFUSAL_COPY[refusal]);
				expect(error.fields.refusal).toBe(refusal);
				expect(error.fields.projectId).toBe(
					refusal === "no_project_access" ? KEY.projectId : undefined,
				);
				return [refusal, error.errorType];
			}),
		);
		expect(tags).toEqual({
			session_ended: "permission_denied",
			no_project_access: "permission_denied",
			invalid_input: "invalid_input",
			name_missing: "invalid_input",
			choice_not_offered: "invalid_input",
			choice_missing: "invalid_input",
			project_changed: "bring_in_refused",
			app_unavailable: "bring_in_refused",
			publish_in_flight: "bring_in_refused",
		});
	});
});
