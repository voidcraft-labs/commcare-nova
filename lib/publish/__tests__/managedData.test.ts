/**
 * The words Nova says about data CommCare HQ manages. Every export is read
 * with each argument shape it names (one and several, present and absent),
 * every string it gives keeps the voice rules a machine can hold, and the
 * sentences that choose a form by their arguments choose the right one.
 */

import { describe, expect, it } from "vitest";
import * as copy from "../managedData";
import {
	appsThatReadIt,
	CHOICE_OTHER_PROJECT,
	choiceNotOffered,
	columnsBecomeText,
	managedColumnKept,
	managedLookupGuideLines,
	managedLookupTableRefusal,
	managedOrganizationCommitRefusal,
	managedPlacesKeptInUse,
	managedPlacesLeftOut,
	type NamedApp,
	organizationManagedRefusal,
	type ReviewChoice,
	reviewChoiceBody,
	reviewChoiceTitle,
} from "../managedData";

const intake: NamedApp = { appName: "Intake", deleted: false };
const followUp: NamedApp = { appName: "Follow-up", deleted: false };
const retired: NamedApp = { appName: "Old intake", deleted: true };

const offered = { offered: true } as const;

/** A label, a title or a button: one line, no full stop. */
type Kind = "sentence" | "label";

/**
 * Every export, read with each argument shape it names. The key is the
 * export's name, so a new export with no entry here fails the coverage test.
 */
const READINGS: Record<
	string,
	{ readonly kind: Kind; readonly texts: readonly (string | null)[] }
