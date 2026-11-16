/**
 * Builder state re-architecture — ephemeral session type definitions.
 *
 * Everything in this store lives only while the builder route is mounted
 * and is NEVER undoable. Separating from BlueprintDoc means there's no
 * risk of UI state bleeding into undo history and no need for a partialize
 * allow-list — the two stores have disjoint responsibilities.
 *
 * Types are organized by concern:
 *   - Preview/sidebar primitives
 *   - Generation lifecycle — stages, errors, partial scaffold
 */

import type { Uuid } from "@/lib/doc/types";
import type { MediaKind } from "@/lib/domain/multimedia";
import type { PreviewAfterSubmitFrame } from "@/lib/preview/afterSubmitRouting";
import type { AfterSubmitStackState } from "@/lib/preview/afterSubmitStack";
import type { CaseDataByType } from "@/lib/preview/engine/formEngine";
import type { SearchCsqlRuntimeWire } from "@/lib/preview/engine/searchCsqlRuntime";
import type { CaseDatabaseSnapshot } from "@/lib/preview/engine/xpathInstances";
import type { Location } from "@/lib/routing/types";

// ── Interaction primitives ───────────────────────────────────────────────

/**
 * The after-submit frames still to run in the running app
 * (`lib/preview/afterSubmitStack.ts`): on Android the destinations beneath
 * the one that opened, which run each after the one above it finishes; on
 * Web Apps never any, since Formplayer opens the frame on top alone.
 */
export type PreviewAfterSubmitStack =
	AfterSubmitStackState<PreviewAfterSubmitFrame>;

/**
 * Visibility + stash state for one sidebar column. `open` is current
 * visibility; `stashed` records whether we should reopen when leaving
 * preview mode. See `setPreviewing` in the store.
 */
export type SidebarState = { open: boolean; stashed: boolean | undefined };

/**
 * The case-loading form a running-app case list feeds, plus the case the
 * user picked for it — the preview-mode equivalent of CommCare passing the
 * selected case datum down the navigation stack.
 *
 * `formUuid` is the destination form, set where a form is chosen: before
 * its case (a forms-first menu's form, a link's, a retained command's),
 * or from the menu the case opened (`formChosenAfterCase`). A list with no
 * form requested holds no target and goes on to its form menu once a case
 * is chosen (`menuProjection.ts::previewCaseListFormRequest`), which holds
 * the case on a history entry of its own (`lib/routing/previewHeldMenu.ts`).
 * `cases` is filled once the worker continues from Results, or by a form link
 * carrying the case value the next form opens with. Absence means the
 * destination is still waiting for Results; an empty array is an explicit
 * blank link and must never auto-select; one and many cases use the same
 * ordered collection. It is cleared on every preview-mode toggle.
 */
export interface PreviewCaseChoice {
	readonly caseId: string;
	readonly caseName?: string;
	/** Chosen from a search's Results while the worker's device does not hold
	 *  it: the claim CommCare posts for this choice writes a claim row
	 *  (`claimSearchedCasesAction`), so the worker's device holds it from then
	 *  on. Absent for a case the device holds. */
	readonly claimable?: true;
}

export interface PreviewCaseTarget {
	formUuid: Uuid;
	cases?: readonly PreviewCaseChoice[];
	/** The Register action that opened a case list registration form: the
	 * host module's search and the attempt it was offered on. Absent on every
	 * other way into a form, which is what lets the form screen refuse a
	 * direct URL (`lib/preview/caseListRegistration.ts`). */
	searchLaunch?: PreviewSearchLaunch;
	/** Post-submit local-device world carried by a direct form link. A fresh
	 * restore may omit a case the device just closed, but the linked form still
	 * opens against the case and casedb state the submitting entry committed. */
	caseData?: CaseDataByType;
	caseDatabase?: CaseDatabaseSnapshot;
	/** What the worker typed into the case list's filter when they chose the
	 * case, which the entry's session holds as `session/data/stringquery`, as
	 * Android keeps a case list's last search on its frame. Absent when the
	 * filter was empty or no case list opened the form. */
	caseListSearchText?: string;
	/** A form link opened the form. A form of a module that opens on its
	 * search then reads each Search field's starting value, not the module's
	 * last search, as Web Apps rebuilds a linked form's query step
	 * (`caseListRegistration.ts::formSearchAnswers`). */
	openedByLink?: true;
	/** The worker chose the form from a menu after its case: the session
	 * holds the case beneath the form's command, so a step back off the form
	 * lands on that menu with the case held and a second on a case list that
	 * holds no form (`CommCareSession.stepBack`). A list reached with this
	 * target opens no form once a case is chosen
	 * (`menuProjection.ts::previewCaseListFormRequest`); the menu the form
	 * was chosen on is the history entry the form was opened from
	 * (`lib/routing/previewHeldMenu.ts`). */
	formChosenAfterCase?: PreviewFormChosenAfterCase;
}

