/**
 * The notice lines the writer stores, from each deployment's class and the
 * migrated document, with no probe of HQ.
 */

import { describe, expect, it } from "vitest";
import { entryPointInventory } from "@/lib/domain/entryPoints";
import { migrationNoticeEntrySchema } from "@/lib/notices/migrationNotice";
import {
	appNoticeEntries,
	baselineNotices,
	cczNeedsProjectSpace,
	deploymentNoticeReasons,
	deploymentNotices,
	noticeEntityNames,
} from "../notice";
import { readRawDocument } from "../oldShape";
import type { AppPlan, DeploymentPlan } from "../plan";
import {
	migratedFixtureDocument,
	readFixtureCarriers,
} from "./fixtures/preStep";

const withEntryPoints = migratedFixtureDocument(
	"targeted-invalid-question-ids",
);
const withoutEntryPoints = migratedFixtureDocument("navigation-base");

/**
 * A read profile under which no settings line is due: both lists shown and
 * each worker preference held, so a test of another line sees it alone.
 */
const SETTLED_PROFILE = {
	"cc-show-saved": "yes",
	"cc-show-incomplete": "yes",
	"cc-fuzzy-search-enabled": "no",
	"cc-autoup-freq": "freq-never",
	"cc-enable-tts": "no",
} as const;

function deployment(patch: Partial<DeploymentPlan> = {}): DeploymentPlan {
	return {
		deploymentId: "00000000-0000-7000-8000-00000000d001",
		server: "production",
		domain: "field-ops",
		remoteAppId: "remote-app-1",
		outcome: "unreadable",
		buildSpecVersion: null,
		pairing: null,
		identities: [],
		unpaired: [],
		formIdsUnknown: [],
		keyUses: [],
		notices: [],
		...patch,
	};
}

function app(patch: Partial<AppPlan> = {}): AppPlan {
	return {
		appId: "app-1",
		projectId: "project-1",
		baseSeq: 3,
		baseDigest: "a".repeat(64),
		targetDigest: "a".repeat(64),
		blockers: [],
		changes: [],
		discardsPrivateWork: false,
		deployments: [],
		...patch,
	};
}

