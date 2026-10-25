import { describe, expect, it } from "vitest";
import type { Platform } from "@/lib/domain/platforms";
import {
	effectivePreviewPlatform,
	PREVIEW_PLATFORM_RULES,
	platformUnavailableSentence,
	previewPlatformRules,
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
