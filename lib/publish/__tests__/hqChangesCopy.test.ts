import { describe, expect, it } from "vitest";
import type { DriftReference } from "@/lib/publish/driftReference";
import * as copy from "@/lib/publish/hqChangesCopy";
import {
	BASELINE_UNKNOWN_SENTENCE,
	BRING_IN_CHANGES_ACTION,
	baselineUnknownSentence,
	broughtInLine,
	CANNOT_BRING_IN_HEADING,
	CANNOT_BRING_IN_OTHER_WAYS,
	CANNOT_BRING_IN_TOO_LARGE_LEAD,
	CHECK_AGAIN_ACTION,
	COPY_BOTH_LISTS_ACTION,
	cannotBringInLead,
	caseDataLine,
	caseTypesLine,
	HQ_CHANGES_BRING_IN_LOST_LINE,
	HQ_CHANGES_DIALOG_TITLE,
	HQ_CHANGES_FAILED_LINE,
	HQ_CHANGES_FILES_NOT_PERMITTED,
	HQ_CHANGES_GATE_LEAD,
	HQ_CHANGES_GATE_NEXT,
	HQ_CHANGES_HEADING,
	HQ_CHANGES_REVIEW_LOST_LINE,
	HQ_CHANGES_STAGE_LABELS,
	HQ_CHANGES_STILL_READING,
	HQ_CHANGES_TABLE_CHOICE_MISSING,
	HQ_CHANGES_TABLE_CHOICE_NOT_OFFERED,
	hqChangedBringInMessage,
	hqChangedFoundLine,
	hqChangesBroughtInToast,
	hqChangesHeldLine,
	hqChangesLead,
	hqChangesMovedLine,
	hqChangesPublishingStoppedLine,
	hqChangesUnavailableLine,
	keptChangedInHqLine,
	LISTS_COPIED_LINE,
	LISTS_NOT_COPIED_LINE,
	NEXT_PUBLISH_DIALOG_LEAD,
	NEXT_PUBLISH_GOES_AHEAD,
	NEXT_PUBLISH_HEADING,
	NEXT_PUBLISH_LEAD,
	NOVA_CHANGES_HEADING,
	NOVA_CHANGES_LEAD,
	nextPublishChangesLine,
	nothingNewToPublishLine,
	nothingToBringInLine,
	PUBLISH_OVER_CHOSEN_LINE,
	PUBLISH_OVER_HQ_ACTION,
	PUBLISH_OVER_HQ_HELPER,
	PUBLISH_OVER_INSTEAD_LINE,
	renamedInNovaLine,
	SEE_WHAT_CHANGED_ACTION,
	SEE_WHAT_CHANGED_IN_HQ_ACTION,
	showAllAction,
	sincePhrase,
	USE_HQ_VERSION_ACTION,
	USE_HQ_VERSION_HELPER,
} from "@/lib/publish/hqChangesCopy";
import {
	HQ_CHANGE_HELD,
	HQ_CHANGES_STAGES,
	HQ_CHANGES_UNAVAILABLE,
} from "@/lib/publish/hqChangesKinds";
import { keptRefreshSentence } from "@/lib/publish/keptValues";

const PUBLISHED: DriftReference = { kind: "published" };
const BROUGHT_IN: DriftReference = {
	kind: "brought-in",
	at: "2026-11-10T23:30:00.000Z",
};
const CHANGES_BROUGHT_IN: DriftReference = { kind: "changes-brought-in" };
const AUCKLAND = { locale: "en-GB", timeZone: "Pacific/Auckland" } as const;

describe("the phrase {since}", () => {
	it("says each kind of reference, the day in the reader's zone", () => {
		expect(sincePhrase(PUBLISHED, "alpha")).toBe(
			"Nova last published this app to “alpha”",
		);
		expect(sincePhrase(BROUGHT_IN, "alpha")).toBe(
			"Nova brought this app in on 10 November 2026",
		);
		expect(sincePhrase(BROUGHT_IN, "alpha", AUCKLAND)).toBe(
			"Nova brought this app in on 11 November 2026",
		);
		expect(sincePhrase(CHANGES_BROUGHT_IN, "alpha")).toBe(
			"Nova last brought in changes from “alpha”",
		);
	});
});

