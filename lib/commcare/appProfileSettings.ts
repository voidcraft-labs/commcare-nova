/**
 * The seventeen profile settings every Nova app states, on both export paths.
 *
 * `expandDoc` writes them into `profile.properties` as `{ key: value }`, and
 * HQ's build adds each setting's own `force` (`Application.create_profile`,
 * `static/app_manager/json/commcare-profile-settings.yml`). The local
 * profile writes each as `<property key value force="true"/>`, or without
 * `force` where HQ's definition has none. One list feeds both, so the two
 * paths never state different values for one document.
 *
 * Two are the app's own settings, `appSettings.showSavedForms` and
 * `showIncompleteForms`. The other fifteen are constants at the value a
 * device reads when the key is absent, so writing them changes nothing a
 * device does from install, and HQ's settings page keeps each, since each is
 * one of the setting's own choices. Every forced one is written again at an
 * update, on both paths, so fuzzy search, automatic updates and text to
 * speech, which a worker can also set, return to these values then; the map
 * layer, written without `force`, keeps the worker's. On a publish they are seeded, not owned:
 * the overlay (`targetOverlay.ts::projectProfileForTarget`) keeps a value the
 * target already holds for any of the fifteen, and always writes Nova's two.
 */

import type { BlueprintDoc } from "@/lib/domain";

export interface AppProfileProperty {
	readonly key: string;
	readonly value: string;
	/** HQ's own `force` for the setting. */
	readonly force: boolean;
}

/** The two settings Nova holds, which a publish always writes at Nova's value. */
export const OWNED_PROFILE_PROPERTY_KEYS = [
	"cc-show-saved",
	"cc-show-incomplete",
] as const;

/**
 * The fifteen constants, in profile order, each at the value a device reads
 * for an absent key (commcare-android's reader of each, and Formplayer's
 * where it reads one).
 */
export const SEEDED_PROFILE_PROPERTIES: readonly AppProfileProperty[] = [
	{ key: "cc-fuzzy-search-enabled", value: "no", force: true },
	{ key: "cc-gps-auto-capture-accuracy", value: "10", force: true },
	{ key: "cc-content-valid", value: "no", force: true },
	{ key: "cc-autoup-freq", value: "freq-never", force: true },
	{ key: "cc-enable-tts", value: "no", force: true },
	{ key: "cc-autosync-freq", value: "freq-never", force: true },
	{ key: "cc-days-form-retain", value: "-1", force: true },
	{ key: "cc-inflation-target-density", value: "none", force: true },
	{
		key: "cc-label-required-questions-with-asterisk",
		value: "no",
		force: true,
	},
	{ key: "cc-login-duration-seconds", value: "86400", force: true },
	{ key: "cc-maps-default-layer", value: "normal", force: false },
	{ key: "cc-resize-images", value: "none", force: true },
	{ key: "logenabled", value: "Enabled", force: true },
	{ key: "unsent-number-limit", value: "5", force: true },
	{ key: "unsent-time-limit", value: "5", force: true },
];

function yesNo(value: boolean): string {
	return value ? "yes" : "no";
}

/** The seventeen settings of one document, in profile order. */
export function appProfileProperties(
	doc: Pick<BlueprintDoc, "appSettings">,
): readonly AppProfileProperty[] {
	return [
		...SEEDED_PROFILE_PROPERTIES,
		{
			key: "cc-show-saved",
			value: yesNo(doc.appSettings.showSavedForms),
			force: true,
		},
		{
			key: "cc-show-incomplete",
			value: yesNo(doc.appSettings.showIncompleteForms),
			force: true,
		},
	];
}