> = {
	MANAGED_TABLE_BADGE: { kind: "label", texts: [copy.MANAGED_TABLE_BADGE] },
	managedTableBanner: {
		kind: "sentence",
		texts: [copy.managedTableBanner("acme-health")],
	},
	managedTableBannerRefreshed: {
		kind: "sentence",
		texts: [copy.managedTableBannerRefreshed("November 3, 2026")],
	},
	REFRESH_FROM_HQ: { kind: "label", texts: [copy.REFRESH_FROM_HQ] },
	OPEN_IN_HQ: { kind: "label", texts: [copy.OPEN_IN_HQ] },
	MANAGE_IN_NOVA: { kind: "label", texts: [copy.MANAGE_IN_NOVA] },
	CONNECT_TO_REFRESH_TABLE: {
		kind: "label",
		texts: [copy.CONNECT_TO_REFRESH_TABLE],
	},
	managedTableGone: {
		kind: "sentence",
		texts: [copy.managedTableGone("districts", "acme-health")],
	},
	HOLDS_MORE_THAN_ONE_VALUE: {
		kind: "label",
		texts: [copy.HOLDS_MORE_THAN_ONE_VALUE],
	},
	holdsColumnNamed: {
		kind: "label",
		texts: [copy.holdsColumnNamed("2nd name")],
	},
	managedTableUnsupported: {
		kind: "sentence",
		texts: [
			copy.managedTableUnsupported(copy.HOLDS_MORE_THAN_ONE_VALUE),
			copy.managedTableUnsupported(copy.holdsColumnNamed("2nd name")),
		],
	},
	managedTableOverCap: {
		kind: "sentence",
		texts: [
			copy.managedTableOverCap(["6,000 rows (Nova takes 5,000)"]),
			copy.managedTableOverCap([
				"6,000 rows (Nova takes 5,000)",
				"300 columns (Nova takes 250)",
			]),
		],
	},
	managedLookupTableRefusal: {
		kind: "sentence",
		texts: [managedLookupTableRefusal("Districts", "acme-health")],
	},
	appsThatReadIt: {
		kind: "sentence",
		texts: [
			appsThatReadIt([intake]),
			appsThatReadIt([intake, followUp, retired]),
		],
	},
	manageInNovaTitle: {
		kind: "label",
		texts: [copy.manageInNovaTitle("Districts")],
	},
	manageInNovaBody: {
		kind: "sentence",
		texts: copy.manageInNovaBody("acme-health"),
	},
	MANAGE_IN_NOVA_CONFIRM: {
		kind: "label",
		texts: [copy.MANAGE_IN_NOVA_CONFIRM],
	},
	KEEP_IN_HQ: { kind: "label", texts: [copy.KEEP_IN_HQ] },
	managedInNovaBanner: {
		kind: "sentence",
		texts: [copy.managedInNovaBanner("acme-health")],
	},
	LET_HQ_MANAGE_AGAIN: { kind: "label", texts: [copy.LET_HQ_MANAGE_AGAIN] },
	letHqManageTitle: {
		kind: "label",
		texts: [copy.letHqManageTitle("Districts")],
	},
	letHqManageBody: {
		kind: "sentence",
		texts: [copy.letHqManageBody("acme-health")],
	},
	columnsBecomeText: {
		kind: "sentence",
		texts: [
			columnsBecomeText(["Population"]),
			columnsBecomeText(["Population", "Opened", "Rank"]),
		],
	},
	LET_HQ_MANAGE_CONFIRM: {
		kind: "label",
		texts: [copy.LET_HQ_MANAGE_CONFIRM],
	},
	KEEP_MANAGING_IN_NOVA: {
		kind: "label",
		texts: [copy.KEEP_MANAGING_IN_NOVA],
	},
	COLUMN_GONE_IN_HQ: { kind: "label", texts: [copy.COLUMN_GONE_IN_HQ] },
	MANAGED_TABLE_ALREADY_MATCHES: {
		kind: "sentence",
		texts: [copy.MANAGED_TABLE_ALREADY_MATCHES],
	},
	MANAGED_TABLE_REFRESHED_ROWS: {
		kind: "sentence",
		texts: [copy.MANAGED_TABLE_REFRESHED_ROWS],
	},
	MANAGED_TABLE_REFRESHED_COLUMNS: {
		kind: "sentence",
		texts: [copy.MANAGED_TABLE_REFRESHED_COLUMNS],
	},
	managedColumnKept: {
		kind: "sentence",
		texts: [
			managedColumnKept("region", [intake], "acme-health"),
			managedColumnKept("region", [intake, retired], "acme-health"),
		],
	},
	cannotReadManagedTables: {
		kind: "sentence",
		texts: [copy.cannotReadManagedTables("acme-health")],
	},
	HQ_UNAVAILABLE: { kind: "sentence", texts: [copy.HQ_UNAVAILABLE] },
	MANAGEMENT_NEEDS_ADMIN: {
		kind: "sentence",
		texts: [copy.MANAGEMENT_NEEDS_ADMIN],
	},
	REFRESH_NEEDS_EDITOR: {
		kind: "sentence",
		texts: [copy.REFRESH_NEEDS_EDITOR],
	},
	TABLE_TAKEN_OVER_MEANWHILE: {
		kind: "sentence",
		texts: [copy.TABLE_TAKEN_OVER_MEANWHILE],
	},
	managedTableUnrepresentable: {
		kind: "sentence",
		texts: [copy.managedTableUnrepresentable("notes")],
	},
	MANAGED_PLACES_LABEL: { kind: "label", texts: [copy.MANAGED_PLACES_LABEL] },
	managedPlacesBanner: {
		kind: "sentence",
		texts: [copy.managedPlacesBanner("acme-health", "November 3, 2026")],
	},
	managedPlacesLevelsNote: {
		kind: "sentence",
		texts: [copy.managedPlacesLevelsNote("acme-health")],
	},
	MANAGED_PLACES_NO_PERSONA: {
		kind: "sentence",
		texts: [copy.MANAGED_PLACES_NO_PERSONA],
	},
	MANAGED_PLACES_NO_EXTERNAL_IDS: {
		kind: "sentence",
		texts: [copy.MANAGED_PLACES_NO_EXTERNAL_IDS],
	},
	managedPlacesKeptInUse: {
		kind: "sentence",
		texts: [
			managedPlacesKeptInUse(["Kisumu"]),
			managedPlacesKeptInUse(["Kisumu", "Nakuru"]),
		],
	},
	organizationManagedRefusal: {
		kind: "sentence",
		texts: [organizationManagedRefusal("acme-health")],
	},
	managedPlacesLeftOut: {
		kind: "sentence",
		texts: [
			managedPlacesLeftOut({ ward: 1 }),
			managedPlacesLeftOut({ ward: 3, village: 1200 }),
		],
	},
	managedPlacesRefreshed: {
		kind: "sentence",
		texts: [copy.managedPlacesRefreshed(2, 0, 1)],
	},
	MANAGED_PLACES_ALREADY_MATCH: {
		kind: "sentence",
		texts: [copy.MANAGED_PLACES_ALREADY_MATCH],
	},
	managedPlacesOverLimit: {
		kind: "sentence",
		texts: [copy.managedPlacesOverLimit("acme-health", 12400)],
	},
	cannotReadManagedPlaces: {
		kind: "sentence",
		texts: [copy.cannotReadManagedPlaces("acme-health")],
	},
	managedPlaceNotHoldable: {
		kind: "sentence",
		texts: [copy.managedPlaceNotHoldable("Kisumu", "acme-health")],
	},
	managedOrganizationCommitRefusal: {
		kind: "sentence",
		texts: [
			managedOrganizationCommitRefusal(
				{ kind: "level-in-use", levels: ["Ward"] },
				"acme-health",
			),
			managedOrganizationCommitRefusal(
				{ kind: "level-in-use", levels: ["Ward", "Village"] },
				"acme-health",
			),
			managedOrganizationCommitRefusal(
				{ kind: "placement", place: "Kisumu" },
				"acme-health",
			),
			managedOrganizationCommitRefusal(
				{
					kind: "value",
					place: "Kisumu",
					issue: "Its Population value isn't a whole number.",
				},
				"acme-health",
			),
		],
	},
	CONNECT_TO_REFRESH_PLACES: {
		kind: "label",
		texts: [copy.CONNECT_TO_REFRESH_PLACES],
	},
	MANAGED_DATA_PASSED: { kind: "sentence", texts: [copy.MANAGED_DATA_PASSED] },
	MANAGED_DATA_CHANGED: {
		kind: "sentence",
		texts: [copy.MANAGED_DATA_CHANGED],
	},
	managedDataUnreadablePermission: {
		kind: "sentence",
		texts: [copy.managedDataUnreadablePermission("acme-health")],
	},
	managedDataUnreadable: {
		kind: "sentence",
		texts: [copy.managedDataUnreadable("acme-health")],
	},
	managedTableRowsUnreadable: {
		kind: "sentence",
		texts: [copy.managedTableRowsUnreadable("districts", "acme-health")],
	},
	managedColumnGoneItem: {
		kind: "sentence",
		texts: [
			copy.managedColumnGoneItem("region", "districts", 1),
			copy.managedColumnGoneItem("region", "districts", 4),
		],
	},
	managedTableGoneItem: {
		kind: "sentence",
		texts: [copy.managedTableGoneItem("districts")],
	},
	managedTableUnsupportedItem: {
		kind: "sentence",
		texts: [copy.managedTableUnsupportedItem("districts", "field properties")],
	},
	managedTableManyValuesItem: {
		kind: "sentence",
		texts: [copy.managedTableManyValuesItem("districts")],
	},
	managedTableOverCapItem: {
		kind: "sentence",
		texts: [
			copy.managedTableOverCapItem("districts", [
				"6,000 rows (Nova takes 5,000)",
			]),
			copy.managedTableOverCapItem("districts", [
				"6,000 rows (Nova takes 5,000)",
				"9 MB of rows (Nova takes 8 MB in one table)",
			]),
		],
	},
	managedTableNameItem: {
		kind: "sentence",
		texts: [copy.managedTableNameItem("districts", "2nd name")],
	},
	managedTableFromElsewhereItem: {
		kind: "sentence",
		texts: [
			copy.managedTableFromElsewhereItem(
				"districts",
				"acme-west",
				"November 3, 2026",
				"acme-health",
			),
		],
	},
	managedTablesLeftOut: {
		kind: "sentence",
		texts: [
			copy.managedTablesLeftOut(["districts"], "acme-health"),
			copy.managedTablesLeftOut(["districts", "clinics"], "acme-health"),
		],
	},
	HAND_BACK_OFFERED: { kind: "sentence", texts: [copy.HAND_BACK_OFFERED] },
	managedPlacesPassed: {
		kind: "sentence",
		texts: [copy.managedPlacesPassed("acme-health")],
	},
	MANAGED_PLACES_NOT_REFRESHED: {
		kind: "sentence",
		texts: [copy.MANAGED_PLACES_NOT_REFRESHED],
	},
	managedTableUnrepresentableItem: {
		kind: "sentence",
		texts: [copy.managedTableUnrepresentableItem("notes", "districts")],
	},
	MANAGED_TABLE_HANDED_BACK: {
		kind: "sentence",
		texts: [copy.MANAGED_TABLE_HANDED_BACK],
	},
	MANAGED_TABLE_HANDED_BACK_AFTER_CREATE: {
		kind: "sentence",
		texts: [copy.MANAGED_TABLE_HANDED_BACK_AFTER_CREATE],
	},
	MANAGED_LOOKUP_GUIDE_TITLE: {
		kind: "label",
		texts: [copy.MANAGED_LOOKUP_GUIDE_TITLE],
	},
	reviewManagedTables: {
		kind: "sentence",
		texts: [
			copy.reviewManagedTables(["districts"], "acme-health"),
			copy.reviewManagedTables(["districts", "clinics"], "acme-health"),
		],
	},
	reviewSameEqualTable: {
		kind: "sentence",
		texts: [
			copy.reviewSameEqualTable("districts", "Kenya rollout", "acme-health"),
		],
	},
	reviewMediaLeftOut: {
		kind: "sentence",
		texts: [copy.reviewMediaLeftOut(1), copy.reviewMediaLeftOut(3)],
	},
	reviewMediaAdded: {
		kind: "sentence",
		texts: [
			copy.reviewMediaAdded(1, "Kenya rollout"),
			copy.reviewMediaAdded(1200, "Kenya rollout"),
		],
	},
	reviewManagedPlaces: {
		kind: "sentence",
		texts: [
			copy.reviewManagedPlaces(1, "acme-health"),
			copy.reviewManagedPlaces(340, "acme-health"),
		],
	},
	reviewChoiceTitle: {
		kind: "label",
		texts: [
			reviewChoiceTitle("districts", "Kenya rollout", { differs: ["rows"] }),
			reviewChoiceTitle("districts", "Kenya rollout", { differs: [] }),
		],
	},
	reviewChoiceBody: {
		kind: "sentence",
		texts: [
			reviewChoiceBody("districts", "Kenya rollout", "acme-health", {
				differs: ["columns", "rows"],
				apps: [intake],
				options: { "use-commcare-hq": offered, "use-project": offered },
			}),
		],
	},
	HQ_TABLE_ANSWER: { kind: "label", texts: [copy.HQ_TABLE_ANSWER] },
	hqTableAnswerConsequence: {
		kind: "sentence",
		texts: [
			copy.hqTableAnswerConsequence("Kenya rollout", "districts", []),
			copy.hqTableAnswerConsequence("Kenya rollout", "districts", [intake]),
			copy.hqTableAnswerConsequence("Kenya rollout", "districts", [
				intake,
				followUp,
			]),
		],
	},
	hqTableAnswerGoneColumns: {
		kind: "sentence",
		texts: [
			copy.hqTableAnswerGoneColumns([intake], ["region"]),
			copy.hqTableAnswerGoneColumns([intake, followUp], ["region", "zone"]),
		],
	},
	projectTableAnswer: {
		kind: "label",
		texts: [copy.projectTableAnswer("Kenya rollout")],
	},
	projectTableAnswerConsequence: {
		kind: "sentence",
		texts: [copy.projectTableAnswerConsequence("Kenya rollout", "acme-health")],
	},
	choiceNotOffered: {
		kind: "sentence",
		texts: [
			choiceNotOffered(
				{ offered: false, why: "needs-admin", name: null },
				"Kenya rollout",
			),
			choiceNotOffered(
				{ offered: false, why: "managed-elsewhere", name: "acme-west" },
				"Kenya rollout",
			),
			choiceNotOffered(
				{
					offered: false,
					why: "app-reads-a-missing-column",
					name: "region",
				},
				"Kenya rollout",
			),
			choiceNotOffered(
				{ offered: false, why: "fails-a-project-space-rule", name: null },
				"Kenya rollout",
			),
		],
	},
	CHOICE_OTHER_PROJECT: { kind: "sentence", texts: [CHOICE_OTHER_PROJECT] },
	MEDIA_CHECKED_LATER: { kind: "sentence", texts: [copy.MEDIA_CHECKED_LATER] },
};

