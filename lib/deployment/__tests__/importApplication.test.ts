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
import { hqImportApplication } from "../importApplication";

const TARGET = { server: "production", domain: "field-ops" } as const;

function shell(doc: BlueprintDoc) {
	return {
		prepared: { doc, assets: new Map(), attachmentTarget: null },
		target: TARGET,
		compatibility: { advisories: [] },
		update: null,
		identity: DERIVED_WIRE_IDENTITY,
	};
}

function update(doc: BlueprintDoc, source: HqAppSource) {
	return { ...shell(doc), update: { appId: "hq-app", source } };
}

/** The source of the shell a first publish creates, as HQ serves it back. */
function shellSource(overrides: Partial<HqAppSource> = {}): HqAppSource {
	return {
		docType: "Application",
		buildSpecVersion: "2.57.0",
		profile: {},
		langs: ["en"],
		translations: { en: { en: "English" } },
		addOns: {},
		modules: [],
		raw: {},
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
		expect(Object.keys(application)).toEqual(
			APP_SHELL_KEYS.filter((key) => key !== "auto_gps_capture"),
		);
		expect(ownership).toEqual({
			addOns: [],
			profileProperties: [],
			profileCustomProperties: [],
			autoGpsCapture: false,
		});
		if (connect === undefined) throw new Error("Missing the Connect fixture.");
		const connectShell = hqImportApplication(shell(connect));
		expect(Object.keys(connectShell.application)).toEqual([...APP_SHELL_KEYS]);
		expect(connectShell.ownership.autoGpsCapture).toBe(true);
	});

	it("fills the shell with the three keys over its source, and owns the two settings", () => {
		const doc = buildDoc({
			appName: "Visits",
			appSettings: { showSavedForms: true, showIncompleteForms: false },
		});
		const { application, ownership } = hqImportApplication(
			update(doc, shellSource({ addOns: { menu_mode: false } })),
		);
		expect(Object.hasOwn(application, "auto_gps_capture")).toBe(false);
		expect(Object.hasOwn(application, "add_ons")).toBe(false);
		expect(application.profile?.properties).toEqual(
			Object.fromEntries(
				appProfileProperties(doc).map(({ key, value }) => [key, value]),
			),
		);
		expect(Object.keys(application).at(-1)).toBe("_attachments");
		expect(ownership).toEqual({
			addOns: [],
			profileProperties: ["cc-show-saved", "cc-show-incomplete"],
			profileCustomProperties: [],
			autoGpsCapture: false,
		});
	});

	it("keeps a Connect app's Auto Capture Location in the update and in its ownership", () => {
		if (connect === undefined) throw new Error("Missing the Connect fixture.");
		const { application, ownership } = hqImportApplication(
			update(connect, shellSource()),
		);
		expect(application.auto_gps_capture).toBe(true);
		expect(ownership.autoGpsCapture).toBe(true);
	});
});
