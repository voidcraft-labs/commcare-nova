import { describe, expect, it } from "vitest";
import type { DeploymentView, KeptRefreshView } from "@/lib/deployment/actions";
import {
	changedOutcome,
	type HqChangesOutcome,
	type HqChangesReview,
} from "@/lib/deployment/hqChanges/types";
import type { ReviewTable } from "@/lib/deployment/reading/projectData/reviewTypes";
import {
	BRING_IN_CHANGES_ACTION,
	broughtInLine,
	CANNOT_BRING_IN_TOO_LARGE_LEAD,
	cannotBringInLead,
	HQ_CHANGES_BRING_IN_LOST_LINE,
	HQ_CHANGES_FAILED_LINE,
	HQ_CHANGES_GATE_LEAD,
	HQ_CHANGES_GATE_NEXT,
	HQ_CHANGES_HEADING,
	HQ_CHANGES_NO_EDIT_ACCESS_LINE,
	HQ_CHANGES_NOTHING_TAKEN_LINE,
	HQ_CHANGES_REVIEW_LOST_LINE,
	hqChangesLead,
	hqChangesMovedLine,
	hqChangesUnavailableLine,
	NEXT_PUBLISH_GOES_AHEAD,
	NOVA_CHANGES_HEADING,
	nothingToBringInLine,
	PUBLISH_OVER_HQ_ACTION,
	PUBLISH_OVER_HQ_HELPER,
	PUBLISH_OVER_INSTEAD_LINE,
	renamedInNovaLine,
	USE_HQ_VERSION_ACTION,
	USE_HQ_VERSION_HELPER,
} from "@/lib/publish/hqChangesCopy";
import {
	type CircumstanceFinding,
	circumstanceFinding,
	type Finding,
} from "@/lib/publish/hqFindings";
import {
	bothListsText,
	cardDriftReference,
	type HqChangesPanelEvent,
	type HqChangesPanelState,
	headerChangesAction,
	hqChangedTargetsOf,
	initialHqChangesPanel,
	keptRefreshOffersReview,
	LIST_LINES_SHOWN,
	nextRequest,
	type PanelViewContext,
	panelView,
	publishOverDiscard,
	reduceHqChangesPanel,
	shownChanges,
} from "../hqChangesPanelModel";

const AT = 1_000;
const PUBLISH: PanelViewContext = {
	home: "publish",
	domain: "clinic",
	since: { kind: "published" },
};
const CARD: PanelViewContext = {
	home: "card",
	domain: "clinic",
	since: { kind: "published" },
};
const SINCE = "Nova last published this app to “clinic”";

type ChangesReview = Extract<HqChangesReview, { kind: "changes" }>;

function changes(overrides: Partial<ChangesReview> = {}): ChangesReview {
	return {
		kind: "changes",
		since: { kind: "published" },
		hqChanges: ["Registration: the question age was added"],
		novaChanges: [],
		madeBy: [],
		caseData: [],
		publishChanges: [],
		observedDigest: "o".repeat(64),
		renamedInNova: [],
		tables: [],
		ownerRules: [],
		projectName: "Field team",
		readingId: "reading-1",
		reviewDigest: "d".repeat(64),
		...overrides,
	};
}

function nothing(
	reason: "unchanged" | "reads-the-same" | "already-here",
	overrides: Partial<Extract<HqChangesReview, { kind: "nothing" }>> = {},
): Extract<HqChangesReview, { kind: "nothing" }> {
	const recorded = reason !== "unchanged";
	return {
		kind: "nothing",
		reason,
		since: { kind: "published" },
		hqChanges: [],
		publishChanges: [],
		readingId: recorded ? "reading-2" : null,
		reviewDigest: recorded ? "r".repeat(64) : null,
		...overrides,
	};
}

const VIEW = { marker: "the deployment" } as unknown as DeploymentView;

function run(
	events: readonly HqChangesPanelEvent[],
	start: HqChangesPanelState = initialHqChangesPanel(AT),
): HqChangesPanelState {
	return events.reduce(reduceHqChangesPanel, start);
}

/** The review sent and answered. */
function answered(review: HqChangesReview): HqChangesPanelState {
	return run([
		{ type: "sent", id: 1 },
		{ type: "review-answered", review },
	]);
}

/** Every state a review passes through before it answers, with each event that can arrive. */
function statesBeforeAnswer(): HqChangesPanelState[] {
	const states = [initialHqChangesPanel(AT)];
	for (const event of [
		{ type: "sent", id: 1 },
		{ type: "stage", stage: "reading-app" },
		{ type: "stage", stage: "checking-media" },
		{ type: "files", done: 3, total: 40 },
		{ type: "stage", stage: "checking" },
	] as const) {
		states.push(reduceHqChangesPanel(states[states.length - 1], event));
	}
	return states;
}

