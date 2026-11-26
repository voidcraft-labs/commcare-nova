/**
 * The list a baseline keeps of what the first publish changes, as it stands
 * for where the app runs now. Pure. The plausible failures: a stored Web
 * Apps line that says Web Apps is turned off for an app that now runs in
 * it, lines out of registry order, a worker reassurance over a list whose
 * lines a worker meets, and a stored value of a shape the store would read
 * as a list.
 */
import { describe, expect, it } from "vitest";
import {
	FIRST_PUBLISH_CHANGE_IDS,
	type FirstPublishChangeId,
	firstPublishSentenceId,
	firstPublishViewFromStored,
	type StoredFirstPublish,
	storedFirstPublishSchema,
} from "../firstPublishChangeIds";

function stored(
	ids: readonly FirstPublishChangeId[],
	webAppsOnInHq: boolean,
	of: StoredFirstPublish["of"] = "first-publish",
): StoredFirstPublish {
	return { ids, webAppsOnInHq, of };
}

describe("firstPublishViewFromStored", () => {
	it("shows the recorded location change only while Connect is enabled", () => {
		const id = "connect-app-captures-location";
		const appSettings = { showIncompleteForms: false };
		for (const kind of ["first-publish", "next-publish"] as const) {
			const recorded = stored([id], true, kind);
			const absent = stored([], true, kind);
			for (const connectRoles of [
				["learn"],
				[],
				["deliver"],
				["learn", "deliver"],
			] as const) {
				const app = { appSettings, connectRoles: [...connectRoles] };
				const shown = firstPublishViewFromStored(recorded, app);
				expect(shown.ids).toEqual(connectRoles.length === 0 ? [] : [id]);
				expect(shown.touchesWorkers).toBe(connectRoles.length > 0);
				expect(firstPublishViewFromStored(absent, app).ids).toEqual([]);
			}
		}
	});

	it("works the Web Apps line out again from where the app runs now", () => {
		const list = stored(["forms-and-settings-rewritten"], true);
		expect(
			firstPublishViewFromStored(list, {
				connectRoles: [],
				appSettings: {
					runsOnlyOn: "android",
					showIncompleteForms: false,
				},
			}),
		).toEqual({
			ids: ["forms-and-settings-rewritten", "web-apps-turned-off"],
			touchesWorkers: true,
			of: "first-publish",
		});
		for (const runsOnlyOn of ["web-apps", undefined] as const) {
			expect(
				firstPublishViewFromStored(list, {
					connectRoles: [],
					appSettings: {
						runsOnlyOn,
						showIncompleteForms: false,
					},
				}),
			).toEqual({
				ids: ["forms-and-settings-rewritten"],
				touchesWorkers: false,
				of: "first-publish",
			});
		}
		const off = stored(["forms-and-settings-rewritten"], false);
		for (const runsOnlyOn of ["web-apps", undefined] as const) {
			expect(
				firstPublishViewFromStored(off, {
					connectRoles: [],
					appSettings: {
						runsOnlyOn,
						showIncompleteForms: false,
					},
				}).ids,
			).toEqual(["forms-and-settings-rewritten", "web-apps-turned-on"]);
		}
		expect(
			firstPublishViewFromStored(off, {
				connectRoles: [],
				appSettings: {
					runsOnlyOn: "android",
					showIncompleteForms: false,
				},
			}).ids,
		).toEqual(["forms-and-settings-rewritten"]);
	});

	it("never repeats a Web Apps line a list stored, and keeps registry order", () => {
		const list = stored(
			[
				"text-spaces-dropped",
				"web-apps-turned-on",
				"forms-and-settings-rewritten",
				"web-apps-turned-off",
				"names-respelled",
			],
			true,
			"next-publish",
		);
		const view = firstPublishViewFromStored(list, {
			connectRoles: [],
			appSettings: {
				runsOnlyOn: "web-apps",
				showIncompleteForms: false,
			},
		});
		expect(view).toEqual({
			ids: [
				"forms-and-settings-rewritten",
				"names-respelled",
				"text-spaces-dropped",
			],
			touchesWorkers: true,
			of: "next-publish",
		});
		const order = view.ids.map((id) => FIRST_PUBLISH_CHANGE_IDS.indexOf(id));
		expect(order).toEqual([...order].sort((a, b) => a - b));
	});
});

describe("storedFirstPublishSchema", () => {
	it("reads exactly the three keys, with registered ids", () => {
		const value = stored(["hidden-values-added"], false);
		expect(storedFirstPublishSchema.parse(value)).toEqual(value);
		for (const malformed of [
			{ ...value, extra: true },
			{ ids: ["not-registered"], webAppsOnInHq: false, of: "first-publish" },
			{ ids: [], webAppsOnInHq: "no", of: "first-publish" },
			{ ids: [], webAppsOnInHq: false, of: "later" },
			null,
		]) {
			expect(storedFirstPublishSchema.safeParse(malformed).success).toBe(false);
		}
	});
});

describe("firstPublishSentenceId", () => {
	it("names the sentence that says each id", () => {
		expect(firstPublishSentenceId("names-respelled")).toBe(
			"forms-and-settings-rewritten",
		);
		expect(firstPublishSentenceId("text-spaces-dropped")).toBe(
			"text-spaces-dropped",
		);
	});
});
