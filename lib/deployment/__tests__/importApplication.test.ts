/**
 * The two bodies a publish sends, each with the ownership the drift baseline
 * records. Pure: no store and no HQ; what HQ does with each body is the
 * proof lane's.
 */
import { describe, expect, it } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { connectWireFixtures } from "@/lib/commcare/__tests__/connectWireFixtures";
import { appProfileProperties } from "@/lib/commcare/appProfileSettings";
import { APP_SHELL_KEYS } from "@/lib/commcare/expander";
import type { HqAppSource } from "@/lib/commcare/hq/appSource";
import { DERIVED_WIRE_IDENTITY } from "@/lib/commcare/wireIdentity";
import type { BlueprintDoc } from "@/lib/domain";
import { NEW_APP_SETTINGS } from "@/lib/domain/blueprint";
import { hqImportApplication } from "../importApplication";

const TARGET = { server: "production", domain: "field-ops" } as const;

function shell(doc: BlueprintDoc) {
	return {
		prepared: { doc, assets: new Map(), attachmentTarget: null },
		target: TARGET,
		compatibility: { advisories: [] },
		update: null,
		identity: DERIVED_WIRE_IDENTITY,
		languageNames: "nova",
		seeds: "nova",
		keyedCaseIdPrefixes: new Map(),
	} as const;
}

function update(doc: BlueprintDoc, source: HqAppSource) {
	return { ...shell(doc), update: { appId: "hq-app", source } };
}

/** An update of the app mapping a bring-in left `adopted`. */
function adoptedUpdate(doc: BlueprintDoc, source: HqAppSource) {
	return {
		...update(doc, source),
		languageNames: "target",
		seeds: "target",
	} as const;
}

/** The source of the shell a first publish creates, as HQ serves it back. */
function shellSource(overrides: Partial<HqAppSource> = {}): HqAppSource {
	return {
		docType: "Application",
		buildSpecVersion: "2.57.0",
		cloudcareEnabled: true,
		logoRefs: {},
		profile: {},
		langs: ["en"],
		translations: { en: { en: "English" } },
		addOns: {},
		modules: [],
		raw: {},
		name: null,
		lastModified: null,
		multimediaMap: [],
		buildProfiles: [],
		...overrides,
	};
}

const connect = connectWireFixtures().find(
	(fixture) => fixture.name === "deliver-default",
)?.doc;