describe("the review", () => {
	it("opens loading, names one review to send, and names none once it is sent", () => {
		const opened = initialHqChangesPanel(AT);
		expect(nextRequest(opened)).toEqual({ id: 1, kind: "review" });
		const sent = reduceHqChangesPanel(opened, { type: "sent", id: 1 });
		expect(nextRequest(sent)).toBeNull();
		/* A stale id does not mark the request sent. */
		expect(
			nextRequest(reduceHqChangesPanel(opened, { type: "sent", id: 7 })),
		).toEqual({ id: 1, kind: "review" });
	});

	it("shows how to recover a claimed target whose required review is unavailable", () => {
		const state = answered({
			kind: "unavailable",
			reason: "baseline-unread",
			since: { kind: "published" },
			requiresReview: true,
		});
		for (const context of [CARD, PUBLISH]) {
			const body = panelView(state, context).body;
			if (body.kind !== "line")
				throw new Error("Expected recovery for the unread HQ target.");
			for (const step of [
				"Project admin or owner",
				"Stop publishing here",
				"publish in progress finishes",
				"new Nova app",
				"different project space",
			])
				expect(body.line).toContain(step);
		}
	});

	it("waits for the member to accept an older target's first-publish review and shows no discard", () => {
		const state = answered(
			changes({
				requiresReview: true,
				hqChanges: ["Publishing removes the old picture reference."],
			}),
		);
		expect(nextRequest(state)).toBeNull();
		expect(publishOverDiscard(state, "app-1")).toBeNull();
		for (const context of [CARD, PUBLISH])
			expect(panelView(state, context).body).toMatchObject({
				kind: "lists",
				choices: { bringIn: { discard: false }, publishOver: null },
			});
		const pending = reduceHqChangesPanel(state, {
			type: "bring-in-pressed",
			discard: false,
			at: AT,
		});
		expect(nextRequest(pending)?.kind).toBe("bring-in");
		const done = reduceHqChangesPanel(pending, {
			type: "bring-in-answered",
			outcome: { kind: "recorded", deployment: VIEW },
		});
		expect(panelView(done, CARD).body).toEqual({
			kind: "brought-in",
			line: "Nova recorded your review for the next publish.",
		});
	});

	it("draws the stage row with the stage the stream names, its file count moving every ten files for a screen reader", () => {
		const states = statesBeforeAnswer();
		expect(panelView(states[0], PUBLISH).stage).toEqual({
			label: "Reading the app in CommCare HQ",
			announced: "Reading the app in CommCare HQ",
			startedAt: AT,
		});
		expect(panelView(states[4], PUBLISH).stage).toEqual({
			label: "Checking pictures and sounds (3 of 40)",
			announced: "Checking pictures and sounds (0 of 40)",
			startedAt: AT,
		});
		expect(panelView(states[5], PUBLISH).stage?.label).toBe(
			"Checking what changed",
		);
	});

	it("draws no choice, no tick and no item while it waits on its answer", () => {
		for (const state of statesBeforeAnswer()) {
			const view = panelView(state, PUBLISH);
			expect(view.body).toEqual({ kind: "loading" });
			expect(view.drawsItem).toBe(false);
			expect(publishOverDiscard(state, "app-1")).toBeNull();
			expect(
				reduceHqChangesPanel(state, {
					type: "bring-in-pressed",
					discard: false,
					at: AT,
				}),
			).toBe(state);
		}
	});

	it("says a review that ended with no answer, with Check again, and draws the item", () => {
		for (const [end, line] of [
			["lost", HQ_CHANGES_REVIEW_LOST_LINE],
			["failed", HQ_CHANGES_FAILED_LINE],
		] as const) {
			const state = run([
				{ type: "sent", id: 1 },
				{ type: "review-ended", end },
			]);
			expect(panelView(state, PUBLISH)).toEqual({
				stage: null,
				moved: null,
				body: { kind: "line", line, role: "alert", checkAgain: true },
				drawsItem: true,
				waysOn: false,
			});
			const again = reduceHqChangesPanel(state, { type: "check", at: 2_000 });
			expect(nextRequest(again)).toEqual({ id: 2, kind: "review" });
			expect(panelView(again, PUBLISH).stage?.startedAt).toBe(2_000);
		}
	});

	it("sends no second review while one is on its way", () => {
		const loading = run([{ type: "sent", id: 1 }]);
		expect(reduceHqChangesPanel(loading, { type: "check", at: 5 })).toBe(
			loading,
		);
	});
});

describe("changes, and nothing in Nova would be removed", () => {
	it("lists what changed with Bring in these changes, and in the publish dialog the way to publish over them", () => {
		const view = panelView(answered(changes()), PUBLISH);
		expect(view.drawsItem).toBe(false);
		expect(view.body).toMatchObject({
			kind: "lists",
			hqHeading: HQ_CHANGES_HEADING,
			hqLead: hqChangesLead(SINCE, false),
			hqList: {
				shown: ["Registration: the question age was added"],
				showAll: null,
			},
			nova: null,
			copyBoth: false,
			notice: null,
			choices: {
				bringIn: {
					label: BRING_IN_CHANGES_ACTION,
					helper: null,
					discard: false,
				},
				renamed: null,
				publishOver: {
					label: PUBLISH_OVER_HQ_ACTION,
					helper: null,
					lead: PUBLISH_OVER_INSTEAD_LINE,
				},
				stop: false,
			},
		});
	});

	it("offers no publish over on the card", () => {
		const view = panelView(answered(changes()), CARD);
		expect(view.body).toMatchObject({ choices: { publishOver: null } });
	});

	it("brings the changes in with one press, sending one bring-in with the review's reading and digest", () => {
		const pressed = reduceHqChangesPanel(answered(changes()), {
			type: "bring-in-pressed",
			discard: false,
			at: 3_000,
		});
		expect(nextRequest(pressed)).toEqual({
			id: 2,
			kind: "bring-in",
			readingId: "reading-1",
			reviewDigest: "d".repeat(64),
			tableChoices: {},
			ownerRuleChoices: {},
		});
		const sent = reduceHqChangesPanel(pressed, { type: "sent", id: 2 });
		expect(nextRequest(sent)).toBeNull();
		/* A second press while it runs does nothing. */
		expect(
			reduceHqChangesPanel(sent, {
				type: "bring-in-pressed",
				discard: false,
				at: 3_001,
			}),
		).toBe(sent);
	});

	it("refuses Use CommCare HQ's version, which this list does not offer", () => {
		const state = answered(changes());
		expect(
			reduceHqChangesPanel(state, {
				type: "bring-in-pressed",
				discard: true,
				at: AT,
			}),
		).toBe(state);
	});
});