/** Exports that are lines of a file, held by their own test below. */
const LINES = new Set(["managedLookupGuideLines"]);

describe("every export keeps Nova's voice", () => {
	it("is read here, so no export goes unchecked", () => {
		const exported = Object.keys(copy).filter((name) => !LINES.has(name));
		expect(exported.sort()).toEqual(Object.keys(READINGS).sort());
	});

	for (const [name, { kind, texts }] of Object.entries(READINGS)) {
		it(`${name} gives text a person can read`, () => {
			expect(texts.length).toBeGreaterThan(0);
			for (const text of texts) {
				expect(text).not.toBeNull();
				const line = text ?? "";
				expect(line.trim()).toBe(line);
				expect(line.length).toBeGreaterThan(0);
				expect(line).not.toMatch(/[—–…{}]|\.\.\.|\bundefined\b|\bnull\b|\s{2}/);
				if (kind === "sentence") expect(line).toMatch(/[.?]$/);
				else expect(line).not.toMatch(/\.$/);
			}
		});
	}
});

describe("the forms a sentence chooses by its arguments", () => {
	it("joins the levels O14 names and makes the verb agree", () => {
		expect(
			managedOrganizationCommitRefusal(
				{ kind: "level-in-use", levels: ["Ward"] },
				"acme-health",
			),
		).toBe(
			"Ward still has places in it, and this app's places are managed in CommCare HQ (acme-health). You can move those places to another level there and refresh, then remove the level.",
		);
		expect(
			managedOrganizationCommitRefusal(
				{ kind: "level-in-use", levels: ["Ward", "Village", "Zone"] },
				"acme-health",
			),
		).toBe(
			"Ward, Village and Zone still have places in them, and this app's places are managed in CommCare HQ (acme-health). You can move those places to another level there and refresh, then remove the levels.",
		);
	});

	it("carries O16's issue between its two sentences", () => {
		expect(
			managedOrganizationCommitRefusal(
				{
					kind: "value",
					place: "Kisumu",
					issue: "Its Population value isn't a whole number.",
				},
				"acme-health",
			),
		).toBe(
			"Kisumu blocks this change. Its Population value isn't a whole number. This app's places are managed in CommCare HQ (acme-health), so you can change that value there and refresh, then try the change again.",
		);
	});

	it("names the table and the project space bare in the two write refusals", () => {
		expect(managedLookupTableRefusal("Districts", "acme-health")).toBe(
			"The lookup table Districts is managed in CommCare HQ (acme-health), so Nova can't change it here. You can change it in CommCare HQ and refresh Nova's copy, or choose Manage in Nova on the table's page.",
		);
		expect(organizationManagedRefusal("acme-health")).toBe(
			"This app's places are managed in CommCare HQ (acme-health), so Nova can't change them here. You can change them in CommCare HQ, then refresh Nova's copy in Organization.",
		);
	});

	it("leaves out a line with nothing to name", () => {
		expect(appsThatReadIt([])).toBeNull();
		expect(columnsBecomeText([])).toBeNull();
		expect(managedPlacesLeftOut({})).toBeNull();
		expect(copy.hqTableAnswerGoneColumns([intake], [])).toBeNull();
	});

	it("says where an app in the trash is, and counts one app as one", () => {
		expect(appsThatReadIt([intake])).toBe("One app reads it: Intake.");
		expect(appsThatReadIt([intake, retired])).toBe(
			"These apps read it: Intake and Old intake (in the trash).",
		);
	});

	it("makes T16 agree with the apps that read the kept column", () => {
		expect(managedColumnKept("region", [intake], "acme-health")).toBe(
			"CommCare HQ no longer has the column region, and Intake still reads it. Nova kept the column, with no values, so that app keeps opening. Its next publish to acme-health stops until the column is back in CommCare HQ or it stops reading it.",
		);
		expect(managedColumnKept("region", [intake, followUp], "acme-health")).toBe(
			"CommCare HQ no longer has the column region, and Intake and Follow-up still read it. Nova kept the column, with no values, so those apps keep opening. Their next publish to acme-health stops until the column is back in CommCare HQ or they stop reading it.",
		);
		expect(() => managedColumnKept("region", [], "acme-health")).toThrow(
			/none was given/,
		);
	});

	it("counts the places of O6 and O8 and spells a count with its separator", () => {
		expect(managedPlacesKeptInUse(["Kisumu"])).toBe(
			"1 place is gone from CommCare HQ, and a persona or an owner rule still uses it: Kisumu. Nova kept it. You can move those personas or rules, then refresh again.",
		);
		expect(managedPlacesLeftOut({ ward: 1 })).toBe(
			"1 place in CommCare HQ sits at a level this app doesn't have (ward), so Nova's copy leaves it out. You can add a level with that code, then refresh.",
		);
		expect(managedPlacesLeftOut({ ward: 3, village: 1200 })).toBe(
			"1,203 places in CommCare HQ sit at a level this app doesn't have (ward and village), so Nova's copy leaves them out. You can add a level for each of those codes, then refresh.",
		);
		expect(copy.managedPlacesOverLimit("acme-health", 12400)).toBe(
			"acme-health now has 12,400 places, and Nova holds up to 10,000 for an app. Nova kept its copy as it was.",
		);
		// A list that named no total stopped once it passed the limit.
		expect(copy.managedPlacesOverLimit("acme-health", null)).toBe(
			"acme-health now has more than 10,000 places, and Nova holds up to 10,000 for an app. Nova kept its copy as it was.",
		);
	});

	it("joins the caps' phrases with and", () => {
		expect(
			copy.managedTableOverCap([
				"6,000 rows (Nova takes 5,000)",
				"300 columns (Nova takes 250)",
			]),
		).toBe(
			"This table now has 6,000 rows (Nova takes 5,000) and 300 columns (Nova takes 250) in CommCare HQ. Nova kept its copy as it was.",
		);
	});

	it("makes T6's holds for a name and for many values", () => {
		expect(
			copy.managedTableUnsupported(copy.holdsColumnNamed("2nd name")),
		).toBe(
			"This table now holds a column named 2nd name in CommCare HQ, which Nova can't hold yet. Nova kept its copy as it was.",
		);
		expect(copy.managedTableUnsupported(copy.HOLDS_MORE_THAN_ONE_VALUE)).toBe(
			"This table now holds a field with more than one value in CommCare HQ, which Nova can't hold yet. Nova kept its copy as it was.",
		);
	});
});

