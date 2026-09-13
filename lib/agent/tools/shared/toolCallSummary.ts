/** Transcript presentation captured when a tool runs, so its names remain
 * correct after later edits. Model and MCP projections omit this metadata. */
export interface ToolCallSummary {
	/**
	 * The immediate container the change lives in, by human name — the module
	 * for a case-list column / search input / case-search config, the form for a
	 * field. Rendered as a "→ <name>" breadcrumb so it leads rather than trails.
	 * Omitted for top-level acts (creating a module has no container).
	 */
	location?: string;
	/**
	 * The entity acted on, by its human label / name / header — the field label,
	 * the column header, the form or module name. Omitted when the tool only
	 * knows an opaque identifier (e.g. removing a column by uuid), in which case
	 * the action verb alone carries the line ("Removed a column → Clients").
	 */
	subject?: string;
	/**
	 * For a single call that performs a MULTI-ITEM action — a bulk field add, a
	 * column / search-input reorder — the number of items affected. The transcript
	 * folds it into the action ("Added 3 fields", "Reordered 5 columns") so the
	 * scale of the change is legible without expanding the prose.
	 */
	count?: number;
	/**
	 * For a call that changes the subject's NAME: whether the subject received
	 * its first name (`"named"` — a build's opening `updateApp` resolving the
	 * nameless birth state) or replaced an existing one (`"renamed"`). Captured
	 * here because only the executing tool sees the prior doc — the transcript
	 * can't reconstruct pre-call state, so without this fact it would have to
	 * hedge with one generic verb for both acts.
	 */
	nameChange?: "named" | "renamed";
	/**
	 * The call verified the requested state already holds and wrote nothing.
	 * The transcript's verb must not claim a change ("Arranged 2 sections"
	 * for a re-sent partition would), so this flag routes the headline to
	 * "Nothing to change" instead. Set it INSTEAD of `count`.
	 */
	noop?: true;
	/**
	 * For a call that changes the app's CommCare Connect type: the RESULTING
	 * state. `"off"` is the disable; `"learn"` / `"deliver"` cover enable and a
	 * mode switch alike, so the transcript's verb stays honest without knowing
	 * the prior state.
	 */
	connect?: "learn" | "deliver" | "off";
	/**
	 * For a call that deliberately changed NOTHING because it first needs the
	 * user's go-ahead — `editField`'s conversion consent round. The transcript
	 * renders "Checked a conversion" instead of claiming the edit landed (the
	 * default done-tense action would lie), and the summary's presence keeps
	 * the model-directed relay prose off the user-facing detail line.
	 */
	awaitingConsent?: boolean;
}

/** The operation completed. Owners add identities and consequential effects;
 * success alone does not say whether work was staged, committed, or a no-op. */
export interface MutationSuccess {
	ok: true;
	summary: ToolCallSummary;
}