describe("deployment notice reasons", () => {
	it("tells every deployment that has a next publish that new links wait for it", () => {
		expect(entryPointInventory(withEntryPoints).length).toBeGreaterThan(0);
		for (const outcome of ["read-in-full", "no-form-ids"] as const) {
			expect(
				deploymentNotices(
					{ outcome, profileProperties: SETTLED_PROFILE },
					withEntryPoints,
				).map((notice) => notice.reason),
			).toEqual(["data-paths-move-once", "deep-links-need-republish"]);
		}
	});

	it("tells an unreadable deployment its ids change once at the next publish", () => {
		expect(deploymentNoticeReasons("unreadable", withEntryPoints)).toEqual([
			"ids-change-once-unreadable",
			"data-paths-move-once",
			"deep-links-need-republish",
			"settings-unknown-unreadable",
		]);
		expect(deploymentNoticeReasons("unreadable", withoutEntryPoints)).toEqual([
			"ids-change-once-unreadable",
			"data-paths-move-once",
			"settings-unknown-unreadable",
		]);
	});

	it("gives a deleted and an unsupported deployment their one line alone", () => {
		expect(deploymentNoticeReasons("deleted", withEntryPoints)).toEqual([
			"hq-app-deleted",
		]);
		expect(deploymentNoticeReasons("unsupported", withEntryPoints)).toEqual([
			"hq-app-not-nova-made",
		]);
	});

	it("says nothing for a deployment whose reads stopped the run", () => {
		expect(deploymentNoticeReasons("transient", withEntryPoints)).toEqual([]);
	});

	it("says nothing about links in an app with no entry point", () => {
		expect(entryPointInventory(withoutEntryPoints)).toEqual([]);
		expect(
			deploymentNotices(
				{ outcome: "read-in-full", profileProperties: SETTLED_PROFILE },
				withoutEntryPoints,
			),
		).toEqual([{ reason: "data-paths-move-once" }]);
	});

	it("names each entity left unpaired, and each form whose stored id no read gave", () => {
		const menu = {
			kind: "module" as const,
			uuid: "00000000-0000-4000-8000-0000000000a1",
		};
		const form = {
			kind: "form" as const,
			uuid: "00000000-0000-4000-8000-0000000000b1",
		};
		expect(
			deploymentNotices(
				{
					outcome: "no-form-ids",
					unpaired: [menu],
					formIdsUnknown: [form.uuid],
					profileProperties: SETTLED_PROFILE,
				},
				withoutEntryPoints,
			),
		).toEqual([
			{ reason: "menu-id-changes-once", entities: [menu] },
			{ reason: "form-ids-change-once", entities: [form] },
			{ reason: "data-paths-move-once" },
		]);
	});

	it("names no form under form-ids-change-once where every stored id was read", () => {
		expect(
			deploymentNotices(
				{
					outcome: "read-in-full",
					unpaired: [],
					formIdsUnknown: [],
					profileProperties: SETTLED_PROFILE,
				},
				withoutEntryPoints,
			),
		).toEqual([{ reason: "data-paths-move-once" }]);
	});

	it("tells every deployment with a next publish, once and naming no form, that the data paths Nova adds move", () => {
		const target = migratedFixtureDocument("case-operation-query");
		const classes = [
			"read-in-full",
			"no-form-ids",
			"unreadable",
			"deleted",
			"unsupported",
			"transient",
		] as const;
		const entries = appNoticeEntries(
			app({
				deployments: classes.map((outcome, index) =>
					deployment({
						deploymentId: `00000000-0000-7000-8000-00000000d00${index + 1}`,
						outcome,
						notices: deploymentNotices(
							{
								outcome,
								...(outcome === "read-in-full" || outcome === "no-form-ids"
									? { profileProperties: SETTLED_PROFILE }
									: {}),
							},
							target,
						),
					}),
				),
			}),
			"Clinic",
		);
		const moved = entries.filter(
			(entry) => entry.reason === "data-paths-move-once",
		);
		expect(
			moved.map((entry) =>
				entry.kind === "deployment" ? entry.deployment.deploymentId : null,
			),
		).toEqual([
			"00000000-0000-7000-8000-00000000d001",
			"00000000-0000-7000-8000-00000000d002",
			"00000000-0000-7000-8000-00000000d003",
		]);
		for (const entry of moved) {
			expect(entry).not.toHaveProperty("entities");
			expect(entry).not.toHaveProperty("detail");
		}
	});
});

describe("ccz-needs-project-space", () => {
	it("names a live app no deployment holds once the ledger writes are made", () => {
		expect(
			cczNeedsProjectSpace({
				appName: "Clinic",
				deleted: false,
				reachedAfterCutover: false,
			}),
		).toEqual([
			{
				reason: "ccz-needs-project-space",
				entity: { type: "app", nameAtMigration: "Clinic" },
			},
		]);
	});

	it("names no app that is published somewhere, and no deleted app", () => {
		expect(
			cczNeedsProjectSpace({
				appName: "Clinic",
				deleted: false,
				reachedAfterCutover: true,
			}),
		).toEqual([]);
		expect(
			cczNeedsProjectSpace({
				appName: "Clinic",
				deleted: true,
				reachedAfterCutover: false,
			}),
		).toEqual([]);
	});
});

