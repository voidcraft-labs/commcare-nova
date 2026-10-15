/**
 * Step `app-settings`, the last of the fixed order and the one step that
 * takes values read from CommCare HQ: writes `appSettings`, which every
 * export states as the profile's `cc-show-saved` and `cc-show-incomplete`.
 *
 * Only a deployment whose source the cutover read (`read-in-full` or
 * `no-form-ids`) is counted; a deleted, linked or unreadable one is not,
 * since nothing will be published over it from what it holds. The rule keeps
 * each list on wherever some reader shows it on some read deployment today,
 * so the next publish takes no list away from any worker:
 *
 * - `showSavedForms` is `true` when some counted deployment holds `"yes"` for
 *   `cc-show-saved` (Android, its one reader, shows the list only then), and
 *   `false` otherwise;
 * - `showIncompleteForms` is `false` when at least one deployment is counted
 *   and every one holds `"no"` for `cc-show-incomplete` (the Web Apps client
 *   shows its tile unless the value is `"no"`), and `true` otherwise.
 *
 * With no deployment counted each setting is what a Nova `.ccz` shows today:
 * saved forms hidden, incomplete forms shown. An app with a counted
 * deployment gets one `android-form-lists-setting-stored` line naming both
 * values; an app with none gets no line, since its local archive already
 * shows what it stores.
 */

import type { JsonRecord } from "../oldShape";
import type { CutoverStep, DeploymentOutcome } from "../transform";

/** The classes whose source the cutover read, so whose profile it counts. */
const COUNTED: ReadonlySet<DeploymentOutcome> = new Set([
	"read-in-full",
	"no-form-ids",
]);

function onOff(value: boolean): "on" | "off" {
	return value ? "on" : "off";
}

export const appSettingsStep: CutoverStep = {
	id: "app-settings",
	apply(document, context) {
		if (document.appSettings !== undefined) return [];
		const counted = context.deployments.filter((deployment) =>
			COUNTED.has(deployment.outcome),
		);
		const showSavedForms = counted.some(
			(deployment) => deployment.profileProperties?.["cc-show-saved"] === "yes",
		);
		const showIncompleteForms = !(
			counted.length > 0 &&
			counted.every(
				(deployment) =>
					deployment.profileProperties?.["cc-show-incomplete"] === "no",
			)
		);
		const appSettings: JsonRecord = { showSavedForms, showIncompleteForms };
		(document as { appSettings?: JsonRecord }).appSettings = appSettings;
		if (counted.length === 0) return [];
		return [
			{
				reason: "android-form-lists-setting-stored",
				entity: { type: "app", nameAtMigration: document.appName },
				detail: {
					saved: onOff(showSavedForms),
					incomplete: onOff(showIncompleteForms),
				},
			},
		];
	},
};
