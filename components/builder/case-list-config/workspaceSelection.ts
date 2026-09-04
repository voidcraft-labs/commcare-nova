// components/builder/case-list-config/workspaceSelection.ts
//
// Selection model for the case-list workspace. Selecting an entity on
// a canvas opens its properties in the inspector rail; the selection
// is workspace-local UI state (not URL state: case-list entities
// have no standalone screens the way fields do).

/**
 * Which of a search field's conditions the center canvas edits. `match` is
 * the custom match condition (the advanced arm's predicate); `required` and
 * `validation` are the Search-screen predicates every visible field may carry.
 */
export type SearchConditionSlot = "match" | "required" | "validation";

export type WorkspaceSelection =
	/** A shared field definition selected from a Results or Details row. Each
	 *  canvas owns its membership + order; selection opens only this field's
	 *  source and formatting properties in the rail. */
	| {
			readonly type: "column";
			readonly uuid: string;
	  }
	/** A directly arranged search input; selection opens its property/matching
	 *  options without moving arrangement out of the canvas. */
	| { readonly type: "input"; readonly uuid: string }
	/** A complex Search condition is edited in the roomy center canvas, never
	 *  duplicated inside the inspector. The target remembers where Back returns.
	 *  An absent `slot` on an input target is the custom match condition. */
	| {
			readonly type: "search-condition";
			readonly target:
				| {
						readonly kind: "input";
						readonly uuid: string;
						readonly slot?: SearchConditionSlot;
				  }
				| { readonly kind: "search-button" };
	  }
	/** Search-screen options with no draggable row: screen copy, button
	 *  visibility, and owner exclusions. */
	| { readonly type: "search-panel" };

/** The slot an input condition target names, with the match default applied. */
export function searchConditionSlotOf(target: {
	readonly kind: "input";
	readonly slot?: SearchConditionSlot;
}): SearchConditionSlot {
	return target.slot ?? "match";
}