describe("loading", () => {
	it("names each stage, the pictures and sounds with their count", () => {
		expect(HQ_CHANGES_STAGES.map((stage) => stage)).toEqual(
			Object.keys(HQ_CHANGES_STAGE_LABELS),
		);
		expect(HQ_CHANGES_STAGE_LABELS["reading-app"]).toBe(
			"Reading the app in CommCare HQ",
		);
		expect(HQ_CHANGES_STAGE_LABELS["reading-project-data"]).toBe(
			"Reading its lookup tables",
		);
		expect(HQ_CHANGES_STAGE_LABELS.checking).toBe("Checking what changed");
		expect(HQ_CHANGES_STAGE_LABELS["checking-media"](null)).toBe(
			"Checking pictures and sounds",
		);
		expect(
			HQ_CHANGES_STAGE_LABELS["checking-media"]({ done: 3, total: 1200 }),
		).toBe("Checking pictures and sounds (3 of 1,200)");
		expect(HQ_CHANGES_STAGE_LABELS["adding-media"]).toBe(
			"Adding pictures and sounds to this Project",
		);
		expect(HQ_CHANGES_STAGE_LABELS["bringing-in"]).toBe(
			"Bringing the changes in",
		);
		expect(HQ_CHANGES_STILL_READING).toBe(
			"Still reading. A large app can take a little while.",
		);
	});
});

describe("the lists", () => {
	const since = sincePhrase(PUBLISHED, "alpha");

	it("says the headings and leads", () => {
		expect(HQ_CHANGES_HEADING).toBe("What changed in CommCare HQ");
		expect(hqChangesLead(since, false)).toBe(
			"These changed in CommCare HQ since Nova last published this app to “alpha”. You can bring them in to Nova. Everything else in this app stays as it is.",
		);
		expect(hqChangesLead(since, true)).toBe(
			"These changed in CommCare HQ since Nova last published this app to “alpha”.",
		);
		expect(NOVA_CHANGES_HEADING).toBe("What changed in Nova since then");
		expect(NOVA_CHANGES_LEAD).toBe(
			"Nova doesn't combine the two, so this is a choice between them.",
		);
	});

	it("says every button and the sentence under each", () => {
		expect(BRING_IN_CHANGES_ACTION).toBe("Bring in these changes");
		expect(PUBLISH_OVER_INSTEAD_LINE).toBe(
			"Or you can publish over them, which replaces them with this app's version.",
		);
		expect(USE_HQ_VERSION_ACTION).toBe("Use CommCare HQ's version");
		expect(USE_HQ_VERSION_HELPER).toBe(
			"This app takes CommCare HQ's changes. The changes listed under Nova are removed, and Nova can't put them back.",
		);
		expect(PUBLISH_OVER_HQ_ACTION).toBe("Publish over CommCare HQ's changes");
		expect(PUBLISH_OVER_HQ_HELPER).toBe(
			"CommCare HQ takes this app's version. What changed there is replaced.",
		);
		expect(PUBLISH_OVER_CHOSEN_LINE).toBe(
			"This publish replaces what changed in CommCare HQ with this app's version.",
		);
		expect(COPY_BOTH_LISTS_ACTION).toBe("Copy both lists");
		expect(LISTS_COPIED_LINE).toBe("Both lists copied.");
		expect(LISTS_NOT_COPIED_LINE).toBe(
			"Nova couldn't copy the lists here. You can select them above and copy them yourself.",
		);
		expect(showAllAction(14)).toBe("Show all 14");
		expect(showAllAction(1200)).toBe("Show all 1,200");
		expect(CHECK_AGAIN_ACTION).toBe("Check again");
	});

	it("names the case properties renamed in Nova, one and several", () => {
		expect(
			renamedInNovaLine([{ caseType: "mother", from: "edd", to: "due_date" }]),
		).toBe(
			"Since then, the case property “edd” of the case type “mother” was renamed to “due_date” in Nova, which moved saved case data to the new name. To use CommCare HQ's version, you can rename it back in Nova, so the data moves back with it, and then check again.",
		);
		expect(
			renamedInNovaLine([
				{ caseType: "mother", from: "edd", to: "due_date" },
				{ caseType: "mother", from: "lmp", to: "last_period" },
			]),
		).toBe(
			"Since then, these case properties of the case type “mother” were renamed in Nova: “edd” to “due_date”, and “lmp” to “last_period”, which moved saved case data to the new names. To use CommCare HQ's version, you can rename them back in Nova, so the data moves back with them, and then check again.",
		);
		expect(
			renamedInNovaLine([
				{ caseType: "mother", from: "a", to: "b" },
				{ caseType: "mother", from: "c", to: "d" },
				{ caseType: "child", from: "e", to: "f" },
			]),
		).toContain(
			"these case properties were renamed in Nova: “a” to “b” on “mother”, “c” to “d” on “mother”, and “e” to “f” on “child”, which moved",
		);
		expect(
			renamedInNovaLine([
				{ caseType: "mother", from: "edd", to: "due_date" },
				{ caseType: "child", from: "edd", to: "due_date" },
			]),
		).toContain(
			"“edd” to “due_date” on “mother”, and “edd” to “due_date” on “child”, which moved",
		);
	});
});

