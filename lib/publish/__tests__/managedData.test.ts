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
	managedPlacesKeptLeftOut,
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
	LOOKUP_DISCARD_NOTE: {
		kind: "sentence",
		texts: [copy.LOOKUP_DISCARD_NOTE],
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
	MANAGED_TABLE_REFRESHED_SINCE: {
		kind: "sentence",
		texts: [copy.MANAGED_TABLE_REFRESHED_SINCE],
	},
	HAND_BACK_OVERTAKEN: {
		kind: "sentence",
		texts: [copy.HAND_BACK_OVERTAKEN],
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
	MANAGEMENT_REVIEW_MOVED: {
		kind: "sentence",
		texts: [copy.MANAGEMENT_REVIEW_MOVED],
	},
	handBackWhilePublishing: {
		kind: "sentence",
		texts: [copy.handBackWhilePublishing("acme-health")],
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
	managedPlacesRemade: {
		kind: "sentence",
		texts: [
			copy.managedPlacesRemade(["Mercy Clinic"]),
			copy.managedPlacesRemade(["Mercy Clinic", "Old Post"]),
		],
	},
	managedPlacesKeptLeftOut: {
		kind: "sentence",
		texts: [
			managedPlacesKeptLeftOut(["Mercy Clinic"]),
			managedPlacesKeptLeftOut(["Mercy Clinic", "Old Post"]),
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
	MANAGED_PLACES_REFRESHED_SINCE: {
		kind: "sentence",
		texts: [copy.MANAGED_PLACES_REFRESHED_SINCE],
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
			managedOrganizationCommitRefusal(
				{ kind: "level-in-use", levels: ["Ward"], kept: true },
				"acme-health",
			),
			managedOrganizationCommitRefusal(
				{ kind: "placement", place: "Kisumu", kept: true },
				"acme-health",
			),
			managedOrganizationCommitRefusal(
				{
					kind: "value",
					place: "Kisumu",
					issue: "Its Population value isn't a whole number.",
					kept: true,
				},
				"acme-health",
			),
			managedOrganizationCommitRefusal(
				{
					kind: "owner-none-below",
					level: "Facility",
					source: "Riverside",
					sourceKept: false,
				},
				"acme-health",
			),
			managedOrganizationCommitRefusal(
				{
					kind: "owner-none-below",
					level: "Facility",
					source: "Riverside",
					sourceKept: true,
				},
				"acme-health",
			),
			managedOrganizationCommitRefusal(
				{
					kind: "owner-ambiguous",
					level: "Facility",
					source: "Riverside",
					places: ["Mercy Clinic", "Hope Clinic"],
					kept: null,
				},
				"acme-health",
			),
			managedOrganizationCommitRefusal(
				{
					kind: "owner-ambiguous",
					level: "Facility",
					source: "Riverside",
					places: ["Mercy Clinic", "Hope Clinic"],
					kept: "Mercy Clinic",
				},
				"acme-health",
			),
		],
	},
	managedPlacesRefreshRefusal: {
		kind: "sentence",
		texts: [
			copy.managedPlacesRefreshRefusal(
				{ kind: "placement", place: "Kisumu" },
				"acme-health",
			),
			copy.managedPlacesRefreshRefusal(
				{
					kind: "value",
					place: "Kisumu",
					issue: '"Beds" is required for places at this level.',
				},
				"acme-health",
			),
			copy.managedPlacesRefreshRefusal(
				{ kind: "kept", place: "Kisumu" },
				"acme-health",
			),
			copy.managedPlacesRefreshRefusal(
				{
					kind: "owner-none-below",
					level: "Facility",
					source: "Kisumu",
					sourceKept: false,
				},
				"acme-health",
			),
			copy.managedPlacesRefreshRefusal(
				{
					kind: "owner-none-below",
					level: "Facility",
					source: "Kisumu",
					sourceKept: true,
				},
				"acme-health",
			),
			copy.managedPlacesRefreshRefusal(
				{
					kind: "owner-ambiguous",
					level: "Facility",
					source: "Kisumu",
					places: ["North clinic", "South clinic"],
					kept: null,
				},
				"acme-health",
			),
			copy.managedPlacesRefreshRefusal(
				{
					kind: "owner-ambiguous",
					level: "Facility",
					source: "Kisumu",
					places: ["North clinic", "South clinic"],
					kept: "South clinic",
				},
				"acme-health",
			),
			copy.managedPlacesRefreshRefusal(
				{
					kind: "owner-outside-address-book",
					level: "Facility",
					place: "North clinic",
					persona: "Asha",
				},
				"acme-health",
			),
		],
	},
	CONNECT_TO_REFRESH_PLACES: {
		kind: "label",
		texts: [copy.CONNECT_TO_REFRESH_PLACES],
	},
	managedDataPassed: {
		kind: "sentence",
		texts: [
			copy.managedDataPassed({ domain: "acme-health", here: 2, elsewhere: 0 }),
			copy.managedDataPassed({ domain: "acme-health", here: 1, elsewhere: 1 }),
			copy.managedDataPassed({ domain: "acme-health", here: 0, elsewhere: 1 }),
			copy.managedDataPassed({ domain: "acme-health", here: 0, elsewhere: 2 }),
		],
	},
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
	MANAGED_TABLE_NO_COLUMNS: {
		kind: "sentence",
		texts: [copy.MANAGED_TABLE_NO_COLUMNS],
	},
	managedTableNoColumnsItem: {
		kind: "sentence",
		texts: [copy.managedTableNoColumnsItem("districts")],
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
	managedTableFromElsewhereCurrentItem: {
		kind: "sentence",
		texts: [
			copy.managedTableFromElsewhereCurrentItem(
				"districts",
				"acme-west",
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
		texts: [
			copy.managedPlacesPassed("acme-health", true),
			copy.managedPlacesPassed("acme-health", false),
		],
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
	managedLookupGuideTitle: {
		kind: "label",
		texts: [false, true].map((several) =>
			copy.managedLookupGuideTitle(
				{
					fileName: "lookup-tables-managed-in-acme-health.xlsx",
					projectSpace: "acme-health",
					tables: [{ tag: "districts", refreshedOn: "2026-11-03" }],
				},
				several,
			),
		),
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
			choiceNotOffered(
				{ offered: false, why: "too-many-columns", name: "312" },
				"Kenya rollout",
			),
		],
	},
	CHOICE_OTHER_PROJECT: { kind: "sentence", texts: [CHOICE_OTHER_PROJECT] },
	MEDIA_CHECKED_LATER: { kind: "sentence", texts: [copy.MEDIA_CHECKED_LATER] },
};

/**
 * Exports that assemble lines out of the exports read here: the HQ app file's
 * guide, held by its own test below, and what is said after a table action
 * or a refresh of places, held by the banners' models' tests
 * (`projectDataModel.test.ts`, `organizationUi.test.ts`).
 */
const LINES = new Set([
	"managedLookupGuideLines",
	"managedTableOutcomeLines",
	"managedPlacesOutcomeLines",
]);

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
	it("joins the levels a removed-level refusal names and makes the verb agree", () => {
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

	it("sends a place CommCare HQ no longer has to what uses it, in the kept forms of the commit refusals", () => {
		expect(
			managedOrganizationCommitRefusal(
				{ kind: "placement", place: '"Mercy Clinic"', kept: true },
				"acme-health",
			),
		).toBe(
			'"Mercy Clinic" wouldn\'t fit where it stands after this level change. CommCare HQ (acme-health) no longer has it, and Nova keeps it only while something in this app uses it or a place below it. You can move or change what uses it and refresh, then try the change again.',
		);
		expect(
			managedOrganizationCommitRefusal(
				{ kind: "level-in-use", levels: ["Ward", "Village"], kept: true },
				"acme-health",
			),
		).toBe(
			"Ward and Village still have places in them that CommCare HQ (acme-health) no longer has, and Nova keeps them only while something in this app uses them or a place below them. You can move or change what uses them and refresh, then remove the levels.",
		);
	});

	it("words an owner rule's source refusals with a step a managed copy takes", () => {
		expect(
			managedOrganizationCommitRefusal(
				{
					kind: "owner-none-below",
					level: "Facility",
					source: "Riverside",
					sourceKept: false,
				},
				"acme-health",
			),
		).toBe(
			'The owner rule for Facility needs exactly one live facility below "Riverside", and this app\'s places are managed in CommCare HQ (acme-health), which has none there. You can add one there and refresh, or change the rule.',
		);
		expect(
			managedOrganizationCommitRefusal(
				{
					kind: "owner-ambiguous",
					level: "Facility",
					source: "Riverside",
					places: ["Mercy Clinic", "Hope Clinic"],
					kept: "Mercy Clinic",
				},
				"acme-health",
			),
		).toBe(
			'The owner rule for Facility needs exactly one live facility below "Riverside", and both "Mercy Clinic" and "Hope Clinic" stand there. CommCare HQ (acme-health) no longer has "Mercy Clinic", and Nova keeps it only while something in this app uses it or a place below it. You can move or change what uses it and refresh, or change the rule.',
		);
	});

	it("carries a value refusal's issue between its two sentences", () => {
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

	it("makes the kept-column line agree with the apps that read the kept column", () => {
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

	it("counts the kept, left-out and kept-left-out places and spells a count with its separator", () => {
		expect(managedPlacesKeptInUse(["Kisumu"])).toBe(
			"1 place is gone from CommCare HQ, and a persona, an owner rule or an automation still uses it: Kisumu. Nova kept it. You can move or change what uses it, then refresh again.",
		);
		expect(managedPlacesLeftOut({ ward: 1 })).toBe(
			"1 place in CommCare HQ sits at a level this app doesn't have (ward), so Nova's copy leaves it out. Where this app uses it, Nova keeps it as it stood before. You can add a level with that code, then refresh.",
		);
		expect(managedPlacesLeftOut({ ward: 3, village: 1200 })).toBe(
			"1,203 places in CommCare HQ sit at a level this app doesn't have (ward and village), so Nova's copy leaves them out. Where this app uses one of them, Nova keeps that place as it stood before. You can add a level for each of those codes, then refresh.",
		);
		expect(managedPlacesKeptLeftOut(["Mercy Clinic"])).toBe(
			"1 place in CommCare HQ sits at a level this app doesn't have, and a persona, an owner rule or an automation still uses it: Mercy Clinic. Nova kept it as it stood before. You can add that level, or move or change what uses it, then refresh again.",
		);
		expect(managedPlacesKeptLeftOut(["Mercy Clinic", "Old Post"])).toBe(
			"2 places in CommCare HQ sit at a level this app doesn't have, and a persona, an owner rule or an automation still uses them: Mercy Clinic and Old Post. Nova kept them as they stood before. You can add the levels they sit at, or move or change what uses them, then refresh again.",
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

	it("makes the unsupported refresh's holds for a name and for many values", () => {
		expect(
			copy.managedTableUnsupported(copy.holdsColumnNamed("2nd name")),
		).toBe(
			"This table now holds a column named 2nd name in CommCare HQ, which Nova can't hold yet. Nova kept its copy as it was.",
		);
		expect(copy.managedTableUnsupported(copy.HOLDS_MORE_THAN_ONE_VALUE)).toBe(
			"This table now holds a field with more than one value in CommCare HQ, which Nova can't hold yet. Nova kept its copy as it was.",
		);
	});

	it("says the passed managed-data check sends none only of the tables the target manages", () => {
		expect(
			copy.managedDataPassed({ domain: "acme-health", here: 2, elsewhere: 0 }),
		).toBe(
			"Nova checked the lookup tables CommCare HQ manages for this app. Nothing this app reads is missing, and Nova sends none of them.",
		);
		expect(
			copy.managedDataPassed({ domain: "acme-health", here: 1, elsewhere: 1 }),
		).toBe(
			"Nova checked the lookup tables CommCare HQ manages for this app. Nothing this app reads is missing in acme-health, and Nova sends none of the tables acme-health manages.",
		);
		expect(
			copy.managedDataPassed({ domain: "acme-health", here: 0, elsewhere: 1 }),
		).toBe(
			"Nova checked the lookup table CommCare HQ manages for this app. Another project space manages it, so this publish puts Nova's copy in acme-health.",
		);
		expect(
			copy.managedDataPassed({ domain: "acme-health", here: 0, elsewhere: 3 }),
		).not.toMatch(/sends none/);
	});

	it("makes the passed project-data check agree with the tables it names", () => {
		expect(copy.managedTablesLeftOut(["districts"], "acme-health")).toBe(
			"CommCare HQ manages districts in acme-health, so Nova leaves it as it is.",
		);
		expect(
			copy.managedTablesLeftOut(["districts", "clinics"], "acme-health"),
		).toBe(
			"CommCare HQ manages districts and clinics in acme-health, so Nova leaves them as they are.",
		);
	});

	it("says the passed organization check refreshed the places only where it did", () => {
		expect(copy.managedPlacesPassed("acme-health", true)).toBe(
			"acme-health manages this app's places. Nova refreshed its copy and sends none.",
		);
		expect(copy.managedPlacesPassed("acme-health", false)).toBe(
			"acme-health manages this app's places, and Nova sends none.",
		);
	});
});

describe("the review's choice about a table that meets a Project table", () => {
	const base: ReviewChoice = {
		differs: [],
		apps: [intake, followUp],
		options: { "use-commcare-hq": offered, "use-project": offered },
	};

	it("draws the choice's title by whether the tables differ", () => {
		expect(
			reviewChoiceTitle("districts", "Kenya rollout", { differs: ["columns"] }),
		).toBe("districts is already in Kenya rollout, and it's different");
		expect(
			reviewChoiceTitle("districts", "Kenya rollout", { differs: [] }),
		).toBe("districts is already in Kenya rollout");
	});

	it("draws the choice body's first form for tables that differ, naming what differs", () => {
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

	it("draws the choice body's second form for an equal table Nova manages, open to the person", () => {
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

	it("drops the choice body's last sentence where the Project's table fails a project space rule", () => {
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

	it("keeps the choice body's last sentence where use-project is refused for another reason", () => {
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

	it("draws the choice body's third form for an equal table managed from another project space", () => {
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
		expect(
			choiceNotOffered(
				{ offered: false, why: "too-many-columns", name: "1,312" },
				"Kenya rollout",
			),
		).toBe(
			"Kenya rollout's table would have 1,312 columns with the ones its apps still read, and Nova takes 250.",
		);
		expect(() =>
			choiceNotOffered(
				{ offered: false, why: "managed-elsewhere", name: null },
				"Kenya rollout",
			),
		).toThrow(/names nothing/);
	});

	it("makes the first answer's lines agree and drops the apps where none reads the table", () => {
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
	const file = {
		fileName: "lookup-tables-managed-in-acme-health.xlsx",
		projectSpace: "acme-health",
		tables: [
			{ tag: "districts", refreshedOn: "2026-11-03" },
			{ tag: "clinics", refreshedOn: "2026-11-04" },
		],
	};

	it("lists each table, names the file, and points at the step above", () => {
		expect(
			managedLookupGuideLines(file, { several: false, afterUploadStep: true }),
		).toEqual([
			"These tables are managed in CommCare HQ, and Nova only keeps a copy:",
			"  districts (in acme-health, copied on 2026-11-03)",
			"  clinics (in acme-health, copied on 2026-11-04)",
			"",
			"If you're importing into that project space, it already has them, so leave",
			'"lookup-tables-managed-in-acme-health.xlsx" out. Uploading it there would',
			"replace their rows with Nova's copy.",
			"",
			"For any other project space, upload it on the Lookup Tables page too, the",
			"same way as the file above.",
		]);
		expect(copy.managedLookupGuideTitle(file, false)).toBe(
			copy.MANAGED_LOOKUP_GUIDE_TITLE,
		);
	});

	it("says how to upload it where no step above carries a lookup table file", () => {
		const lines = managedLookupGuideLines(file, {
			several: false,
			afterUploadStep: false,
		});
		expect(lines.slice(-5)).toEqual([
			"For any other project space, open the Lookup Tables page in CommCare HQ:",
			"  https://www.commcarehq.org/a/<your-project>/fixtures/",
			"",
			'Upload "lookup-tables-managed-in-acme-health.xlsx" there, tick "Replace existing',
			'tables", and click Upload Tables.',
		]);
		expect(lines.join("\n")).not.toMatch(/above|[—…]/);
	});

	it("names its own project space where others manage tables in files of their own", () => {
		const lines = managedLookupGuideLines(file, {
			several: true,
			afterUploadStep: true,
		});
		expect(lines.slice(0, 7)).toEqual([
			"These tables are managed in acme-health on CommCare HQ, and Nova only keeps a copy:",
			"  districts (copied on 2026-11-03)",
			"  clinics (copied on 2026-11-04)",
			"",
			"If you're importing into acme-health, it already has them, so leave",
			'"lookup-tables-managed-in-acme-health.xlsx" out. Uploading it there would',
			"replace their rows with Nova's copy.",
		]);
		expect(lines.join("\n")).not.toMatch(/that project space/);
		expect(copy.managedLookupGuideTitle(file, true)).toBe(
			"Lookup tables managed in acme-health",
		);
	});
});
