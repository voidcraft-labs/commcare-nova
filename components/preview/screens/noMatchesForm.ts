/**
 * Whether the running app may open a no-matches registration form.
 *
 * On the wire the form is reachable only through the Register action on
 * Results, relevant when the inline search found nothing
 * (`lib/commcare/suite/case-search/noMatches.ts`). Preview keeps the same
 * door: the form is admitted only through a launch the case list issued on
 * a COMPLETED search of its own module that found nothing, and the launch
 * must still name the module's current search attempt. Every other way in
 * (a direct URL, a stale launch, a search still running, a failed one, one
 * with matches) is refused, and the screen says where to go instead.
 */

import type { Form, Uuid } from "@/lib/domain";
import { isNoMatchesForm } from "@/lib/domain";
import type {
	PreviewSearchAnswers,
	PreviewSearchLaunch,
	PreviewSearchState,
} from "@/lib/session/types";

export type NoMatchesFormAdmission =
	/** Not a no-matches form: nothing to admit. */
	| { readonly kind: "not-applicable" }
	/** Opened from the Register action; these are the search's answers. */
	| { readonly kind: "admitted"; readonly answers: PreviewSearchAnswers }
	| { readonly kind: "refused"; readonly reason: NoMatchesRefusal };

export type NoMatchesRefusal =
	/** No launch carried the form here (a direct URL or a menu). */
	| "no-launch"
	/** The launch belongs to another module's search. */
	| "foreign-module"
	/** The module has not searched in this run. */
	| "not-searched"
	| "search-running"
	| "search-failed"
	/** The search found cases, so registration is not offered. */
	| "has-matches"
	/** A later search superseded the one that offered the form. */
	| "stale-launch";

export function noMatchesFormAdmission(args: {
	readonly form: Pick<Form, "entry"> | undefined;
	readonly moduleUuid: Uuid | undefined;
	/** The launch on the form's case target, when the target names this form. */
	readonly launch: PreviewSearchLaunch | undefined;
	readonly searchState: PreviewSearchState | undefined;
}): NoMatchesFormAdmission {
	const { form, moduleUuid, launch, searchState } = args;
	if (form === undefined || !isNoMatchesForm(form)) {
		return { kind: "not-applicable" };
	}
	if (launch === undefined) return { kind: "refused", reason: "no-launch" };
	if (moduleUuid === undefined || launch.moduleUuid !== moduleUuid) {
		return { kind: "refused", reason: "foreign-module" };
	}
	if (searchState === undefined || searchState.kind === "not-searched") {
		return { kind: "refused", reason: "not-searched" };
	}
	if (searchState.attempt !== launch.attempt) {
		return { kind: "refused", reason: "stale-launch" };
	}
	if (searchState.kind === "running") {
		return { kind: "refused", reason: "search-running" };
	}
	if (searchState.kind === "failed") {
		return { kind: "refused", reason: "search-failed" };
	}
	if (searchState.matchCount !== 0) {
		return { kind: "refused", reason: "has-matches" };
	}
	return { kind: "admitted", answers: searchState.answers };
}

/** The refusal in Nova's voice: what happened, and the next step. */
export function noMatchesRefusalCopy(reason: NoMatchesRefusal): {
	readonly title: string;
	readonly description: string;
} {
	switch (reason) {
		case "search-running":
			return {
				title: "This form opens after a search finds no matches",
				description:
					"A search is still running. Wait for Results, then use Register from there.",
			};
		case "search-failed":
			return {
				title: "This form opens after a search finds no matches",
				description:
					"The last search did not complete. Search again, and register from Results when nothing matches.",
			};
		case "has-matches":
			return {
				title: "This form opens after a search finds no matches",
				description:
					"The last search found cases, so Results offers them instead. Search again to register someone new.",
			};
		case "no-launch":
		case "foreign-module":
		case "not-searched":
		case "stale-launch":
			return {
				title: "This form opens after a search finds no matches",
				description:
					"Start from Search. When nothing matches, Results offers this form.",
			};
	}
}