describe("the case data lines", () => {
	const property = (name: string) => ({ caseType: "mother", name });

	it("names one property, several, and five at most", () => {
		expect(caseDataLine([property("edd")])).toBe(
			"The case type “mother” no longer has the case property “edd”, so its cases saved in Nova lose that value the next time each one is saved.",
		);
		expect(caseDataLine([property("edd"), property("lmp")])).toBe(
			"The case type “mother” no longer has the case properties “edd” and “lmp”, so its cases saved in Nova lose those values the next time each one is saved.",
		);
		expect(
			caseDataLine(["a", "b", "c", "d", "e", "f", "g"].map(property)),
		).toBe(
			"The case type “mother” no longer has the case properties “a”, “b”, “c”, “d”, “e” and 2 more, so its cases saved in Nova lose those values the next time each one is saved.",
		);
	});

	it("names each property with its case type where the properties are of several types", () => {
		expect(
			caseDataLine([
				{ caseType: "mother", name: "visit_date" },
				{ caseType: "child", name: "visit_date" },
			]),
		).toBe(
			"The app no longer has the case properties “visit_date” on “mother” and “visit_date” on “child”, so cases saved in Nova lose those values the next time each one is saved.",
		);
		expect(caseDataLine([{ caseType: "child", name: "status" }])).toBe(
			"The case type “child” no longer has the case property “status”, so its cases saved in Nova lose that value the next time each one is saved.",
		);
	});

	it("names one case type, several, and five at most", () => {
		expect(caseTypesLine(["child"])).toBe(
			"The app no longer has the case type “child”. Its cases saved in Nova are kept, and no list in this app shows them.",
		);
		expect(caseTypesLine(["child", "visit"])).toBe(
			"The app no longer has the case types “child” and “visit”. Their cases saved in Nova are kept, and no list in this app shows them.",
		);
		expect(caseTypesLine(["a", "b", "c", "d", "e", "f"])).toBe(
			"The app no longer has the case types “a”, “b”, “c”, “d”, “e” and 1 more. Their cases saved in Nova are kept, and no list in this app shows them.",
		);
	});
});

describe("the next publish", () => {
	it("says the panel's lead and the dialog's heading and lead", () => {
		expect(NEXT_PUBLISH_LEAD).toBe(
			"Nova writes a few things its own way, so your next publish changes these in CommCare HQ:",
		);
		expect(NEXT_PUBLISH_HEADING).toBe(
			"What this publish changes in CommCare HQ",
		);
		expect(NEXT_PUBLISH_DIALOG_LEAD).toBe(
			"CommCare HQ's version holds a few things Nova writes its own way. This publish changes them there.",
		);
	});
});