/** Where the case a form was chosen after came from: the module whose case
 *  list chose it, the form's own or a parent's whose case the form's menu
 *  goes on with (`menuProjection.ts::previewMenuCaseContext`'s
 *  `selectedByModuleUuid`). A route back to a list returns there
 *  (`menuProjection.ts::previewCaseListReturn`). */
export interface PreviewFormChosenAfterCase {
	readonly caseListModuleUuid: Uuid;
	/** The form was chosen from that case list's own form menu (a menu with
	 *  no submenus, `CaseListScreen`), which holds the case on a history entry
	 *  of its own (`lib/routing/previewHeldMenu.ts`). Absent where a menu
	 *  screen listed the form (`ModuleScreen`), which holds the case in
	 *  `previewMenuCaseSelections`. */
	readonly fromCaseListMenu?: true;
}

/** A command retained by after-submit navigation. Its exact task may finish
 * even when the save changes whether that task is offered on a menu. */
export interface PreviewTaskContinuation {
	readonly moduleUuid: Uuid;
	readonly formUuid?: Uuid;
	/** The retained menu's world survives ordinary Back from a chosen form. */
	readonly returnModuleUuid?: Uuid;
	readonly selectingModuleUuids: readonly Uuid[];
	readonly caseDatabase: CaseDatabaseSnapshot;
}

/** The worker's answers as the search-input instance would hold them:
 * prompt name → value, hidden inputs included. */
export type PreviewSearchAnswers = Readonly<Record<string, string>>;

export type PreviewSearchFailure =
	| "invalid-search"
	| "error"
	| "unauthenticated"
	| "persona-unavailable"
	| "platform-unavailable"
	| "language-unavailable";

/**
 * What the device worked out for a search's `_xpath_query` rows when the
 * search was sent (`searchCsqlRuntime.ts::evaluateSearchCsqlRuntime`). A
 * device evaluates them once, as it sends the request, and keeps that query
 * for the session's query step, so Results and the module's forms read this
 * one value: a claim or a lookup that changes later reads nothing again.
 * `value` is `undefined` for a search with no row to fold.
 */
export interface PreviewSearchDeviceValues {
	readonly value: SearchCsqlRuntimeWire | undefined;
}

/**
 * One module's search context in the running app: not searched yet, a
 * search running, the last search failed, or the last search completed
 * with a match count. Kept per module in the session store so the
 * no-matches registration form, a different screen, can ask whether the
 * search that offered it found nothing (`previewSearchState.ts`).
 *
 * Every list's search stands and lets go by one rule
 * (`lib/preview/searchStanding.ts`), so the session holds two more kinds
 * that only the list reads: the search a Search action ran on a menu whose
 * forms do not read it (`action`), and the Search screen the worker asked
 * for again (`manual`), Web Apps' `force_manual_search`.
 */
