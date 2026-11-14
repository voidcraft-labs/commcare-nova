import { describe, expect, it } from "vitest";
import type { Platform } from "@/lib/domain/platforms";
import {
	effectivePreviewPlatform,
	PREVIEW_PLATFORM_RULES,
	platformUnavailableSentence,
	previewPlatformRules,
	requiredMarkShown,
} from "../platform";

const BOTH: readonly Platform[] = ["web-apps", "android"];
const WEB_APPS: readonly Platform[] = ["web-apps"];
const ANDROID: readonly Platform[] = ["android"];

describe("effectivePreviewPlatform", () => {
	it.each([
		[BOTH, undefined, "web-apps"],
		[BOTH, "web-apps", "web-apps"],
		[BOTH, "android", "android"],
		[WEB_APPS, undefined, "web-apps"],
		[WEB_APPS, "web-apps", "web-apps"],
		[WEB_APPS, "android", "web-apps"],
		[ANDROID, undefined, "android"],
		[ANDROID, "web-apps", "android"],
		[ANDROID, "android", "android"],
	] as const)("plays %j with %s chosen as %s", (declared, chosen, expected) => {
		expect(effectivePreviewPlatform(declared, chosen)).toBe(expected);
	});

	it("derives a choice the app stopped declaring to the platform it still runs on", () => {
		const chosen: Platform = "android";
		expect(effectivePreviewPlatform(BOTH, chosen)).toBe("android");
		expect(effectivePreviewPlatform(WEB_APPS, chosen)).toBe("web-apps");
	});
});

describe("the rule table", () => {
	it("is frozen per platform and read through previewPlatformRules", () => {
		expect(Object.isFrozen(PREVIEW_PLATFORM_RULES["web-apps"])).toBe(true);
		expect(Object.isFrozen(PREVIEW_PLATFORM_RULES.android)).toBe(true);
		expect(previewPlatformRules("android")).toBe(
			PREVIEW_PLATFORM_RULES.android,
		);
		expect(previewPlatformRules("web-apps").formScreens).toBe("one-screen");
		expect(previewPlatformRules("android").recalculation).toBe("on-change");
	});
});

describe("the list filter and the required mark", () => {
	it("splits on single spaces, keeps the list's order and skips an empty box in Web Apps", () => {
		expect(previewPlatformRules("web-apps").listFilter).toEqual({
			terms: "single-spaces",
			fuzzyOrder: "closest-among-ties",
			emptyText: "skipped",
		});
		expect(previewPlatformRules("web-apps").requiredMark).toBe("always");
	});

	it("splits on runs of whitespace, puts the closest first and runs an edited empty box on Android", () => {
		expect(previewPlatformRules("android").listFilter).toEqual({
			terms: "whitespace-runs",
			fuzzyOrder: "closest-first",
			emptyText: "runs-once-edited",
		});
		expect(previewPlatformRules("android").requiredMark).toBe("by-setting");
	});
});

describe("requiredMarkShown", () => {
	it("marks every required question under always, whatever the setting", () => {
		expect(requiredMarkShown("always", null)).toBe(true);
		expect(requiredMarkShown("always", false)).toBe(true);
		expect(requiredMarkShown("always", true)).toBe(true);
	});

	it("marks one under by-setting only where the setting is on", () => {
		expect(requiredMarkShown("by-setting", null)).toBe(false);
		expect(requiredMarkShown("by-setting", false)).toBe(false);
		expect(requiredMarkShown("by-setting", true)).toBe(true);
	});
});

describe("platformUnavailableSentence", () => {
	it("names the platform the app runs on and how to use it", () => {
		expect(platformUnavailableSentence("web-apps", "a session")).toBe(
			"This app runs only on Android, so a session can't run in Web Apps. Leave platform out to use Android.",
		);
		expect(platformUnavailableSentence("android", "the form")).toBe(
			"This app runs only in Web Apps, so the form can't run on Android. Leave platform out to use Web Apps.",
		);
	});
});