describe("nothing to bring in", () => {
	it("says each reason against each kind of reference", () => {
		const rows: readonly [DriftReference, string][] = [
			[PUBLISHED, "Nova last published this app to “alpha”"],
			[BROUGHT_IN, "Nova brought this app in on 10 November 2026"],
			[CHANGES_BROUGHT_IN, "Nova last brought in changes from “alpha”"],
		];
		for (const [reference, phrase] of rows) {
			const since = sincePhrase(reference, "alpha");
			expect(nothingToBringInLine("unchanged", since)).toBe(
				`Nothing in this app has changed in CommCare HQ since ${phrase}.`,
			);
			expect(nothingToBringInLine("reads-the-same", since)).toBe(
				`CommCare HQ saved this app since ${phrase}, and Nova reads it as the same app. There's nothing to bring in.`,
			);
			expect(nothingToBringInLine("already-here", since)).toBe(
				`What changed in CommCare HQ since ${phrase} is already in this app. There's nothing to bring in.`,
			);
		}
		expect(NEXT_PUBLISH_GOES_AHEAD).toBe(
			"Your next publish here goes ahead as usual.",
		);
	});
});

describe("something Nova can't hold", () => {
	it("says the heading, the lead for one and several, the size lead and the other ways", () => {
		expect(CANNOT_BRING_IN_HEADING).toBe(
			"Nova can't bring in CommCare HQ's version",
		);
		expect(cannotBringInLead(1)).toBe(
			"Nova read what changed and found 1 thing it can't hold, so it brought nothing in. Taking part of an app would lose the rest at the next publish. Here is each one, with what you can do about it.",
		);
		expect(cannotBringInLead(3)).toBe(
			"Nova read what changed and found 3 things it can't hold, so it brought nothing in. Taking part of an app would lose the rest at the next publish. Here is each one, with what you can do about it.",
		);
		expect(CANNOT_BRING_IN_TOO_LARGE_LEAD).toBe(
			"CommCare HQ's version of this app is larger than Nova brings in, so Nova brought nothing in.",
		);
		expect(CANNOT_BRING_IN_OTHER_WAYS).toBe(
			"You can also publish over CommCare HQ's version, which removes these from CommCare HQ, or stop publishing here.",
		);
	});
});

describe("after it is brought in", () => {
	it("says whether changes in Nova were removed, and that nothing is new to publish", () => {
		expect(broughtInLine(false)).toBe(
			"CommCare HQ's changes are in this app now.",
		);
		expect(broughtInLine(true)).toBe(
			"This app now holds CommCare HQ's version. The changes listed under Nova were removed.",
		);
		expect(nothingNewToPublishLine("alpha")).toBe(
			"There's nothing new to publish to “alpha” yet.",
		);
	});
});

describe("the publish dialog's headline", () => {
	it("says each kind of reference, and the tables and places sentence where they are listed", () => {
		expect(hqChangedBringInMessage(PUBLISHED, false)).toBe(
			"Something in this app changed in CommCare HQ since Nova last published it, so Nova stopped before sending anything. Here's what changed.",
		);
		expect(hqChangedBringInMessage(BROUGHT_IN, false, AUCKLAND)).toBe(
			"Something in this app changed in CommCare HQ since Nova brought it in on 11 November 2026, so Nova stopped before sending anything. Here's what changed.",
		);
		expect(hqChangedBringInMessage(CHANGES_BROUGHT_IN, false)).toBe(
			"Something in this app changed in CommCare HQ since Nova last brought in changes from it, so Nova stopped before sending anything. Here's what changed.",
		);
		expect(hqChangedBringInMessage(PUBLISHED, true)).toBe(
			"Something in this app changed in CommCare HQ since Nova last published it, so Nova stopped before sending anything. Here's what changed. The lookup tables and places listed below keep their own choice.",
		);
		for (const since of [PUBLISHED, BROUGHT_IN, CHANGES_BROUGHT_IN]) {
			expect(hqChangedBringInMessage(since, true)).not.toContain(
				"even when it changed no value",
			);
		}
	});
});

