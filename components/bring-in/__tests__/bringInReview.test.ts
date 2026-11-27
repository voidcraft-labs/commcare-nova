/**
 * The review's answers and the lines under its platform choice: the defaults
 * a review opens with, the tables still waiting on the person, the body a
 * create is sent, why Nova chose a declaration and what the first publish
 * asks, and the first-publish list of the row the person chose. The
 * plausible failures are a default that answers a table for the person, a
 * reason that contradicts the choice, a create sent for another app than the
 * one on screen, and the preselected row's list shown for the row the person
 * chose.
 */

import { describe, expect, it } from "vitest";
import type { ReadingRefusal, ReviewTable } from "@/lib/deployment";
import {
	PLATFORM_DECLARATION_LABELS,
	PLATFORM_DECLARATION_LINES,
	PLATFORM_FEATURES,
} from "@/lib/domain/platforms";
import {
	REVIEW_CHANGE_LATER,
	REVIEW_CHOICE_MISSING,
	REVIEW_NO_CHOICE_OPEN,
	REVIEW_RUNS_ON_WHY,
	REVIEW_WEB_APPS_ASKS_OFF,
	REVIEW_WEB_APPS_ASKS_ON,
	splitDatetimeLine,
} from "@/lib/publish/bringInCopy";
import { firstPublishLines } from "@/lib/publish/firstPublishCopy";
import { CREATE_ANSWER_LEADS } from "@/lib/publish/hqReadingCopy";
import {
	CHOICE_OTHER_PROJECT,
	choiceNotOffered,
	columnsBecomeText,
	HQ_TABLE_ANSWER,
	hqTableAnswerConsequence,
	hqTableAnswerGoneColumns,
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
import {
	addressSearchReviewLine,
	adoptionRecordedFeaturesLine,
	PLAN_FEATURES,
} from "@/lib/publish/planFeatures";
import {
	addressSearchLine,
	answerSourceOf,
	bringInInputOf,
	chosenDeclaration,
	createLeadLine,
	declarationRows,
	declarationWhy,
	initialAnswers,
	initialBringInModel,
	type ReviewAnswers,
	recordedFeaturesLine,
	reduceBringIn,
	reviewMediaLines,
	reviewPlacesLine,
	reviewPress,
	reviewProjectOf,
	reviewRefusalAt,
	reviewTablesView,
	screenOf,
	sentenceWithNames,
	tableChoiceView,
	unansweredChoices,
} from "../bringInModel";
import {
	choice,
	choiceTable,
	DIGEST_1,
	KEY,
	newTable,
	READING_ID,
	review,
	reviewAnswer,
	view,
} from "./bringInFixtures";

describe("initialAnswers", () => {
	it("takes CommCare HQ's name and the preselected choice, and answers no table", () => {
		const body = review({
			appName: "Visits in HQ",
			runsOn: [
				choice(null),
				choice("android", { splitDatetime: true, preselected: true }),
			],
			tables: [choiceTable("districts", { hq: true, project: true })],
		});
		expect(initialAnswers(reviewAnswer(body, DIGEST_1))).toEqual({
			reviewDigest: DIGEST_1,
			appName: "Visits in HQ",
			runsOnlyOn: "android",
			splitDatetime: true,
			tableChoices: {},
		});
	});
});

describe("unansweredChoices", () => {
	it("lists the tables that ask a choice and have no answer, in tag order", () => {
		const body = review({
			tables: [
				newTable("alpha"),
				choiceTable("crops", { hq: true, project: true }),
				choiceTable("districts", { hq: false, project: false }),
				choiceTable("wards", { hq: true, project: true }),
			],
		});
		const answers: ReviewAnswers = {
			...initialAnswers(reviewAnswer(body)),
			tableChoices: { wards: "use-commcare-hq" },
		};
		expect(unansweredChoices(body, answers)).toEqual(["crops", "districts"]);
		expect(unansweredChoices(body, initialAnswers(reviewAnswer(body)))).toEqual(
			["crops", "districts", "wards"],
		);
	});
});

describe("bringInInputOf", () => {
	it("carries the address's key, the review's reading and digest, and the trimmed name", () => {
		const body = review({
			runsOn: [choice(null, { preselected: true }), choice("android")],
			tables: [choiceTable("districts", { hq: true, project: true })],
		});
		const answer = reviewAnswer(body, DIGEST_1);
		const answers: ReviewAnswers = {
			...initialAnswers(answer),
			appName: "  My visits \n",
			runsOnlyOn: "android",
			tableChoices: { districts: "use-project" },
		};
		expect(bringInInputOf(KEY, answer, answers)).toEqual({
			projectId: KEY.projectId,
			server: KEY.server,
			domain: KEY.domain,
			remoteAppId: KEY.remoteAppId,
			readingId: READING_ID,
			reviewDigest: DIGEST_1,
			appName: "My visits",
			runsOnlyOn: "android",
			splitDatetime: false,
			tableChoices: { districts: "use-project" },
		});
	});
});

describe("declarationRows", () => {
	it("gives each way to run its label and line, and the split line where it splits", () => {
		const body = review({
			datetimeQuestions: 3,
			runsOn: [
				choice(null, { splitDatetime: true, preselected: true }),
				choice("android"),
			],
		});
		const rows = declarationRows(body);
		expect(rows.map((row) => row.choice)).toEqual(body.runsOn);
		expect(rows[0]).toMatchObject({
			label: PLATFORM_DECLARATION_LABELS.both,
			line: PLATFORM_DECLARATION_LINES.both,
			splitLine: splitDatetimeLine(3),
		});
		expect(rows[1]).toMatchObject({
			label: PLATFORM_DECLARATION_LABELS.android,
			line: PLATFORM_DECLARATION_LINES.android,
			splitLine: null,
		});
	});
});

describe("declarationWhy", () => {
	const answersFor = (
		body: ReturnType<typeof review>,
		runsOnlyOn: "android" | "web-apps" | null,
	): ReviewAnswers => ({
		...initialAnswers(reviewAnswer(body)),
		runsOnlyOn,
		splitDatetime: false,
	});
	const twoWays = (overrides: Parameters<typeof review>[0]) =>
		review({
			runsOn: [choice(null, { preselected: true }), choice("android")],
			...overrides,
		});

	for (const reason of [
		"content",
		"web-apps-off-in-hq",
		"keeps-web-apps",
	] as const) {
		it(`says why Nova chose, for ${reason}`, () => {
			const body = twoWays({ runsOnWhy: reason });
			expect(declarationWhy(body, answersFor(body, null)).why).toBe(
				REVIEW_RUNS_ON_WHY[reason],
			);
		});
	}

	it("says the first publish asks before turning Web Apps off, where the choice leaves it out and HQ has it on", () => {
		const body = twoWays({ webAppsOnInHq: true });
		expect(
			declarationWhy(body, answersFor(body, "android")).firstPublishAsks,
		).toBe(REVIEW_WEB_APPS_ASKS_OFF);
		expect(
			declarationWhy(body, answersFor(body, null)).firstPublishAsks,
		).toBeNull();
	});

	it("says the first publish asks before turning Web Apps on, where the choice includes it and HQ has it off", () => {
		const body = twoWays({ webAppsOnInHq: false });
		expect(declarationWhy(body, answersFor(body, null)).firstPublishAsks).toBe(
			REVIEW_WEB_APPS_ASKS_ON,
		);
		expect(
			declarationWhy(body, answersFor(body, "android")).firstPublishAsks,
		).toBeNull();
		const webOnly = review({
			webAppsOnInHq: false,
			runsOn: [choice("web-apps", { preselected: true })],
		});
		expect(
			declarationWhy(webOnly, answersFor(webOnly, "web-apps")).firstPublishAsks,
		).toBe(REVIEW_WEB_APPS_ASKS_ON);
	});

	it("gives each platform the app can't run on its block, with every feature as an item of its own", () => {
		const body = review({
			runsOn: [choice("android", { preselected: true })],
			webAppsOnInHq: false,
			platformsOut: [
				{
					platform: "web-apps",
					features: ["datetime-question", "list-first"],
					media: true,
				},
				{ platform: "android", features: [], media: true },
				{ platform: "web-apps", features: ["datetime-question"], media: false },
			],
		});
		const why = declarationWhy(body, answersFor(body, "android"));
		expect(why.later).toBe(REVIEW_CHANGE_LATER);
		const [both, filesOnly, featuresOnly] = why.cannotRun;
		expect(both?.lead).not.toBeNull();
		expect(both?.features).toEqual([
			PLATFORM_FEATURES["datetime-question"].label,
			PLATFORM_FEATURES["list-first"].label,
		]);
		expect(both?.files).not.toBeNull();
		expect(filesOnly?.lead).toBeNull();
		expect(filesOnly?.features).toEqual([]);
		expect(filesOnly?.files).not.toBeNull();
		expect(filesOnly?.files).not.toBe(both?.files);
		expect(featuresOnly?.files).toBeNull();
		for (const block of why.cannotRun) {
			for (const label of block.features) {
				expect(block.lead ?? "").not.toContain(label);
				expect(block.files ?? "").not.toContain(label);
			}
		}
	});

	it("refuses answers no way to run matches, naming where they come from", () => {
		const body = review({ runsOn: [choice(null, { preselected: true })] });
		expect(() =>
			chosenDeclaration(body, {
				...answersFor(body, null),
				splitDatetime: true,
			}),
		).toThrow(/bringInModel\.ts::reduceBringIn/);
	});
});

describe("the first-publish list of the chosen row", () => {
	const preselectedView = view(["forms-and-settings-rewritten"], false);
	const androidView = view(
		[
			"forms-and-settings-rewritten",
			"web-apps-turned-off",
			"date-and-time-questions-split",
		],
		true,
	);
	const body = review({
		webAppsOnInHq: true,
		datetimeQuestions: 2,
		runsOn: [
			choice(null, { preselected: true, firstPublish: preselectedView }),
			choice("android", { splitDatetime: true, firstPublish: androidView }),
		],
	});
	const answer = reviewAnswer(body, DIGEST_1);
	const lineIds = (lines: ReturnType<typeof firstPublishLines>) =>
		lines.workers.lines.map((line) => line.id);

	it("follows the row the person chose, from the preselected one to another", () => {
		let model = reduceBringIn(
			reduceBringIn(
				initialBringInModel({ kind: "app", key: KEY }, KEY.projectId),
				{
					type: "resume",
					input: null,
				},
			),
			{ type: "call", call: "read", at: 1 },
		);
		model = reduceBringIn(model, { type: "read-done", answer, at: 2 });
		const shown = screenOf(model);
		if (shown.kind !== "review") throw new Error("expected the review");
		const first = firstPublishLines(
			chosenDeclaration(body, shown.answers).firstPublish,
			"review",
		);
		expect(lineIds(first)).not.toContain("web-apps-turned-off");
		expect(first.reassurance).not.toBeNull();

		model = reduceBringIn(model, {
			type: "answers",
			answers: { ...shown.answers, runsOnlyOn: "android", splitDatetime: true },
		});
		const chosen = screenOf(model);
		if (chosen.kind !== "review") throw new Error("expected the review");
		const second = firstPublishLines(
			chosenDeclaration(body, chosen.answers).firstPublish,
			"review",
		);
		expect(lineIds(second)).toContain("web-apps-turned-off");
		expect(lineIds(second)).toContain("date-and-time-questions-split");
		expect(second.reassurance).toBeNull();
	});

	it("reassures over a list that touches no worker, and differs between surfaces only in its lead", () => {
		const quiet = firstPublishLines(preselectedView, "review");
		expect(quiet.workers.lines).toEqual([]);
		expect(quiet.reassurance).not.toBeNull();
		const review_ = firstPublishLines(androidView, "review");
		const publish = firstPublishLines(androidView, "publish");
		expect(review_.lead).not.toBe(publish.lead);
		expect({ ...review_, lead: "" }).toEqual({ ...publish, lead: "" });
	});
});

describe("reviewPress", () => {
	const body = review({
		tables: [
			choiceTable("crops", { hq: true, project: true }),
			choiceTable("districts", { hq: true, project: true }),
		],
	});
	const answer = reviewAnswer(body, DIGEST_1);
	const answered: ReviewAnswers = {
		...initialAnswers(answer),
		tableChoices: { crops: "use-project", districts: "use-commcare-hq" },
	};

	it("stops at a name that is empty once trimmed or longer than a name holds, before any table", () => {
		for (const appName of ["", "   \n", "x".repeat(256)]) {
			expect(
				reviewPress(KEY, answer, { ...initialAnswers(answer), appName }),
			).toEqual({ kind: "name" });
		}
		expect(
			reviewPress(KEY, answer, { ...answered, appName: "x".repeat(255) }).kind,
		).toBe("create");
	});

	it("names the first table without an answer, and sends nothing", () => {
		expect(
			reviewPress(KEY, answer, {
				...answered,
				tableChoices: { districts: "use-project" },
			}),
		).toEqual({ kind: "choice", tag: "crops" });
	});

	it("sends the create for the address on screen once every answer is given", () => {
		expect(reviewPress(KEY, answer, answered)).toEqual({
			kind: "create",
			input: bringInInputOf(KEY, answer, answered),
		});
	});
});

describe("tableChoiceView", () => {
	const apps = [{ appId: "app-1", appName: "Intake", deleted: false }];

	function table(
		options: NonNullable<ReviewTable["choice"]>["options"],
		differs: readonly ("columns" | "rows")[] = ["rows"],
	): ReviewTable {
		return {
			tag: "districts",
			standing: "choice",
			hqDigest: "d".repeat(64),
			projectTable: null,
			choice: { differs, apps, options },
		};
	}

	const bothOffered = table({
		"use-commcare-hq": {
			offered: true,
			goneColumns: ["zone"],
			retypedColumns: ["population"],
		},
		"use-project": { offered: true, goneColumns: [], retypedColumns: [] },
	});

	it("offers both answers with what each does, neither chosen, and the way to another Project", () => {
		const shown = tableChoiceView(bothOffered, "Field team", KEY.domain, false);
		const choice = bothOffered.choice;
		if (choice === null) throw new Error("expected a choice");
		expect(shown.legend).toBe(
			reviewChoiceTitle("districts", "Field team", choice),
		);
		expect(shown.body).toBe(
			reviewChoiceBody("districts", "Field team", KEY.domain, choice),
		);
		expect(shown.rows).toEqual([
			{
				choice: "use-commcare-hq",
				label: HQ_TABLE_ANSWER,
				lines: [
					hqTableAnswerConsequence("Field team", "districts", apps),
					columnsBecomeText(["population"]),
					hqTableAnswerGoneColumns(apps, ["zone"]),
				],
				unavailableReason: null,
			},
			{
				choice: "use-project",
				label: projectTableAnswer("Field team"),
				lines: [projectTableAnswerConsequence("Field team", KEY.domain)],
				unavailableReason: null,
			},
		]);
		expect(shown.alert).toBeNull();
		expect(shown.otherProject).toBe(CHOICE_OTHER_PROJECT);
	});

	it("leaves out the columns' lines where CommCare HQ's table changes no column", () => {
		const plain = table({
			"use-commcare-hq": { offered: true, goneColumns: [], retypedColumns: [] },
			"use-project": { offered: true, goneColumns: [], retypedColumns: [] },
		});
		expect(
			tableChoiceView(plain, "Field team", KEY.domain, false).rows[0]?.lines,
		).toEqual([hqTableAnswerConsequence("Field team", "districts", apps)]);
	});

	it("asks for the choice beside the way out once Bring it in finds it unanswered", () => {
		const shown = tableChoiceView(bothOffered, "Field team", KEY.domain, true);
		expect(shown.alert).toBe(REVIEW_CHOICE_MISSING);
		expect(shown.otherProject).toBe(CHOICE_OTHER_PROJECT);
	});

	it("keeps an answer that can't be chosen as a row with its reason", () => {
		const shown = tableChoiceView(
			table({
				"use-commcare-hq": {
					offered: false,
					why: "managed-elsewhere",
					name: "other-space",
				},
				"use-project": { offered: true, goneColumns: [], retypedColumns: [] },
			}),
			"Field team",
			KEY.domain,
			false,
		);
		expect(shown.rows[0]?.unavailableReason).toBe(
			choiceNotOffered(
				{ offered: false, why: "managed-elsewhere", name: "other-space" },
				"Field team",
			),
		);
		expect(shown.rows[0]?.lines).toEqual([
			hqTableAnswerConsequence("Field team", "districts", apps),
		]);
		expect(shown.rows[1]?.unavailableReason).toBeNull();
		expect(shown.otherProject).toBe(CHOICE_OTHER_PROJECT);
	});

	it("says once that neither choice is open, in the way out's place, and as the alert once pressed", () => {
		const closed = table({
			"use-commcare-hq": { offered: false, why: "needs-admin", name: null },
			"use-project": {
				offered: false,
				why: "fails-a-project-space-rule",
				name: null,
			},
		});
		const idle = tableChoiceView(closed, "Field team", KEY.domain, false);
		expect(idle.rows.map((row) => row.unavailableReason)).toEqual([
			choiceNotOffered(
				{ offered: false, why: "needs-admin", name: null },
				"Field team",
			),
			choiceNotOffered(
				{ offered: false, why: "fails-a-project-space-rule", name: null },
				"Field team",
			),
		]);
		expect(idle.alert).toBeNull();
		expect(idle.otherProject).toBe(REVIEW_NO_CHOICE_OPEN);
		const pressed = tableChoiceView(closed, "Field team", KEY.domain, true);
		expect(pressed.alert).toBe(REVIEW_NO_CHOICE_OPEN);
		expect(pressed.otherProject).toBeNull();
	});

	it("refuses a table that asks no choice", () => {
		expect(() =>
			tableChoiceView(newTable("alpha"), "Field team", KEY.domain, false),
		).toThrow(/asks none/);
	});
});

describe("reviewTablesView", () => {
	it("is absent for an app that reads no table", () => {
		expect(reviewTablesView(review(), "Field team", KEY.domain)).toBeNull();
	});

	it("names the managed tables with each tag set apart, and lists the equal and the choosing tables", () => {
		const sameManaged: ReviewTable = {
			...newTable("wards"),
			standing: "same-managed",
		};
		const sameEqual: ReviewTable = {
			...newTable("crops"),
			standing: "same-equal",
		};
		const choosing = choiceTable("districts", { hq: true, project: true });
		const shown = reviewTablesView(
			review({ tables: [newTable("in"), sameManaged, sameEqual, choosing] }),
			"Field team",
			KEY.domain,
		);
		if (shown === null) throw new Error("expected the tables");
		expect(shown.managed?.map((part) => part.text).join("")).toBe(
			reviewManagedTables(["in", "wards"], KEY.domain),
		);
		expect(
			shown.managed?.filter((part) => part.mono).map((part) => part.text),
		).toEqual(["in", "wards"]);
		expect(shown.sameEqual).toEqual([
			reviewSameEqualTable("crops", "Field team", KEY.domain),
		]);
		expect(shown.choices).toEqual([choosing]);
	});

	it("has no managed line where no table comes in managed", () => {
		const shown = reviewTablesView(
			review({
				tables: [choiceTable("districts", { hq: true, project: true })],
			}),
			"Field team",
			KEY.domain,
		);
		expect(shown?.managed).toBeNull();
	});
});

describe("sentenceWithNames", () => {
	it("sets apart each name where the sentence places it, even a name its words also hold", () => {
		const parts = sentenceWithNames(
			(names) => `Read ${names.join(" and ")} in a`,
			["a", "Read"],
		);
		expect(parts).toEqual([
			{ text: "Read ", mono: false },
			{ text: "a", mono: true },
			{ text: " and ", mono: false },
			{ text: "Read", mono: true },
			{ text: " in a", mono: false },
		]);
	});

	it("refuses a sentence that changes, drops or repeats a name it is given", () => {
		for (const sentence of [
			(names: readonly string[]) => names.join("").slice(1),
			(names: readonly string[]) => `Only ${names[0]}`,
			(names: readonly string[]) => `${names[0]} and ${names[0]}`,
		]) {
			expect(() => sentenceWithNames(sentence, ["a", "b"])).toThrow(
				/changed a name's mark/,
			);
		}
	});
});

describe("the review's places, files and recorded features", () => {
	it("draws places and files only where the review counts some", () => {
		expect(reviewPlacesLine(review(), KEY.domain)).toBeNull();
		expect(
			reviewPlacesLine(
				review({ places: { count: 3, digest: "f".repeat(64) } }),
				KEY.domain,
			),
		).toBe(reviewManagedPlaces(3, KEY.domain));
		expect(reviewMediaLines(review(), "Field team")).toEqual([]);
		const both = review({ mediaLeftOut: 2 });
		expect(
			reviewMediaLines(
				{ ...both, creates: { ...both.creates, mediaFiles: 12 } },
				"Field team",
			),
		).toEqual([reviewMediaAdded(12, "Field team"), reviewMediaLeftOut(2)]);
	});

	it("names the plan features of the chosen row, and nothing where it records none", () => {
		expect(recordedFeaturesLine(choice(null), KEY.domain)).toBeNull();
		expect(
			recordedFeaturesLine(
				{ ...choice(null), recordedFeatures: [{ kind: "commtrack-off" }] },
				KEY.domain,
			),
		).toBeNull();
		expect(
			recordedFeaturesLine(
				{
					...choice(null),
					recordedFeatures: [
						{ kind: "plan-feature", subject: "web-apps" },
						{ kind: "form-entry-sync-off" },
						{ kind: "plan-feature", subject: "lookup-tables" },
					],
				},
				KEY.domain,
			),
		).toBe(
			adoptionRecordedFeaturesLine(
				[PLAN_FEATURES["web-apps"].label, PLAN_FEATURES["lookup-tables"].label],
				KEY.domain,
			),
		);
	});

	it("names what address search needs of the project space only where the chosen row searches", () => {
		expect(addressSearchLine(choice(null), KEY.domain)).toBeNull();
		const line = addressSearchLine(
			{
				...choice(null),
				addressSearch: [
					"Visit has a question that searches for an address in Web Apps.",
				],
			},
			KEY.domain,
		);
		expect(line).toBe(addressSearchReviewLine(KEY.domain));
		expect(line).toContain(`“${KEY.domain}”`);
		expect(line).toContain("Geocoder");
	});
});

describe("what a create that did not create says on the review", () => {
	it("places each refusal at the name, above the footer, or on the refused screen", () => {
		const at: Record<ReadingRefusal, "name" | "footer" | null> = {
			name_missing: "name",
			choice_not_offered: "footer",
			choice_missing: "footer",
			project_changed: "footer",
			no_project_access: null,
			invalid_input: null,
			app_unavailable: null,
			/* The review stands while another app's publish finishes. */
			publish_in_flight: "footer",
		};
		for (const [refusal, place] of Object.entries(at)) {
			expect(reviewRefusalAt(refusal as ReadingRefusal)).toBe(place);
		}
		expect(reviewRefusalAt(null)).toBeNull();
	});

	it("reads a create's lead, and adds that choices were made again where one was dropped", () => {
		expect(createLeadLine({ kind: "held", dropped: false })).toBe(
			CREATE_ANSWER_LEADS.held,
		);
		expect(createLeadLine({ kind: "changed-review", dropped: true })).toBe(
			`${CREATE_ANSWER_LEADS.changed.review} ${CREATE_ANSWER_LEADS.choicesDropped}`,
		);
		expect(
			createLeadLine({ kind: "changed-already-in-nova", dropped: false }),
		).toBe(CREATE_ANSWER_LEADS.changed["already-in-nova"]);
	});

	it("says a screen came from a create exactly where the model holds a create's lead", () => {
		const body = review();
		const reading = reduceBringIn(
			reduceBringIn(
				reduceBringIn(
					initialBringInModel({ kind: "app", key: KEY }, KEY.projectId),
					{ type: "resume", input: null },
				),
				{ type: "call", call: "read", at: 1 },
			),
			{ type: "read-done", answer: reviewAnswer(body), at: 2 },
		);
		expect(answerSourceOf(reading)).toBe("read");
		const asked = reduceBringIn(reading, {
			type: "create-asked",
			input: bringInInputOf(
				KEY,
				reviewAnswer(body),
				initialAnswers(reviewAnswer(body)),
			),
		});
		const held = reduceBringIn(
			reduceBringIn(asked, { type: "call", call: "create", at: 3 }),
			{
				type: "create-done",
				answer: {
					kind: "held",
					finding: {
						code: "rate-limited",
						standing: "stop",
						place: { kind: "app" },
						subject: null,
						detail: {},
					},
				},
				at: 4,
			},
		);
		expect(answerSourceOf(held)).toBe("create");
	});
});

describe("reviewProjectOf", () => {
	it("finds the Project the address names, and nothing where the page's list lacks it", () => {
		const projects = [
			{ id: "project-0", name: "Mine", personal: true },
			{ id: KEY.projectId, name: "Field team", personal: false },
		];
		expect(reviewProjectOf(projects, KEY)).toBe(projects[1]);
		expect(reviewProjectOf(projects.slice(0, 1), KEY)).toBeNull();
	});
});
