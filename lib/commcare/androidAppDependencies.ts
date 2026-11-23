import {
	ANDROID_APP_NAMES,
	type AndroidAppLabels,
	REQUIRED_ANDROID_APPS,
	type RequiredAndroidApp,
} from "@/lib/domain/requiredAndroidApps";

import { readLocaleValueAsCore } from "./localeFile";

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

export function targetAndroidAppLabels(
	text: Readonly<Record<string, Readonly<Record<string, string>>>>,
): AndroidAppLabels | undefined {
	const entries = Object.entries(text).flatMap(([language, strings]) => {
		const names = REQUIRED_ANDROID_APPS.flatMap((app) => {
			const key = `android.package.name.${PACKAGE_IDS[app]}`;
			if (!Object.hasOwn(strings, key)) return [];
			const shown = readLocaleValueAsCore(key, strings[key]);
			return shown === undefined ? [] : [[app, shown] as const];
		});
		return names.length ? [[language, Object.fromEntries(names)] as const] : [];
	});
	return entries.length ? Object.fromEntries(entries) : undefined;
}

export function requiredAndroidPackages(
	apps: readonly RequiredAndroidApp[] = [],
) {
	return apps.map((app) => ({
		id: PACKAGE_IDS[app],
		name: ANDROID_APP_NAMES[app],
	}));
}

/** The `profile.features` object a source holds, or null where it holds none. */
function profileFeaturesOf(source: unknown): Record<string, unknown> | null {
	if (!source || typeof source !== "object" || Array.isArray(source))
		return null;
	const profile = (source as Record<string, unknown>).profile;
	if (!profile || typeof profile !== "object" || Array.isArray(profile))
		return null;
	const features = (profile as Record<string, unknown>).features;
	if (!features || typeof features !== "object" || Array.isArray(features))
		return null;
	return features as Record<string, unknown>;
}

/**
 * Whether CommCare HQ dropped the Android apps `earlier` named because the
 * project space lost App Dependencies, rather than a person emptying them.
 * Every settings save in a project space without the privilege deletes the
 * key (`app_manager/views/settings.py::edit_commcare_profile`), while the
 * settings page saves a cleared picker as `[]` (`commcare_settings.js`'s
 * `valueToSave` posts the multiSelect's empty list, which the same view
 * writes as given). So a selection the earlier read held, whose key the read
 * now lacks, is a lost privilege; a present `[]` is a person's choice.
 */
export function androidRequirementsPrivilegeLost(
	earlier: unknown,
	now: unknown,
): boolean {
	const before = profileFeaturesOf(earlier)?.dependencies;
	if (!Array.isArray(before) || before.length === 0) return false;
	const after = profileFeaturesOf(now);
	return after === null || !Object.hasOwn(after, "dependencies");
}

/** Before Nova owned this profile selection, the raw HQ baseline could
 * already name worker apps absent from the published document. A take
 * compares this one setting to that document. The original HQ observation
 * and its digest still bind confirmation, re-reads and the deployment log. */
export function androidRequirementsComparisonSource(
	source: unknown,
	required: readonly RequiredAndroidApp[] | undefined,
): unknown {
	if (!source || typeof source !== "object" || Array.isArray(source))
		return source;
	const raw = source as Record<string, unknown>;
	const profile = raw.profile;
	if (
		profile !== undefined &&
		(!profile || typeof profile !== "object" || Array.isArray(profile))
	)
		return source;
	const stored = (profile ?? {}) as Record<string, unknown>;
	const features = stored.features;
	if (
		features !== undefined &&
		(!features || typeof features !== "object" || Array.isArray(features))
	)
		return source;
	const projected = { ...(features as Record<string, unknown> | undefined) };
	const packages = requiredAndroidPackages(required).map((app) => app.id);
	if (packages.length) projected.dependencies = packages;
	else delete projected.dependencies;
	return { ...raw, profile: { ...stored, features: projected } };
}
