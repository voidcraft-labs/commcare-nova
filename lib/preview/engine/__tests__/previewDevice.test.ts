import { describe, expect, it } from "vitest";
import { NEW_APP_SETTINGS } from "@/lib/domain";
import {
	APP_TEST_WINDOW_WIDTH,
	defaultPreviewDevice,
	previewDeviceContext,
	previewDeviceInput,
	serverPreviewDevice,
} from "../previewDevice";

const ID = "8b6a3c0e-7f3a-4d5b-9c2e-1a2b3c4d5e6f";
const REFUSAL =
	"Preview sent the device it runs on in a shape it cannot read. It expects a platform, a device id, a language code and, in Web Apps, a window width. Check the caller that builds the device from the session store.";

describe("previewDeviceInput", () => {
	it("admits each platform's shape", () => {
		expect(
			previewDeviceInput({
				platform: "web-apps",
				androidDeviceId: ID,
				appLanguage: "en",
				windowWidth: 1024,
			}),
		).toEqual({
			platform: "web-apps",
			androidDeviceId: ID,
			appLanguage: "en",
			windowWidth: 1024,
		});
		expect(
			previewDeviceInput({
				platform: "android",
				androidDeviceId: ID,
				appLanguage: "es",
			}),
		).toEqual({ platform: "android", androidDeviceId: ID, appLanguage: "es" });
	});

	it.each([
		[
			"a width on Android",
			{
				platform: "android",
				androidDeviceId: ID,
				appLanguage: "en",
				windowWidth: 320,
			},
		],
		[
			"a device id that is no UUID",
			{ platform: "web-apps", androidDeviceId: "phone", appLanguage: "en" },
		],
		["a value that is no object", "web-apps"],
		[
			"an undeclared platform name",
			{ platform: "ios", androidDeviceId: ID, appLanguage: "en" },
		],
		[
			"a fractional width",
			{
				platform: "web-apps",
				androidDeviceId: ID,
				appLanguage: "en",
				windowWidth: 10.5,
			},
		],
	])("refuses %s with the sentence", (_label, value) => {
		expect(() => previewDeviceInput(value)).toThrow(REFUSAL);
	});
});

describe("the device's session values", () => {
	it("are Formplayer's on Web Apps and the install's on Android", () => {
		expect(
			previewDeviceContext({
				platform: "web-apps",
				androidDeviceId: ID,
				appLanguage: "en",
				windowWidth: 800,
			}),
		).toEqual({
			deviceid: "Formplayer",
			appversion: "Formplayer Version: 2.64",
			drift: "0",
			window_width: "800",
			applanguage: "en",
		});
		expect(
			previewDeviceContext({
				platform: "android",
				androidDeviceId: ID,
				appLanguage: "es",
			}),
		).toEqual({
			deviceid: `commcare_${ID}`,
			appversion:
				'CommCare Android, version "2.65.0"(). App v. CommCare Version 2.65.0. Build , built on: ',
			drift: "0",
			applanguage: "es",
		});
	});

	it("gives a windowless journey a 1280-wide Web Apps window and none on Android", () => {
		expect(
			serverPreviewDevice({ platform: "web-apps", appLanguage: "en" })
				.windowWidth,
		).toBe(APP_TEST_WINDOW_WIDTH);
		const android = serverPreviewDevice({
			platform: "android",
			appLanguage: "en",
			androidDeviceId: ID,
		});
		expect(android).toEqual({
			platform: "android",
			androidDeviceId: ID,
			appLanguage: "en",
		});
	});
});

describe("defaultPreviewDevice", () => {
	it.each([
		[undefined, "web-apps"],
		["web-apps", "web-apps"],
		["android", "android"],
	] as const)(
		"plays an app running only on %s on %s",
		(runsOnlyOn, platform) => {
			const device = defaultPreviewDevice(
				{
					localization: undefined,
					appSettings:
						runsOnlyOn === undefined
							? NEW_APP_SETTINGS
							: { ...NEW_APP_SETTINGS, runsOnlyOn },
				},
				undefined,
			);
			expect(device.platform).toBe(platform);
			expect(device.windowWidth).toBeUndefined();
		},
	);

	it("plays both platforms' default without a document", () => {
		expect(defaultPreviewDevice(undefined, undefined).platform).toBe(
			"web-apps",
		);
	});
});
