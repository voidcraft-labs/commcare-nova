/**
 * The application walker over CommCare HQ's own answers: an app HQ made
 * (`shell`), the same after a save of its settings page, an app HQ built
 * with menus of every kind (`hq-built`) and one after a save of its UI
 * translations page, each read through Nova's reader of HQ's source view.
 * Each key HQ's own pages write must be claimed at the app, under the entry
 * whose value class takes the value. Over sources a test changed: a logo
 * entry the uploader did not write, the Web Apps logo, and a language's
 * name that differs from Nova's label.
 *
 * It would catch an `Application` key left unclaimed, a setting accounted
 * under the wrong value class, a logo entry with no `m_id` admitted, and a
 * display name raised as a finding where the manifest keeps it (or kept
 * where the manifest refuses it).
 */

import { describe, expect, it } from "vitest";
import { makeTranslationUnitId } from "@/lib/domain";
import { inventoryIndex } from "../../surface/inventory";
import { readApplication } from "../appShell";
import { readStructure } from "../structure";
import {
	closeAfterStructure,
	entriesAt,
	readContext,
	readerInput,
	retainedSourceBody,
	sourceFromBody,
} from "./readerInput";

const A = "application-and-settings";
const APP_PLACES = new Set(["app", "app-settings", "languages"]);

/** The two stages that claim an app's root keys and its menus' own keys, and the forms stage's
 *  one read of the walker's: each form's source. */
async function readShell(body: Readonly<Record<string, unknown>>) {
	const ctx = readContext(readerInput(await sourceFromBody(body)));
	readApplication(ctx);
	readStructure(ctx);
	return { ctx, closed: closeAfterStructure(ctx) };
}

describe("readApplication over CommCare HQ's own apps", () => {
	it.each([
		"shell/app-source",
		"shell/app-source-after-app-settings-save",
		"hq-built/app-source",
		"navigation-base/app-source-after-ui-translations-save",
	])("claims every key of %s at the app", async (file) => {
		const { closed } = await readShell(retainedSourceBody(file));
		expect(
			closed.findings.filter((finding) => APP_PLACES.has(finding.place.kind)),
		).toEqual([]);
		expect(
			closed.defects.filter((defect) => APP_PLACES.has(defect.place.kind)),
		).toEqual([]);
	});

	it("accounts each setting HQ's settings page saves under the entry of its value", async () => {
		const { ctx, closed } = await readShell(
			retainedSourceBody("shell/app-source-after-app-settings-save"),
		);
		expect(entriesAt(closed, "/build_spec")).toEqual([
			`${A}/34-hq-build-spec-at-or-above-nova-s-floor-2-57`,
		]);
		expect(entriesAt(closed, "/profile/properties/cc-autoup-freq")).toEqual([
			`${A}/1-properties-cc-autoup-freq`,
		]);
		expect(entriesAt(closed, "/profile/properties/purge-freq")).toEqual([
			`${A}/3-properties-purge-freq`,
		]);
		expect(entriesAt(closed, "/profile/properties/cc-show-saved")).toEqual([
			`${A}/20-properties-cc-show-saved`,
		]);
		expect(entriesAt(closed, "/profile/features/users")).toEqual([
			`${A}/15-features-users`,
		]);
		expect(entriesAt(closed, "/translations/en/en")).toEqual([
			`${A}/translations-lang-code-language-display-names-equal-to-the-label`,
		]);
		expect(ctx.draft.appSettings).toEqual({
			showSavedForms: false,
			showIncompleteForms: false,
		});
		expect(ctx.draft.localization).toBeUndefined();
		expect(ctx.draft.appName?.value).toBe("Patients & visits <Café>");
	});

	it("reads a setting outside its choices as that setting's refusal, at the app", async () => {
		const body = retainedSourceBody("shell/app-source-after-app-settings-save");
		const profile = body.profile as {
			properties: Record<string, string>;
		};
		const { closed } = await readShell({
			...body,
			profile: {
				...profile,
				properties: {
					...profile.properties,
					"cc-autoup-freq": "freq-hourly",
					"cc-show-saved": "yes",
				},
			},
		});
		expect(entriesAt(closed, "/profile/properties/cc-autoup-freq")).toEqual([
			`${A}/profile-properties-or-features-dependencies-value-outside-its`,
		]);
		expect(
			closed.findings.filter((finding) => APP_PLACES.has(finding.place.kind)),
		).toMatchObject([
			{
				code: `${A}/profile-properties-or-features-dependencies-value-outside-its`,
				place: { kind: "app" },
				detail: { name: "cc-autoup-freq" },
			},
		]);
	});

	it("refuses a build below Nova's floor at the app's settings, with the version HQ holds", async () => {
		const body = retainedSourceBody("shell/app-source");
		const { closed } = await readShell({
			...body,
			build_spec: { ...(body.build_spec as object), version: "2.53.0" },
		});
		expect(
			closed.findings.filter((finding) => APP_PLACES.has(finding.place.kind)),
		).toMatchObject([
			{
				code: `${A}/34p-hq-build-spec-below-nova-s-floor`,
				place: { kind: "app-settings" },
				detail: { name: "2.53.0" },
			},
		]);
	});
});

