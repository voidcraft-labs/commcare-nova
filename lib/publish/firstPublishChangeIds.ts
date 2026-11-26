/**
 * The ids of what an app's first publish after Nova brought it in changes
 * in CommCare HQ, and the list a baseline keeps of them.
 *
 * Client-safe, and it imports nothing of `lib/deployment` or `lib/commcare`:
 * the review, the publish dialog, MCP and the deployment store read one
 * vocabulary. The register that decides which ids apply to a reading lives
 * with the reader; this file holds its ids, its `touchesWorkers` column as
 * data, and the stored list's shape.
 */

import { z } from "zod";
import type { AppSettings, BlueprintDoc } from "@/lib/domain";
import type { Platform } from "@/lib/domain/platforms";

/** Every change a first publish can make, in registry order. */
export const FIRST_PUBLISH_CHANGE_IDS = [
	"forms-and-settings-rewritten",
	"hidden-values-added",
	"case-names-checked",
	"validation-counts-moved",
	"validation-messages-composed",
	"instant-comparison",
	"empty-rows-guard",
	"absent-session-value-guard",
	"row-predicate-current",
	"search-value-guards",
	"search-today-device-day",
	"case-settings-respelled",
	"question-display-respelled",
	"search-filter-rows-recut",
	"sort-rule-kept-as-hidden-column",
	"list-settings-respelled",
	"search-filter-joined-to-list",
	"search-restates-list-filter",
	"link-held-case-guards-added",
	"registration-label-fixed",
	"date-and-time-saved-as-hq-stores-it",
	"connect-app-captures-location",
	"unused-translation-keys-removed",
	"location-list-setting-reset",
	"web-apps-turned-off",
	"web-apps-turned-on",
	"incomplete-forms-tile-hidden",
	"date-and-time-questions-split",
	"blank-translations-filled",
	"media-paths-joined",
	"media-files-renamed",
	"media-references-with-no-file-removed",
	"broken-pictures-removed",
	"unshown-form-media-removed",
	"unused-media-entries-removed",
	"names-respelled",
	"media-maps-respelled",
	"text-spaces-dropped",
	"form-text-characters-written-as-outputs",
	"hidden-value-defaults-dropped",
	"sort-by-entry-with-a-blank-name-dropped",
	"form-titles-written",
	"unread-fixture-declarations-dropped",
	"owner-rule-given-to-worker",
] as const;
export type FirstPublishChangeId = (typeof FIRST_PUBLISH_CHANGE_IDS)[number];

/** A list of what a publish changes, as every surface shows it. */
export interface FirstPublishView {
	readonly ids: readonly FirstPublishChangeId[];
	readonly touchesWorkers: boolean;
	/** A historical card whose accepted source can only be re-established by a full review. */
	readonly needsReview?: true;
	/** Which kind of list this is (`StoredFirstPublish.of`). */
	readonly of: "first-publish" | "next-publish";
}

const firstPublishChangeIdSchema = z.enum(FIRST_PUBLISH_CHANGE_IDS);
const firstPublishKindSchema = z.enum(["first-publish", "next-publish"]);

export const firstPublishViewSchema: z.ZodType<FirstPublishView> =
	z.strictObject({
		ids: z.array(firstPublishChangeIdSchema).readonly(),
		touchesWorkers: z.boolean(),
		needsReview: z.literal(true).optional(),
		of: firstPublishKindSchema,
	});

/** The register's `touchesWorkers` column as client-safe data: whether a worker meets the change. */
export const FIRST_PUBLISH_TOUCHES_WORKERS: Readonly<
	Record<FirstPublishChangeId, boolean>
