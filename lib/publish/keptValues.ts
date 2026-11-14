/**
 * The words of the kept list: the settings a project space keeps in CommCare
 * HQ that Nova does not change when it publishes, and what Refresh from
 * CommCare HQ says when it reads them again.
 *
 * Client-safe and free of wire vocabulary: the Publishing card, the review of
 * an app brought in and MCP all read these strings, and a component reaches
 * the kept list only as label ids (`KeptLabelId`), which it words through
 * `KEPT_LABELS`.
 */

/** The label ids, in the order the kept list's labels are listed. */
export const KEPT_LABEL_IDS = [
	"automatic-app-updates",
	"sent-form-retention",
	"device-logging",
	"automatic-sync",
	"media-check-at-install",
	"unsent-form-warning-count",
	"unsent-form-warning-days",
	"image-resizing",
	"fuzzy-search",
	"sign-in-duration",
	"image-scaling",
	"location-capture-accuracy",
	"default-map-layer",
	"text-to-speech",
	"required-question-asterisk",
	"case-detail-view-logging",
	"reworded-commcare-screens",
	"android-logos",
	"mobile-report-version",
	"location-with-every-form",
	"persistent-menu",
	"web-apps-breadcrumbs",
	"secure-submissions",
	"custom-base-url",
	"practice-mobile-worker",
	"worker-activity-credential",
] as const;
export type KeptLabelId = (typeof KEPT_LABEL_IDS)[number];

/** What a person reads for each kept setting. */
export const KEPT_LABELS: Readonly<Record<KeptLabelId, string>> = {
	"automatic-app-updates": "Automatic app updates",
	"sent-form-retention": "How long sent forms are kept",
	"device-logging": "Device logging",
	"automatic-sync": "Automatic sync",
	"media-check-at-install": "Media check at install",
	"unsent-form-warning-count": "Unsent form warning, by count",
	"unsent-form-warning-days": "Unsent form warning, by days",
	"image-resizing": "Image resizing",
	"fuzzy-search": "Fuzzy search in case lists",
	"sign-in-duration": "How long a sign-in lasts",
	"image-scaling": "Image scaling",
	"location-capture-accuracy": "Accuracy for automatic location capture",
	"default-map-layer": "Default map layer",
	"text-to-speech": "Text to speech",
	"required-question-asterisk": "Asterisk on required questions",
	"case-detail-view-logging": "Logging of case detail views",
	"reworded-commcare-screens": "CommCare's own screens, reworded",
	"android-logos": "Android logos",
	"mobile-report-version": "Mobile report version",
	"location-with-every-form": "Location captured with every form",
	"persistent-menu": "Persistent menu in Web Apps",
	"web-apps-breadcrumbs": "Breadcrumbs in Web Apps",
	"secure-submissions": "Secure submissions",
	"custom-base-url": "Custom base URL",
	"practice-mobile-worker": "Practice mobile worker",
	"worker-activity-credential": "Worker activity credential",
};

/**
 * The sentence above the kept list, or the one that says there is none.
 * `date` is the baseline's date, already formatted for the reader.
 */
export function keptLead(date: string, hasLabels: boolean): string {
	return hasLabels
		? `These stay as they are in CommCare HQ, as it held them on ${date}:`
		: `Every setting CommCare HQ keeps for this app matches a new app's, as it held them on ${date}.`;
}

/** The line under the kept list, whether it lists anything or not. */
export const KEPT_FOLLOWS_LINE =
	"Nova doesn't change these when it publishes. A CCZ made for this project space follows them.";

/**
 * What Refresh from CommCare HQ can answer: the kinds of the deployment
 * service's refresh outcome, restated here so this file stays client-safe.
 */
export type KeptRefreshKind =
	| "refreshed"
	| "changed-in-hq"
	| "superseded"
	| "no-baseline"
	| "app-gone"
	| "unreadable"
	| "key-not-accepted"
	| "no-permission"
	| "unavailable";

/** The sentence a refresh that found a change made in CommCare HQ ends on. */
function keptChangedInHqSentence(date: string): string {
	return `CommCare HQ saved this app since Nova last read it, so these stay as of ${date}.`;
}

/** The sentence a person reads after Refresh from CommCare HQ answers. */
export function keptRefreshSentence(
	outcome: {
		readonly kind: KeptRefreshKind;
		/** For `refreshed`: whether the label list differs from the one shown before the refresh. */
		readonly listChanged: boolean;
	},
	context: {
		/** The baseline's date, formatted for the reader. */
		readonly date: string;
		/** The project space's name. */
		readonly space: string;
	},
): string {
	const { date, space } = context;
	switch (outcome.kind) {
		case "refreshed":
			return outcome.listChanged
				? "Updated. This is what CommCare HQ holds now."
				: "Nothing has changed. This is still what CommCare HQ holds.";
		case "changed-in-hq":
			return keptChangedInHqSentence(date);
		case "superseded":
			return "Someone published here while Nova was reading, so this is as that publish left it.";
		case "no-baseline":
			return "Nova hasn't read this app from CommCare HQ since its last publish here, so it has nothing to refresh. Publishing again reads it.";
		case "app-gone":
			return `CommCare HQ no longer has this app in ${space}. Check status shows where things stand.`;
		case "unreadable":
			return `CommCare HQ answered with something Nova couldn't read as this app, so these stay as of ${date}. Opening the app in CommCare HQ shows whether it still opens there.`;
		case "key-not-accepted":
			return `CommCare HQ didn't accept your saved API key, so these stay as of ${date}. You can save a new key in Settings, then refresh again.`;
		case "no-permission":
			return `CommCare HQ didn't let your account read this app, so these stay as of ${date}. Reading it needs permission to edit apps in ${space}. You can check the connected account, then refresh again.`;
		case "unavailable":
			return "Nova couldn't reach CommCare HQ just now. You can try again in a moment. Nothing was changed.";
	}
}
