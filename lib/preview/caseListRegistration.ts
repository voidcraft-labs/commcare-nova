/**
 * Whether the running app may open a module's case list registration form
 * offered after an empty search (`Module.caseListRegistrationForm`,
 * `afterEmptySearchRegistrationFormOf`). A form a case list always offers
 * is an ordinary form of its own menu, opened from the list with a launch
 * that only decides where it returns (`alwaysOfferedRegistrationReturn`).
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

import type { BlueprintDoc, Form, SearchInputDef, Uuid } from "@/lib/domain";
import {
	afterEmptySearchRegistrationFormOf,
	moduleUuidOfForm,
} from "@/lib/domain";
import {
	type PreviewScreenRead,
	readPreviewScreen,
} from "@/lib/preview/engine/dataRefusal";
import type { PreviewSearchSessionValues } from "@/lib/preview/engine/identity";
import {
	type SearchInputValues,
	searchInputInstanceValues,
} from "@/lib/preview/engine/runtimeBindings";
import type { PreviewSearchEnvironment } from "@/lib/preview/engine/searchExpressionEvaluation";
import {
	openSearchRunState,
	withHiddenValues,
} from "@/lib/preview/engine/searchRunState";
import { searchAttemptOf } from "@/lib/session/previewSearchState";
import type {
	PreviewSearchAnswers,
	PreviewSearchLaunch,
	PreviewSearchState,
} from "@/lib/session/types";

/* The Register action a list draws, for either arm, and the return of a form
 * a list always offers, which read the wire owner's frames. */
export {
	alwaysOfferedRegistrationReturn,
	type PreviewRegisterAction,
	previewRegisterAction,
	registeredCaseOnDevice,
	selectionsAfterRegistrationReturn,
} from "./engine/caseListRegisterAction";

type RegistrationDoc = Pick<BlueprintDoc, "modules" | "forms" | "formOrder">;

/** Whether the form is the case list registration form its module's slot
 *  names. */
export function isCaseListRegistrationForm(
	doc: RegistrationDoc,
	formUuid: Uuid | undefined,
): boolean {
	if (formUuid === undefined) return false;
	const moduleUuid = moduleUuidOfForm(doc, formUuid);
	return (
		moduleUuid !== undefined &&
		afterEmptySearchRegistrationFormOf(doc, moduleUuid) === formUuid
	);
}

/** A case list registration's native return takes precedence over ordinary
 * after-submit routing. Explicit `firstMenu` is the only alternative. */
export function caseListRegistrationPostSubmit(
	doc: RegistrationDoc,
	formUuid: Uuid,
): "firstMenu" | "results" | undefined {
	const form: Pick<Form, "postSubmit"> | undefined = doc.forms[formUuid];
	if (form === undefined || !isCaseListRegistrationForm(doc, formUuid))
		return undefined;
	return form.postSubmit === "firstMenu" ? "firstMenu" : "results";
}

export type CaseListRegistrationAdmission =
	/** Not a case list registration form: nothing to admit. */
	| { readonly kind: "not-applicable" }
	/** Opened from the Register action; these are the search's answers. */
	| { readonly kind: "admitted"; readonly answers: PreviewSearchAnswers }
	| { readonly kind: "refused"; readonly reason: CaseListRegistrationRefusal };

export type CaseListRegistrationRefusal =
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

