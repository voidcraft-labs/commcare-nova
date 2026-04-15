/**
 * DragReorderContext — shares the live dnd-kit items map + active drag
 * uuid with any descendant that needs to read them during a drag.
 *
 * `VirtualFormList` sets this value; `QuestionRow` / `GroupOpenRow` read it
 * indirectly through the sortable system (dnd-kit updates sortable state
 * from the items map via the `move()` helper). Keeping the context around
 * preserves parity with the legacy `FormRenderer`, which exposed the same
 * reorder state to nested renderers for the drag-placeholder visual.
 */

"use client";
import { createContext } from "react";

export interface DragReorderState {
	/** Group bucket → ordered uuid list. Updated live by `move()` during
	 *  drag; becomes the source of truth for drop position calculation. */
	readonly itemsMap: Record<string, string[]>;
	/** UUID of the question being dragged. */
	readonly activeUuid: string;
}

export const DragReorderContext = createContext<DragReorderState | null>(null);