export type PreviewSearchState =
	| { readonly kind: "not-searched" }
	| {
			/** A Search action's search on a menu whose forms do not read it:
			 * the list reads it itself, with its own device values; the
			 * session holds its answers (hidden values included) so it stands
			 * and lets go as every search does, and a list built afresh takes
			 * it back. */
			readonly kind: "action";
			readonly submission: string;
			readonly answers: PreviewSearchAnswers;
			/** The menu's default search, which the list ran as it opened:
			 *  no answer the worker gave, so history taking it back runs the
			 *  default search again, whatever answers were given since
			 *  (`previewSearchState.ts::searchWithLatestInputs`). */
			readonly automatic?: true;
	  }
	| {
			/** The worker pressed Search again and has not searched since: the
			 * list shows its Search screen where it would otherwise run its
			 * default search, as Web Apps asks for the query screen with
			 * `force_manual_search` in the address's query data
			 * (`utils.js::CloudcareUrl.setQueryData`;
			 * `MenuSessionRunnerService.java::handleQueryScreen`). It stands
			 * and lets go as a search does: a crumb, Home, a submission and a
			 * new session drop it, and Formplayer runs the default search. */
			readonly kind: "manual";
			readonly submission: string;
	  }
	| {
			readonly kind: "running";
			readonly attempt: number;
			/** This search's own identity, unique across every search Preview
			 * runs: the key its device values are kept under. */
			readonly submission: string;
			readonly answers: PreviewSearchAnswers;
			readonly deviceValues?: PreviewSearchDeviceValues;
			/** The menu's default search, which the list ran as it opened:
			 *  no answer the worker gave, so history taking it back runs the
			 *  default search again, whatever answers were given since
			 *  (`previewSearchState.ts::searchWithLatestInputs`). */
			readonly automatic?: true;
	  }
	| {
			readonly kind: "failed";
			readonly attempt: number;
			/** This search's own identity, unique across every search Preview
			 * runs: the key its device values are kept under. */
			readonly submission: string;
			readonly answers: PreviewSearchAnswers;
			readonly reason: PreviewSearchFailure;
			readonly deviceValues?: PreviewSearchDeviceValues;
			/** The menu's default search, which the list ran as it opened:
			 *  no answer the worker gave, so history taking it back runs the
			 *  default search again, whatever answers were given since
			 *  (`previewSearchState.ts::searchWithLatestInputs`). */
			readonly automatic?: true;
	  }
	| {
			readonly kind: "completed";
			readonly attempt: number;
			/** This search's own identity, unique across every search Preview
			 * runs: the key its device values are kept under. */
			readonly submission: string;
			readonly answers: PreviewSearchAnswers;
			readonly matchCount: number;
			readonly deviceValues?: PreviewSearchDeviceValues;
			/** Set once the no-matches form registers a case: Results then
			 * shows that one case, as the wire's return frame does. */
			readonly registeredCaseId?: string;
			/** The menu's default search, which the list ran as it opened:
			 *  no answer the worker gave, so history taking it back runs the
			 *  default search again, whatever answers were given since
			 *  (`previewSearchState.ts::searchWithLatestInputs`). */
			readonly automatic?: true;
			/** On Web Apps, history returned to a screen past the list and ran
			 *  the list's query again there with these answers, the latest the
			 *  worker gave it (`previewSearchState.ts::searchRunPastItsList`):
			 *  the forms read what they find, and `matchCount` is still what
			 *  the list counted for the answers it ran with before, which the
			 *  list counts again as it comes on show. */
			readonly rerunPastList?: true;
	  };

/** Which search offered a no-matches registration form. */
export interface PreviewSearchLaunch {
	readonly moduleUuid: Uuid;
	readonly attempt: number;
}

/** Which case list's Register action opened a form it always offers. */
export interface PreviewCaseListRegistrationLaunch {
	readonly hostModuleUuid: Uuid;
}

/**
 * The one entry of a form that a case list's Register action opened, which
 * after submit returns where that list's choice says
 * (`lib/preview/engine/caseListRegisterAction.ts::alwaysOfferedRegistrationReturn`).
 * It names the form it opened, in its own menu, so a form screen reached any
 * other way is by construction not this launch, and it lasts while the
 * running app stays on that launch's own path
 * (`lib/preview/caseListRegistrationEntry.ts::caseListRegistrationEntryContinues`):
 * the form, and the parent case selection that admits it. Every other
 * location ends it, and so does its submission. Ephemeral, never stored.
 */
export interface PreviewCaseListRegistrationEntry
	extends PreviewCaseListRegistrationLaunch {
	/** The form's own menu, where the action opens it. */
	readonly moduleUuid: Uuid;
	readonly formUuid: Uuid;
}

