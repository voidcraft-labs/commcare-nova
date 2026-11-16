/**
 * What a running form's Submit offers, given the form's state.
 *
 * A press on Submit either submits or does nothing, and a press that does
 * nothing must never meet a Submit that looks ready. So every condition that
 * keeps a form from being submitted is one arm here, and the screen reads the
 * same answer twice: as it renders, to disable Submit and say why (or show it
 * busy), and as a press lands, from the state read at that moment, where a
 * press the screen has not yet caught up with finds Submit's next render
 * already disabled for the same reason.
 *
 * Neither platform differs here. These are the waits of Preview's own form
 * entry (its engine, its device case data, its selected record, its access to
 * the app); a device answers a press on its submit button once its form has
 * loaded, and Preview's Submit is enabled at exactly that point.
 *
 * One arm is a fault: a form that names nowhere to go after it is submitted.
 * `lib/domain/postSubmit.ts::effectivePostSubmit` gives every form in the
 * document either its destinations or a destination, so this never happens;
 * where it does the screen shows its fault state and reports it, rather than
 * offering a Submit that would land nowhere.
 */

/** The form entry's own readiness, from the engine's entry state. */
export type PreviewSubmitEntry = "initializing" | "rebuilding" | "ready";

/** The device case database the entry reads, from the engine's entry state. */
export type PreviewSubmitCaseDatabase = "ready" | "refreshing" | "failed";

/**
 * The signed-in member's write access to the app's case data: `editor` may
 * submit, `checking` is an access refresh not yet settled (the session's
 * `refreshing` / `reconnecting` phases, or a render that has not caught up
 * with the session), and `no-edit-access` is a member who may only view the
 * app, or one whose access ended.
 */
export type PreviewSubmitAccess = "editor" | "checking" | "no-edit-access";

export interface PreviewSubmitState {
	/** The form names where it goes after a submission: its destinations, or
	 * the destination `effectivePostSubmit` gives it. */
	readonly afterSubmitKnown: boolean;
	/** A submission of this entry is in flight. */
	readonly submitting: boolean;
	/** Clear form was pressed and the fresh entry has not arrived yet. */
	readonly clearing: boolean;
	readonly entry: PreviewSubmitEntry;
	readonly caseDatabase: PreviewSubmitCaseDatabase;
	/** A user-controlled repeat's rows are being added or removed. */
	readonly repeatSettling: boolean;
	/** The selected record (and the ancestors it preloads from) is bound to
	 * the entry; a form that loads no case is always bound. */
	readonly caseBindingReady: boolean;
	readonly access: PreviewSubmitAccess;
}

export type PreviewSubmitBusyReason = "submitting" | "clearing";

export type PreviewSubmitWaitReason =
	| "form-initializing"
	| "case-data-refreshing"
	| "record-loading"
	| "form-rebuilding"
	| "repeat-updating"
	| "access-checking";

export type PreviewSubmitUnavailableReason =
	| "case-data-failed"
	| "no-edit-access";

export type PreviewSubmitOffer =
	| { readonly kind: "offered" }
	/** Submit shows its busy state: the press it already took is running. */
	| { readonly kind: "busy"; readonly reason: PreviewSubmitBusyReason }
	/** Submit is disabled until the form is ready again; nothing is needed
	 * from the worker. */
	| { readonly kind: "waiting"; readonly reason: PreviewSubmitWaitReason }
	/** Submit is disabled and stays so until the person does something
	 * else (return to Edit, or gain edit access). */
	| {
			readonly kind: "unavailable";
			readonly reason: PreviewSubmitUnavailableReason;
	  }
	/** An invariant breach: the screen shows its fault state and reports it. */
	| { readonly kind: "fault"; readonly reason: "no-after-submit" };

/**
 * The one decision. Arms are ordered by what the screen says first: a fault
 * outranks everything; Clear form outranks the form it replaces; a change to
 * the form itself (its entry, its case data, its record, its repeats)
 * outranks a press already running, because that press does not finish: it
 * finds the form changed under it and settles back to idle
 * (`FormScreen.tsx::handleSubmit`), so the line says what the form waits for
 * while Submit's own label still shows the press; and a wait that will end by
 * itself outranks a state the person has to change.
 */
export function previewSubmitOffer(
	state: PreviewSubmitState,
): PreviewSubmitOffer {
	if (!state.afterSubmitKnown) {
		return { kind: "fault", reason: "no-after-submit" };
	}
	if (state.clearing) return { kind: "busy", reason: "clearing" };
	if (state.entry === "initializing") {
		return { kind: "waiting", reason: "form-initializing" };
	}
	if (state.caseDatabase === "failed") {
		return { kind: "unavailable", reason: "case-data-failed" };
	}
	if (state.caseDatabase === "refreshing") {
		return { kind: "waiting", reason: "case-data-refreshing" };
	}
	if (!state.caseBindingReady) {
		return { kind: "waiting", reason: "record-loading" };
	}
	if (state.entry === "rebuilding") {
		return { kind: "waiting", reason: "form-rebuilding" };
	}
	if (state.repeatSettling) {
		return { kind: "waiting", reason: "repeat-updating" };
	}
	if (state.submitting) return { kind: "busy", reason: "submitting" };
	if (state.access === "checking") {
		return { kind: "waiting", reason: "access-checking" };
	}
	if (state.access === "no-edit-access") {
		return { kind: "unavailable", reason: "no-edit-access" };
	}
	return { kind: "offered" };
}

/**
 * The access a press reads, from the session at that moment and the app the
 * screen rendered for. A different app is a screen not yet caught up, so it
 * reads as an access check still settling, never as a press to act on.
 */
export function previewSubmitAccess(args: {
	readonly accessPhase:
		| "authorized"
		| "refreshing"
		| "reconnecting"
		| "upgradeRequired"
		| "revoked";
	readonly canEdit: boolean;
	readonly sameApp: boolean;
	/** The attachment coordinator holds this entry's write authority for the
	 * same tuple; it lags the session by a render at most. */
	readonly entryAuthorityCurrent: boolean;
}): PreviewSubmitAccess {
	if (args.accessPhase === "refreshing" || args.accessPhase === "reconnecting")
		return "checking";
	if (args.accessPhase !== "authorized" || !args.canEdit)
		return "no-edit-access";
	if (!args.sameApp || !args.entryAuthorityCurrent) return "checking";
	return "editor";
}