describe("the stops", () => {
	const AFTER =
		"Nova can bring in changes made in CommCare HQ after your next publish here.";
	const line = (
		reason: (typeof HQ_CHANGES_UNAVAILABLE)[number],
		since: DriftReference = PUBLISHED,
	) => hqChangesUnavailableLine(reason, { domain: "alpha", since });

	it("says nothing in the project space is this app's: deleted, never published, stopped", () => {
		expect(line("app-deleted")).toBe(
			"This app is in recently deleted, and another Nova app took its app in “alpha” while it was there, so there's nothing there to bring in. Once this app is restored, you can check again.",
		);
		expect(line("not-published")).toBe(
			"Nova hasn't published this app to “alpha”, so there's nothing there to bring in. Publishing there makes a new app.",
		);
		expect(line("publishing-stopped")).toBe(
			"Nova stopped publishing this app to “alpha”, so there's nothing there to bring in. Publishing there again makes a new app.",
		);
		expect(line("publishing-stopped")).toBe(
			hqChangesPublishingStoppedLine("alpha"),
		);
	});

	it("says why Nova can't tell CommCare HQ's changes from this app's", () => {
		expect(line("no-reference")).toBe(
			`Nova can't tell CommCare HQ's changes from this app's here, because its record of the last publish to “alpha” doesn't hold what that takes. ${AFTER}`,
		);
		expect(line("baseline-unread")).toBe(
			`${BASELINE_UNKNOWN_SENTENCE} ${AFTER}`,
		);
		expect(line("baseline-unread", CHANGES_BROUGHT_IN)).toBe(
			`${baselineUnknownSentence(CHANGES_BROUGHT_IN)} ${AFTER}`,
		);
		expect(line("base-needs-project-data", BROUGHT_IN)).toBe(
			`This Project's lookup tables or organization changed since Nova brought this app in on 10 November 2026, so Nova can't read its own record of what it left in “alpha”, and can't tell what changed there. ${AFTER}`,
		);
		expect(line("base-unreadable")).toBe(
			`Nova couldn't read its own record of what it left in “alpha”, so it can't tell what changed there. That's Nova's to fix, and Nova has reported it. ${AFTER}`,
		);
		expect(line("base-too-large")).toBe(
			"Nova's record of what it left in “alpha” is larger than Nova compares, so it can't tell what changed there. That limit is Nova's, not the app's. You can publish over the change, or stop publishing here.",
		);
		expect(line("nova-updated", CHANGES_BROUGHT_IN)).toBe(
			`Nova updated how this app is stored since Nova last brought in changes from “alpha”, so it can't tell this app's changes from CommCare HQ's here. ${AFTER}`,
		);
		expect(line("nova-defect")).toBe(
			"Nova read what changed in CommCare HQ and couldn't fit it to this app, so it changed nothing. That's Nova's to fix, and Nova has reported it. You can check again later, publish over the change, or stop publishing here.",
		);
		expect(line("app-moved")).toBe(
			`This app moved to another Project after it was changed in Nova and before it was published to “alpha” again, so Nova can't tell this app's changes from CommCare HQ's here. ${AFTER}`,
		);
	});

	it("says each held change, each platform as a sentence names it", () => {
		expect(hqChangesHeldLine("languages-reordered", null)).toBe(
			"The language this app's own text is written in changed in CommCare HQ, and Nova can't bring that in. You can put the app's languages and its name in each language back as they were in CommCare HQ and check again, or publish over the change.",
		);
		expect(
			hqChangesHeldLine("runs-elsewhere", {
				app: ["web-apps", "android"],
				hq: ["android"],
			}),
		).toBe(
			"CommCare HQ's version doesn't run everywhere this app does. This app runs in Web Apps and on Android, and what changed in CommCare HQ runs only on Android. You can change where this app runs in App settings and check again, or publish over the change.",
		);
		expect(HQ_CHANGE_HELD).toEqual(["languages-reordered", "runs-elsewhere"]);
	});

	it("says the gate's refusal and the review that moved", () => {
		expect(HQ_CHANGES_GATE_LEAD).toBe(
			"Bringing these changes in would leave something in this app that no longer works, so Nova changed nothing.",
		);
		expect(HQ_CHANGES_GATE_NEXT).toBe(
			"You can change that in Nova and check again, or publish over the change.",
		);
		expect(hqChangesMovedLine(null)).toBe(
			"CommCare HQ's copy or this app changed while you were reading, so here is the list as it stands now.",
		);
		expect(hqChangesMovedLine("Asha")).toBe(
			"CommCare HQ's copy or this app changed while you were reading, so here is the list as it stands now. Asha is editing this app. You can bring the changes in when they pause.",
		);
	});
});

