import {
	ANDROID_APP_NAMES,
	REQUIRED_ANDROID_APPS,
	type RequiredAndroidApp,
} from "@/lib/domain/requiredAndroidApps";

/** The identifiers HQ stores in its profile and Android asks its package manager about. */
const PACKAGE_IDS: Record<RequiredAndroidApp, string> = {
	"commcare-reminders": "org.commcare.dalvik.reminders",
	"commcare-ussd": "callout.commcare.org.sendussd",
	"biometrics-capture": "com.dimagi.biometric",
	"commcare-toolkit": "org.rdtoolkit",
	"area-calculator": "richard.chard.lu.android.areamapper",
	"breath-counter": "org.commcare.respiratory",
	"simprints-id": "com.simprints.id",
};

const appByPackage = new Map(
	REQUIRED_ANDROID_APPS.map((app) => [PACKAGE_IDS[app], app]),
);

export function requiredAndroidAppsFromProfile(
	value: unknown,
): RequiredAndroidApp[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const apps: RequiredAndroidApp[] = [];
	for (const id of value) {
		const app = typeof id === "string" ? appByPackage.get(id) : undefined;
		if (app === undefined || apps.includes(app)) return undefined;
		apps.push(app);
	}
	return apps;
}

/** An existing selection a legacy publish never owned. Its replacement needs the current source digest. */
export function changesUnownedAndroidApps(
	features: unknown,
	wanted: readonly RequiredAndroidApp[] = [],
): boolean {
	if (
		!features ||
		typeof features !== "object" ||
		!Object.hasOwn(features, "dependencies")
	)
		return false;
	const existing = requiredAndroidAppsFromProfile(
		(features as Record<string, unknown>).dependencies,
	);
	if (existing === undefined) return true;
	if (existing.length === 0) return false;
	return (
		existing.length !== wanted.length ||
		existing.some((app, i) => app !== wanted[i])
	);
}

export function requiredAndroidPackages(
	apps: readonly RequiredAndroidApp[] = [],
) {
	return apps.map((app) => ({
		id: PACKAGE_IDS[app],
		name: ANDROID_APP_NAMES[app],
	}));
}