/**
 * The case currently being viewed in the running-app case list (the row a
 * user clicked into the detail/confirm, before continuing). Mirrors the
 * case-list's local selection so the breadcrumb can name it while you're
 * still on the list. Cleared when the selection clears (back to results) and
 * on every preview-mode toggle.
 */
export interface PreviewSelectedCase {
	caseId: string;
	caseName: string;
}

/**
 * A case selected for one module menu. This is the Preview equivalent of a
 * menu-scoped case datum: it makes that menu's case-loading forms runnable
 * and may be inherited by a child menu that works with the same case type.
 *
 * It is deliberately separate from `PreviewCaseTarget`. Selecting a case for
 * a parent menu does not imply that any particular form should open. The map
 * that stores these values is keyed by module uuid, so reorder and rename do
 * not change the selection's owner.
 */
export interface PreviewMenuCaseSelection {
	caseType: string;
	cases: readonly (PreviewCaseChoice & {
		/** Flattened selected-row values for case-scoped form visibility. */
		readonly caseProperties?: Readonly<Record<string, string>>;
	})[];
}

/** A case-type parent selection that must happen before a target module can
 * continue. The selecting module comes from case ancestry, independently of
 * the target module's structural menu parent. */
export interface PreviewParentCaseRequest {
	selectingModuleUuid: Uuid;
	/** Immediate next selector(s), ending with the originally requested module. */
	returnModuleUuids: readonly Uuid[];
	/** Exact running leaf that initiated the chain. Absent for an ordinary
	 * menu-to-module parent selection. */
	resumeLocation?: Location;
	/** Safe running-menu destination when the worker cancels the selector. */
	cancelLocation?: Location;
	/** The request at the selector before this one, where this one follows a
	 * case chosen there in the same request. Back from this selector's list
	 * lets that case go and returns to it, as `CommCareSession.stepBack`
	 * pops the last datum and stops where the session asks for it again. */
	previous?: PreviewParentCaseRequest;
}

// ── Staged media uploads ─────────────────────────────────────────────────

/**
 * Lifecycle of one staged slot upload. `uploading` carries the byte-level
 * PUT progress (0..1); `error` holds the person-readable failure the slot
 * chip shows until the user dismisses or retries. There is no terminal
 * success state — a confirmed upload dispatches the gated attach and the
 * staged record is REMOVED (the doc's committed reference takes over as
 * the slot's truth).
 */
export type StagedUploadStatus =
	| { state: "uploading"; progress: number }
	| { state: "error"; message: string };

/**
 * One in-flight (or failed) slot upload, keyed in the store by the
 * carrier slot it will attach to. Ephemeral by design: the doc must never
 * hold a reference to an asset that isn't `ready`, so until the upload
 * confirms (the hash → signed-PUT → confirm flow flips the row to ready)
 * the only trace of it anywhere is this session record — cancel or
 * failure leaves the doc untouched because nothing was ever committed.
 */
export interface StagedUpload {
	filename: string;
	kind: MediaKind;
	status: StagedUploadStatus;
}

// ── Generation lifecycle ─────────────────────────────────────────────────

/** Cumulative milestones within a generation run. Live builds establish
 *  their foundation (app settings plus an optional data model), then build
 *  content through atomic module/form tools. `Fix` is HISTORICAL ONLY — a
 *  milestone of the retired validate-fix loop, kept so old runs still replay
 *  intelligibly. */
export enum GenerationStage {
	Foundation = "foundation",
	Build = "build",
	Fix = "fix",
}

/** Error state during generation — metadata, not a phase. The session
 *  stays in agent-active mode; this describes what went wrong. */
export type GenerationError = {
	message: string;
	severity: "recovering" | "failed";
} | null;

/** Status label for each generation stage, shown in builder progress surfaces. */
export const STAGE_LABELS: Record<GenerationStage, string> = {
	[GenerationStage.Foundation]: "Setting up app",
	[GenerationStage.Build]: "Building app content",
	[GenerationStage.Fix]: "Fixing validation errors",
};

/* The canonical session state type is `BuilderSessionState` in `store.ts`.
 * It includes both fields and actions. The types above are shared between
 * the store, hooks, and consumers. */