describe("a request that ends with no answer, or one the bring-in refuses", () => {
	it("says that the connection was lost, or that Nova failed, and what to do next", () => {
		expect(HQ_CHANGES_REVIEW_LOST_LINE).toBe(
			"Nova lost its connection while reading what changed in CommCare HQ, and nothing in this app changed. You can check again.",
		);
		expect(HQ_CHANGES_BRING_IN_LOST_LINE).toBe(
			"Nova lost its connection while bringing the changes in. You can check again to see where things stand.",
		);
		expect(HQ_CHANGES_FAILED_LINE).toBe(
			"Something went wrong on Nova's side, and Nova has reported it. You can check again to see where things stand.",
		);
	});

	it("says why a bring-in took nothing", () => {
		expect(HQ_CHANGES_TABLE_CHOICE_MISSING).toBe(
			"A lookup table these changes read needs your choice before Nova can bring them in. You can choose what to do with it in the list of changes.",
		);
		expect(HQ_CHANGES_TABLE_CHOICE_NOT_OFFERED).toBe(
			"One of the choices sent isn't one this list of changes offers. The list may have changed, so you can check again and choose again.",
		);
		expect(HQ_CHANGES_FILES_NOT_PERMITTED).toBe(
			"You don't have edit access to this Project's files any more, so Nova brought nothing in. One of its admins can give you edit access.",
		);
		expect(hqChangesPublishingStoppedLine("clinic")).toBe(
			"Nova stopped publishing this app to “clinic”, so there's nothing there to bring in. Publishing there again makes a new app.",
		);
	});
});

describe("the other strings", () => {
	it("says C1 to C3, the dialog's title and T1", () => {
		expect(keptChangedInHqLine("10 November 2026")).toBe(
			"CommCare HQ saved this app since Nova last read it, so these stay as of 10 November 2026.",
		);
		expect(
			keptRefreshSentence(
				{ kind: "changed-in-hq", changed: false },
				{ date: "10 November 2026", space: "alpha" },
			),
		).toBe(keptChangedInHqLine("10 November 2026"));
		expect(SEE_WHAT_CHANGED_ACTION).toBe("See what changed");
		expect(SEE_WHAT_CHANGED_IN_HQ_ACTION).toBe(
			"See what changed in CommCare HQ",
		);
		expect(HQ_CHANGES_DIALOG_TITLE).toBe("Changes in CommCare HQ");
		expect(hqChangesBroughtInToast("Asha")).toBe(
			"Asha brought in changes from CommCare HQ, so this app now shows the latest. Edits you hadn't saved yet are kept where they still fit.",
		);
		expect(hqChangesBroughtInToast(null)).toBe(
			"Someone in this Project brought in changes from CommCare HQ, so this app now shows the latest. Edits you hadn't saved yet are kept where they still fit.",
		);
	});
});

const REFERENCES = [PUBLISHED, BROUGHT_IN, CHANGES_BROUGHT_IN] as const;

/**
 * Every function this file exports, each called over its arms. A new
 * function export fails the completeness check until it is listed here.
 */
