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
import {
	changedOutcome,
	type HqChangesReview,
} from "@/lib/deployment/hqChanges/types";
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
	renameRecoveryLine,
} from "@/lib/publish/hqChangesCopy";
import {
	HQ_CHANGE_HELD,
	HQ_CHANGES_UNAVAILABLE,
	renameNamesReused,
} from "@/lib/publish/hqChangesKinds";
import { ACCOUNT_CHECK_AGAIN_LINE } from "@/lib/publish/hqFindingCopy";
import {
	circumstanceFinding,
	FINDING_NAME_MAX_LENGTH,
	type Finding,
} from "@/lib/publish/hqFindings";
import { PAGE_LIMIT_CHARS, reviewedPageDigest } from "../paging";
import { MAX_RESULT_SIZE_CHARS } from "../resultSize";
import {
	CHANGED_NOW_PAGED_NEXT,
	describeHqChangesOutcome,
} from "../tools/bringInHqChanges";
import {
	changesPageFor,
	changesPageSubject,
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
	parseAccountPage,
	stopProjection,
	tableProjection,
} from "../tools/readingProjection";

import { makeRemoteChangesError } from "../tools/uploadAppToHq";

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
		ownerRules: [],
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
				renamed_in_nova_total: 0,
				tables_total: 0,
				made_by_total: 5,
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
	it("explains how to recover an unread claimed target", () => {
		const answer = projected({
			kind: "unavailable",
			reason: "baseline-unread",
			since: { kind: "published" },
			requiresReview: true,
		});
		for (const step of [
			"Project admin or owner",
			"Stop publishing here",
			"publish in progress finishes",
			"new Nova app",
			"different project space",
		])
			expect(answer.message).toContain(step);
	});

	it("preserves a mandatory first-publish review and the concrete references it asks the member to approve", () => {
		const listed = changes({
			requiresReview: true,
			hqChanges: ["Publishing removes the old picture reference."],
			publishChanges: ["This publish removes 1 unused file reference."],
		});
		expect(projected(listed)).toMatchObject({
			kind: "changes",
			requires_review: true,
			hq_changes: listed.hqChanges,
			publish_changes: listed.publishChanges,
			review_digest: listed.reviewDigest,
		});
	});

	function followPages(review: Extract<HqChangesReview, { kind: "changes" }>) {
		const lists = { hq_changes: [] as string[], nova_changes: [] as string[] };
		const rest = {
			renamed_in_nova: [] as unknown[],
			tables: [] as unknown[],
			made_by: [] as string[],
		};
		/* The part of a cut line read so far, and which part comes next. */
		let open: { list: keyof typeof lists; text: string; next: number } | null =
			null;
		let cursor: string | null = null;
		let pages = 0;
		let cut = 0;
		const seen = new Set<string>();
		do {
			const parsed = cursor === null ? null : parseAccountPage(cursor);
			const page = changesPageFor(review, parsed, HEAD.domain);
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
				renamed_in_nova_total: review.renamedInNova.length,
				tables_total: review.tables.length,
				made_by_total: review.madeBy.length,
				made_by_line:
					review.madeBy.length > 0 ? madeByLine(review.madeBy) : null,
				reading_id: READING_ID,
				review_digest: served.next_page === null ? DIGEST : null,
				observed_digest:
					served.next_page === null ? review.observedDigest : null,
			});
			/* Each page with rename evidence gives the recovery for this review. */
			expect(served.renamed_in_nova_line).toBe(
				served.renamed_in_nova.length === 0
					? null
					: renameRecoveryLine(renameNamesReused(review.renamedInNova)),
			);
			rest.renamed_in_nova.push(...served.renamed_in_nova);
			rest.tables.push(...served.tables);
			rest.made_by.push(...served.made_by);
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
		return { ...lists, ...rest, pages, cut };
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

	it("pages renames made in Nova, the tables the app newly reads and who made the changes with the lines, each answer under the limit", () => {
		/* None of the three has a bound on how many there are: renames are a
		 * member's, as many as they made since, a change in CommCare HQ can read
		 * any number of new tables, and every member who changed the app is
		 * named. */
		const renamedInNova = Array.from({ length: 900 }, (_, index) => ({
			caseType: index % 2 === 0 ? "mother" : "child",
			from: `property_${index}_${"x".repeat(60)}`,
			to: `renamed_${index}_${"y".repeat(60)}`,
		}));
		const tables = Array.from(
			{ length: 400 },
			(_, index): ReviewTable => ({
				tag: `table_${index}`,
				standing: "choice",
				hqDigest: "d".repeat(64),
				projectTable: null,
				choice: {
					differs: ["rows"],
					apps: Array.from({ length: 6 }, (_, app) => ({
						appId: `app-${app}`,
						appName: `Registration ${app}`,
						deleted: false,
					})),
					options: {
						"use-commcare-hq": {
							offered: true,
							goneColumns: [],
							retypedColumns: [],
						},
						"use-project": { offered: false, why: "needs-admin", name: null },
					},
				},
			}),
		);
		const madeBy = Array.from(
			{ length: 3000 },
			(_, index) => `Member ${index} of the field team`,
		);
		const review = changes({
			hqChanges: Array.from(
				{ length: 500 },
				(_, index) =>
					`The form “Visit ${index}” in the menu “Mothers”: its name`,
			),
			renamedInNova,
			tables,
			madeBy,
		});
		expect(
			JSON.stringify({ renamedInNova, tables, madeBy }).length,
		).toBeGreaterThan(MAX_RESULT_SIZE_CHARS);
		const read = followPages(review);
		expect(read.pages).toBeGreaterThan(3);
		expect(read.hq_changes).toEqual(review.hqChanges);
		expect(read.renamed_in_nova).toEqual(
			renamedInNova.map((rename) => ({
				case_type: rename.caseType,
				from: rename.from,
				to: rename.to,
			})),
		);
		expect(read.tables).toEqual(
			tables.map((table) =>
				JSON.parse(
					JSON.stringify(tableProjection(table, "Field team", HEAD.domain)),
				),
			),
		);
		expect(read.made_by).toEqual(madeBy);
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
		expect(changesPageFor(now, cursor, HEAD.domain)).toEqual({
			from: 0,
			restarted: true,
		});
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
		expect(
			changesPageFor(
				before,
				{
					from: 3001,
					digest: reviewedPageDigest(
						"changes",
						changesPageSubject(before, HEAD.domain),
						3001,
					),
				},
				HEAD.domain,
			),
		).toBeNull();
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

	it("keeps the reused-name recovery on every rename page even when the conflicting move is on another page", () => {
		const renames = Array.from({ length: 640 }, (_, index) => ({
			caseType: "patient_referral_followup",
			from: `household_referral_progress_before_the_followup_${index}`,
			to: `household_referral_progress_after_the_followup_${index}`,
		}));
		renames.push({ ...renames[0], from: "later" });
		const review = changes({ renamedInNova: renames });
		const first = describeHqChangesReview(review, HEAD, FIRST_PAGE);
		if (first.kind !== "changes")
			throw new Error("Expected a review of HQ changes.");
		expect(first.next_page).not.toBeNull();
		expect(first.renamed_in_nova.some((move) => move.from === "later")).toBe(
			false,
		);
		expect(first.renamed_in_nova_line).toContain(
			"reversing the listed changes could move the wrong case values",
		);
		expect(followPages(review).pages).toBeGreaterThan(1);
	});

	it("reconstructs a 355-property recovery list across case types and a fragmented rename", () => {
		const moves = Array.from({ length: 355 }, (_, i) => ({
			caseType: "a".repeat(90),
			from: `p${i}`,
			to: `q${i}`,
		}));
		moves.push({ caseType: "b", from: "last", to: "newlast" });
		const old = 'Before "'.repeat(11000),
			to = "After \n".repeat(14000);
		moves.push({ caseType: "b", from: old, to });
		moves.push({ caseType: "b", from: "new-name", to: "newlast" });
		const review = changes({ renamedInNova: moves });
		const rows: { case_type: string; from: string; to: string }[] = [];
		let sections: string[] = [];
		let page: { from: number; restarted: boolean } = FIRST_PAGE.page;
		let continued = 0;
		for (;;) {
			const shown = describeHqChangesReview(review, HEAD, {
				...FIRST_PAGE,
				page,
			});
			if (shown.kind !== "changes")
				throw new Error("A changes review was expected.");
			expect(
				JSON.stringify({
					content: [{ type: "text", text: JSON.stringify(shown) }],
				}).length,
			).toBeLessThanOrEqual(PAGE_LIMIT_CHARS);
			if (shown.renamed_in_nova.length || shown.rename_parts?.length)
				expect(shown.renamed_in_nova_line).toContain(
					"move the wrong case values",
				);
			rows.push(...shown.renamed_in_nova);
			for (const part of shown.rename_parts ?? []) {
				expect(part.item).toBe(356);
				expect(part.part).toBe(sections.length + 1);
				sections.push(part.text);
				if (part.parts === part.part) {
					rows.push(JSON.parse(sections.join("")));
					sections = [];
				}
			}
			if (!shown.next_page) {
				expect(shown.review_digest).toBe(DIGEST);
				break;
			}
			expect(shown.review_digest).toBeNull();
			const next = changesPageFor(
				review,
				parseAccountPage(shown.next_page),
				HEAD.domain,
			);
			if (!next || next.restarted)
				throw new Error("The unchanged review should continue.");
			page = next;
			continued++;
		}
		expect(continued).toBeGreaterThan(1);
		expect(sections).toHaveLength(0);
		expect(rows).toHaveLength(moves.length);
		expect(rows).toEqual(
			moves.map(({ caseType, from, to }) => ({
				case_type: caseType,
				from,
				to,
			})),
		);
	});

	it("restarts fragmented table choices and contributor names after their presentation changes", () => {
		const wide = "Project " + "x".repeat(48),
			short = "Visits";
		const tables: ReviewTable[] = Array.from({ length: 7 }, (_, i) => ({
			tag: `table_${i}`,
			standing: "choice",
			hqDigest: DIGEST,
			projectTable: null,
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
		const before = changes({
			tables,
			projectName: wide,
			hqChanges: [],
			madeBy: ["Å", "B"],
		});
		const first = describeHqChangesReview(before, HEAD, FIRST_PAGE);
		if (first.kind !== "changes") throw new Error("Expected table choices.");
		expect(first.table_parts?.map((x) => [x.item, x.part])).toEqual([
			[0, 1],
			[0, 2],
			[1, 1],
			[1, 2],
		]);
		const cursor = parseAccountPage(first.next_page ?? "");
		const after = { ...before, projectName: short };
		const start = changesPageFor(after, cursor, HEAD.domain);
		expect(start).toEqual({ from: 0, restarted: true });
		const seen: string[] = [];
		let page = start;
		while (page) {
			const got = describeHqChangesReview(after, HEAD, { ...FIRST_PAGE, page });
			if (got.kind !== "changes")
				throw new Error("Expected the table choices.");
			seen.push(...got.tables.map((row) => row.tag));
			if (!got.next_page) {
				expect(got.review_digest).toBe(before.reviewDigest);
				break;
			}
			expect(got.review_digest).toBeNull();
			page = changesPageFor(
				after,
				parseAccountPage(got.next_page),
				HEAD.domain,
			);
		}
		expect(seen).toEqual(tables.map((t) => t.tag));
		for (const changed of [
			{ ...before, madeBy: ["A\u030a", "B"] },
			{ ...before, madeBy: ["Å", "É"] },
			{ ...before, madeBy: ["B", "Å"] },
			{ ...before, hqChanges: ["A different physical reference"] },
		])
			expect(changesPageFor(changed, cursor, HEAD.domain)).toEqual({
				from: 0,
				restarted: true,
			});
	});

	it("names each case property renamed in Nova and the sentence that holds the bring-in back", () => {
		const renames = [
			{ caseType: "mother", from: "edd", to: "due_date" },
			{ caseType: "mother", from: "lmp", to: "last_period" },
		];
		const served = projected(changes({ renamedInNova: renames }));
		expect(served.renamed_in_nova).toEqual([
			{ case_type: "mother", from: "edd", to: "due_date" },
			{ case_type: "mother", from: "lmp", to: "last_period" },
		]);
		expect(served.renamed_in_nova_line).toBe(renameRecoveryLine(false));
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

	it.each(["reads-the-same", "already-here"] as const)(
		"pages a recordable %s reading losslessly and withholds its receipt until the final identity line",
		async (reason) => {
			const long = '"☀😀\n'.repeat(25000);
			const lines = [
				"This form moved.",
				long,
				...Array.from(
					{ length: 30 },
					(_, i) => `File ${i}: ${(i % 2 === 0 ? "\\" : "x").repeat(6000)}`,
				),
			];
			const review = {
				kind: "nothing",
				reason,
				since: { kind: "published" },
				hqChanges: lines,
				publishChanges: [],
				readingId: READING_ID,
				reviewDigest: DIGEST,
			} as const;
			const nested = await describeHqChangesOutcome(
				{ kind: "changed", now: review, editedBy: '"'.repeat(80_000) },
				CALL,
			);
			expect(nested).toMatchObject({
				kind: "changed",
				now: { kind: "nothing", review_digest: null },
				next: CHANGED_NOW_PAGED_NEXT,
			});
			expect(
				JSON.stringify({
					content: [{ type: "text", text: JSON.stringify(nested) }],
				}).length,
			).toBeLessThanOrEqual(PAGE_LIMIT_CHARS);
			const collected: string[] = [];
			let cursor: string | null = null;
			let pages = 0;
			do {
				const at = changesPageFor(
					review,
					cursor === null ? null : parseAccountPage(cursor),
					HEAD.domain,
				);
				if (!at) throw new Error("Expected the same reading to continue.");
				const result = describeHqChangesReview(review, HEAD, {
					...FIRST_PAGE,
					page: at,
					envelope: (now) => ({ kind: "changed", now }),
				});
				if (result.kind !== "nothing")
					throw new Error("Expected unchanged document");
				expect(
					JSON.stringify({ kind: "changed", now: result }).length,
				).toBeLessThanOrEqual(PAGE_LIMIT_CHARS);
				cursor = result.next_page ?? null;
				expect(
					JSON.stringify({
						content: [
							{
								type: "text",
								text: JSON.stringify({ kind: "changed", now: result }),
							},
						],
					}).length,
				).toBeLessThanOrEqual(PAGE_LIMIT_CHARS);
				expect(result.review_digest).toBe(cursor === null ? DIGEST : null);
				expect(result.next !== null).toBe(cursor === null);
				expect(result.hq_changes_total).toBe(lines.length);
				if (result.cut_line && result.cut_line.part > 1)
					collected[collected.length - 1] += result.hq_changes[0];
				else collected.push(...result.hq_changes);
				pages++;
				if (pages > 40) throw new Error("The unchanged page did not advance.");
			} while (cursor);
			expect(pages).toBeGreaterThan(2);
			expect(collected).toEqual(lines);
		},
	);

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
						hqChanges: [],
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
					hq_changes: [],
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
			const page = changesPageFor(review, parsed, HEAD.domain);
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
		const page = changesPageFor(now, cursor, HEAD.domain);
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
		expect(changesPageFor(changes(), cursor, HEAD.domain)).toEqual({
			from: 0,
			restarted: true,
		});
		expect(
			changesPageFor(
				before,
				{ from: 300, digest: accountDigest(before) },
				HEAD.domain,
			),
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
		/* A reading that passed its work limit leads with its own line. */
		expect(
			lead([circumstanceFinding("too-intricate", { kind: "app" }, {})]),
		).toMatchObject({
			kind: "account",
			message:
				"CommCare HQ's version of this app takes more checking than Nova gives one app, so Nova brought nothing in.",
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
	it("gives the gate's lead, each finding in the voice MCP speaks and its next step", async () => {
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
			findings_total: 2,
			next: HQ_CHANGES_GATE_NEXT,
		});
	});

	it("holds as many of a gate's findings as one answer holds, each fitted, and says how many there are", async () => {
		const details = Array.from(
			{ length: 30 },
			(_, index) => `${index} ${"x".repeat(50_000)}`,
		);
		const answer = await describeHqChangesOutcome(
			{ kind: "gate", findings: details, details },
			CALL,
		);
		expect(answer.kind).toBe("gate");
		if (answer.kind !== "gate") return;
		expect(answer.findings_total).toBe(30);
		expect(answer.findings.length).toBeGreaterThan(0);
		expect(answer.findings.length).toBeLessThan(30);
		expect(JSON.stringify(answer).length).toBeLessThanOrEqual(PAGE_LIMIT_CHARS);
	});

	it("relays a refusal's own sentence", async () => {
		expect(
			await describeHqChangesOutcome(
				{ kind: "refused", message: "Not now." },
				CALL,
			),
		).toEqual({ kind: "refused", message: "Not now." });
	});

	it("gives the review as it now stands, with the line that says it moved and who moved the app", async () => {
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
		expect(changesPageFor(now, cursor, HEAD.domain)).toEqual({
			from: answered.now.hq_changes.length + answered.now.nova_changes.length,
			restarted: false,
		});
	});

	it("says the review moved over nothing to bring in, and only that nothing was brought in where the read stopped or the change can't be brought in", async () => {
		const stood: HqChangesReview = {
			kind: "nothing",
			reason: "unchanged",
			since: { kind: "published" },
			hqChanges: [],
			publishChanges: [],
			readingId: null,
			reviewDigest: null,
		};
		expect(
			(await describeHqChangesOutcome(changedOutcome(stood), CALL)).message,
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
			/* No name rides a review the person can't act on here: one that is
			 * unavailable because the app moved must not name who edits it now. */
			expect(
				await describeHqChangesOutcome(changedOutcome(now, "Ana"), CALL),
			).toEqual({
				kind: "changed",
				message: HQ_CHANGES_NOTHING_TAKEN_LINE,
				now: describeHqChangesReview(now, HEAD, {
					...FIRST_PAGE,
					remoteAppId: null,
				}),
				next: null,
			});
		}
	});
});

it("withholds all overwrite receipts when many changed places and lookup tables need a larger review", () => {
	const placements = { recorded: 0, moved: 0 };
	const changes = Array.from({ length: 500 }, (_, i) => ({
		kind: i % 2 === 0 ? ("location" as const) : ("lookup-table" as const),
		novaResourceId: `resource-${i}`,
		name: `Resource ${i}`,
		identity: `resource_${i}`,
		parts: ["Its name changed in CommCare HQ."],
		note: null,
		observedDigest: "c".repeat(64),
		baselineKnown: true,
		since: { kind: "published" as const },
		canBringIn: false,
	}));
	const render = (rows: typeof changes) =>
		makeRemoteChangesError("HQ holds changes.", "visits", rows, {
			placements,
			placement_moves: null,
		});
	const partial = render(changes.slice(0, 1));
	expect(JSON.parse(partial.content[0].text)).toMatchObject({
		remote_changes: [{ observed_digest: "c".repeat(64) }],
	});
	const response = render(changes);
	expect(JSON.stringify(response).length).toBeLessThanOrEqual(PAGE_LIMIT_CHARS);
	const body = JSON.parse(response.content[0].text);
	expect(body).toMatchObject({
		error_type: "hq_changed",
		requires_review: true,
		placements,
	});
	expect(body).not.toHaveProperty("remote_changes");
	expect(response.content[0].text).not.toContain("c".repeat(64));
});