describe("changes, and changes in Nova that would be removed", () => {
	const s2 = changes({
		novaChanges: ["Visit: the question weight was added"],
		madeBy: ["Ada"],
		caseData: [
			"The case type “patient” no longer has the case property “age”, so its cases saved in Nova lose that value the next time each one is saved.",
		],
		publishChanges: ["One sentence of the register."],
	});

	it("lists both, the case data lines, the next publish, Copy both lists and the three choices with none chosen", () => {
		const view = panelView(answered(s2), CARD);
		expect(view.body).toMatchObject({
			kind: "lists",
			hqLead: hqChangesLead(SINCE, true),
			caseData: s2.caseData,
			publishChanges: s2.publishChanges,
			nova: {
				heading: NOVA_CHANGES_HEADING,
				madeBy: ["Ada"],
				list: { shown: s2.novaChanges, showAll: null },
			},
			copyBoth: true,
			choices: {
				bringIn: {
					label: USE_HQ_VERSION_ACTION,
					helper: USE_HQ_VERSION_HELPER,
					discard: true,
				},
				renamed: null,
				publishOver: {
					label: PUBLISH_OVER_HQ_ACTION,
					helper: PUBLISH_OVER_HQ_HELPER,
					lead: null,
				},
				stop: true,
			},
		});
		expect(view.drawsItem).toBe(false);
	});

	it("uses CommCare HQ's version at once, with no second question", () => {
		const pressed = reduceHqChangesPanel(answered(s2), {
			type: "bring-in-pressed",
			discard: true,
			at: AT,
		});
		expect(pressed.phase).toMatchObject({ kind: "bringing-in", discard: true });
		expect(nextRequest(pressed)?.kind).toBe("bring-in");
	});

	it("keeps the headings and lists while the bring-in runs and draws the stage row in place of every choice", () => {
		const running = run(
			[
				{ type: "bring-in-pressed", discard: true, at: 4_000 },
				{ type: "sent", id: 2 },
				{ type: "stage", stage: "adding-media" },
			],
			answered(s2),
		);
		const view = panelView(running, PUBLISH);
		expect(view.body).toMatchObject({
			kind: "lists",
			nova: { list: { shown: s2.novaChanges } },
			choices: null,
		});
		expect(view.stage?.label).toBe(
			"Adding pictures and sounds to this Project",
		);
		expect(view.drawsItem).toBe(false);
		expect(publishOverDiscard(running, "app-1")).toBeNull();
	});

	it.each([true, false])(
		"explains the saved-data hold and refuses the take with a Nova change list present: %s",
		(removes) => {
			const renames = [{ caseType: "patient", from: "age", to: "years" }];
			const state = answered({
				...s2,
				novaChanges: removes ? s2.novaChanges : [],
				renamedInNova: renames,
			});
			expect(panelView(state, PUBLISH).body).toMatchObject({
				choices: { bringIn: null, renamed: renamedInNovaLine(renames) },
			});
			expect(
				reduceHqChangesPanel(state, {
					type: "bring-in-pressed",
					discard: removes,
					at: AT,
				}),
			).toBe(state);
		},
	);

	it("copies every line of both lists, shown or not, under their two headings", () => {
		const long = changes({
			hqChanges: Array.from({ length: 12 }, (_, i) => `HQ line ${i}`),
			novaChanges: ["Nova line"],
		});
		expect(bothListsText(long)).toBe(
			[
				HQ_CHANGES_HEADING,
				...long.hqChanges,
				"",
				NOVA_CHANGES_HEADING,
				"Nova line",
			].join("\n"),
		);
		expect(shownChanges(answered(long))).toBe(long);
	});

	it("holds the answer to a copy until it is cleared, and a refusal until the next review", () => {
		const copied = reduceHqChangesPanel(answered(s2), { type: "copied" });
		expect(copied.copy).toBe("copied");
		expect(reduceHqChangesPanel(copied, { type: "copy-cleared" }).copy).toBe(
			"idle",
		);
		const refused = reduceHqChangesPanel(answered(s2), {
			type: "copy-refused",
		});
		expect(reduceHqChangesPanel(refused, { type: "copy-cleared" }).copy).toBe(
			"refused",
		);
	});
});

describe("a list longer than ten lines", () => {
	it("waits to offer either decision until every physical file it would remove is visible", () => {
		const files = Array.from(
			{ length: 20 },
			(_, i) =>
				`Publishing removes the reference to “visit-${i}” from the app in CommCare HQ. This app doesn't use it.`,
		);
		const state = answered(
			changes({
				hqChanges: [...files, "The app’s name"],
				fileReviewLines: files.length,
			}),
		);
		const take = { type: "bring-in-pressed", discard: false, at: 1 } as const;
		expect(panelView(state, PUBLISH).body).toMatchObject({
			choices: { bringIn: null, publishOver: null },
		});
		expect(reduceHqChangesPanel(state, take)).toBe(state);
		expect(publishOverDiscard(state, "app")).toBeNull();
		const all = reduceHqChangesPanel(state, { type: "show-all", list: "hq" });
		expect(reduceHqChangesPanel(all, take).phase.kind).toBe("bringing-in");
		expect(publishOverDiscard(all, "app")).toMatchObject({
			novaResourceId: "app",
		});
	});
	it("shows its first ten and Show all with the whole count, then every line", () => {
		const lines = Array.from({ length: 13 }, (_, i) => `line ${i}`);
		const state = answered(changes({ hqChanges: lines }));
		expect(panelView(state, PUBLISH).body).toMatchObject({
			hqList: { shown: lines.slice(0, LIST_LINES_SHOWN), showAll: 13 },
		});
		const all = reduceHqChangesPanel(state, { type: "show-all", list: "hq" });
		expect(panelView(all, PUBLISH).body).toMatchObject({
			hqList: { shown: lines, showAll: null },
		});
	});

	it("shows exactly ten with no Show all", () => {
		const lines = Array.from({ length: 10 }, (_, i) => `line ${i}`);
		expect(
			panelView(answered(changes({ hqChanges: lines })), PUBLISH).body,
		).toMatchObject({ hqList: { shown: lines, showAll: null } });
	});
});