describe("an app's notice entries", () => {
	it("are empty for an app nothing changed in", () => {
		expect(appNoticeEntries(app(), "Clinic")).toEqual([]);
	});

	it("put each deployment's lines first, then the discarded private work, each a valid entry", () => {
		const entries = appNoticeEntries(
			app({
				discardsPrivateWork: true,
				deployments: [
					deployment({ notices: [{ reason: "deep-links-need-republish" }] }),
				],
			}),
			"Clinic",
		);
		expect(entries).toEqual([
			{
				kind: "deployment",
				reason: "deep-links-need-republish",
				deployment: {
					deploymentId: "00000000-0000-7000-8000-00000000d001",
					server: "production",
					domain: "field-ops",
				},
			},
			{
				kind: "document",
				reason: "unsaved-assistant-work-discarded",
				entity: { type: "app", nameAtMigration: "Clinic" },
			},
		]);
		for (const entry of entries) {
			expect(migrationNoticeEntrySchema.safeParse(entry).success).toBe(true);
		}
	});

	it("cuts a stored name at the length an entry keeps", () => {
		const [entry] = appNoticeEntries(
			app({ discardsPrivateWork: true }),
			"x".repeat(250),
		);
		expect(entry?.kind === "document" && entry.entity.nameAtMigration).toBe(
			"x".repeat(200),
		);
	});

	it("names a deployment line's entities by the migrated document, the hidden menu by its form", () => {
		const raw = readRawDocument(
			"no-matches-parent",
			readFixtureCarriers("no-matches-parent"),
		);
		const names = noticeEntityNames(raw);
		const [menuUuid] = raw.moduleOrder;
		if (menuUuid === undefined) throw new Error("The fixture has no menu.");
		const hiddenMenu = [...names.keys()].find(
			(uuid) => !(uuid in raw.modules) && !(uuid in raw.forms),
		);
		if (hiddenMenu === undefined) throw new Error("No hidden menu was named.");
		const entries = appNoticeEntries(
			app({
				deployments: [
					deployment({
						outcome: "read-in-full",
						notices: [
							{
								reason: "menu-id-changes-once",
								entities: [
									{ kind: "module", uuid: menuUuid },
									{ kind: "module", uuid: hiddenMenu },
								],
							},
						],
					}),
				],
			}),
			"Clinic",
			names,
		);
		const [entry] = entries;
		expect(entry?.kind === "deployment" && entry.entities).toEqual([
			{
				type: "module",
				uuid: menuUuid,
				nameAtMigration: raw.modules[menuUuid]?.name,
			},
			{
				type: "module",
				uuid: hiddenMenu,
				nameAtMigration: "Register patient",
			},
		]);
		expect(migrationNoticeEntrySchema.safeParse(entry).success).toBe(true);
	});
});

describe("the drift lines a deployment's baselines give", () => {
	const table = {
		kind: "lookupTable",
		uuid: "0199a000-0000-7000-8000-000000000001",
		name: "Clinics",
	} as const;
	const place = {
		kind: "location",
		uuid: "0199a000-0000-7000-8000-000000000002",
		name: "District 4",
	} as const;

	it("says the first publish writes over earlier edits where the app's baseline is the cutover's", () => {
		for (const outcome of ["read-in-full", "no-form-ids"] as const) {
			expect(
				baselineNotices({ outcome, app: "cutover", unreadResources: [] }),
			).toEqual([{ reason: "next-publish-overwrites-hq-edits" }]);
		}
	});

	it("says the next publish asks, naming no entity where the app is the one not read", () => {
		expect(
			baselineNotices({
				outcome: "unreadable",
				app: "unread",
				unreadResources: [table],
			}),
		).toEqual([{ reason: "next-publish-asks-before-overwriting" }]);
	});

	it("names each table and place not read beside a read app", () => {
		expect(
			baselineNotices({
				outcome: "read-in-full",
				app: "cutover",
				unreadResources: [table, place],
			}),
		).toEqual([
			{ reason: "next-publish-overwrites-hq-edits" },
			{
				reason: "next-publish-asks-before-overwriting",
				entities: [table, place],
			},
		]);
	});

	it("gives a linked app and a deleted one no drift line", () => {
		expect(
			baselineNotices({
				outcome: "unsupported",
				app: "unread",
				unreadResources: [table],
			}),
		).toEqual([]);
		expect(
			baselineNotices({ outcome: "deleted", app: null, unreadResources: [] }),
		).toEqual([]);
	});

	it("are stored in the enum's order beside the plan's lines, tables and places by their own names", () => {
		const entries = appNoticeEntries(
			app({
				deployments: [
					deployment({
						outcome: "unreadable",
						notices: [
							{ reason: "deep-links-need-republish" },
							{ reason: "ids-change-once-unreadable" },
						],
					}),
				],
			}),
			"Clinic",
			new Map(),
			new Map([
				[
					"00000000-0000-7000-8000-00000000d001",
					baselineNotices({
						outcome: "read-in-full",
						app: "cutover",
						unreadResources: [table, place],
					}),
				],
			]),
		);
		expect(entries.map((entry) => entry.reason)).toEqual([
			"ids-change-once-unreadable",
			"deep-links-need-republish",
			"next-publish-overwrites-hq-edits",
			"next-publish-asks-before-overwriting",
		]);
		const asks = entries[3];
		expect(asks?.kind === "deployment" && asks.entities).toEqual([
			{ type: "lookupTable", uuid: table.uuid, nameAtMigration: "Clinics" },
			{ type: "location", uuid: place.uuid, nameAtMigration: "District 4" },
		]);
		for (const entry of entries) {
			expect(migrationNoticeEntrySchema.safeParse(entry).success).toBe(true);
		}
	});
});

