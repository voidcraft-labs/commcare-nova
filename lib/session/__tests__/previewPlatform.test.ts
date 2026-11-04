/**
 * Preview's platform facts, through the store's own actions over a real doc
 * store: the lifetimes of `previewPlatform`, `previewAtDeviceHome` and
 * `previewDeviceSyncedAt`, the navigation reset of a platform change, and an
 * entry-point launch landing under its worker.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { createBlueprintDocStore } from "@/lib/doc/store";
import { NEW_APP_SETTINGS } from "@/lib/domain";
import type { Platform } from "@/lib/domain/platforms";
import { createBuilderSessionStore } from "../store";

function stores(runsOnlyOn?: Platform) {
	const docStore = createBlueprintDocStore();
	docStore.getState().load(
		buildDoc({
			appId: "platform-app",
			appName: "Platforms",
			appSettings:
				runsOnlyOn === undefined
					? NEW_APP_SETTINGS
					: { ...NEW_APP_SETTINGS, runsOnlyOn },
			modules: [],
		}),
	);
	const session = createBuilderSessionStore({
		appId: "platform-app",
		projectId: "project",
		role: "editor",
		canEdit: true,
	});
	session.getState()._setDocStore(docStore);
	return { docStore, session };
}

describe("setPreviewing", () => {
	it.each([
		[undefined, { atHome: true }, false],
		[undefined, { atHome: false }, false],
		[undefined, undefined, false],
		["android", { atHome: true }, true],
		["android", { atHome: false }, false],
		["android", undefined, false],
	] as const)(
		"on an app declaring %s opening %j shows the device home: %s",
		(declared, at, deviceHome) => {
			const { session } = stores(declared);
			session.getState().setPreviewing(true, at);
			const state = session.getState();
			expect(state.previewAtDeviceHome).toBe(deviceHome);
			expect(state.previewDeviceSyncedAt !== undefined).toBe(
				declared === "android",
			);
		},
	);

	it("keeps the chosen platform across a flip out and clears the run's facts", () => {
		const { session } = stores();
		session.getState().setPreviewing(true, { atHome: true });
		session.getState().setPreviewPlatform("android");
		session.getState().setPreviewing(false);
		const state = session.getState();
		expect(state.previewPlatform).toBe("android");
		expect(state.previewAtDeviceHome).toBe(false);
		expect(state.previewDeviceSyncedAt).toBeUndefined();
		session.getState().setPreviewing(true, { atHome: true });
		expect(session.getState().previewAtDeviceHome).toBe(true);
	});
});

describe("setPreviewPlatform", () => {
	it("clears the running navigation and opens Android at home", () => {
		const { session } = stores();
		session.getState().setPreviewing(true, { atHome: false });
		session.getState().setPreviewCaseTarget({
			formUuid: testUuid("platform-form"),
			cases: [{ caseId: "picked" }],
		});
		session.getState().setPreviewMenuCaseSelection(testUuid("platform-menu"), {
			caseType: "patient",
			cases: [{ caseId: "picked", caseName: "Asha", caseProperties: {} }],
		});
		session.getState().setPreviewPlatform("android");
		const state = session.getState();
		expect(state.previewPlatform).toBe("android");
		expect(state.previewCaseTarget).toBeUndefined();
		expect(state.previewMenuCaseSelections).toEqual({});
		expect(state.previewSearchStates).toEqual({});
		expect(state.previewAtDeviceHome).toBe(true);
		expect(state.previewDeviceSyncedAt).toBeTypeOf("number");
		session.getState().setPreviewPlatform("web-apps");
		expect(session.getState().previewAtDeviceHome).toBe(false);
		expect(session.getState().previewDeviceSyncedAt).toBeUndefined();
	});

	it.each([
		["android", "web-apps", true],
		["web-apps", "android", false],
	] as const)(
		"on an app running only on %s, choosing %s opens the platform it plays",
		(declared, chosen, deviceHome) => {
			const { session } = stores(declared);
			session.getState().setPreviewing(true, { atHome: false });
			session.getState().setPreviewPlatform(chosen);
			const state = session.getState();
			expect(state.previewAtDeviceHome).toBe(deviceHome);
			expect(state.previewDeviceSyncedAt !== undefined).toBe(deviceHome);
		},
	);

	it("resets on a confirmed Project change and on reset, keeping the install id", () => {
		const { session } = stores();
		const install = session.getState().previewAndroidDeviceId;
		session.getState().setPreviewPlatform("android");
		session.getState().applyAccessSnapshot({
			projectId: "other",
			role: "editor",
			canEdit: true,
		});
		expect(session.getState().previewPlatform).toBeUndefined();
		session.getState().setPreviewPlatform("android");
		session.getState().reset();
		expect(session.getState().previewPlatform).toBeUndefined();
		expect(session.getState().previewAndroidDeviceId).toBe(install);
	});

	it("sends a change of worker on Android to the device home", () => {
		const { session } = stores("android");
		session.getState().setPreviewing(true, { atHome: false });
		session.getState().setPreviewPersonaUuid(testUuid("platform-persona"));
		expect(session.getState().previewAtDeviceHome).toBe(true);
	});
});

describe("installEntryPointLaunch", () => {
	const formUuid = testUuid("platform-launch-form");
	const launch = (personaUuid?: string) => ({
		entryPointUuid: testUuid("platform-launch"),
		expectedSeq: 1,
		location: {
			kind: "form" as const,
			moduleUuid: testUuid("platform-launch-module"),
			formUuid,
		},
		...(personaUuid === undefined ? {} : { personaUuid }),
		menuSelections: {},
		formTarget: { formUuid, cases: [{ caseId: "launched" }] },
		ignoreDisplayConditions: false,
	});

	it("installs the launch under its worker, off the device home", () => {
		const { session } = stores();
		session.getState().setPreviewing(true, { atHome: true });
		const persona = testUuid("platform-launch-persona");
		session.getState().installEntryPointLaunch(launch(persona));
		const state = session.getState();
		expect(state.previewPersonaUuid).toBe(persona);
		expect(state.previewEntryPointLaunch?.personaUuid).toBe(persona);
		expect(state.previewCaseTarget).toEqual(launch(persona).formTarget);
		expect(state.previewAtDeviceHome).toBe(false);
	});

	it("advances Android's last sync on a launch", () => {
		const { session } = stores("android");
		session.getState().setPreviewing(true, { atHome: true });
		session.getState().markPreviewDeviceSynced(1);
		session.getState().installEntryPointLaunch(launch());
		expect(session.getState().previewDeviceSyncedAt).toBeGreaterThan(1);
	});
});