describe("a table that asks its choice", () => {
	const table = {
		tag: "districts",
		standing: "choice",
	} as unknown as ReviewTable;
	const withTable = changes({
		tables: [
			table,
			{ tag: "regions", standing: "new" } as unknown as ReviewTable,
		],
	});

	it("is drawn, and a bring-in pressed before it is answered asks for it, with a new nonce each press", () => {
		const state = answered(withTable);
		expect(panelView(state, PUBLISH).body).toMatchObject({
			tables: [table],
			projectName: "Field team",
		});
		const once = reduceHqChangesPanel(state, {
			type: "bring-in-pressed",
			discard: false,
			at: AT,
		});
		expect(once.phase.kind).toBe("answered");
		expect(once.needsChoice).toEqual({ nonce: 1 });
		expect(nextRequest(once)).toBeNull();
		const twice = reduceHqChangesPanel(once, {
			type: "bring-in-pressed",
			discard: false,
			at: AT,
		});
		expect(twice.needsChoice).toEqual({ nonce: 2 });
	});

	it("sends the answer given with the bring-in", () => {
		const pressed = run(
			[
				{ type: "table-chosen", tag: "districts", choice: "use-project" },
				{ type: "bring-in-pressed", discard: false, at: AT },
			],
			answered(withTable),
		);
		expect(nextRequest(pressed)).toMatchObject({
			kind: "bring-in",
			tableChoices: { districts: "use-project" },
		});
		expect(pressed.needsChoice).toBeNull();
	});

	it("asks again for a table whose entry changed in the review the bring-in came back with, and keeps the answer of one that did not", () => {
		const choiceOf = (
			apps: NonNullable<ReviewTable["choice"]>["apps"],
		): ReviewTable =>
			({
				tag: "districts",
				standing: "choice",
				hqDigest: "d".repeat(64),
				projectTable: null,
				choice: {
					differs: ["rows"],
					apps,
					options: {
						"use-commcare-hq": {
							offered: true,
							goneColumns: [],
							retypedColumns: [],
						},
						"use-project": {
							offered: true,
							goneColumns: [],
							retypedColumns: [],
						},
					},
				},
			}) as ReviewTable;
		const crops = { ...choiceOf([]), tag: "crops" } as ReviewTable;
		const before = changes({ tables: [choiceOf([]), crops] });
		const sent = run(
			[
				{ type: "table-chosen", tag: "districts", choice: "use-commcare-hq" },
				{ type: "table-chosen", tag: "crops", choice: "use-project" },
				{ type: "bring-in-pressed", discard: false, at: AT },
				{ type: "sent", id: 2 },
			],
			answered(before),
		);
		/* Another app began reading districts while the bring-in ran. */
		const now = changes({
			reviewDigest: "e".repeat(64),
			tables: [
				choiceOf([{ appId: "stock", appName: "Stock counts", deleted: false }]),
				crops,
			],
		});
		const moved = reduceHqChangesPanel(sent, {
			type: "bring-in-answered",
			outcome: { kind: "changed", now, editedBy: null },
		});
		expect(moved.tableChoices).toEqual({ crops: "use-project" });
		const pressed = reduceHqChangesPanel(moved, {
			type: "bring-in-pressed",
			discard: false,
			at: AT,
		});
		expect(pressed.needsChoice).toEqual({ nonce: 1 });
		expect(nextRequest(pressed)).toBeNull();
	});
});

describe("an owner rule the places cannot satisfy", () => {
	const rule = {
		level: "clinic",
		levelName: "Clinic",
		conflict: { kind: "no-place", source: "North district" },
		forms: ["Transfer"],
	} as const;
	const withRule = changes({ ownerRules: [rule] });

	it("is drawn, and a bring-in pressed before it is answered asks for it and sends nothing", () => {
		const state = answered(withRule);
		expect(panelView(state, PUBLISH).body).toMatchObject({
			ownerRules: [rule],
		});
		const pressed = reduceHqChangesPanel(state, {
			type: "bring-in-pressed",
			discard: false,
			at: AT,
		});
		expect(pressed.needsChoice).toEqual({ nonce: 1 });
		expect(nextRequest(pressed)).toBeNull();
	});

	it("sends the person's answer with the bring-in", () => {
		const pressed = run(
			[
				{ type: "owner-rule-chosen", level: "clinic", choice: "worker" },
				{ type: "bring-in-pressed", discard: false, at: AT },
			],
			answered(withRule),
		);
		expect(nextRequest(pressed)).toMatchObject({
			kind: "bring-in",
			ownerRuleChoices: { clinic: "worker" },
		});
	});

	it("takes no answer for a level the review does not ask about", () => {
		const state = reduceHqChangesPanel(answered(withRule), {
			type: "owner-rule-chosen",
			level: "region",
			choice: "worker",
		});
		expect(state.ownerRuleChoices).toEqual({});
	});

	it("asks again where the review the bring-in came back with asks another question", () => {
		const sent = run(
			[
				{ type: "owner-rule-chosen", level: "clinic", choice: "worker" },
				{ type: "bring-in-pressed", discard: false, at: AT },
				{ type: "sent", id: 2 },
			],
			answered(withRule),
		);
		const now = changes({
			reviewDigest: "e".repeat(64),
			ownerRules: [
				{
					...rule,
					conflict: {
						kind: "two-places",
						source: "North district",
						places: ["First clinic", "Second clinic"],
					},
				},
			],
		});
		const moved = reduceHqChangesPanel(sent, {
			type: "bring-in-answered",
			outcome: { kind: "changed", now, editedBy: null },
		});
		expect(moved.ownerRuleChoices).toEqual({});
	});
});

