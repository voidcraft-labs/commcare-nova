/**
 * The account of an app Nova can't bring in, and the stop that ends a read:
 * how findings group under headings, how a long run of one sentence folds,
 * which heading and count line the account reads, what the copied list
 * holds, and which actions each stop offers. The plausible failures are a
 * form's heading drawn twice, a finding lost between the answer and the
 * screen or the clipboard, "1 things", "this time" over a limit a retry
 * cannot pass, two findings of one code that read alike, a copied list that
 * reads as complete, and a stop with no way on.
 */

import { describe, expect, it } from "vitest";
import type { AccountAnswer } from "@/lib/deployment";
import { BRING_IN_ACTIONS, openAppAction } from "@/lib/publish/bringInCopy";
import {
	ACCOUNT_CHECK_AGAIN_LINE,
	type CircumstanceContext,
	circumstanceBlock,
	FINDING_LABELS,
	findingLine,
	placeLine,
} from "@/lib/publish/hqFindingCopy";
import {
	CIRCUMSTANCE_STANDINGS,
	type CircumstanceFinding,
	circumstanceFinding,
	type Finding,
	type HqAppClaimDetail,
	READ_CIRCUMSTANCES,
	type StopCircumstance,
} from "@/lib/publish/hqFindings";
import { moreFindingsLine } from "@/lib/publish/hqReadingCopy";
import { MEDIA_CHECKED_LATER } from "@/lib/publish/managedData";
import {
	type AccountItem,
	accountAsText,
	accountGroups,
	accountHeading,
	accountStandings,
	countLine,
	placeGroupKey,
	STOP_ACTIONS,
	type StopAction,
	stopActionLabel,
} from "../bringInModel";
import { FORM_PLACE, manifestFinding, QUESTION_PLACE } from "./bringInFixtures";

const CONTEXT: CircumstanceContext = {
	server: "US",
	space: "demo-space",
	app: "Household visits",
	formatDate: (iso) => iso.slice(0, 10),
};

function account(
	findings: readonly Finding[],
	overrides: Partial<AccountAnswer> = {},
): AccountAnswer {
	return {
		kind: "account",
		appName: "Household visits",
		findings,
		more: 0,
		counts: { notYet: findings.length, never: 0, fixInHq: 0 },
		mediaChecked: true,
		...overrides,
	};
}

/** Every finding an item holds, folded or not. */
function findingsOf(items: readonly AccountItem[]): Finding[] {
	return items.flatMap((item) =>
		item.kind === "fold" ? item.findings : [item.finding],
	);
}

describe("accountGroups", () => {
	it("makes one group a key, in first-appearance order, with a form's later questions under it", () => {
		const formA = manifestFinding(FORM_PLACE(0, 0), { subject: "case-tiles" });
		const formB = manifestFinding(FORM_PLACE(0, 1), { subject: "case-tiles" });
		const questionA = manifestFinding(QUESTION_PLACE(0, 0, "/data/age"));
		const menu = manifestFinding(
			{ kind: "menu", menu: 1, name: "Menu 1" },
			{ subject: "case-tiles" },
		);
		const findings = [formA, formB, questionA, menu];
		const groups = accountGroups(findings);
		expect(groups.map((group) => group.key)).toEqual([
			placeGroupKey(formA.place),
			placeGroupKey(formB.place),
			placeGroupKey(menu.place),
		]);
		expect(groups[0]?.heading).toBe(placeLine(FORM_PLACE(0, 0)));
		expect(groups[0]?.items).toEqual([
			{ kind: "finding", finding: formA, prefix: null },
			{ kind: "finding", finding: questionA, prefix: "/data/age" },
		]);
		expect(findingsOf(groups.flatMap((group) => group.items))).toHaveLength(
			findings.length,
		);
	});

	it("heads a group a question opens with its form, and points the link at the form", () => {
		const question = manifestFinding(QUESTION_PLACE(2, 3, "/data/name"));
		const [group] = accountGroups([question]);
		expect(group?.place).toEqual(FORM_PLACE(2, 3));
		expect(group?.heading).toBe(placeLine(FORM_PLACE(2, 3)));
	});

	it("puts every file in one group of pictures and sounds, each line beginning with its path", () => {
		const first = circumstanceFinding(
			"media-file-unreadable",
			{ kind: "media", path: "jr://file/a.png" },
			{ name: "a.png" },
		);
		const second = circumstanceFinding(
			"media-file-unreadable",
			{ kind: "media", path: "jr://file/b.png" },
			{ name: "b.png" },
		);
		const groups = accountGroups([first, second]);
		expect(groups).toHaveLength(1);
		expect(groups[0]?.heading).toBe("Pictures and sounds");
		expect(
			groups[0]?.items.map((item) => item.kind === "finding" && item.prefix),
		).toEqual(["jr://file/a.png", "jr://file/b.png"]);
	});

	it("folds a run of more than twenty findings of one sentence, and keeps twenty as lines", () => {
		const run = (n: number) =>
			Array.from({ length: n }, (_, i) =>
				manifestFinding(QUESTION_PLACE(0, 0, `/data/q${i}`), {
					name: "minimal",
				}),
			);
		const other = manifestFinding(QUESTION_PLACE(0, 0, "/data/other"), {
			subject: "case-tiles",
		});

		const twenty = accountGroups([...run(20), other]);
		const lines = twenty[0]?.items ?? [];
		expect(lines.every((item) => item.kind === "finding")).toBe(true);

		const findings = [other, ...run(21)];
		const [group] = accountGroups(findings);
		expect(group?.items).toHaveLength(2);
		const fold = group?.items[1];
		expect(fold?.kind).toBe("fold");
		if (fold?.kind !== "fold") throw new Error("expected a fold");
		expect(fold.findings).toHaveLength(21);
		expect(fold.sentence).toBe(findingLine(findings[1] as Finding).sentence);
		expect(fold.standing).toBe("not-yet");
		expect(findingsOf(group?.items ?? [])).toEqual(findings);
	});

	it("never folds findings of one sentence whose names in CommCare HQ differ", () => {
		const findings = Array.from({ length: 22 }, (_, i) =>
			manifestFinding(QUESTION_PLACE(0, 0, `/data/q${i}`), {
				name: i % 2 === 0 ? "minimal" : "compact",
			}),
		);
		const [group] = accountGroups(findings);
		expect(group?.items.every((item) => item.kind === "finding")).toBe(true);
	});
});

