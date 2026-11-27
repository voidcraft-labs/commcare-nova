/**
 * The kinds the sentences about changes made in CommCare HQ take as input:
 * why a change can't be told apart from the app's, which change Nova names
 * and can't take, a case property renamed in Nova, and the stages a review
 * and a bring-in name as they move.
 *
 * Client-safe, and it imports nothing of `lib/deployment` or
 * `lib/commcare`: the copy beside it is read by the builder, MCP and the
 * docs, and the plan and the review in `lib/deployment/hqChanges` take
 * these kinds from here.
 */

/**
 * Why Nova can't bring in CommCare HQ's changes there: the app was never
 * published to that project space, or publishing there stopped, so nothing
 * there is this app's; the app is in recently deleted; another Nova app took
 * its CommCare HQ app there while it was, and it has not published there
 * since its restore; or Nova can't tell CommCare HQ's changes from this
 * app's: no reference to compare against, a baseline it couldn't read, a
 * base reading it can't make, one too large to compare, a comparison that
 * takes more work than Nova gives one app, a document Nova updated or moved
 * since, or a change that didn't fit, which is Nova's own
 * defect.
 */
export const HQ_CHANGES_UNAVAILABLE = [
	"not-published",
	"publishing-stopped",
	"app-deleted",
	"hq-app-taken",
	"no-reference",
	"baseline-unread",
	"base-needs-project-data",
	"base-unreadable",
	"base-too-large",
	"comparison-too-intricate",
	"nova-updated",
	"app-moved",
	"nova-defect",
] as const;
export type HqChangesUnavailable = (typeof HQ_CHANGES_UNAVAILABLE)[number];

/**
 * The two changes Nova names and can't take as a change: the language the
 * app's own text is written in moved, or CommCare HQ's version runs on
 * fewer platforms than the app.
 */
export const HQ_CHANGE_HELD = [
	"languages-reordered",
	"runs-elsewhere",
] as const;
export type HqChangeHeld = (typeof HQ_CHANGE_HELD)[number];

/** A case property renamed in Nova: on `caseType`, from `from` to `to`. */
export interface CasePropertyRename {
	readonly caseType: string;
	readonly from: string;
	readonly to: string;
}

/**
 * The stages a review names as it moves, then the two more a bring-in
 * names after them: adding the files CommCare HQ added or replaced to the
 * Project, and the commit itself.
 */
export const HQ_CHANGES_STAGES = [
	"reading-app",
	"reading-project-data",
	"checking",
	"checking-media",
	"adding-media",
	"bringing-in",
] as const;
export type HqChangesStage = (typeof HQ_CHANGES_STAGES)[number];

/** Reversing the full list as one rename requires a unique source and
 * destination in each case type. A former occupant can share either name. */
export function renameNamesReused(
	renames: readonly CasePropertyRename[],
): boolean {
	const sources = new Set<string>(),
		destinations = new Set<string>();
	for (const { caseType, from, to } of renames) {
		const source = JSON.stringify([caseType, from]),
			destination = JSON.stringify([caseType, to]);
		if (sources.has(source) || destinations.has(destination)) return true;
		sources.add(source);
		destinations.add(destination);
	}
	return false;
}
