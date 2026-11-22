import { z } from "zod";

/** Apps a worker can be asked to install before opening this app on Android. */
export const REQUIRED_ANDROID_APPS = [
	"commcare-reminders",
	"commcare-ussd",
	"biometrics-capture",
	"commcare-toolkit",
	"area-calculator",
	"breath-counter",
	"simprints-id",
] as const;

export type RequiredAndroidApp = (typeof REQUIRED_ANDROID_APPS)[number];

export const ANDROID_APP_NAMES: Record<RequiredAndroidApp, string> = {
	"commcare-reminders": "CommCare Reminders",
	"commcare-ussd": "CommCare USSD",
	"biometrics-capture": "Biometrics Capture",
	"commcare-toolkit": "CommCare Toolkit",
	"area-calculator": "Area Calculator for CommCare",
	"breath-counter": "Breath Counter",
	"simprints-id": "Simprints ID",
};

export const requiredAndroidAppsSchema = z
	.array(z.enum(REQUIRED_ANDROID_APPS))
	.max(REQUIRED_ANDROID_APPS.length)
	.refine((apps) => new Set(apps).size === apps.length, {
		error: "Each Android app can appear once in the list.",
	});

/** Android checks all selected apps before it offers the worker an entry. */
export function missingAndroidApps(
	platform: "web-apps" | "android",
	required: readonly RequiredAndroidApp[] = [],
	installed: readonly RequiredAndroidApp[] = [],
): RequiredAndroidApp[] {
	return platform === "android"
		? required.filter((app) => !installed.includes(app))
		: [];
}
