/**
 * UI-only presentation facts for a single SA tool call.
 *
 * Every mutating tool returns a prose `message` — the contract the SA and MCP
 * clients read, carrying uuids / indices / counts the model needs to act on a
 * follow-up call. That prose is the wrong thing to show a human in the chat
 * transcript: it buries the location ("…on module \"Clients\".") at the end and
 * leaks identifiers ("(uuid 9021b7da…)", "at index 0"). So alongside `message`
 * each tool also returns this `summary` — the same names it already resolved
 * to build the message, but as discrete fields the transcript can render
 * cleanly (see `lib/chat/toolSummary.ts`).
 *
 * Captured at execution time, where the doc is in hand and names are resolved,
 * so it stays correct for a thread reloaded long after the doc has moved on —
 * never re-derived from positional indices against a drifted doc.
 *
 * The model never needs `summary`: it's a handful of name-tokens the SA itself
 * just produced. So it rides along additively (the SA / MCP clients harmlessly
 * ignore it; the MCP projector drops it from the wire for tidiness) rather than
 * behind a `toModelOutput` split — there's no payload here worth the machinery.
 */
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
}

/**
 * Standard success shape for a mutating tool: the prose `message` for the
 * model, plus the `summary` the transcript renders. Tools that also hand the
 * SA a freshly-minted identifier (so it can target a follow-up edit without a
 * re-read) extend this with that field — see `addCaseListColumns`'s `uuids`.
 */
export interface MutationSuccess {
	message: string;
	summary: ToolCallSummary;
}
