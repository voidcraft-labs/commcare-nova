/**
 * Turning on Connect sets the app to Android only in the same batch.
 *
 * Contract (`lib/session/store.ts::switchConnectMode`): a Connect app runs on
 * Android only, so enabling Connect in an app that runs in Web Apps commits
 * Connect and `runsOnlyOn: "android"` as one undo step; a Learn to Deliver
 * switch adds no settings mutation; turning Connect off never widens the
 * declaration; and when the narrowing strands something Android can't run,
 * the gate refuses the whole batch and nothing commits. Driven through the
 * real doc store and session store, as the dialogs drive them.
 */

import { afterEach, describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { createBlueprintDocStore } from "@/lib/doc/store";
import type { Mutation } from "@/lib/doc/types";
import { type AppSettings, NEW_APP_SETTINGS } from "@/lib/domain";
import { toastStore } from "@/lib/ui/toastStore";
import { type ConnectSwitchRequest, createBuilderSessionStore } from "../store";

afterEach(() => toastStore.clear());

const NO_LOOKUPS: Pick<ConnectSwitchRequest, "lookupContext"> = {
	lookupContext: LOOKUP_CONTEXT_UNAVAILABLE,
};

const FORM_A = testUuid("connect-platforms-form-a");
const FORM_B = testUuid("connect-platforms-form-b");

function stores(options: {
	readonly appSettings: AppSettings;
	readonly searchFirst?: boolean;
}) {
	const docStore = createBlueprintDocStore();
	docStore.getState().load(
		buildDoc({
			appId: "connect-platforms",
			appName: "Connect platforms",
			appSettings: options.appSettings,
			caseTypes: [
				{
					name: "patient",
					properties: [{ name: "case_name", label: "Name" }],
				},
			],
			modules: [
				{
					uuid: testUuid("connect-platforms-module"),
					name: "Patients",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					...(options.searchFirst === true && {
						caseSearchConfig: { searchFirst: true },
					}),
					forms: [
						{
							uuid: FORM_A,
							name: "Learn A",
							type: "survey",
							fields: [f({ kind: "text", id: "question_a" })],
						},
						{
							uuid: FORM_B,
							name: "Learn B",
							type: "survey",
							fields: [f({ kind: "text", id: "question_b" })],
						},
					],
				},
			],
		}),
	);
	docStore.getState().startTracking();
	const session = createBuilderSessionStore();
	session.getState()._setDocStore(docStore);
	return { doc: docStore, session };
}

const LEARN_BLOCKS = {
	[FORM_A]: {
		learn_module: {
			id: "learn_a",
			name: "Learn A",
			description: "The first module",
			time_estimate: 5,
		},
	},
};

const DELIVER_BLOCKS = {
	[FORM_A]: { deliver_unit: { id: "visit_a", name: "Visit A" } },
};

function settingsMutations(batch: Iterable<Mutation>) {
	return [...batch].filter((mutation) => mutation.kind === "setAppSettings");
}

describe("turning on Connect sets the app to Android only", () => {
	it("commits Connect and the Android-only declaration as one undo step in an app that runs on both", () => {
		const { doc, session } = stores({ appSettings: NEW_APP_SETTINGS });

		const outcome = session.getState().switchConnectMode({
			type: "learn",
			blocks: LEARN_BLOCKS,
			...NO_LOOKUPS,
		});

		expect(outcome).toEqual({ ok: true });
		expect(doc.getState().connectType).toBe("learn");
		expect(doc.getState().appSettings.runsOnlyOn).toBe("android");

		doc.getState().undo();
		expect(doc.getState().connectType).toBeNull();
		expect(doc.getState().appSettings.runsOnlyOn).toBeUndefined();
		expect(doc.getState().canUndo).toBe(false);
	});

	it("keeps the app on Android only when Connect is turned off", () => {
		const { doc, session } = stores({ appSettings: NEW_APP_SETTINGS });
		session.getState().switchConnectMode({
			type: "learn",
			blocks: LEARN_BLOCKS,
			...NO_LOOKUPS,
		});

		const outcome = session
			.getState()
			.switchConnectMode({ type: null, ...NO_LOOKUPS });

		expect(outcome).toEqual({ ok: true });
		expect(doc.getState().connectType).toBeNull();
		expect(doc.getState().appSettings.runsOnlyOn).toBe("android");
	});

	it("adds no settings change when switching from Learn to Deliver", () => {
		const { doc, session } = stores({
			appSettings: { ...NEW_APP_SETTINGS, runsOnlyOn: "android" },
		});
		session.getState().switchConnectMode({
			type: "learn",
			blocks: LEARN_BLOCKS,
			...NO_LOOKUPS,
		});
		const queuedBefore = doc.getState().peekCommandBatches().length;

		const outcome = session.getState().switchConnectMode({
			type: "deliver",
			blocks: DELIVER_BLOCKS,
			...NO_LOOKUPS,
		});

		expect(outcome).toEqual({ ok: true });
		const switched = doc.getState().peekCommandBatches().slice(queuedBefore);
		expect(switched).toHaveLength(1);
		expect(switched.flatMap(settingsMutations)).toEqual([]);
		expect(doc.getState().connectType).toBe("deliver");
		expect(doc.getState().appSettings.runsOnlyOn).toBe("android");
	});

	it("refuses, and commits nothing, when the app holds something Android can't run", () => {
		const { doc, session } = stores({
			appSettings: { ...NEW_APP_SETTINGS, runsOnlyOn: "web-apps" },
			searchFirst: true,
		});
		const before = doc.getState();

		const outcome = session.getState().switchConnectMode({
			type: "learn",
			blocks: LEARN_BLOCKS,
			...NO_LOOKUPS,
			announce: false,
		});

		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.messages.join(" ")).toMatch(/Android/);
		expect(doc.getState()).toBe(before);
		expect(doc.getState().connectType).toBeNull();
		expect(doc.getState().appSettings.runsOnlyOn).toBe("web-apps");
	});
});
