/**
 * What `read_hq_changes` and `bring_in_hq_changes` serve of one review and
 * of a bring-in's answers that read nothing more, as data: every line of
 * both lists, each sentence from the copy the panel shows, the days as the
 * UTC day, and a long account cut into pages a client follows to its end.
 *
 * It would catch: a list cut on the server, so a person agrees to remove
 * work no line names; MCP and the panel wording one state two ways; an
 * account a client truncates in silence; two versions of an app stitched
 * into one list.
 */

import { describe, expect, it } from "vitest";
import type { HqChangesReview } from "@/lib/deployment/hqChanges/types";
import type { ReviewTable } from "@/lib/deployment/reading/types";
import { madeByLine } from "@/lib/publish/documentChangeCopy";
import type { DriftReference } from "@/lib/publish/driftReference";
import {
	CANNOT_BRING_IN_TOO_LARGE_LEAD,
	cannotBringInLead,
	HQ_CHANGES_GATE_LEAD,
	HQ_CHANGES_GATE_NEXT,
	HQ_CHANGES_NOTHING_TAKEN_LINE,
	hqChangesHeldLine,
	hqChangesLead,
	hqChangesMovedLine,
	hqChangesUnavailableLine,
	NEXT_PUBLISH_LEAD,
	nothingToBringInLine,
	renamedInNovaLine,
} from "@/lib/publish/hqChangesCopy";
import {
	HQ_CHANGE_HELD,
	HQ_CHANGES_UNAVAILABLE,
} from "@/lib/publish/hqChangesKinds";
import { ACCOUNT_CHECK_AGAIN_LINE } from "@/lib/publish/hqFindingCopy";
import {
	circumstanceFinding,
	FINDING_NAME_MAX_LENGTH,
	type Finding,
} from "@/lib/publish/hqFindings";
import { MAX_RESULT_SIZE_CHARS } from "../resultSize";
import {
	CHANGED_NOW_PAGED_NEXT,
	describeHqChangesOutcome,
} from "../tools/bringInHqChanges";
import {
	changesPageFor,
	describeHqChangesReview,
	type HqChangesCall,
	LINE_PART_MAX_CHARS,
	lineParts,
	RECORD_NOTHING_NEXT,
	reviewHead,
} from "../tools/readHqChanges";
import {
	accountDigest,
	circumstanceContextFor,
	PAGE_LIMIT_CHARS,
	parseAccountPage,
	stopProjection,
	tableProjection,
} from "../tools/readingProjection";

const CALL: HqChangesCall = {
	scope: {
		appId: "app-1",
		projectId: "project-1",
		role: "editor",
		actorUserId: "member-1",
	},
	target: { server: "india", domain: "clinic" },
};
const HEAD = reviewHead(CALL);
const FIRST_PAGE = {
	projectId: "project-1",
	remoteAppId: "a1b2c3d4e5f6",
	page: { from: 0, restarted: false },
} as const;
const DIGEST = "a".repeat(64);
const READING_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

const SINCES: readonly [DriftReference, string][] = [
	[{ kind: "published" }, "Nova last published this app to “clinic”"],
	[
		{ kind: "brought-in", at: "2026-11-10T23:30:00.000Z" },
		"Nova brought this app in on 10 November 2026",
	],
	[
		{ kind: "changes-brought-in" },
		"Nova last brought in changes from “clinic”",
	],
];

function projected(review: HqChangesReview) {
	/* As a client parses it: JSON, every undefined key gone. */
	return JSON.parse(
		JSON.stringify(describeHqChangesReview(review, HEAD, FIRST_PAGE)),
	);
}

function changes(
	overrides: Partial<Extract<HqChangesReview, { kind: "changes" }>> = {},
): Extract<HqChangesReview, { kind: "changes" }> {
	return {
		kind: "changes",
		since: { kind: "published" },
		hqChanges: ["The app's name"],
		novaChanges: [],
		madeBy: [],
		caseData: [],
		publishChanges: [],
		observedDigest: "b".repeat(64),
		renamedInNova: [],
		tables: [],
		projectName: "Field team",
		readingId: READING_ID,
		reviewDigest: DIGEST,
		...overrides,
	};
}

