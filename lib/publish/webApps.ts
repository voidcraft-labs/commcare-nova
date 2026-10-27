/**
 * The Web Apps question a publish asks, in public vocabulary.
 *
 * Safe for browser, HTTP and MCP consumers. A publish writes the app's Web
 * App setting on CommCare HQ from where the app runs, and asks a person
 * before an update changes the value HQ holds (`hq_web_apps_change`). A first
 * publish whose new app HQ made with Web Apps off, for an app that runs in
 * Web Apps, stops (`hq_plan_lacks_web_apps`). This module holds the change's
 * shape and every sentence those two stops say.
 */

import { namesInWords, type PlatformNarrowing } from "./planFeatures";

/**
 * The change an update would make to the app's Web App setting on CommCare
 * HQ: `from` is the value HQ holds, `to` the value the app's declaration
 * writes. `changedInHq` is true where the value moved in CommCare HQ since
 * Nova last published, false where it is the declaration that moved, and
 * null where Nova cannot tell.
 */
export interface WebAppsChange {
	readonly from: boolean;
	readonly to: boolean;
	readonly changedInHq: boolean | null;
}

/** The heading the publish dialog shows over the question. */
export const WEB_APPS_CHANGE_HEADING = "Web Apps for this app";

/** The refusal's message: what changes, who moved it, and what workers meet. */
export function webAppsChangeMessage(
	space: string,
	change: WebAppsChange,
): string {
	if (change.to) {
		return change.changedInHq === true
			? `Someone turned this app's Web App setting off in CommCare HQ since Nova last published it to “${space}”. This app runs in Web Apps, so publishing turns it back on, and workers there can open it in Web Apps from the next version Web Apps serves, usually the next one you release. Where a project space's plan doesn't include Web Apps, saving the app's settings in CommCare HQ turns it off.`
			: `This app runs in Web Apps, and its Web App setting on “${space}” is off. Publishing turns it on, so workers there can open it in Web Apps from the next version Web Apps serves, usually the next one you release.`;
	}
	return change.changedInHq === true
		? `Someone turned this app's Web App setting on in CommCare HQ since Nova last published it to “${space}”. This app runs on Android only, so publishing turns it back off, and from the next version Web Apps serves, nobody there can open the app in Web Apps.`
		: `This app runs on Android only, and its Web App setting on “${space}” is on. Publishing turns it off, so from the next version Web Apps serves, nobody there can open the app in Web Apps.`;
}

/** The checkbox that answers the question with the declaration's value. */
export function webAppsChangeConfirmLabel(change: WebAppsChange): string {
	return change.to
		? "Turn Web Apps on for this app"
		: "Turn Web Apps off for this app";
}

/** The `web-apps` check's detail where there is no app with Nova's content yet. */
export function webAppsCheckNoContentDetail(domain: string): string {
	return `There's no app with this app's content on “${domain}” yet, so its Web App setting is set when the app is filled in.`;
}

/** The `web-apps` check's detail where HQ already holds the declaration. */
export function webAppsCheckMatchesDetail(domain: string): string {
	return `The app's Web App setting on “${domain}” already matches where this app runs.`;
}

/** The `web-apps` check's detail where the person answered the question. */
export function webAppsCheckAnsweredDetail(
	domain: string,
	to: boolean,
): string {
	return `You chose to turn Web Apps ${to ? "on" : "off"} for this app on “${domain}”.`;
}

/**
 * The `hq_plan_lacks_web_apps` refusal's message: HQ made the new app with
 * Web Apps off, and what a person can do, offering Android only where the
 * app's content allows it.
 */
export function planLacksWebAppsMessage(
	space: string,
	narrowing: PlatformNarrowing,
): string {
	const lead = `CommCare HQ made this app on “${space}” with Web Apps off, which it does where the project space's plan doesn't include Web-Based Apps (CloudCare). Nova sent nothing else, and no longer counts on the earlier answer that the plan includes it.`;
	if (narrowing.open)
		return `${lead} If the app's workers use phones, you can set it to run on Android only, in App settings, and publish again: Nova fills in the same app. Once the plan includes Web Apps, you can confirm it when you publish again.`;
	if (narrowing.features.length > 0)
		return `${lead} This app uses ${namesInWords(narrowing.features)}, which Android can't run, so it needs a plan with Web Apps. Once the plan includes it, you can confirm it when you publish again, and Nova fills in the same app.`;
	return `${lead} This app uses something Android can't run, so it needs a plan with Web Apps. Once the plan includes it, you can confirm it when you publish again, and Nova fills in the same app.`;
}