export function caseListRegistrationAdmission(args: {
	readonly doc: RegistrationDoc;
	readonly formUuid: Uuid | undefined;
	readonly moduleUuid: Uuid | undefined;
	/** The launch on the form's case target, when the target names this form. */
	readonly launch: PreviewSearchLaunch | undefined;
	readonly searchState: PreviewSearchState | undefined;
}): CaseListRegistrationAdmission {
	const { doc, formUuid, moduleUuid, launch } = args;
	if (!isCaseListRegistrationForm(doc, formUuid)) {
		return { kind: "not-applicable" };
	}
	if (launch === undefined) return { kind: "refused", reason: "no-launch" };
	if (moduleUuid === undefined || launch.moduleUuid !== moduleUuid) {
		return { kind: "refused", reason: "foreign-module" };
	}
	/* Only a search of a menu whose forms read it can have offered the form;
	 * a Search screen asked for again holds none. */
	const searchState = searchAttemptOf(args.searchState);
	if (searchState === undefined) {
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
	/* A search a registration's return keyed to its case is no search that
	 * found nothing, so a launch from before that return is stale. */
	if (searchState.registeredCaseId !== undefined) {
		return { kind: "refused", reason: "stale-launch" };
	}
	/* Nor is a search history ran again past its list with other answers
	 * (`previewSearchState.ts::searchRunPastItsList`): what offered the form
	 * was an empty result for the answers it ran with before, and Web Apps
	 * shows the list again over the new run rather than reopening the form
	 * (`MenuSessionRunnerService.advanceSessionWithSelections`, `nonAppNav`). */
	if (searchState.rerunPastList) {
		return { kind: "refused", reason: "stale-launch" };
	}
	return { kind: "admitted", answers: searchState.answers };
}

/** The refusal in Nova's voice: what happened, and the next step. */
export function caseListRegistrationRefusalCopy(
	reason: CaseListRegistrationRefusal,
): {
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

/**
 * What a form's `#search/<name>` reads: the search-input instance its entry
 * holds. A case list registration form reads its admitted launch's answers.
 * A form of a menu whose forms read the search reads the completed search's
 * answers,
 * which its inline query step keeps; one opened another way (a form link,
 * even after a search in its module, or an entry point, with no completed
 * search behind it) is rebuilt on Web Apps with the query screen's starting
 * values (`RemoteQuerySessionManager.initUserAnswers`), so it reads
 * `defaults`. Any other form holds no search input.
 */
export function formSearchAnswers(args: {
	readonly searchInputs: readonly SearchInputDef[];
	readonly admission: CaseListRegistrationAdmission;
	/** The menu's forms read the search (`moduleFormsReadSearch`). */
	readonly formsReadSearch: boolean;
	readonly searchState: PreviewSearchState | undefined;
	/** A form link opened the form (`PreviewCaseTarget.openedByLink`). */
	readonly openedByLink: boolean;
	/** The Search fields' starting values, as the Search screen fills its
	 * prompts as it opens (`searchRunState.ts::openSearchRunState`). */
	readonly defaults: SearchInputValues;
}): SearchInputValues | undefined {
	const { searchInputs, admission, formsReadSearch, searchState, defaults } =
		args;
	if (admission.kind === "admitted")
		return searchInputInstanceValues(
			searchInputs,
			new Map(Object.entries(admission.answers)),
		);
	if (admission.kind === "refused" || !formsReadSearch) return undefined;
	return formReadsCompletedSearch(searchState, args.openedByLink)
		? searchInputInstanceValues(
				searchInputs,
				new Map(Object.entries(searchState.answers)),
			)
		: searchInputInstanceValues(searchInputs, defaults);
}

/**
 * Whether the form reaches its `#search/` answers through its menu's Search
 * screen opening now: a form of a menu whose forms read the search, opened
 * with no completed search behind it (a form link, an entry point). Web Apps
 * rebuilds such a form's query step with a query manager built as the Search
 * screen is built (`RemoteQuerySessionManager`'s constructor).
 */
export function formOpensSearchScreen(args: {
	readonly admission: CaseListRegistrationAdmission;
	readonly formsReadSearch: boolean;
	readonly searchState: PreviewSearchState | undefined;
	readonly openedByLink: boolean;
}): boolean {
	return (
		args.formsReadSearch &&
		args.admission.kind === "not-applicable" &&
		!formReadsCompletedSearch(args.searchState, args.openedByLink)
	);
}

const NO_STARTING_VALUES: SearchInputValues = new Map();

/**
 * What a form's `#search/<name>` reads (`formSearchAnswers`), read as its
 * screen reads it (`readPreviewScreen`). Where the form reaches them through
 * its menu's Search screen opening (`formOpensSearchScreen`), that screen
 * opens as Preview's Search screen opens, App Tests' and the form check's
 * too (`searchRunState.ts::openSearchRunState`): every starting value, hidden
 * value and required condition, and the check of each field a starting value
 * answers, is read, and a read of data the worker's device lacks refuses the
 * form as it refuses that screen. `world` is undefined while what those reads
 * read (the worker, the lookups, the device's cases) still loads; nothing is
 * read then, and the form reads no starting value.
 */
export function readFormSearchAnswers(args: {
	readonly searchInputs: readonly SearchInputDef[];
	readonly admission: CaseListRegistrationAdmission;
	readonly formsReadSearch: boolean;
	readonly searchState: PreviewSearchState | undefined;
	readonly openedByLink: boolean;
	readonly world:
		| {
				readonly session: PreviewSearchSessionValues;
				readonly environment: PreviewSearchEnvironment;
		  }
		| undefined;
}): PreviewScreenRead<SearchInputValues | undefined> {
	let defaults = NO_STARTING_VALUES;
	if (formOpensSearchScreen(args) && args.world !== undefined) {
		const { session, environment } = args.world;
		/* The query step seeds each hidden prompt's value beside the starting
		 * values (`RemoteQuerySessionManager.initUserAnswers`), and the form
		 * reads both. */
		const opened = readPreviewScreen(() => {
			const state = openSearchRunState(
				environment.moduleUuid,
				args.searchInputs,
				session,
				environment,
			);
			return withHiddenValues(state.defaults, state.resolveHidden());
		});
		if (opened.kind === "refused") return opened;
		defaults = opened.value;
	}
	return { kind: "read", value: formSearchAnswers({ ...args, defaults }) };
}

/** Whether a form of a menu whose forms read the search reads its module's
 * completed search (`formSearchAnswers`) rather than the Search fields'
 * starting values. */
export function formReadsCompletedSearch(
	searchState: PreviewSearchState | undefined,
	openedByLink: boolean,
): searchState is Extract<PreviewSearchState, { kind: "completed" }> {
	return !openedByLink && searchState?.kind === "completed";
}