describe("hqImportApplication", () => {
	it("sends the shell its own keys, with no add-on and no profile key in its ownership", () => {
		const doc = buildDoc({ appName: "Visits" });
		const { application, ownership } = hqImportApplication(shell(doc));
		// `case_sharing` is there only for an app that shares cases.
		expect(Object.keys(application)).toEqual(
			APP_SHELL_KEYS.filter(
				(key) => key !== "case_sharing" && key !== "build_profiles",
			),
		);
		expect(ownership).toEqual({
			addOns: [],
			profileProperties: [],
			profileCustomProperties: [],
			autoGpsCapture: true,
		});
		if (connect === undefined) throw new Error("Missing the Connect fixture.");
		const connectShell = hqImportApplication(shell(connect));
		expect(Object.keys(connectShell.application)).toEqual(
			APP_SHELL_KEYS.filter(
				(key) => key !== "case_sharing" && key !== "build_profiles",
			),
		);
		expect(connectShell.ownership.autoGpsCapture).toBe(true);
		const sharing = buildDoc({
			appName: "Visits",
			appSettings: { ...NEW_APP_SETTINGS, caseSharing: true },
		});
		const sharingShell = hqImportApplication(shell(sharing)).application;
		expect(Object.keys(sharingShell)).toEqual(
			APP_SHELL_KEYS.filter((key) => key !== "build_profiles"),
		);
		expect(sharingShell.case_sharing).toBe(true);
	});

	it("fills the shell with the three keys over its source, and owns the form lists, the Android app selection, the location switch and case sharing", () => {
		const doc = buildDoc({
			appName: "Visits",
			appSettings: { showSavedForms: true, showIncompleteForms: false },
		});
		const { application, ownership } = hqImportApplication(
			update(doc, shellSource({ addOns: { menu_mode: false } })),
		);
		expect(application.auto_gps_capture).toBe(false);
		expect(Object.hasOwn(application, "add_ons")).toBe(false);
		expect(application.profile?.properties).toEqual(
			Object.fromEntries(
				appProfileProperties(doc).map(({ key, value }) => [key, value]),
			),
		);
		expect(Object.keys(application).at(-1)).toBe("_attachments");
		/* The update writes or removes the Android apps workers need. */
		expect(ownership).toEqual({
			menuLayouts: true,
			addOns: [],
			profileProperties: ["cc-show-saved", "cc-show-incomplete"],
			profileFeatures: ["dependencies"],
			profileCustomProperties: [],
			autoGpsCapture: true,
			caseSharing: true,
		});
	});

	it("writes where the app runs as cloudcare_enabled on the update, after location_fixture_restore, and never on the shell", () => {
		/* The plausible failures: the shell carrying the key (a key the create
		 * baseline's ownership does not state) or the update omitting it, which
		 * HQ's update would then keep at whatever the plan's create left. */
		const both = buildDoc({ appName: "Visits" });
		const android = buildDoc({
			appName: "Visits",
			appSettings: {
				showSavedForms: false,
				showIncompleteForms: false,
				runsOnlyOn: "android",
			},
		});
		for (const [doc, expected] of [
			[both, true],
			[android, false],
		] as const) {
			const { application } = hqImportApplication(update(doc, shellSource()));
			expect(application.cloudcare_enabled).toBe(expected);
			const keys = Object.keys(application);
			expect(keys.indexOf("cloudcare_enabled")).toBe(
				keys.indexOf("location_fixture_restore") + 1,
			);
			expect(keys.at(-1)).toBe("_attachments");
			const created = hqImportApplication(shell(doc)).application;
			expect(Object.hasOwn(created, "cloudcare_enabled")).toBe(false);
		}
	});

	it("keeps a Connect app's Auto Capture Location in the update and in its ownership", () => {
		if (connect === undefined) throw new Error("Missing the Connect fixture.");
		const { application, ownership } = hqImportApplication(
			update(connect, shellSource()),
		);
		expect(application.auto_gps_capture).toBe(true);
		expect(ownership.autoGpsCapture).toBe(true);
	});
	it("leaves an adopted app's language names and unset settings as CommCare HQ holds them", () => {
		/* The plausible failure: the input's options never reaching the
		 * overlay, so the first publish over an app Nova brought in renames a
		 * language and seeds every setting its workers never had. */
		const doc = buildDoc({
			appName: "Visits",
			appSettings: { showSavedForms: true, showIncompleteForms: false },
		});
		const source = shellSource({
			translations: { en: { en: "Inglés" } },
			profile: { properties: { "cc-autoup-freq": "freq-daily" } },
		});
		const adopted = hqImportApplication(adoptedUpdate(doc, source));
		/* Nothing of Nova's differs there, so the body leaves the key out and
		 * CommCare HQ keeps the name it holds. */
		expect(Object.hasOwn(adopted.application, "translations")).toBe(false);
		expect(adopted.application.profile?.properties).toEqual({
			"cc-autoup-freq": "freq-daily",
			"cc-show-saved": "yes",
			"cc-show-incomplete": "no",
		});
		/* The descriptor is the same: it names Nova's two settings alone. */
		expect(adopted.ownership.profileProperties).toEqual([
			"cc-show-saved",
			"cc-show-incomplete",
		]);
		const created = hqImportApplication(update(doc, source));
		expect(Object.hasOwn(created.application, "translations")).toBe(true);
		expect(created.application.translations?.en?.en).not.toBe("Inglés");
		expect(created.application.profile?.properties?.["cc-enable-tts"]).toBe(
			"no",
		);
	});

	describe("logo_refs", () => {
		const pathOnly = { path: "jr://file/commcare/abc.png" };
		const uploaded = {
			path: "jr://file/commcare/logo/data/hq_logo_android_home.png",
			uid: "a1b2c3",
			m_id: "e9f8d7c6b5a4",
			url: "/hq/multimedia/file/CommCareImage/e9f8d7c6b5a4/logo.png",
			updated: true,
			original_path: "logo.png",
			icon_class: "fa fa-picture-o",
			media_type: "CommCareImage",
			humanized_content_length: "4.2 KB",
			image_size: "64 x 64",
		};
		const doc = buildDoc({ appName: "Visits" });

		it("are sent on an update only to take out a path-only entry, keeping every uploader entry", () => {
			const { application } = hqImportApplication(
				update(
					doc,
					shellSource({
						logoRefs: {
							hq_logo_web_apps: pathOnly,
							hq_logo_android_home: uploaded,
						},
					}),
				),
			);
			expect(
				(application as unknown as Record<string, unknown>).logo_refs,
			).toEqual({ hq_logo_android_home: uploaded });
			expect(Object.keys(application).at(-1)).toBe("_attachments");
		});

		it("are left out where the target holds no path-only entry, so HQ keeps its own", () => {
			for (const logoRefs of [{}, { hq_logo_android_home: uploaded }]) {
				const { application } = hqImportApplication(
					update(doc, shellSource({ logoRefs })),
				);
				expect(Object.hasOwn(application, "logo_refs")).toBe(false);
			}
		});

		it("are never on the shell a first publish creates", () => {
			const { application } = hqImportApplication(shell(doc));
			expect(Object.hasOwn(application, "logo_refs")).toBe(false);
		});
	});
});
