/**
 * domQueries — pure DOM helpers for the builder.
 *
 * These helpers were methods on `BuilderEngine`. They query and animate the
 * live DOM — they carry no state, hold no references, and never close over
 * store instances. Keeping them as free functions (rather than class methods)
 * lets call sites import them directly without routing through a React
 * context.
 *
 * Both are used by `lib/routing/builderActions.ts#useUndoRedo` to highlight
 * the affected field after a temporal undo/redo. They are exported for
 * unit tests (`__tests__/builderActions-useUndoRedo.test.tsx`) which mock
 * this module to spy on the DOM side-effects in isolation.
 */
"use client";

/**
 * Find a specific field element within the selected field's inspector.
 *
 * The field inspector docks in the right rail (rendered there by the rail from
 * the URL selection), so it's no longer a sibling of the canvas row.
 * We locate its body by the stable `data-field-inspector` uuid tag — not by
 * field `id`, so the lookup survives renames — then match the requested
 * property by `data-field-id`.
 *
 * Returns `null` when the inspector is not mounted (no current selection) or
 * when the requested property doesn't exist in the current inspector view.
 * Callers treat `null` as "nothing to highlight" and bail gracefully.
 */
export function findFieldElement(
	fieldUuid: string,
	fieldId?: string,
): HTMLElement | null {
	if (!fieldId) return null;
	const panel = document.querySelector(
		`[data-field-inspector="${fieldUuid}"]`,
	) as HTMLElement | null;
	if (!panel) return null;
	return panel.querySelector(`[data-field-id="${fieldId}"]`);
}

/**
 * Flash a subtle violet highlight on an element to signal an undo/redo
 * state change. Web Animations API — fire-and-forget, no cleanup needed.
 *
 * Toggles (role="switch") get a scale press instead of a backgroundColor
 * overlay because their visual footprint is smaller and a color wash would
 * read as a different toggle state rather than a confirmation cue.
 */
export function flashUndoHighlight(el: HTMLElement): void {
	if (el.getAttribute("role") === "switch") {
		el.animate(
			[
				{ transform: "scale(1)" },
				{ transform: "scale(0.8)" },
				{ transform: "scale(1)" },
			],
			{ duration: 300, easing: "cubic-bezier(0.4, 0, 0.2, 1)" },
		);
		return;
	}
	el.animate(
		[
			{ backgroundColor: "rgba(139, 92, 246, 0.12)" },
			{ backgroundColor: "transparent" },
		],
		{ duration: 600, easing: "cubic-bezier(0.4, 0, 0.2, 1)" },
	);
}
