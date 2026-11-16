/**
 * What a person reads about stopping publishing an app to a project space,
 * and about a deployment that stopped.
 *
 * Client-safe, and it imports nothing of `lib/deployment`: the Publishing
 * card, the publish dialog, the home list and MCP read one text.
 */

import { namesInWords } from "./planFeatures";

/** The control on the card and at the drift stop. */
export const STOP_PUBLISHING_ACTION = "Stop publishing here";

/** The line under that control. */
export const STOP_PUBLISHING_HELPER =
	"The app in CommCare HQ stays as it is, and this app stops publishing to it. It can be brought in to Nova again as a new app.";

/** The confirmation's title. */
export function stopPublishingConfirmTitle(domain: string): string {
	return `Stop publishing to “${domain}”?`;
}

/** The confirmation's body. */
export function stopPublishingConfirmBody(domain: string): string {
	return `Nova stops publishing this app to “${domain}”. The app in CommCare HQ stays exactly as it is, and you or a teammate can bring it in to Nova again as a new app. If you publish to “${domain}” later, Nova makes a new app there.`;
}

export const STOP_PUBLISHING_CONFIRM = "Stop publishing";
export const STOP_PUBLISHING_CANCEL = "Cancel";

/**
 * The card's line for a deployment that stopped. `ending` is
 * `deploymentEnding`'s answer, taken structurally so this file imports
 * nothing of `lib/deployment`. `date` is the day the caller formatted.
 * The `claimed-elsewhere` line names no person: whoever's restore or
 * publish met the other app chose nothing, so the line says what happened.
 */
export function endedLine(
	ending: {
		readonly byName: string;
		readonly reason: "stopped" | "claimed-elsewhere";
	},
	date: string,
): string {
	switch (ending.reason) {
		case "stopped":
			return `${ending.byName} stopped publishing here on ${date}. The app in CommCare HQ stays as it was, and publishing here again makes a new app beside it.`;
		case "claimed-elsewhere":
			return `Nova stopped publishing here on ${date}, because another Nova app publishes to that CommCare HQ app now. Publishing here again makes a new app beside it.`;
		default: {
			const unplaced: never = ending.reason;
			return unplaced;
		}
	}
}

/** The link beside the ended line. */
export const ENDED_HQ_APP_LINK = "Open the app in CommCare HQ";

/** The publish dialog's plan line where the next publish makes a new app beside the ended one. */
export const PUBLISH_PLAN_CREATES_BESIDE =
	"Nova stopped publishing to the app that's already in this project space, so this makes a new app beside it.";

/** The card's line where CommCare HQ reported the app gone. */
export const GONE_APP_NEXT_PUBLISH =
	"Publishing again creates a new app on CommCare HQ, because the one that was there is gone.";

/**
 * The home list's line after a restore that stopped publishing to some
 * project spaces. Each entry is one project space as the caller words it,
 * quotation marks included: “{domain}”, with its server's label after it
 * where the caller adds one. Several are joined in words.
 */
export function restoredStoppedPublishing(spaces: readonly string[]): string {
	if (spaces.length === 1) {
		return `Your app is back. It no longer publishes to ${spaces[0]}, because another Nova app publishes to that CommCare HQ app now. Publishing there again makes a new app.`;
	}
	return `Your app is back. It no longer publishes to ${namesInWords(spaces)}, because other Nova apps publish to those CommCare HQ apps now. Publishing to one of them again makes a new app there.`;
}

/** The home list's line for a restore that met where the app publishes changing three times in a row. */
export const RESTORE_CLAIMS_CHANGED =
	"Nova couldn't bring this app back just now, because where it publishes was changing at the same moment. Nothing was changed, and you can try again.";

/** A publish whose settling of a released mapping met the same (`app_changed_while_publishing`). */
export const PUBLISH_CLAIMS_CHANGED =
	"Where this app publishes was changing while Nova got this publish ready, so nothing was sent. You can publish again now.";
