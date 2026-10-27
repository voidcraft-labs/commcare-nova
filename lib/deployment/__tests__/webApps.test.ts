/**
 * Pure: when a publish asks about the app's Web App setting, and the two
 * stops that read the setting HQ holds. The plausible failures: a question
 * over an empty shell (its fill writes the declaration with no question), a
 * question that never stops asking once answered, an answer that outlives
 * the value it agreed to, a `changedInHq` that blames the wrong side, and a
 * baseline read that takes an absent or non-boolean value as on.
 */
import { describe, expect, it } from "vitest";
import type { HqAppSource } from "@/lib/commcare/hq/appSource";
import {
	baselineWebApps,
	createdWithoutWebApps,
	type WebAppsChangeInput,
	webAppsChange,
	webAppsMovedDuringPush,
} from "../webApps";

function source(cloudcareEnabled: boolean): HqAppSource {
	return {
		docType: "Application",
		buildSpecVersion: "2.57.0",
		cloudcareEnabled,
		logoRefs: {},
		profile: {},
		langs: ["en"],
		translations: {},
		addOns: {},
		modules: [],
		raw: {},
	};
}

const pushed = (cloudcareEnabled: unknown) => ({
	origin: "push" as const,
	source: { doc_type: "Application", cloudcare_enabled: cloudcareEnabled },
});

function ask(overrides: Partial<WebAppsChangeInput>) {
	return webAppsChange({
		declaresWebApps: true,
		held: false,
		baseline: pushed(true),
		confirmWebApps: undefined,
		...overrides,
	});
}

describe("webAppsChange", () => {
	it("never asks over the empty app a first publish made", () => {
		for (const held of [true, false]) {
			expect(
				ask({ held, baseline: { origin: "create", source: {} } }),
			).toBeNull();
		}
	});

	it("never asks where HQ already holds the declaration", () => {
		expect(ask({ declaresWebApps: true, held: true })).toBeNull();
		expect(
			ask({ declaresWebApps: false, held: false, baseline: pushed(true) }),
		).toBeNull();
	});

	it("passes once the person answers with the declaration", () => {
		expect(ask({ confirmWebApps: true })).toBeNull();
		expect(
			ask({ declaresWebApps: false, held: true, confirmWebApps: false }),
		).toBeNull();
	});

	it("still asks where the answer is the old value, since the declaration moved since", () => {
		expect(ask({ confirmWebApps: false })).toEqual({
			from: false,
			to: true,
			changedInHq: true,
		});
	});

	it("says someone changed it in CommCare HQ where the baseline held the other value", () => {
		expect(ask({ baseline: pushed(true) })).toEqual({
			from: false,
			to: true,
			changedInHq: true,
		});
		expect(
			ask({
				declaresWebApps: true,
				held: false,
				baseline: { origin: "cutover", source: { cloudcare_enabled: true } },
			}),
		).toEqual({ from: false, to: true, changedInHq: true });
	});

	it("says the declaration moved where the baseline held the same value", () => {
		expect(
			ask({ declaresWebApps: false, held: true, baseline: pushed(true) }),
		).toEqual({ from: true, to: false, changedInHq: false });
	});

	it("cannot tell who moved it over an unread baseline or none", () => {
		for (const baseline of [
			{ origin: "unread" as const },
			null,
		] satisfies WebAppsChangeInput["baseline"][]) {
			expect(ask({ baseline })).toEqual({
				from: false,
				to: true,
				changedInHq: null,
			});
		}
	});
});

describe("baselineWebApps", () => {
	it("reads on only from a true cloudcare_enabled, as HQ reads an absent value", () => {
		expect(baselineWebApps({ cloudcare_enabled: true })).toBe(true);
		for (const held of [
			{ cloudcare_enabled: false },
			{},
			{ cloudcare_enabled: "true" },
			{ cloudcare_enabled: 1 },
			null,
			"source",
		]) {
			expect(baselineWebApps(held)).toBe(false);
		}
	});
});

describe("createdWithoutWebApps", () => {
	it("stops only an app that runs in Web Apps whose new app reads Web Apps off", () => {
		expect(
			createdWithoutWebApps({ declaresWebApps: true, shell: source(false) }),
		).toBe(true);
		expect(
			createdWithoutWebApps({ declaresWebApps: true, shell: source(true) }),
		).toBe(false);
		for (const on of [true, false]) {
			expect(
				createdWithoutWebApps({ declaresWebApps: false, shell: source(on) }),
			).toBe(false);
		}
	});
});

describe("webAppsMovedDuringPush", () => {
	it("is a move exactly where the second read differs from the held one", () => {
		expect(webAppsMovedDuringPush(source(true), source(false))).toBe(true);
		expect(webAppsMovedDuringPush(source(false), source(true))).toBe(true);
		expect(webAppsMovedDuringPush(source(true), source(true))).toBe(false);
		expect(webAppsMovedDuringPush(source(false), source(false))).toBe(false);
	});
});