describe("the review's choice about a table that meets a Project table", () => {
	const base: ReviewChoice = {
		differs: [],
		apps: [intake, followUp],
		options: { "use-commcare-hq": offered, "use-project": offered },
	};

	it("draws R6's title by whether the tables differ", () => {
		expect(
			reviewChoiceTitle("districts", "Kenya rollout", { differs: ["columns"] }),
		).toBe("districts is already in Kenya rollout, and it's different");
		expect(
			reviewChoiceTitle("districts", "Kenya rollout", { differs: [] }),
		).toBe("districts is already in Kenya rollout");
	});

	it("draws R7's first form for tables that differ, naming what differs", () => {
		const lead =
			"This app reads the lookup table districts from acme-health. Kenya rollout already has a table by that name with";
		expect(
			reviewChoiceBody("districts", "Kenya rollout", "acme-health", {
				...base,
				differs: ["rows", "columns"],
			}),
		).toBe(`${lead} different columns and rows, read by Intake and Follow-up.`);
		expect(
			reviewChoiceBody("districts", "Kenya rollout", "acme-health", {
				...base,
				differs: ["columns"],
			}),
		).toBe(`${lead} different columns, read by Intake and Follow-up.`);
		expect(
			reviewChoiceBody("districts", "Kenya rollout", "acme-health", {
				...base,
				differs: ["rows"],
				apps: [],
			}),
		).toBe(`${lead} different rows.`);
	});

	it("draws R7's second form for an equal table Nova manages, open to the person", () => {
		expect(
			reviewChoiceBody("districts", "Kenya rollout", "acme-health", base),
		).toBe(
			"This app reads the lookup table districts from acme-health. Kenya rollout already has a table by that name with the same columns and rows, managed in Nova and read by Intake and Follow-up. No app of Kenya rollout publishes it to acme-health yet, so it's yours to say which one this app uses.",
		);
		expect(
			reviewChoiceBody("districts", "Kenya rollout", "acme-health", {
				...base,
				apps: [],
			}),
		).toBe(
			"This app reads the lookup table districts from acme-health. Kenya rollout already has a table by that name with the same columns and rows, managed in Nova. No app of Kenya rollout publishes it to acme-health yet, so it's yours to say which one this app uses.",
		);
	});

	it("drops R7's last sentence where the Project's table fails a project space rule", () => {
		expect(
			reviewChoiceBody("districts", "Kenya rollout", "acme-health", {
				...base,
				options: {
					"use-commcare-hq": offered,
					"use-project": {
						offered: false,
						why: "fails-a-project-space-rule",
						name: null,
					},
				},
			}),
		).toBe(
			"This app reads the lookup table districts from acme-health. Kenya rollout already has a table by that name with the same columns and rows, managed in Nova and read by Intake and Follow-up.",
		);
	});

	it("keeps R7's last sentence where use-project is refused for another reason", () => {
		expect(
			reviewChoiceBody("districts", "Kenya rollout", "acme-health", {
				...base,
				options: {
					"use-commcare-hq": { offered: false, why: "needs-admin", name: null },
					"use-project": {
						offered: false,
						why: "app-reads-a-missing-column",
						name: "region",
					},
				},
			}),
		).toMatch(/so it's yours to say which one this app uses\.$/);
	});

	it("draws R7's third form for an equal table managed from another project space", () => {
		const elsewhere = {
			...base,
			options: {
				"use-commcare-hq": {
					offered: false,
					why: "managed-elsewhere",
					name: "acme-west",
				},
				"use-project": offered,
			},
		} as const;
		expect(
			reviewChoiceBody("districts", "Kenya rollout", "acme-health", elsewhere),
		).toBe(
			"This app reads the lookup table districts from acme-health. Kenya rollout already has a table by that name with the same columns and rows, managed in CommCare HQ from acme-west and read by Intake and Follow-up.",
		);
		expect(
			reviewChoiceBody("districts", "Kenya rollout", "acme-health", {
				...elsewhere,
				apps: [],
			}),
		).toBe(
			"This app reads the lookup table districts from acme-health. Kenya rollout already has a table by that name with the same columns and rows, managed in CommCare HQ from acme-west.",
		);
	});

	it("words each reason an answer is not offered, and refuses a reason with its name missing", () => {
		expect(
			choiceNotOffered(
				{ offered: false, why: "managed-elsewhere", name: "acme-west" },
				"Kenya rollout",
			),
		).toBe(
			"Kenya rollout's table is managed in CommCare HQ (acme-west), so it can't follow two project spaces.",
		);
		expect(
			choiceNotOffered(
				{ offered: false, why: "app-reads-a-missing-column", name: "region" },
				"Kenya rollout",
			),
		).toBe(
			"This app reads the column region, which Kenya rollout's table doesn't have.",
		);
		expect(() =>
			choiceNotOffered(
				{ offered: false, why: "managed-elsewhere", name: null },
				"Kenya rollout",
			),
		).toThrow(/names nothing/);
	});

	it("makes R8's lines agree and drops the apps where none reads the table", () => {
		expect(
			copy.hqTableAnswerConsequence("Kenya rollout", "districts", []),
		).toBe(
			"Kenya rollout's districts takes CommCare HQ's columns and rows and becomes managed in CommCare HQ. Nova keeps it read-only until someone chooses Manage in Nova.",
		);
		expect(
			copy.hqTableAnswerConsequence("Kenya rollout", "districts", [intake]),
		).toBe(
			"Kenya rollout's districts takes CommCare HQ's columns and rows and becomes managed in CommCare HQ. Intake will read CommCare HQ's rows from then on, and Nova keeps it read-only until someone chooses Manage in Nova.",
		);
		expect(copy.hqTableAnswerGoneColumns([intake], ["region"])).toBe(
			"Intake reads the column region, which CommCare HQ's table doesn't have. It stays, with no values.",
		);
		expect(
			copy.hqTableAnswerGoneColumns([intake, followUp], ["region", "zone"]),
		).toBe(
			"Intake and Follow-up read the columns region and zone, which CommCare HQ's table doesn't have. They stay, with no values.",
		);
		expect(() => copy.hqTableAnswerGoneColumns([], ["region"])).toThrow(
			/no app was given/,
		);
	});
});

describe("the HQ app file's guide to the tables CommCare HQ manages", () => {
	const tables = [
		{ tag: "districts", domain: "acme-health", refreshedOn: "2026-11-03" },
		{ tag: "clinics", domain: "acme-health", refreshedOn: "2026-11-04" },
	];
	const workbook = "lookup-tables-managed-in-commcare-hq.xlsx";

	it("lists each table, names the second file, and points at the step above", () => {
		expect(managedLookupGuideLines(tables, workbook, true)).toEqual([
			"These tables are managed in CommCare HQ, and Nova only keeps a copy:",
			"  districts (in acme-health, copied on 2026-11-03)",
			"  clinics (in acme-health, copied on 2026-11-04)",
			"",
			"If you're importing into that project space, it already has them, so leave",
			'"lookup-tables-managed-in-commcare-hq.xlsx" out. Uploading it there would',
			"replace their rows with Nova's copy.",
			"",
			"For any other project space, upload it on the Lookup Tables page too, the",
			"same way as the file above.",
		]);
	});

	it("says how to upload it where no step above carries a first file", () => {
		const lines = managedLookupGuideLines(tables, workbook, false);
		expect(lines.slice(-5)).toEqual([
			"For any other project space, open the Lookup Tables page in CommCare HQ:",
			"  https://www.commcarehq.org/a/<your-project>/fixtures/",
			"",
			'Upload "lookup-tables-managed-in-commcare-hq.xlsx" there, tick "Replace existing',
			'tables", and click Upload Tables.',
		]);
		expect(lines.join("\n")).not.toMatch(/above|[—…]/);
	});
});