describe("after the bring-in", () => {
	const pressed = (review: ChangesReview) =>
		run(
			[
				{
					type: "bring-in-pressed",
					discard: review.novaChanges.length > 0,
					at: AT,
				},
				{ type: "sent", id: 2 },
			],
			answered(review),
		);

	it("says the changes are in and hands the surface the record, whether anything was removed or not", () => {
		for (const discarded of [false, true]) {
			const review = changes({
				novaChanges: discarded ? ["Nova line"] : [],
			});
			const outcome: HqChangesOutcome = {
				kind: "brought-in",
				seq: 9,
				discarded,
				deployment: VIEW,
			};
			const state = reduceHqChangesPanel(pressed(review), {
				type: "bring-in-answered",
				outcome,
			});
			expect(panelView(state, PUBLISH)).toEqual({
				stage: null,
				moved: null,
				body: { kind: "brought-in", line: broughtInLine(discarded) },
				drawsItem: false,
				waysOn: false,
			});
			expect(state.settled).toEqual({
				id: 1,
				kind: "brought-in",
				deployment: VIEW,
				discarded,
			});
		}
	});

	it("gives the gate's refusal with each finding's sentence, the buttons back and no item", () => {
		const state = reduceHqChangesPanel(pressed(changes()), {
			type: "bring-in-answered",
			outcome: {
				kind: "gate",
				findings: ["The automation reads age."],
				details: ["The automation reads the property `age`."],
			},
		});
		const view = panelView(state, PUBLISH);
		expect(view.body).toMatchObject({
			kind: "lists",
			notice: {
				lines: [
					HQ_CHANGES_GATE_LEAD,
					"The automation reads age.",
					HQ_CHANGES_GATE_NEXT,
				],
				role: "alert",
			},
			choices: { bringIn: { label: BRING_IN_CHANGES_ACTION } },
		});
		expect(view.drawsItem).toBe(false);
		expect(state.settled).toBeNull();
	});

	it("draws on the card the publish over the gate's refusal names, with the review's digest, and no other notice draws it there", () => {
		const gated = reduceHqChangesPanel(pressed(changes()), {
			type: "bring-in-answered",
			outcome: {
				kind: "gate",
				findings: ["The automation reads age."],
				details: ["The automation reads the property `age`."],
			},
		});
		expect(panelView(gated, CARD).body).toMatchObject({
			notice: { lines: expect.arrayContaining([HQ_CHANGES_GATE_NEXT]) },
			choices: {
				publishOver: {
					label: PUBLISH_OVER_HQ_ACTION,
					helper: PUBLISH_OVER_HQ_HELPER,
					lead: null,
				},
			},
		});
		expect(publishOverDiscard(gated, "app-1")).toEqual({
			kind: "app",
			novaResourceId: "app-1",
			observedDigest: "o".repeat(64),
		});
		/* The publish dialog keeps its own way of offering it. */
		expect(panelView(gated, PUBLISH).body).toMatchObject({
			choices: { publishOver: { lead: PUBLISH_OVER_INSTEAD_LINE } },
		});
		const refused = reduceHqChangesPanel(pressed(changes()), {
			type: "bring-in-answered",
			outcome: { kind: "refused", message: "The app is still being built." },
		});
		expect(panelView(refused, CARD).body).toMatchObject({
			choices: { publishOver: null },
		});
	});

	it("gives a refusal's own sentence with the buttons back", () => {
		const state = reduceHqChangesPanel(pressed(changes()), {
			type: "bring-in-answered",
			outcome: { kind: "refused", message: "The app is still being built." },
		});
		expect(panelView(state, PUBLISH).body).toMatchObject({
			notice: { lines: ["The app is still being built."], role: "alert" },
			choices: { bringIn: { discard: false } },
		});
	});

	it("says a bring-in that ended with no answer, with the buttons back", () => {
		for (const [end, line] of [
			["lost", HQ_CHANGES_BRING_IN_LOST_LINE],
			["failed", HQ_CHANGES_FAILED_LINE],
		] as const) {
			const state = reduceHqChangesPanel(pressed(changes()), {
				type: "bring-in-ended",
				end,
			});
			expect(panelView(state, PUBLISH).body).toMatchObject({
				notice: { lines: [line] },
				choices: { bringIn: { label: BRING_IN_CHANGES_ACTION } },
			});
		}
	});

	it("says the review moved and shows it as it stands now where the app or CommCare HQ moved, naming who edited", () => {
		const now = changes({
			hqChanges: ["Visit: renamed"],
			reviewDigest: "e".repeat(64),
		});
		const state = reduceHqChangesPanel(pressed(changes()), {
			type: "bring-in-answered",
			outcome: { kind: "changed", now, editedBy: "Grace" },
		});
		const view = panelView(state, PUBLISH);
		expect(view.moved).toBe(hqChangesMovedLine("Grace"));
		expect(view.body).toMatchObject({
			kind: "lists",
			hqList: { shown: ["Visit: renamed"] },
			choices: { bringIn: { label: BRING_IN_CHANGES_ACTION } },
		});
		/* The next press sends the new digest. */
		const again = reduceHqChangesPanel(state, {
			type: "bring-in-pressed",
			discard: false,
			at: AT,
		});
		expect(nextRequest(again)).toMatchObject({ reviewDigest: "e".repeat(64) });
		expect(again.moved).toBeNull();
	});
});