describe("readApplication's logos", () => {
	const ASSET = "0f0e0d0c-0b0a-4908-8706-050403020100";
	const webApps = (entry: Record<string, unknown>) => ({
		...retainedSourceBody("shell/app-source"),
		logo_refs: { hq_logo_web_apps: entry },
	});

	it("refuses a logo entry the uploader did not write: one with no m_id", async () => {
		const { ctx, closed } = await readShell(
			webApps({ path: "jr://file/commcare/logo/data/hq_logo_web_apps.png" }),
		);
		expect(closed.findings).toMatchObject([
			{
				code: `${A}/logo-refs-slot-path-other-than-the-uploader-s-jr-file-commcare`,
				detail: { name: "hq_logo_web_apps" },
			},
		]);
		expect(ctx.draft.logo).toBeUndefined();
		expect(ctx.facts.mediaReferences).toEqual([]);
	});

	it("refuses a slot whose path is not the uploader's", async () => {
		const { closed } = await readShell({
			...retainedSourceBody("shell/app-source"),
			logo_refs: {
				hq_logo_android_home: {
					path: "jr://file/commcare/logo/abc.png",
					m_id: "a1",
				},
			},
		});
		expect(closed.findings).toMatchObject([
			{
				code: `${A}/logo-refs-slot-path-other-than-the-uploader-s-jr-file-commcare`,
				detail: { name: "hq_logo_android_home" },
			},
		]);
	});

	it("reads the uploader's Web Apps logo into the document, and keeps an Android logo at HQ", async () => {
		const path = "jr://file/commcare/logo/data/hq_logo_web_apps.png";
		const body = {
			...retainedSourceBody("shell/app-source"),
			logo_refs: {
				hq_logo_web_apps: { path, m_id: "m1" },
				hq_logo_android_home: {
					path: "jr://file/commcare/logo/data/hq_logo_android_home.jpg",
					m_id: "m2",
				},
			},
		};
		const ctx = readContext(
			readerInput(await sourceFromBody(body), {
				media: (asked) =>
					asked === path
						? { kind: "asset", assetId: ASSET, mediaKind: "image" }
						: { kind: "no-entry" },
			}),
		);
		readApplication(ctx);
		readStructure(ctx);
		const closed = closeAfterStructure(ctx);
		expect(closed.findings).toEqual([]);
		expect(entriesAt(closed, "/logo_refs")).toEqual([
			`${A}/logo-refs-hq-logo-web-apps`,
		]);
		expect(ctx.draft.logo).toBe(ASSET);
		expect(ctx.facts.mediaReferences).toEqual([
			{
				path,
				assetId: ASSET,
				mediaKind: "image",
				place: { kind: "app-settings" },
				slot: "app_logo",
			},
		]);
	});

	it("hands the Web Apps logo to project data where its path has no file", async () => {
		const path = "jr://file/commcare/logo/data/hq_logo_web_apps.png";
		const { ctx, closed } = await readShell(webApps({ path, m_id: "m1" }));
		expect(closed.findings).toEqual([]);
		expect(closed.claims.handOffs).toEqual([
			{
				artifact: "app.json",
				where: "/logo_refs",
				key: "schema:Application.logo_refs",
				to: "media-reference",
				subject: path,
			},
		]);
		expect(ctx.facts.pendingMedia).toMatchObject([
			{ path, resolution: "no-entry", slot: "app_logo" },
		]);
	});
});

describe("readApplication's language names", () => {
	it("makes a finding of a name that differs from Nova's label exactly where the manifest's entry makes one", async () => {
		const body = retainedSourceBody("shell/app-source");
		const { closed } = await readShell({
			...body,
			translations: { en: { en: "Inglés" } },
		});
		const entry = inventoryIndex().entry(
			`${A}/translations-lang-code-any-other-value-or-absent-where-hq-s`,
		);
		const makesFinding =
			entry?.standing === "not-yet" ||
			entry?.standing === "never" ||
			entry?.standing === "fix-in-hq";
		expect(entriesAt(closed, "/translations/en/en")).toEqual([entry?.id]);
		expect(closed.findings.some((finding) => finding.code === entry?.id)).toBe(
			makesFinding,
		);
	});

	it("reads the app's name in another language as its translation", async () => {
		const body = retainedSourceBody("shell/app-source");
		const { ctx, closed } = await readShell({
			...body,
			langs: ["en", "fra"],
			translations: {
				en: { en: "English", fra: "français" },
				fra: { "app.display.name": "Patients et visites" },
			},
		});
		expect(entriesAt(closed, "/translations/fra/app.display.name")).toEqual([
			`${A}/translations-app-display-name`,
		]);
		expect(ctx.translations.units()).toEqual([
			{
				unit: makeTranslationUnitId("app", "name"),
				kind: "text",
				byLanguage: new Map([["fra", "Patients et visites"]]),
			},
		]);
		expect(ctx.draft.localization).toEqual({
			sourceLanguage: "eng",
			defaultLanguage: "eng",
			languageOrder: ["eng", "fra"],
			translations: { fra: {} },
			wireCodes: { eng: "en", fra: "fra" },
		});
	});
});
