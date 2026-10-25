// lib/preview/deviceHome.ts
//
// The buttons of Android's home screen, as Preview plays them
// (`activities/HomeButtons.java::buildButtonData`, in its order). Start and
// Sync with server work. Saved and Incomplete show as the app's settings
// show them on a phone (Nova always writes `<checkoff active="true"/>`, so
// `StandardHomeActivityUIController.java::getHiddenButtons` reduces to the
// setting) and Log out of CommCare always shows; the three are disabled with
// a reason, since Preview keeps no form archive or resume and chooses its
// worker from Running as. Training, View Job Status and Report an Issue never
// show for a Nova app: Nova writes no training module, no Connect job and no
// `cc-home-report`.
//
// Labels are runtime messages in the worker's language; reasons are Nova's
// own words, in English. App Tests' device home and Preview's home screen
// read this one list.

import type { AppSettings } from "@/lib/domain/blueprint";
import type { LanguageTag } from "@/lib/domain/localization";
import { type RuntimeMessage, runtimeMessage } from "./runtimeMessages";

export type DeviceHomeButtonKey =
	| "deviceHomeStart"
	| "deviceHomeSaved"
	| "deviceHomeIncomplete"
	| "deviceHomeSync"
	| "deviceHomeLogOut";

export interface DeviceHomeButton {
	readonly key: DeviceHomeButtonKey & RuntimeMessage;
	readonly label: string;
	readonly available: boolean;
	/** Why a disabled button does nothing in Preview. */
	readonly reason?: string;
}

export const DEVICE_HOME_REASONS = {
	deviceHomeSaved:
		"Preview doesn't keep sent forms. On a phone, this lists them.",
	deviceHomeIncomplete:
		"Preview doesn't keep unfinished forms. On a phone, this lists them.",
	deviceHomeLogOut:
		"In Preview, you can choose the worker from Running as at the top",
} as const;

/** The buttons the phone shows for an app with these settings, in order. */
export function deviceHomeButtons(
	appSettings: Pick<AppSettings, "showSavedForms" | "showIncompleteForms">,
	language: LanguageTag | null | undefined,
): readonly DeviceHomeButton[] {
	const button = (
		key: DeviceHomeButtonKey,
		reason?: string,
	): DeviceHomeButton => ({
		key,
		label: runtimeMessage(language, key),
		available: reason === undefined,
		...(reason === undefined ? {} : { reason }),
	});
	return [
		button("deviceHomeStart"),
		...(appSettings.showSavedForms
			? [button("deviceHomeSaved", DEVICE_HOME_REASONS.deviceHomeSaved)]
			: []),
		...(appSettings.showIncompleteForms
			? [
					button(
						"deviceHomeIncomplete",
						DEVICE_HOME_REASONS.deviceHomeIncomplete,
					),
				]
			: []),
		button("deviceHomeSync"),
		button("deviceHomeLogOut", DEVICE_HOME_REASONS.deviceHomeLogOut),
	];
}