const SAMPLED: Readonly<Record<string, () => readonly string[]>> = {
	sincePhrase: () => REFERENCES.map((since) => sincePhrase(since, "alpha")),
	hqChangesLead: () => [hqChangesLead("x", true), hqChangesLead("x", false)],
	showAllAction: () => [showAllAction(12)],
	renamedInNovaLine: () => [
		renamedInNovaLine([{ caseType: "a", from: "b", to: "c" }]),
		renamedInNovaLine([
			{ caseType: "a", from: "b", to: "c" },
			{ caseType: "a", from: "d", to: "e" },
		]),
	],
	caseDataLine: () => [
		caseDataLine([{ caseType: "a", name: "b" }]),
		caseDataLine(
			["a", "b", "c", "d", "e", "f"].map((name) => ({ caseType: "t", name })),
		),
	],
	caseTypesLine: () => [caseTypesLine(["a"]), caseTypesLine(["a", "b"])],
	nothingToBringInLine: () =>
		(["unchanged", "reads-the-same", "already-here"] as const).map((reason) =>
			nothingToBringInLine(reason, "x"),
		),
	cannotBringInLead: () => [cannotBringInLead(1), cannotBringInLead(2)],
	broughtInLine: () => [broughtInLine(true), broughtInLine(false)],
	nothingNewToPublishLine: () => [nothingNewToPublishLine("alpha")],
	nextPublishChangesLine: () => [nextPublishChangesLine("alpha")],
	hqChangedFoundLine: () => [hqChangedFoundLine("x")],
	hqChangedBringInMessage: () =>
		REFERENCES.flatMap((since) => [
			hqChangedBringInMessage(since, false),
			hqChangedBringInMessage(since, true),
		]),
	baselineUnknownSentence: () =>
		REFERENCES.map((since) => baselineUnknownSentence(since)),
	hqChangesUnavailableLine: () =>
		REFERENCES.flatMap((since) =>
			HQ_CHANGES_UNAVAILABLE.map((reason) =>
				hqChangesUnavailableLine(reason, { domain: "alpha", since }),
			),
		),
	hqChangesHeldLine: () =>
		HQ_CHANGE_HELD.flatMap((reason) => [
			hqChangesHeldLine(reason, null),
			hqChangesHeldLine(reason, { app: ["web-apps"], hq: ["android"] }),
		]),
	hqChangesMovedLine: () => [hqChangesMovedLine(null), hqChangesMovedLine("A")],
	hqChangesPublishingStoppedLine: () => [
		hqChangesPublishingStoppedLine("alpha"),
	],
	keptChangedInHqLine: () => [keptChangedInHqLine("1 May 2026")],
	hqChangesBroughtInToast: () => [
		hqChangesBroughtInToast(null),
		hqChangesBroughtInToast("A"),
	],
};

describe("the voice", () => {
	it("holds no em dash and no ellipsis in any string it exports or builds", () => {
		const strings: string[] = [];
		for (const [name, value] of Object.entries(copy)) {
			if (typeof value === "string") strings.push(value);
			else if (typeof value === "function") {
				const sample = SAMPLED[name];
				expect(
					sample,
					`${name} is a function this test does not call; list it in SAMPLED`,
				).toBeDefined();
				strings.push(...(sample?.() ?? []));
			}
		}
		for (const label of Object.values(HQ_CHANGES_STAGE_LABELS)) {
			if (typeof label === "string") strings.push(label);
		}
		strings.push(
			HQ_CHANGES_STAGE_LABELS["checking-media"](null),
			HQ_CHANGES_STAGE_LABELS["checking-media"]({ done: 1, total: 2 }),
		);
		expect(strings.length).toBeGreaterThan(60);
		for (const text of strings)
			expect(text).not.toMatch(/\u2014|\u2026|\.\.\./);
	});

	it("ends no button with a full stop", () => {
		for (const button of [
			BRING_IN_CHANGES_ACTION,
			USE_HQ_VERSION_ACTION,
			PUBLISH_OVER_HQ_ACTION,
			COPY_BOTH_LISTS_ACTION,
			CHECK_AGAIN_ACTION,
			SEE_WHAT_CHANGED_ACTION,
			SEE_WHAT_CHANGED_IN_HQ_ACTION,
			showAllAction(12),
		]) {
			expect(button).not.toMatch(/\.$/);
		}
	});
});