describe("nothing to bring in", () => {
	it("sends the bring-in that records the read at once, once, and says the reason", () => {
		const state = answered(nothing("reads-the-same"));
		expect(nextRequest(state)).toEqual({
			id: 2,
			kind: "bring-in",
			readingId: "reading-2",
			reviewDigest: "r".repeat(64),
			tableChoices: {},
			ownerRuleChoices: {},
		});
		const sent = reduceHqChangesPanel(state, { type: "sent", id: 2 });
		expect(nextRequest(sent)).toBeNull();
		expect(panelView(sent, CARD).body).toEqual({
			kind: "nothing",
			line: nothingToBringInLine("reads-the-same", SINCE),
			hqChanges: [],
			publishChanges: [],
			goesAhead: false,
		});
		expect(panelView(sent, CARD).drawsItem).toBe(false);
	});

	it("sends the record again on Check again where it ended with no answer or was refused, and settles once it lands", () => {
		const review = nothing("reads-the-same");
		for (const end of [
			{ type: "bring-in-ended", end: "lost" },
			{ type: "bring-in-ended", end: "failed" },
			{
				type: "bring-in-answered",
				outcome: { kind: "refused", message: "The app is mid build." },
			},
		] as const satisfies readonly HqChangesPanelEvent[]) {
			const checked = run(
				[
					{ type: "sent", id: 2 },
					end,
					{ type: "check", at: AT },
					{ type: "sent", id: 3 },
					{ type: "review-answered", review },
				],
				answered(review),
			);
			/* Nothing was recorded, so the same review sends its record again. */
			expect(nextRequest(checked)).toEqual({
				id: 4,
				kind: "bring-in",
				readingId: "reading-2",
				reviewDigest: "r".repeat(64),
				tableChoices: {},
				ownerRuleChoices: {},
			});
			expect(checked.settled).toBeNull();
			const landed = run(
				[
					{ type: "sent", id: 4 },
					{
						type: "bring-in-answered",
						outcome: { kind: "recorded", deployment: VIEW },
					},
				],
				checked,
			);
			expect(landed.settled).toMatchObject({
				kind: "nothing",
				deployment: VIEW,
			});
			expect(panelView(landed, CARD).body).toMatchObject({ goesAhead: true });
		}
	});

	it("records a digest once in a panel's life, even where the review answers it again", () => {
		const review = nothing("already-here");
		const recordedThenMoved = run(
			[
				{ type: "sent", id: 2 },
				{
					type: "bring-in-answered",
					outcome: { kind: "changed", now: review, editedBy: null },
				},
			],
			answered(review),
		);
		expect(nextRequest(recordedThenMoved)).toBeNull();
		expect(recordedThenMoved.phase.kind).toBe("settled");
		/* Checked again and answered the same digest: nothing is sent. */
		const checked = run(
			[
				{ type: "check", at: AT },
				{ type: "sent", id: 3 },
				{ type: "review-answered", review },
			],
			recordedThenMoved,
		);
		expect(nextRequest(checked)).toBeNull();
	});

	it("hands the surface what CommCare HQ holds now and the next publish's list once recorded, and on the card says the next publish goes ahead", () => {
		const review = nothing("already-here", { publishChanges: ["A sentence."] });
		const state = run(
			[
				{ type: "sent", id: 2 },
				{
					type: "bring-in-answered",
					outcome: { kind: "recorded", deployment: VIEW },
				},
			],
			answered(review),
		);
		expect(state.settled).toEqual({
			id: 1,
			kind: "nothing",
			deployment: VIEW,
			publishChanges: ["A sentence."],
		});
		expect(panelView(state, CARD).body).toEqual({
			kind: "nothing",
			line: nothingToBringInLine("already-here", SINCE),
			hqChanges: [],
			publishChanges: ["A sentence."],
			goesAhead: true,
		});
		expect(NEXT_PUBLISH_GOES_AHEAD).toBe(
			"Your next publish here goes ahead as usual.",
		);
		expect(panelView(state, PUBLISH).body).toMatchObject({ goesAhead: false });
	});

	it("settles at once where nothing changed and there is no read to record", () => {
		const state = answered(nothing("unchanged"));
		expect(nextRequest(state)).toBeNull();
		expect(state.settled).toEqual({
			id: 1,
			kind: "nothing",
			deployment: null,
			publishChanges: [],
		});
	});

	it("asks the person to check again where the record ended with no answer", () => {
		const state = run(
			[
				{ type: "sent", id: 2 },
				{ type: "bring-in-ended", end: "lost" },
			],
			answered(nothing("reads-the-same")),
		);
		expect(panelView(state, PUBLISH).body).toEqual({
			kind: "line",
			line: HQ_CHANGES_REVIEW_LOST_LINE,
			role: "alert",
			checkAgain: true,
		});
	});
});

describe("something Nova can't hold, and the stops", () => {
	const finding = (code: string): CircumstanceFinding =>
		({
			code,
			standing: "stop",
			place: { kind: "app" },
			subject: null,
			detail: {},
		}) as unknown as CircumstanceFinding;

	it("draws the account with its lead, and the item under it", () => {
		const findings = [{ code: "x" }, { code: "y" }] as unknown as Finding[];
		const view = panelView(
			answered({
				kind: "account",
				findings,
				more: 3,
				counts: { notYet: 5, never: 0, fixInHq: 0 },
			}),
			PUBLISH,
		);
		expect(view.body).toMatchObject({
			kind: "account",
			lead: cannotBringInLead(5),
			tooLarge: null,
		});
		expect(view.drawsItem).toBe(true);
	});

	it("says CommCare HQ's version is too large, with the finding's block and no Check again", () => {
		const tooLarge = finding("too-large");
		const view = panelView(
			answered({
				kind: "account",
				findings: [tooLarge],
				more: 0,
				counts: { notYet: 1, never: 0, fixInHq: 0 },
			}),
			PUBLISH,
		);
		expect(view.body).toMatchObject({
			lead: CANNOT_BRING_IN_TOO_LARGE_LEAD,
			tooLarge,
		});
	});

	it("draws one file past what Nova reads as the account's item, with the file named, never as the app's size", () => {
		const file = circumstanceFinding(
			"media-file-too-large",
			{ kind: "media", path: "jr://file/commcare/video/visit.mp4" },
			{
				name: "jr://file/commcare/video/visit.mp4 (over 1 GB, the most Nova reads of a video)",
			},
		);
		const view = panelView(
			answered({
				kind: "account",
				findings: [file],
				more: 0,
				counts: { notYet: 0, never: 0, fixInHq: 1 },
			}),
			PUBLISH,
		);
		expect(view.body).toMatchObject({
			kind: "account",
			lead: cannotBringInLead(1),
			tooLarge: null,
		});
		expect(view.drawsItem).toBe(true);
	});

	it("says CommCare HQ's version takes more checking than Nova gives one app, with the finding's block and no Check again", () => {
		const tooIntricate = finding("too-intricate");
		const view = panelView(
			answered({
				kind: "account",
				findings: [tooIntricate],
				more: 0,
				counts: { notYet: 1, never: 0, fixInHq: 0 },
			}),
			PUBLISH,
		);
		expect(view.body).toMatchObject({
			lead: "CommCare HQ's version of this app takes more checking than Nova gives one app, so Nova brought nothing in.",
			tooLarge: tooIntricate,
		});
	});

	it("words each unavailable reason against the review's own reference, with Check again only for Nova's defect", () => {
		for (const reason of [
			"not-published",
			"publishing-stopped",
			"app-deleted",
			"hq-app-taken",
			"no-reference",
			"baseline-unread",
			"base-needs-project-data",
			"base-unreadable",
			"base-too-large",
			"nova-updated",
			"app-moved",
			"nova-defect",
		] as const) {
			const since = { kind: "changes-brought-in" } as const;
			const view = panelView(
				answered({ kind: "unavailable", reason, since }),
				PUBLISH,
			);
			expect(view.body).toEqual({
				kind: "line",
				line: hqChangesUnavailableLine(reason, { domain: "clinic", since }),
				role: "status",
				checkAgain: reason === "nova-defect",
			});
			expect(view.drawsItem).toBe(true);
		}
	});

	it("draws a held change and a failed read of CommCare HQ with the item", () => {
		expect(
			panelView(
				answered({ kind: "held", reason: "languages-reordered", runs: null }),
				PUBLISH,
			).drawsItem,
		).toBe(true);
		const stop = finding("key-not-accepted");
		const view = panelView(answered({ kind: "stop", finding: stop }), PUBLISH);
		expect(view.body).toEqual({ kind: "stop", finding: stop });
		expect(view.drawsItem).toBe(true);
	});

	it("offers no choice of its own and takes no press", () => {
		const state = answered({
			kind: "held",
			reason: "runs-elsewhere",
			runs: { app: ["web-apps", "android"], hq: ["android"] },
		});
		expect(publishOverDiscard(state, "app-1")).toBeNull();
		expect(
			reduceHqChangesPanel(state, {
				type: "bring-in-pressed",
				discard: false,
				at: AT,
			}),
		).toBe(state);
	});
});

