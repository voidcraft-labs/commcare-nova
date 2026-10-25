// Devices and rule tables the Preview suites run their engines and reads on.
// An engine built without a device plays Web Apps; a suite whose subject is
// Android's paging, recalculation or day numbers passes `androidDevice()`.

import {
	type PreviewPlatformRules,
	previewPlatformRules,
} from "../../../platform";
import type { PreviewDevice } from "../../previewDevice";

export const TEST_ANDROID_DEVICE_ID = "0f8c1a52-6d3e-4b7a-9c21-5e4d3b2a1f00";

export function webAppsDevice(appLanguage = "en"): PreviewDevice {
	return {
		platform: "web-apps",
		androidDeviceId: TEST_ANDROID_DEVICE_ID,
		appLanguage,
	};
}

export function androidDevice(appLanguage = "en"): PreviewDevice {
	return {
		platform: "android",
		androidDeviceId: TEST_ANDROID_DEVICE_ID,
		appLanguage,
	};
}

export const WEB_APPS_RULES: PreviewPlatformRules =
	previewPlatformRules("web-apps");
export const ANDROID_RULES: PreviewPlatformRules =
	previewPlatformRules("android");