describe("placeGroupKey", () => {
	it("gives a form and its questions one key, and two menus two", () => {
		expect(placeGroupKey(FORM_PLACE(1, 2))).toBe(
			placeGroupKey(QUESTION_PLACE(1, 2, "/data/x")),
		);
		expect(placeGroupKey(FORM_PLACE(1, 2))).not.toBe(
			placeGroupKey(FORM_PLACE(2, 1)),
		);
		expect(placeGroupKey({ kind: "menu", menu: 0, name: "A" })).not.toBe(
			placeGroupKey({ kind: "menu", menu: 1, name: "A" }),
		);
		expect(placeGroupKey({ kind: "case-list", menu: 0, name: "A" })).not.toBe(
			placeGroupKey({ kind: "search", menu: 0, name: "A" }),
		);
	});
});

describe("accountHeading", () => {
	const fault = (code: "unrecognized" | "read-back-differs") =>
		circumstanceFinding(code, { kind: "app" }, { name: "odd_key" });
	const place = circumstanceFinding(
		"places-over-nova-limit",
		{ kind: "organization" },
		{ name: "Districts" },
	);

	it("is this-time for Nova's own faults alone", () => {
		expect(accountHeading([fault("unrecognized")])).toBe("this-time");
		expect(
			accountHeading([fault("unrecognized"), fault("read-back-differs")]),
		).toBe("this-time");
	});

	it("is yet over a limit, a mix, a manifest finding and nothing at all", () => {
		expect(
			accountHeading([circumstanceFinding("too-large", { kind: "app" }, {})]),
		).toBe("yet");
		expect(accountHeading([place])).toBe("yet");
		expect(accountHeading([fault("read-back-differs"), place])).toBe("yet");
		expect(
			accountHeading([fault("unrecognized"), manifestFinding({ kind: "app" })]),
		).toBe("yet");
		expect(accountHeading([])).toBe("yet");
	});
});

describe("countLine", () => {
	it("says each part singular at one and plural above it, leaving out a zero", () => {
		expect(countLine({ notYet: 1, never: 1, fixInHq: 1 })).toBe(
			"1 thing Nova can't hold yet · 1 thing Nova doesn't bring in · 1 thing to change in CommCare HQ",
		);
		expect(countLine({ notYet: 2, never: 3, fixInHq: 4 })).toBe(
			"2 things Nova can't hold yet · 3 things Nova doesn't bring in · 4 things to change in CommCare HQ",
		);
		expect(countLine({ notYet: 0, never: 0, fixInHq: 1 })).toBe(
			"1 thing to change in CommCare HQ",
		);
		expect(countLine({ notYet: 5, never: 0, fixInHq: 0 })).toBe(
			"5 things Nova can't hold yet",
		);
		expect(countLine({ notYet: 0, never: 0, fixInHq: 0 })).toBe("");
	});
});