describe("a review of changes made in CommCare HQ", () => {
	it("returns every line of both lists, with the panel's lead and who made them", () => {
		const hqLines = Array.from(
			{ length: 60 },
			(_, index) => `The form “Visit ${index}” in the menu “Mothers”: its name`,
		);
		const novaLines = Array.from(
			{ length: 45 },
			(_, index) =>
				`The form “Visit ${index}” in the menu “Mothers”: questions changed: “q${index}”`,
		);
		const madeBy = ["Ana", "Bea", "Cy", "Dee", "Eli"];
		for (const [since, phrase] of SINCES) {
			const served = projected(
				changes({
					since,
					hqChanges: hqLines,
					novaChanges: novaLines,
					madeBy,
					caseData: ["A case data line."],
					publishChanges: ["A next publish line."],
				}),
			);
			expect(served).toEqual({
				...HEAD,
				kind: "changes",
				since,
				message: hqChangesLead(phrase, true),
				hq_changes: hqLines,
				nova_changes: novaLines,
				hq_changes_total: 60,
				nova_changes_total: 45,
				next_page: null,
				cut_line: null,
				restarted: false,
				restarted_message: null,
				made_by: madeBy,
				made_by_line: madeByLine(madeBy),
				case_data: ["A case data line."],
				publish_changes: ["A next publish line."],
				publish_changes_lead: NEXT_PUBLISH_LEAD,
				observed_digest: "b".repeat(64),
				renamed_in_nova: [],
				renamed_in_nova_line: null,
				tables: [],
				reading_id: READING_ID,
				review_digest: DIGEST,
			});
		}
	});

	/**
	 * Every page of `review` from the first, following each cursor, held
	 * under the limit, with each list's lines put back together from the
	 * parts of a cut line.
	 */
	function followPages(review: Extract<HqChangesReview, { kind: "changes" }>) {
		const lists = { hq_changes: [] as string[], nova_changes: [] as string[] };
		/* The part of a cut line read so far, and which part comes next. */
		let open: { list: keyof typeof lists; text: string; next: number } | null =
			null;
		let cursor: string | null = null;
		let pages = 0;
		let cut = 0;
		const seen = new Set<string>();
		do {
			const parsed = cursor === null ? null : parseAccountPage(cursor);
			const page = changesPageFor(review, parsed);
			if (page === null) throw new Error("The cursor named no page.");
			expect(page.restarted).toBe(false);
			const served = describeHqChangesReview(review, HEAD, {
				...FIRST_PAGE,
				page,
			});
			if (served.kind !== "changes") throw new Error("no changes");
			expect(JSON.stringify(served).length).toBeLessThan(PAGE_LIMIT_CHARS);
			expect(served).toMatchObject({
				hq_changes_total: review.hqChanges.length,
				nova_changes_total: review.novaChanges.length,
				reading_id: READING_ID,
				review_digest: DIGEST,
			});
			if (served.cut_line === null) {
				expect(open).toBeNull();
				lists.hq_changes.push(...served.hq_changes);
				lists.nova_changes.push(...served.nova_changes);
			} else {
				cut += 1;
				const { list, part, parts } = served.cut_line;
				const other = list === "hq_changes" ? "nova_changes" : "hq_changes";
				expect(served[other]).toEqual([]);
				expect(served[list]).toHaveLength(1);
				const text = served[list][0] ?? "";
				if (part === 1) {
					expect(open).toBeNull();
					open = { list, text, next: 2 };
				} else {
					expect(open).toMatchObject({ list, next: part });
					if (open === null) throw new Error("A part with no first.");
					open = { list, text: open.text + text, next: part + 1 };
				}
				if (part === parts) {
					lists[list].push(open.text);
					open = null;
				}
			}
			cursor = served.next_page;
			/* The cursor never names a page twice. */
			if (cursor !== null) {
				expect(seen.has(cursor)).toBe(false);
				seen.add(cursor);
			}
			pages += 1;
		} while (cursor !== null);
		expect(open).toBeNull();
		return { ...lists, pages, cut };
	}

	it("cuts lists longer than one answer into pages under the limit that give every line once, in order, a line longer than a page in parts, each a page of its own", () => {
		const novaLines = Array.from(
			{ length: 3000 },
			(_, index) =>
				`The form “Visit ${index}” in the menu “Mothers”: questions changed: “household/member/age_${index}” and “household/member/sex_${index}”`,
		);
		const longest = `The form “Census” in the menu “Mothers”: questions changed: ${Array.from(
			{ length: 5000 },
			(_, index) => `“household/q${index}”`,
		).join(", ")}`;
		expect(longest.length).toBeGreaterThan(PAGE_LIMIT_CHARS);
		const review = changes({
			hqChanges: ["The app's name", "The menu “Mothers”: its name changed"],
			novaChanges: [
				...novaLines.slice(0, 1500),
				longest,
				...novaLines.slice(1500),
			],
			madeBy: ["Ana"],
		});
		const read = followPages(review);
		expect(read.pages).toBeGreaterThan(3);
		expect(read.cut).toBe(lineParts(longest).length);
		expect(read.cut).toBeGreaterThan(1);
		expect(read.hq_changes).toEqual(review.hqChanges);
		expect(read.nova_changes).toEqual(review.novaChanges);
	});

	it("holds the longest line the review can write, a name with no length bound and characters JSON escapes, under every answer's limit", () => {
		/* No name has a length bound, and a menu's name in CommCare HQ is its
		 * author's: past the page in every list, with quote marks, control
		 * characters and characters outside the basic plane, whose parts are
		 * never cut inside a code point. */
		const name = `${'"\u0001'.repeat(40_000)}${"😀".repeat(30_000)}é`;
		const line = `The menu “${name}” was added`;
		expect(JSON.stringify(line).length).toBeGreaterThan(MAX_RESULT_SIZE_CHARS);
		const parts = lineParts(line);
		expect(parts.join("")).toBe(line);
		for (const part of parts) {
			expect(JSON.stringify(part).length).toBeLessThanOrEqual(
				LINE_PART_MAX_CHARS,
			);
			/* No part opens or ends inside a surrogate pair. */
			const first = part.charCodeAt(0);
			const last = part.charCodeAt(part.length - 1);
			expect(first >= 0xdc00 && first <= 0xdfff).toBe(false);
			expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
		}
		const review = changes({
			hqChanges: [line, "The app's name"],
			novaChanges: [line],
		});
		const read = followPages(review);
		expect(read.hq_changes).toEqual(review.hqChanges);
		expect(read.nova_changes).toEqual(review.novaChanges);
		expect(read.cut).toBe(2 * lineParts(line).length);
	});

	it("starts a page cut from other lists from the start, restarted, and refuses a page past the end", () => {
		const long = (tag: string) =>
			changes({
				novaChanges: Array.from(
					{ length: 3000 },
					(_, index) =>
						`The form “${tag} ${index}” in the menu “Mothers”: its name`,
				),
			});
		const before = long("Visit");
		const first = describeHqChangesReview(before, HEAD, FIRST_PAGE);
		if (first.kind !== "changes" || first.next_page === null)
			throw new Error("one page held both lists");
		const cursor = parseAccountPage(first.next_page);
		const now = { ...long("Follow-up"), reviewDigest: "c".repeat(64) };
		expect(changesPageFor(now, cursor)).toEqual({ from: 0, restarted: true });
		expect(
			describeHqChangesReview(now, HEAD, {
				...FIRST_PAGE,
				page: { from: 0, restarted: true },
			}),
		).toMatchObject({
			kind: "changes",
			restarted: true,
			restarted_message: expect.stringContaining("from the start"),
		});
		expect(changesPageFor(before, { from: 3001, digest: DIGEST })).toBeNull();
	});

	it("says nothing would be removed where Nova's list is empty, and names no one", () => {
		const served = projected(changes());
		expect(served.message).toBe(
			hqChangesLead("Nova last published this app to “clinic”", false),
		);
		expect(served.nova_changes).toEqual([]);
		expect(served.made_by_line).toBeNull();
		expect(served.publish_changes_lead).toBeNull();
	});

	it("names each case property renamed in Nova and R1's sentence", () => {
		const renames = [
			{ caseType: "mother", from: "edd", to: "due_date" },
			{ caseType: "mother", from: "lmp", to: "last_period" },
		];
		const served = projected(changes({ renamedInNova: renames }));
		expect(served.renamed_in_nova).toEqual([
			{ case_type: "mother", from: "edd", to: "due_date" },
			{ case_type: "mother", from: "lmp", to: "last_period" },
		]);
		expect(served.renamed_in_nova_line).toBe(renamedInNovaLine(renames));
	});

	it("lists a table the changed app newly reads as read_hq_app lists one, naming the app's Project", () => {
		const table: ReviewTable = {
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
		expect(
			projected(changes({ tables: [table], projectName: "Field team" })).tables,
		).toEqual([
			JSON.parse(
				JSON.stringify(tableProjection(table, "Field team", HEAD.domain)),
			),
		]);
	});

	it("says why there is nothing to bring in, for each reason", () => {
		for (const reason of [
			"unchanged",
			"reads-the-same",
			"already-here",
		] as const) {
			for (const [since, phrase] of SINCES) {
				const recorded = reason !== "unchanged";
				expect(
					projected({
						kind: "nothing",
						reason,
						since,
						publishChanges: recorded ? ["A next publish line."] : [],
						readingId: recorded ? READING_ID : null,
						reviewDigest: recorded ? DIGEST : null,
					}),
				).toEqual({
					...HEAD,
					kind: "nothing",
					reason,
					since,
					message: nothingToBringInLine(reason, phrase),
					publish_changes: recorded ? ["A next publish line."] : [],
					publish_changes_lead: recorded ? NEXT_PUBLISH_LEAD : null,
					reading_id: recorded ? READING_ID : null,
					review_digest: recorded ? DIGEST : null,
					next: recorded ? RECORD_NOTHING_NEXT : null,
				});
			}
		}
	});

	it("words each change Nova holds back, and where each version runs", () => {
		for (const reason of HQ_CHANGE_HELD) {
			const runs =
				reason === "runs-elsewhere"
					? { app: ["web-apps", "android"] as const, hq: ["android"] as const }
					: null;
			expect(projected({ kind: "held", reason, runs })).toEqual({
				...HEAD,
				kind: "held",
				reason,
				runs,
				message: hqChangesHeldLine(reason, runs),
			});
		}
	});

	it("words each review Nova cannot make against what the change is measured from", () => {
		for (const reason of HQ_CHANGES_UNAVAILABLE) {
			const since: DriftReference = {
				kind: "brought-in",
				at: "2026-11-10T08:00:00.000Z",
			};
			expect(projected({ kind: "unavailable", reason, since })).toEqual({
				...HEAD,
				kind: "unavailable",
				reason,
				since,
				message: hqChangesUnavailableLine(reason, {
					domain: HEAD.domain,
					since,
				}),
			});
			expect(
				projected({ kind: "unavailable", reason, since: null }).since,
			).toBeNull();
		}
		expect(
			projected({
				kind: "unavailable",
				reason: "baseline-unread",
				since: { kind: "brought-in", at: "2026-11-10T08:00:00.000Z" },
			}).message,
		).toContain("on 10 November 2026");
	});

	it("gives a stop's three strings as the stop screen shows them", () => {
		const finding = circumstanceFinding(
			"plan-lacks-api-access",
			{ kind: "app" },
			{},
		);
		expect(projected({ kind: "stop", finding })).toEqual({
			...HEAD,
			kind: "stop",
			stop: stopProjection(finding, circumstanceContextFor(HEAD, null)),
		});
	});
});

describe("an account a page at a time", () => {
	const LONG = "Ž".repeat(FINDING_NAME_MAX_LENGTH);

	function longest(index: number): Finding {
		return {
			code: "question-appearance-unsupported",
			standing: "not-yet",
			place: {
				kind: "question",
				menu: 999,
				form: 999,
				menuName: LONG,
				formName: LONG,
				path: `${index}/${LONG}`,
			},
			subject: "question-appearance",
			detail: { name: `${index}${LONG}`.slice(0, FINDING_NAME_MAX_LENGTH) },
		};
	}

	function account(
		findings: readonly Finding[],
		more = 0,
	): Extract<HqChangesReview, { kind: "account" }> {
		return {
			kind: "account",
			findings,
			more,
			counts: { notYet: findings.length, never: 0, fixInHq: 0 },
		};
	}

	it("cuts 2,000 findings at their longest into pages under the limit that give every finding once", () => {
		const review = account(
			Array.from({ length: 2000 }, (_, index) => longest(index)),
			12_345,
		);
		const seen: string[] = [];
		let cursor: string | null = null;
		let pages = 0;
		do {
			const parsed = cursor === null ? null : parseAccountPage(cursor);
			const page = changesPageFor(review, parsed);
			if (page === null) throw new Error("The cursor named no page.");
			expect(page.restarted).toBe(false);
			const served = describeHqChangesReview(review, HEAD, {
				...FIRST_PAGE,
				page,
			});
			expect(JSON.stringify(served).length).toBeLessThan(PAGE_LIMIT_CHARS);
			if (served.kind !== "account") throw new Error("no account");
			expect(served.message).toBe(cannotBringInLead(2000 + 12_345));
			expect(served.account.total).toBe(2000);
			expect(served.account.check_again).toBe(ACCOUNT_CHECK_AGAIN_LINE);
			expect(Object.keys(served.account)).not.toContain("media_checked");
			expect(Object.keys(served.account)).not.toContain("note");
			for (const finding of served.account.findings)
				seen.push(finding.named ?? "");
			cursor = served.account.next_page;
			pages += 1;
		} while (cursor !== null);
		expect(pages).toBeGreaterThan(1);
		expect(seen).toEqual(
			review.findings.map((finding) => finding.detail.name ?? ""),
		);
	});

	it("answers a page cut from another account from the fresh one's start, restarted, and a page past the end with none", () => {
		const before = account(
			Array.from({ length: 300 }, (_, index) => longest(index)),
		);
		const first = describeHqChangesReview(before, HEAD, FIRST_PAGE);
		if (first.kind !== "account" || first.account.next_page === null)
			throw new Error("one page held the whole account");
		const cursor = parseAccountPage(first.account.next_page);
		const now = account(
			Array.from({ length: 300 }, (_, index) => longest(index + 1)),
		);
		expect(accountDigest(now)).not.toBe(accountDigest(before));
		const page = changesPageFor(now, cursor);
		expect(page).toEqual({ from: 0, restarted: true });
		const served = describeHqChangesReview(now, HEAD, {
			...FIRST_PAGE,
			page: page ?? FIRST_PAGE.page,
		});
		expect(served).toMatchObject({
			kind: "account",
			restarted: true,
			restarted_message: expect.stringContaining("from the start"),
		});
		expect(changesPageFor(changes(), cursor)).toEqual({
			from: 0,
			restarted: true,
		});
		expect(
			changesPageFor(before, { from: 300, digest: accountDigest(before) }),
		).toBeNull();
	});

	it("says Nova read nothing where the account's one finding is that CommCare HQ's version is too large, as the panel does", () => {
		const tooLarge = circumstanceFinding("too-large", { kind: "app" }, {});
		const lead = (findings: readonly Finding[], more = 0) =>
			describeHqChangesReview(account(findings, more), HEAD, FIRST_PAGE);
		expect(lead([tooLarge])).toMatchObject({
			kind: "account",
			message: CANNOT_BRING_IN_TOO_LARGE_LEAD,
		});
		/* Beside another finding, or with more past the list, Nova did read. */
		expect(lead([tooLarge, longest(0)])).toMatchObject({
			message: cannotBringInLead(2),
		});
		expect(lead([tooLarge], 1)).toMatchObject({
			message: cannotBringInLead(2),
		});
	});

	it("links no place into CommCare HQ where the deployment names no app there", () => {
		const served = describeHqChangesReview(account([longest(0)]), HEAD, {
			...FIRST_PAGE,
			remoteAppId: null,
		});
		if (served.kind !== "account") throw new Error("no account");
		expect(served.account.findings.map((finding) => finding.hq_url)).toEqual([
			null,
		]);
	});
});

describe("a bring-in's answers that name no deployment", () => {
	it("gives G1's lead, each finding in the voice MCP speaks and its next step", async () => {
		expect(
			await describeHqChangesOutcome(
				{
					kind: "gate",
					findings: ["One, for the builder.", "Two, for the builder."],
					details: ["One.", "Two."],
				},
				CALL,
			),
		).toEqual({
			kind: "gate",
			message: HQ_CHANGES_GATE_LEAD,
			findings: ["One.", "Two."],
			next: HQ_CHANGES_GATE_NEXT,
		});
	});

	it("relays a refusal's own sentence", async () => {
		expect(
			await describeHqChangesOutcome(
				{ kind: "refused", message: "Not now." },
				CALL,
			),
		).toEqual({ kind: "refused", message: "Not now." });
	});

	it("gives the review as it now stands, with R2 and who moved the app", async () => {
		const now = changes({ novaChanges: ["The app's name"], madeBy: ["Ana"] });
		for (const editedBy of [null, "Ana"]) {
			expect(
				await describeHqChangesOutcome(
					{ kind: "changed", now, editedBy },
					CALL,
				),
			).toEqual({
				kind: "changed",
				message: hqChangesMovedLine(editedBy),
				edited_by: editedBy,
				now: describeHqChangesReview(now, HEAD, {
					...FIRST_PAGE,
					remoteAppId: null,
				}),
				next: null,
			});
		}
	});

	/* Before `now` was paged it carried every line; a first page alone, sent
	 * on with `discard_nova_changes` true, would remove changes no one was
	 * shown. */
	it("says where the review as it now stands is only its first page, and the read's cursor takes that page's next_page", async () => {
		const now = changes({
			novaChanges: Array.from(
				{ length: 3000 },
				(_, index) =>
					`The form “Visit ${index}” in the menu “Mothers”: questions changed: “household/member/age_${index}”`,
			),
			madeBy: ["Ana"],
		});
		const answered = await describeHqChangesOutcome(
			{ kind: "changed", now, editedBy: null },
			CALL,
		);
		if (answered.kind !== "changed" || answered.now.kind !== "changes")
			throw new Error("not a changed answer over changes");
		expect(answered.next).toBe(CHANGED_NOW_PAGED_NEXT);
		expect(answered.now.next_page).not.toBeNull();
		expect(answered.now.nova_changes.length).toBeLessThan(3000);
		const cursor = parseAccountPage(answered.now.next_page ?? "");
		expect(changesPageFor(now, cursor)).toEqual({
			from: answered.now.hq_changes.length + answered.now.nova_changes.length,
			restarted: false,
		});
	});

	it("says R2 over nothing to bring in, and only that nothing was brought in where the read stopped or the change can't be brought in", async () => {
		const stood: HqChangesReview = {
			kind: "nothing",
			reason: "unchanged",
			since: { kind: "published" },
			publishChanges: [],
			readingId: null,
			reviewDigest: null,
		};
		expect(
			(
				await describeHqChangesOutcome(
					{ kind: "changed", now: stood, editedBy: null },
					CALL,
				)
			).message,
		).toBe(hqChangesMovedLine(null));
		const stopped: readonly HqChangesReview[] = [
			{
				kind: "stop",
				finding: circumstanceFinding(
					"plan-lacks-api-access",
					{ kind: "app" },
					{},
				),
			},
			{ kind: "unavailable", reason: "nova-defect", since: null },
			{ kind: "held", reason: "languages-reordered", runs: null },
		];
		for (const now of stopped) {
			expect(
				await describeHqChangesOutcome(
					{ kind: "changed", now, editedBy: null },
					CALL,
				),
			).toEqual({
				kind: "changed",
				message: HQ_CHANGES_NOTHING_TAKEN_LINE,
				edited_by: null,
				now: describeHqChangesReview(now, HEAD, {
					...FIRST_PAGE,
					remoteAppId: null,
				}),
				next: null,
			});
		}
	});
});
