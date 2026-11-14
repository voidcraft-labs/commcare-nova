/**
 * The kept list on a deployment's card, as state: how its date reads, and
 * what a press of Refresh from CommCare HQ leaves on the card.
 *
 * Pure, so the card's behavior is tested here and `DeploymentStatus` only
 * draws what this returns.
 */

import type {
	DeploymentActionResult,
	DeploymentView,
	KeptRefreshView,
	RefreshedDeploymentView,
} from "@/lib/deployment/actions";
import type { DeploymentKept } from "@/lib/deployment/types";
import {
	KEPT_REFRESH_NOT_REACHED,
	keptChanged,
	keptListUnreadSentence,
	keptRefreshSentence,
} from "@/lib/publish/keptValues";

/** The button's label, at rest and while CommCare HQ is being read. */
export const KEPT_REFRESH_BUTTON = "Refresh from CommCare HQ";
export const KEPT_REFRESH_BUTTON_PENDING = "Reading from CommCare HQ";

/**
 * The kept list's date in the reader's locale: the day and the month, and
 * the year where it is not the current one ("10 November", "10 November
 * 2025"). The year is compared in the reader's own time zone, as the date is
 * shown. `locale` is the reader's when absent.
 */
export function keptDateText(
	observedAt: string,
	now: Date,
	locale?: string,
): string {
	const date = new Date(observedAt);
	return date.toLocaleDateString(locale, {
		day: "numeric",
		month: "long",
		...(date.getFullYear() !== now.getFullYear() && {
			year: "numeric" as const,
		}),
	});
}

/** A refresh's record as the card holds it, with what Preview may now name. */
export type ShownRefreshedView = DeploymentView &
	Pick<RefreshedDeploymentView, "preview">;

/**
 * The record a refresh handed back, as the card holds it. A refresh that
 * landed and could not read its kept list just now answers `unread`, and
 * the card keeps `shown`, the list it drew: the refresh's write is not
 * undone by a read after it, and an empty list would read as one.
 */
export function refreshedViewToShow(
	next: RefreshedDeploymentView,
	shown: DeploymentKept | null,
): ShownRefreshedView {
	return keptWasRead(next) ? next : { ...next, kept: shown };
}

function keptWasRead(
	view: RefreshedDeploymentView,
): view is RefreshedDeploymentView & ShownRefreshedView {
	return view.kept !== "unread";
}

/** What one refresh leaves on the card. */
export interface KeptRefreshNotice {
	/** The sentence shown under the list. */
	readonly sentence: string;
	/** True where the read did not happen or did not land, which the card shows as an alert. */
	readonly failed: boolean;
	/** The record the card now holds, where the outcome carries one. */
	readonly view: ShownRefreshedView | null;
	/**
	 * The kept list the sentence speaks of: the record's the outcome handed
	 * back, or the one shown when the button was pressed. The card shows the
	 * sentence only while it holds this list (`keptNoticeApplies`).
	 */
	readonly kept: DeploymentKept | null;
}

/**
 * Whether a refresh's sentence still speaks of the kept list the card holds:
 * the same date and the same kept values (`keptChanged`), or no list on
 * either side. A publish or a reload that moves the list retires it.
 */
export function keptNoticeApplies(
	notice: KeptRefreshNotice,
	current: DeploymentKept | null,
): boolean {
	if (notice.kept === null || current === null) {
		return notice.kept === current;
	}
	return (
		notice.kept.observedAt === current.observedAt &&
		!keptChanged(notice.kept, current)
	);
}

/** What the card shows when the refresh's request never came back with an answer. */
export function keptRefreshNotReached(
	shown: DeploymentKept,
): KeptRefreshNotice {
	return {
		sentence: KEPT_REFRESH_NOT_REACHED,
		failed: true,
		view: null,
		kept: shown,
	};
}

/** The kinds that are a read that did not happen or could not be used. */
const FAILED_KINDS: ReadonlySet<KeptRefreshView["kind"]> = new Set([
	"app-gone",
	"unreadable",
	"too-large",
	"browser-only",
	"key-not-accepted",
	"no-permission",
	"unavailable",
]);

/**
 * What the card shows after a refresh answered.
 *
 * `shown` is the kept list the card drew when the button was pressed: its
 * date words every outcome that leaves the list as it was, and its labels
 * and values decide whether a refresh changed anything (`keptChanged`). A `success: false` answer is a
 * raised sentence (no key, a key that cannot reach the project space, a key
 * on another server, or the request itself refused), shown as it came.
 */
export function keptRefreshNotice(
	result: DeploymentActionResult<KeptRefreshView>,
	shown: DeploymentKept,
	context: {
		readonly now: Date;
		readonly space: string;
		readonly locale?: string;
	},
): KeptRefreshNotice {
	if (!result.success) {
		return { sentence: result.message, failed: true, view: null, kept: shown };
	}
	const outcome = result.data;
	const date = keptDateText(shown.observedAt, context.now, context.locale);
	const answered =
		outcome.kind === "refreshed" || outcome.kind === "superseded"
			? outcome.deployment
			: null;
	const view = answered === null ? null : refreshedViewToShow(answered, shown);
	return {
		sentence:
			answered?.kept === "unread"
				? keptListUnreadSentence(date)
				: keptRefreshSentence(
						{
							kind: outcome.kind,
							changed:
								outcome.kind === "refreshed" &&
								keptChanged(shown, view?.kept ?? null),
						},
						{ date, space: context.space },
					),
		failed: FAILED_KINDS.has(outcome.kind),
		view,
		kept: view === null ? shown : view.kept,
	};
}