describe("a circumstance's name in CommCare HQ", () => {
	it("is drawn on its own line where the code's row says so, and nowhere else", () => {
		expect(CIRCUMSTANCE_STANDINGS["shadow-disagrees"].name).toBe("line");
		expect(CIRCUMSTANCE_STANDINGS["media-file-unreadable"].name).toBe("body");
		const lined = circumstanceFinding(
			"shadow-disagrees",
			{ kind: "menu", menu: 0, name: "Visits" },
			{ name: "Follow up" },
		);
		const bodied = circumstanceFinding(
			"media-file-unreadable",
			{ kind: "media", path: "jr://file/a.png" },
			{ name: "a.png" },
		);
		const [linedGroup, bodiedGroup] = accountGroups([lined, bodied]);
		const item = (group: typeof linedGroup) => group?.items[0];
		const linedItem = item(linedGroup);
		const bodiedItem = item(bodiedGroup);
		if (linedItem?.kind !== "finding" || bodiedItem?.kind !== "finding")
			throw new Error("expected two finding items");
		expect(findingLine(linedItem.finding).named).toBe("Follow up");
		expect(findingLine(bodiedItem.finding).named).toBeNull();

		const text = accountAsText(
			account([lined, bodied], { counts: { notYet: 0, never: 0, fixInHq: 2 } }),
			CONTEXT,
			"2026-11-15",
		);
		expect(text).toContain("In CommCare HQ: Follow up");
		expect(text).not.toContain("In CommCare HQ: a.png");
	});
});

describe("accountAsText", () => {
	it("holds every finding, folded or not, and a circumstance's body, name and next step", () => {
		const folded = Array.from({ length: 21 }, (_, i) =>
			manifestFinding(QUESTION_PLACE(0, 0, `/data/q${i}`), { name: "minimal" }),
		);
		const circumstance = circumstanceFinding(
			"unrecognized",
			{ kind: "form", menu: 1, form: 0, menuName: "Menu 1", name: "Form 0" },
			{ name: "odd_key" },
		);
		const named = manifestFinding(FORM_PLACE(0, 0), {
			subject: "case-tiles",
			name: "grid",
		});
		const findings = [...folded, named, circumstance];
		const text = accountAsText(account(findings), CONTEXT, "2026-11-15");

		const lines = text.split("\n");
		expect(lines[0]).toBe(
			"Nova can't bring in Household visits yet (demo-space, checked 2026-11-15)",
		);
		expect(lines[1]).toBe(countLine(account(findings).counts));
		for (const finding of folded) {
			const { sentence } = findingLine(finding);
			expect(
				lines.filter((line) =>
					line.includes(
						`(${(finding.place as { path: string }).path}): ${sentence}`,
					),
				),
			).toHaveLength(1);
		}
		expect(text).toContain(
			`- ${FINDING_LABELS["not-yet"]}: ${findingLine(named).sentence} In CommCare HQ: grid.`,
		);
		const block = circumstanceBlock(
			circumstance as CircumstanceFinding,
			CONTEXT,
		);
		expect(lines).toContain(`- ${FINDING_LABELS["not-yet"]}: ${block.title}`);
		expect(lines).toContain(`  ${block.body}`);
		expect(lines).toContain("  In CommCare HQ: odd_key");
		expect(lines).toContain(`  ${block.next}`);
		expect(lines.at(-1)).toBe(ACCOUNT_CHECK_AGAIN_LINE);
	});

	it("says what it does not list, and ends with the line about checking again", () => {
		const finding = manifestFinding(FORM_PLACE(0, 0), {
			subject: "case-tiles",
		});
		const text = accountAsText(
			account([finding], { more: 3, mediaChecked: false }),
			CONTEXT,
			"2026-11-15",
		);
		const lines = text.split("\n");
		expect(lines).toContain(moreFindingsLine(3));
		expect(lines).toContain(MEDIA_CHECKED_LATER);
		expect(lines.at(-1)).toBe(ACCOUNT_CHECK_AGAIN_LINE);
	});

	it("reads the heading of Nova's own fault, and this app where the read learned no name", () => {
		const fault = circumstanceFinding(
			"read-back-differs",
			{ kind: "app" },
			{ name: "form-ids" },
		);
		const text = accountAsText(
			account([fault], { appName: null }),
			CONTEXT,
			"2026-11-15",
		);
		expect(text.split("\n")[0]).toBe(
			"Nova couldn't bring in this app this time (demo-space, checked 2026-11-15)",
		);
	});

	it("reads an app whose CommCare HQ name is blank as this app", () => {
		for (const appName of ["", "   "]) {
			const text = accountAsText(
				account([manifestFinding(QUESTION_PLACE(0, 0, "/data/age"))], {
					appName,
				}),
				CONTEXT,
				"2026-11-15",
			);
			expect(text.split("\n")[0]).toBe(
				"Nova can't bring in this app yet (demo-space, checked 2026-11-15)",
			);
		}
	});
});