describe("the card's publish over", () => {
	it("hands the publish dialog the app's discard under the review's observed digest", () => {
		const state = answered(changes({ novaChanges: ["Nova line"] }));
		expect(publishOverDiscard(state, "app-1")).toEqual({
			kind: "app",
			novaResourceId: "app-1",
			observedDigest: "o".repeat(64),
		});
	});
});

describe("the builder's header", () => {
	const clinic = { server: "production", domain: "clinic" } as const;
	const field = { server: "india", domain: "field" } as const;

	it("opens the card's dialog for one project space and the Publishing section for more", () => {
		expect(headerChangesAction([])).toEqual({ kind: "none" });
		expect(headerChangesAction([clinic])).toEqual({
			kind: "dialog",
			target: clinic,
		});
		expect(headerChangesAction([clinic, field])).toEqual({
			kind: "publishing",
		});
	});

	it("reads the check's answer strictly, and takes any other body as no answer", () => {
		expect(hqChangedTargetsOf({ changed: [] })).toEqual([]);
		expect(
			hqChangedTargetsOf({ changed: [clinic, field, { ...clinic }] }),
		).toEqual([clinic, field]);
		for (const body of [
			null,
			[],
			"changed",
			{},
			{ changed: {} },
			{ changed: [{ server: "mars", domain: "clinic" }] },
			{ changed: [{ server: "production", domain: "" }] },
			{ changed: [{ server: "production" }] },
			{ changed: [null] },
		]) {
			expect(hqChangedTargetsOf(body)).toBeNull();
		}
	});
});

describe("the Publishing card's Refresh from CommCare HQ", () => {
	it("offers See what changed exactly where CommCare HQ saved the app since Nova last read it", () => {
		expect(
			keptRefreshOffersReview({
				success: true,
				data: { kind: "changed-in-hq" },
			}),
		).toBe(true);
		for (const kind of ["no-baseline", "unavailable", "app-gone"] as const) {
			expect(
				keptRefreshOffersReview({
					success: true,
					data: { kind } as KeptRefreshView,
				}),
			).toBe(false);
		}
		expect(
			keptRefreshOffersReview({
				success: false,
				code: "invalid_input",
				message: "No key.",
			}),
		).toBe(false);
	});
});

describe("what a line is measured against", () => {
	it("reads the review's own reference over the surface's", () => {
		const since = { kind: "brought-in", at: "2026-10-01T10:00:00Z" } as const;
		const view = panelView(
			answered({ kind: "unavailable", reason: "nova-updated", since }),
			{ ...PUBLISH, since: { kind: "published" } },
		);
		expect(view.body).toMatchObject({
			line: hqChangesUnavailableLine("nova-updated", {
				domain: "clinic",
				since,
			}),
		});
	});

	it("measures a card's change from the day the app was brought in until Nova publishes there", () => {
		const adopted = {
			deployment: {
				deployment: { appId: "app-1" },
				active: [
					{
						kind: "app",
						novaResourceId: "app-1",
						ownership: "adopted",
						adoptedAt: "2026-10-01T10:00:00Z",
						adoptedByName: "Ada",
					},
				],
				superseded: [],
			},
		};
		const firstPublish = { ids: [], of: "first-publish" };
		expect(
			cardDriftReference({
				...adopted,
				firstPublish,
			} as unknown as DeploymentView),
		).toEqual({ kind: "brought-in", at: "2026-10-01T10:00:00Z" });
		expect(
			cardDriftReference({
				...adopted,
				firstPublish: { ...firstPublish, of: "next-publish" },
			} as unknown as DeploymentView),
		).toEqual({ kind: "published" });
		expect(
			cardDriftReference({
				...adopted,
				firstPublish: null,
			} as unknown as DeploymentView),
		).toEqual({ kind: "published" });
	});
});