> = {
	"forms-and-settings-rewritten": false,
	"hidden-values-added": false,
	"case-names-checked": true,
	"validation-counts-moved": true,
	"validation-messages-composed": true,
	"instant-comparison": true,
	"empty-rows-guard": true,
	"absent-session-value-guard": true,
	"row-predicate-current": true,
	"search-value-guards": true,
	"search-today-device-day": true,
	"case-settings-respelled": false,
	"question-display-respelled": false,
	"search-filter-rows-recut": false,
	"sort-rule-kept-as-hidden-column": false,
	"list-settings-respelled": false,
	"search-filter-joined-to-list": false,
	"search-restates-list-filter": true,
	"link-held-case-guards-added": true,
	"registration-label-fixed": true,
	"date-and-time-saved-as-hq-stores-it": true,
	"connect-app-captures-location": true,
	"unused-translation-keys-removed": false,
	"location-list-setting-reset": false,
	"web-apps-turned-off": true,
	"web-apps-turned-on": true,
	"incomplete-forms-tile-hidden": true,
	"date-and-time-questions-split": true,
	"blank-translations-filled": true,
	"media-paths-joined": false,
	"media-files-renamed": true,
	"media-references-with-no-file-removed": false,
	"broken-pictures-removed": true,
	"unshown-form-media-removed": false,
	"unused-media-entries-removed": false,
	"names-respelled": false,
	"media-maps-respelled": false,
	"text-spaces-dropped": true,
	"form-text-characters-written-as-outputs": false,
	"hidden-value-defaults-dropped": false,
	"sort-by-entry-with-a-blank-name-dropped": true,
	"form-titles-written": true,
	"unread-fixture-declarations-dropped": true,
	"owner-rule-given-to-worker": true,
};

/**
 * The changes no reading gives alone: each stands on a list only where the
 * person answered a review's question that makes it, and a later list keeps
 * it only while the list it replaces holds it
 * (`reading/firstPublishChanges.ts::withAnsweredChanges`).
 */
export const ANSWERED_FIRST_PUBLISH_CHANGES: readonly FirstPublishChangeId[] = [
	"owner-rule-given-to-worker",
];

/** Ids another entry's sentence says to a person. */
export const FIRST_PUBLISH_SAID_BY = {
	"search-filter-rows-recut": "forms-and-settings-rewritten",
	"list-settings-respelled": "forms-and-settings-rewritten",
	"question-display-respelled": "forms-and-settings-rewritten",
	"names-respelled": "forms-and-settings-rewritten",
	"media-maps-respelled": "forms-and-settings-rewritten",
} as const satisfies Partial<
	Record<FirstPublishChangeId, FirstPublishChangeId>
>;

/** The ids that have a sentence of their own. */
export type FirstPublishSentenceId = Exclude<
	FirstPublishChangeId,
	keyof typeof FIRST_PUBLISH_SAID_BY
>;

function isSaidByAnother(
	id: FirstPublishChangeId,
): id is keyof typeof FIRST_PUBLISH_SAID_BY {
	return Object.hasOwn(FIRST_PUBLISH_SAID_BY, id);
}

/** The id whose sentence says `id` to a person: its own, or the one `FIRST_PUBLISH_SAID_BY` names. */
export function firstPublishSentenceId(
	id: FirstPublishChangeId,
): FirstPublishSentenceId {
	return isSaidByAnother(id) ? FIRST_PUBLISH_SAID_BY[id] : id;
}

/** A reading keeps each change that workers meet on just one platform, so a later
 * declaration can show the changes for the platforms the app now runs on. */
export const FIRST_PUBLISH_PLATFORM: ReadonlyMap<
	FirstPublishChangeId,
	Platform
> = new Map<FirstPublishChangeId, Platform>([
	["incomplete-forms-tile-hidden", "web-apps"],
	["sort-by-entry-with-a-blank-name-dropped", "android"],
	["form-titles-written", "android"],
]);