describe("the settings lines a deployment's profile gives", () => {
	const settled = (
		patch: Readonly<Record<string, unknown>>,
	): Readonly<Record<string, unknown>> => ({ ...SETTLED_PROFILE, ...patch });
	const withSettings = (
		showSavedForms: boolean,
		showIncompleteForms: boolean,
	) => ({
		...withoutEntryPoints,
		appSettings: { showSavedForms, showIncompleteForms },
	});
	const settingLines = (
		profileProperties: Readonly<Record<string, unknown>>,
		target = withSettings(true, true),
	) =>
		deploymentNotices(
			{ outcome: "read-in-full", profileProperties },
			target,
		).filter((notice) => notice.reason === "setting-changes-at-next-publish");

	it("names saved forms on Android where the project space does not hold yes", () => {
		for (const value of [undefined, "no", ""]) {
			const profile =
				value === undefined
					? Object.fromEntries(
							Object.entries(SETTLED_PROFILE).filter(
								([key]) => key !== "cc-show-saved",
							),
						)
					: settled({ "cc-show-saved": value });
			expect(settingLines(profile)).toEqual([
				{
					reason: "setting-changes-at-next-publish",
					detail: { setting: "saved", readers: "android" },
				},
			]);
		}
		expect(settingLines(settled({}))).toEqual([]);
	});

	it("names Android alone for a project space that holds no incomplete forms value, since Web Apps shows the tile there", () => {
		const profile = Object.fromEntries(
			Object.entries(SETTLED_PROFILE).filter(
				([key]) => key !== "cc-show-incomplete",
			),
		);
		expect(settingLines(profile)).toEqual([
			{
				reason: "setting-changes-at-next-publish",
				detail: { setting: "incomplete", readers: "android" },
			},
		]);
	});

	it("names Android and Web Apps for a project space that holds no, beside one that holds yes", () => {
		const hides = settled({ "cc-show-incomplete": "no" });
		const shows = settled({ "cc-show-incomplete": "yes" });
		const target = migratedFixtureDocument("navigation-base", [
			{
				deploymentId: "00000000-0000-7000-8000-00000000d001",
				outcome: "read-in-full",
				profileProperties: hides,
			},
			{
				deploymentId: "00000000-0000-7000-8000-00000000d002",
				outcome: "no-form-ids",
				profileProperties: shows,
			},
		]);
		expect(target.appSettings).toEqual({
			showSavedForms: true,
			showIncompleteForms: true,
		});
		expect(settingLines(hides, target)).toEqual([
			{
				reason: "setting-changes-at-next-publish",
				detail: { setting: "incomplete", readers: "android-and-webapps" },
			},
		]);
		expect(settingLines(shows, target)).toEqual([]);
	});

	it("never writes a line that turns a list off", () => {
		for (const value of ["yes", "no", undefined]) {
			const profile =
				value === undefined
					? {}
					: { "cc-show-saved": value, "cc-show-incomplete": value };
			expect(settingLines(profile, withSettings(false, false))).toEqual([]);
		}
	});

	it("tells an unreadable project space only that its settings are unknown", () => {
		const reasons = (outcome: DeploymentPlan["outcome"]) =>
			deploymentNotices({ outcome }, withSettings(true, true)).map(
				(notice) => notice.reason,
			);
		expect(reasons("unreadable")).toEqual([
			"ids-change-once-unreadable",
			"data-paths-move-once",
			"settings-unknown-unreadable",
		]);
		for (const outcome of ["read-in-full", "no-form-ids"] as const) {
			expect(
				deploymentNotices(
					{ outcome, profileProperties: SETTLED_PROFILE },
					withSettings(true, true),
				),
			).toEqual([{ reason: "data-paths-move-once" }]);
		}
		expect(reasons("deleted")).toEqual(["hq-app-deleted"]);
		expect(reasons("unsupported")).toEqual(["hq-app-not-nova-made"]);
	});

	it("tells a read project space that lacks one of the three worker preferences that updates reset them", () => {
		const reset = (
			outcome: DeploymentPlan["outcome"],
			profileProperties: Readonly<Record<string, unknown>> | null,
		) =>
			deploymentNotices(
				{ outcome, profileProperties },
				withSettings(false, false),
			).some(
				(notice) => notice.reason === "worker-settings-reset-at-next-publish",
			);
		for (const key of [
			"cc-fuzzy-search-enabled",
			"cc-autoup-freq",
			"cc-enable-tts",
		]) {
			for (const value of [null, ""]) {
				expect(reset("read-in-full", settled({ [key]: value })), key).toBe(
					true,
				);
			}
			const without = Object.fromEntries(
				Object.entries(SETTLED_PROFILE).filter(([held]) => held !== key),
			);
			expect(reset("no-form-ids", without), key).toBe(true);
		}
		expect(reset("read-in-full", SETTLED_PROFILE)).toBe(false);
		expect(
			reset("read-in-full", settled({ "cc-autoup-freq": "freq-daily" })),
		).toBe(false);
		expect(reset("unreadable", null)).toBe(false);
	});

	it("stores each setting line with its detail, after the lines the enum puts first", () => {
		const entries = appNoticeEntries(
			app({
				deployments: [
					deployment({
						outcome: "read-in-full",
						notices: deploymentNotices(
							{ outcome: "read-in-full", profileProperties: {} },
							withSettings(true, true),
						),
					}),
				],
			}),
			"Clinic",
		);
		expect(entries).toEqual([
			{
				kind: "deployment",
				reason: "data-paths-move-once",
				deployment: {
					deploymentId: "00000000-0000-7000-8000-00000000d001",
					server: "production",
					domain: "field-ops",
				},
			},
			{
				kind: "deployment",
				reason: "setting-changes-at-next-publish",
				deployment: {
					deploymentId: "00000000-0000-7000-8000-00000000d001",
					server: "production",
					domain: "field-ops",
				},
				detail: { setting: "saved", readers: "android" },
			},
			{
				kind: "deployment",
				reason: "setting-changes-at-next-publish",
				deployment: {
					deploymentId: "00000000-0000-7000-8000-00000000d001",
					server: "production",
					domain: "field-ops",
				},
				detail: { setting: "incomplete", readers: "android" },
			},
			{
				kind: "deployment",
				reason: "worker-settings-reset-at-next-publish",
				deployment: {
					deploymentId: "00000000-0000-7000-8000-00000000d001",
					server: "production",
					domain: "field-ops",
				},
			},
		]);
		for (const entry of entries) {
			expect(migrationNoticeEntrySchema.safeParse(entry).success).toBe(true);
		}
	});
});