describe("a request its route refused before reading anything", () => {
	const refusal = {
		message: HQ_CHANGES_NO_EDIT_ACCESS_LINE,
		checkAgain: false,
	};

	it("says the route's own sentence for a review, with no Check again where checking again can't help", () => {
		const state = run([
			{ type: "sent", id: 1 },
			{ type: "review-ended", end: refusal },
		]);
		expect(panelView(state, CARD).body).toEqual({
			kind: "line",
			line: HQ_CHANGES_NO_EDIT_ACCESS_LINE,
			role: "alert",
			checkAgain: false,
		});
		const signedOut = run([
			{ type: "sent", id: 1 },
			{
				type: "review-ended",
				end: { message: "Signed out.", checkAgain: true },
			},
		]);
		expect(panelView(signedOut, CARD).body).toMatchObject({
			line: "Signed out.",
			checkAgain: true,
		});
	});

	it("says it beside the lists for a bring-in, with the buttons back", () => {
		const state = run(
			[
				{ type: "bring-in-pressed", discard: false, at: AT },
				{ type: "sent", id: 2 },
				{ type: "bring-in-ended", end: refusal },
			],
			answered(changes()),
		);
		expect(panelView(state, PUBLISH).body).toMatchObject({
			kind: "lists",
			notice: { lines: [HQ_CHANGES_NO_EDIT_ACCESS_LINE], checkAgain: false },
			choices: { bringIn: { label: BRING_IN_CHANGES_ACTION } },
		});
	});
});

describe("Check again beside a notice", () => {
	const pressed = (review: ChangesReview, end: HqChangesPanelEvent) =>
		run(
			[
				{
					type: "bring-in-pressed",
					discard: review.novaChanges.length > 0,
					at: AT,
				},
				{ type: "sent", id: 2 },
				end,
			],
			answered(review),
		);

	it("stands beside every notice that says to check again, and reads the review again", () => {
		for (const end of [
			{ type: "bring-in-ended", end: "lost" },
			{ type: "bring-in-ended", end: "failed" },
			{
				type: "bring-in-answered",
				outcome: {
					kind: "gate",
					findings: ["The automation reads age."],
					details: ["The automation reads the property `age`."],
				},
			},
			{
				type: "bring-in-answered",
				outcome: { kind: "refused", message: "The app is mid build." },
			},
		] as const satisfies readonly HqChangesPanelEvent[]) {
			const state = pressed(changes(), end);
			expect(panelView(state, PUBLISH).body).toMatchObject({
				notice: { checkAgain: true },
			});
			const checked = reduceHqChangesPanel(state, { type: "check", at: AT });
			expect(nextRequest(checked)).toEqual({ id: 3, kind: "review" });
		}
	});

	it("is left to the renamed properties' line where that already offers it", () => {
		const review = changes({
			novaChanges: ["Nova line"],
			renamedInNova: [{ caseType: "patient", from: "phone", to: "mobile" }],
		});
		const state: HqChangesPanelState = {
			...answered(review),
			phase: {
				kind: "answered",
				review,
				notice: { kind: "ended", end: "lost" },
			},
		};
		expect(panelView(state, PUBLISH).body).toMatchObject({
			notice: { checkAgain: false },
			choices: { renamed: renamedInNovaLine(review.renamedInNova) },
		});
	});
});

describe("the moved line over what the bring-in found", () => {
	const pressedThen = (now: HqChangesReview) =>
		run(
			[
				{ type: "bring-in-pressed", discard: false, at: AT },
				{ type: "sent", id: 2 },
				{
					type: "bring-in-answered",
					outcome: changedOutcome(now, "Grace"),
				},
			],
			answered(changes()),
		);

	it("says nothing was brought in over a stop or a state Nova can't bring in, never that a copy changed", () => {
		for (const now of [
			{
				kind: "stop",
				finding: { code: "hq-unreachable" } as unknown as CircumstanceFinding,
			},
			{ kind: "unavailable", reason: "nova-defect", since: null },
			{ kind: "held", reason: "languages-reordered", runs: null },
			{
				kind: "account",
				findings: [{ code: "x" }] as unknown as Finding[],
				more: 0,
				counts: { notYet: 1, never: 0, fixInHq: 0 },
			},
		] as const satisfies readonly HqChangesReview[]) {
			expect(panelView(pressedThen(now), PUBLISH).moved).toBe(
				HQ_CHANGES_NOTHING_TAKEN_LINE,
			);
		}
	});

	it("says the review moved over a list or a standing with nothing to bring in", () => {
		expect(
			panelView(pressedThen(changes({ reviewDigest: "e".repeat(64) })), PUBLISH)
				.moved,
		).toBe(hqChangesMovedLine("Grace"));
		expect(panelView(pressedThen(nothing("unchanged")), PUBLISH).moved).toBe(
			hqChangesMovedLine("Grace"),
		);
	});
});

describe("the ways on the card's sentences name", () => {
	it("are drawn on the card under an account, a held change, base-too-large and nova-defect, and nowhere else", () => {
		const named: readonly HqChangesReview[] = [
			{
				kind: "account",
				findings: [{ code: "x" }] as unknown as Finding[],
				more: 0,
				counts: { notYet: 1, never: 0, fixInHq: 0 },
			},
			{ kind: "unavailable", reason: "base-too-large", since: null },
			{ kind: "unavailable", reason: "nova-defect", since: null },
			{ kind: "held", reason: "languages-reordered", runs: null },
			{ kind: "held", reason: "runs-elsewhere", runs: null },
		];
		for (const review of named) {
			expect(panelView(answered(review), CARD).waysOn).toBe(true);
			/* In the publish dialog the item under the panel is those ways. */
			expect(panelView(answered(review), PUBLISH).waysOn).toBe(false);
		}
		for (const review of [
			/* Nothing there is this app's: there is nothing to publish over or stop. */
			{ kind: "unavailable", reason: "not-published", since: null },
			{ kind: "unavailable", reason: "publishing-stopped", since: null },
			{ kind: "unavailable", reason: "app-deleted", since: null },
			{ kind: "unavailable", reason: "no-reference", since: null },
			{ kind: "unavailable", reason: "nova-updated", since: null },
			changes(),
			nothing("unchanged"),
		] as const satisfies readonly HqChangesReview[]) {
			expect(panelView(answered(review), CARD).waysOn).toBe(false);
		}
	});
});