describe("STOP_ACTIONS", () => {
	const EXPECTED = {
		"not-connected": ["open-settings", "check-again"],
		"key-not-accepted": ["open-settings", "check-again"],
		"key-cannot-reach-space": ["open-settings", "check-again"],
		"plan-lacks-api-access": ["check-again", "choose-another-app"],
		"not-a-member": ["check-again", "choose-another-app"],
		"cannot-edit-apps": ["check-again", "choose-another-app"],
		"cannot-access-apis": ["check-again", "choose-another-app"],
		"api-cut-off": ["check-again", "choose-another-app"],
		"browser-only": ["check-again", "choose-another-app"],
		"cannot-read-organization": ["check-again", "choose-another-app"],
		"rate-limited": ["check-again", "go-to-apps"],
		"hq-unavailable": ["check-again", "go-to-apps"],
		"hq-gateway-refused": ["check-again", "go-to-apps"],
		"changed-while-reading": ["check-again", "go-to-apps"],
		"app-gone": ["choose-another-app", "go-to-apps"],
		"linked-app": ["choose-another-app", "go-to-apps"],
		"remote-app": ["choose-another-app", "go-to-apps"],
		"app-deleted": ["check-again", "choose-another-app"],
		"already-in-nova": ["choose-another-app", "check-again"],
	} satisfies Record<StopCircumstance, readonly StopAction["kind"][]>;

	it("has a row for every code that ends a read, and no other", () => {
		const stops = READ_CIRCUMSTANCES.filter(
			(code) => CIRCUMSTANCE_STANDINGS[code].standing === "stop",
		);
		expect(stops).toHaveLength(19);
		expect(Object.keys(STOP_ACTIONS).sort()).toEqual([...stops].sort());
	});

	for (const code of Object.keys(EXPECTED) as StopCircumstance[]) {
		it(`offers ${code} its actions in order`, () => {
			const finding = circumstanceFinding(code, { kind: "app" }, {});
			expect(STOP_ACTIONS[code](finding).map((action) => action.kind)).toEqual(
				EXPECTED[code],
			);
		});
	}

	it("offers Open for an app the person can open, and never for one held elsewhere", () => {
		const open: HqAppClaimDetail = {
			kind: "open",
			appId: "app-9",
			appName: "Household visits",
		};
		const elsewhere: HqAppClaimDetail = {
			kind: "elsewhere",
			at: "2026-11-01T00:00:00.000Z",
			contact: { role: "owners", names: ["Amara"] },
		};
		const openActions = STOP_ACTIONS["already-in-nova"](
			circumstanceFinding("already-in-nova", { kind: "app" }, { claim: open }),
		);
		expect(openActions).toEqual([
			{ kind: "open-app", appId: "app-9", appName: "Household visits" },
			{ kind: "choose-another-app" },
		]);
		const elsewhereActions = STOP_ACTIONS["already-in-nova"](
			circumstanceFinding(
				"already-in-nova",
				{ kind: "app" },
				{ claim: elsewhere },
			),
		);
		const kinds = elsewhereActions.map((action) => action.kind);
		expect(kinds).not.toContain("open-app");
	});

	it("labels every action with the shared action of its meaning", () => {
		const ACTIONS = {
			"open-settings": { kind: "open-settings" },
			"check-again": { kind: "check-again" },
			"choose-another-app": { kind: "choose-another-app" },
			"go-to-apps": { kind: "go-to-apps" },
			"open-app": {
				kind: "open-app",
				appId: "app-9",
				appName: "Household visits",
			},
		} satisfies {
			readonly [K in StopAction["kind"]]: Extract<StopAction, { kind: K }>;
		};
		const LABELS = {
			"open-settings": BRING_IN_ACTIONS.openSettings,
			"check-again": BRING_IN_ACTIONS.checkAgain,
			"choose-another-app": BRING_IN_ACTIONS.chooseAnotherApp,
			"go-to-apps": BRING_IN_ACTIONS.goToYourApps,
			"open-app": openAppAction("Household visits"),
		} satisfies Record<StopAction["kind"], string>;
		for (const kind of Object.keys(ACTIONS) as StopAction["kind"][]) {
			expect(stopActionLabel(ACTIONS[kind])).toBe(LABELS[kind]);
		}
	});
});

describe("accountStandings", () => {
	it("defines each label the account holds, past the listed limit too, in the labels' order", () => {
		expect(accountStandings({ notYet: 0, never: 0, fixInHq: 0 })).toEqual([]);
		expect(accountStandings({ notYet: 0, never: 3, fixInHq: 1 })).toEqual([
			"never",
			"fix-in-hq",
		]);
		expect(accountStandings({ notYet: 2, never: 0, fixInHq: 0 })).toEqual([
			"not-yet",
		]);
		const listedNone = account([], {
			more: 4,
			counts: { notYet: 0, never: 0, fixInHq: 4 },
		});
		expect(accountStandings(listedNone.counts)).toEqual(["fix-in-hq"]);
	});
});
