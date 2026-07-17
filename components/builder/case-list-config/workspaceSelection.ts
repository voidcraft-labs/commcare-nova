// components/builder/case-list-config/workspaceSelection.ts
//
// Selection model for the case-list workspace. Selecting an entity on
// a canvas opens its properties in the inspector rail; the selection
// is workspace-local UI state (not URL state — case-list entities
// have no standalone screens the way fields do).

import type { ColumnSurface } from "@/lib/doc/order/columnSurface";

export type WorkspaceSelection =
	/** A shared field definition selected from a Results or Details row. Each
	 *  canvas owns its membership + order; selection opens only this field's
	 *  source and formatting properties in the rail. */
	| {
			readonly type: "column";
			readonly uuid: string;
			/**
			 * Present only when Add information found a saved definition that
			 * cannot safely return to the requested screen yet. The inspector
			 * keeps it off-screen while the author repairs it, then completes the
			 * requested reveal atomically with the successful repair.
			 */
			readonly reveal?: {
				readonly surface: ColumnSurface;
				readonly messages: readonly string[];
			};
	  }
	/** A directly arranged search input; selection opens its property/matching
	 *  options without moving arrangement out of the canvas. */
	| { readonly type: "input"; readonly uuid: string }
	/** The filter editor reached from Results' human-readable Cases included
	 *  sentence — the summary is not a duplicate editing surface. */
	| { readonly type: "filter" }
	/** Search-screen options with no draggable row: screen copy, button
	 *  visibility, and owner exclusions. */
	| { readonly type: "search-panel" }
	/** Secondary Results options only (sample data and standalone menu-link
	 *  appearance). Membership, screen arrangement, and Default order stay in the
	 *  center canvas. */
	| { readonly type: "list-panel" };
