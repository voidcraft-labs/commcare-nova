// components/builder/case-list-config/workspaceSelection.ts
//
// Selection model for the case-list workspace. Selecting an entity on
// a canvas opens its properties in the inspector rail; the selection
// is workspace-local UI state (not URL state — case-list entities
// have no standalone screens the way fields do).

export type WorkspaceSelection =
	/** A column — selectable from the case-list table (headers/cells)
	 *  AND the case-detail rows; one entity, two canvases. */
	| { readonly type: "column"; readonly uuid: string }
	/** A search input on the search canvas. */
	| { readonly type: "input"; readonly uuid: string }
	/** The case-list filter (the canvas's human-phrase affordance). */
	| { readonly type: "filter" }
	/** The search panel itself — screen labels, button visibility,
	 *  owner exclusions. */
	| { readonly type: "search-panel" }
	/** The case list itself — sort order, menu-link appearance. */
	| { readonly type: "list-panel" };