/** What a baseline keeps of a list. */
export interface StoredFirstPublish {
	/** Set by a full accepted reading under the source-preserving Refresh contract.
	 * An older first-publish list can describe a different source. */
	readonly reviewed?: 1;
	/** The accepted review bound the concrete non-file inputs of its listed changes. */
	readonly reviewedInputs?: 1;
	/** Canonical identities of the target file references this complete reading approved removing. */
	readonly removedFiles?: readonly string[];
	/**
	 * The ids that applied under the chosen declaration, less the two Web Apps
	 * ids, and each id of `FIRST_PUBLISH_PLATFORM` the reading gives under
	 * any declaration.
	 */
	readonly ids: readonly FirstPublishChangeId[];
	/** CommCare HQ's Web App setting as the reading held it (`HqAppSource.cloudcareEnabled`). */
	readonly webAppsOnInHq: boolean;
	/**
	 * `first-publish`: the list of an app brought in and not yet published.
	 * `next-publish`: what the next publish changes after a bring-in of
	 * changes.
	 */
	readonly of: "first-publish" | "next-publish";
}

/** The universal spelling has no independent affected input. File removals
 * are authorized separately for the exact projected import. */
export function hasRegisteredPublishInputs(
	ids: readonly FirstPublishChangeId[],
): boolean {
	return ids.some(
		(id) =>
			id !== "forms-and-settings-rewritten" &&
			id !== "unused-media-entries-removed",
	);
}

export function needsStoredPublishReview(card: StoredFirstPublish): boolean {
	return (
		(card.of === "first-publish" && card.reviewed !== 1) ||
		(card.reviewedInputs !== 1 && hasRegisteredPublishInputs(card.ids))
	);
}

export const storedFirstPublishSchema: z.ZodType<StoredFirstPublish> =
	z.strictObject({
		ids: z.array(firstPublishChangeIdSchema).readonly(),
		reviewed: z.literal(1).optional(),
		reviewedInputs: z.literal(1).optional(),
		removedFiles: z
			.array(z.string().regex(/^[0-9a-f]{64}$/))
			.readonly()
			.optional(),
		webAppsOnInHq: z.boolean(),
		of: firstPublishKindSchema,
	});

export interface FirstPublishApp {
	readonly appSettings: Pick<AppSettings, "runsOnlyOn" | "showIncompleteForms">;
	readonly connectType: BlueprintDoc["connectType"];
}

/**
 * The list as it stands for an app that now declares `runsOnlyOn`: the
 * stored ids, with `web-apps-turned-off` where CommCare HQ held Web Apps on
 * and the app runs on Android only, `web-apps-turned-on` where HQ held it off
 * and the app runs in Web Apps, and each platform-specific id shown where the app runs on its platform, all in
 * registry order. The current incomplete-forms setting also determines whether the tile can disappear,
 * and turning off Connect leaves the existing location setting on HQ alone.
 */
export function firstPublishViewFromStored(
	stored: StoredFirstPublish,
	{
		appSettings: { runsOnlyOn, showIncompleteForms },
		connectType,
	}: FirstPublishApp,
): FirstPublishView {
	const present = new Set<FirstPublishChangeId>(stored.ids);
	present.delete("web-apps-turned-off");
	present.delete("web-apps-turned-on");
	if (stored.webAppsOnInHq && runsOnlyOn === "android") {
		present.add("web-apps-turned-off");
	}
	if (!stored.webAppsOnInHq && runsOnlyOn !== "android") {
		present.add("web-apps-turned-on");
	}
	if (runsOnlyOn !== undefined) {
		for (const [id, platform] of FIRST_PUBLISH_PLATFORM)
			if (platform !== runsOnlyOn) present.delete(id);
	}
	if (showIncompleteForms) present.delete("incomplete-forms-tile-hidden");
	if (connectType === null) present.delete("connect-app-captures-location");
	const ids = FIRST_PUBLISH_CHANGE_IDS.filter((id) => present.has(id));
	return {
		ids,
		touchesWorkers: ids.some((id) => FIRST_PUBLISH_TOUCHES_WORKERS[id]),
		of: stored.of,
	};
}
