/**
 * Shared style constants for virtualized row components.
 *
 * All rows use the same depth-driven left indent, so we compute it once
 * here rather than scattering magic numbers through four components.
 */

/** Pixels of left indent added per nesting level. Keeps the visual nesting
 *  readable without eating all of the form-width real estate. */
export const DEPTH_INDENT_PX = 20;

/** Base horizontal padding applied to every row (matches the parent scroll
 *  container's inner gutter). */
export const ROW_BASE_PADDING_X_PX = 24;

/** Height of an insertion-point gap at rest (not hovered). Doubles as the
 *  default `estimateSize` for insertion rows. */
export const INSERTION_REST_HEIGHT_PX = 24;

/** Height of an empty-container placeholder row. Matches the 72px min-height
 *  that the old `GroupField` used for empty drop zones. */
export const EMPTY_CONTAINER_HEIGHT_PX = 72;

/** Height of a group bracket row (open or close). */
export const GROUP_BRACKET_HEIGHT_PX = 40;

/**
 * Compute the inline left-padding (in px) for a row at the given depth.
 * Depth 0 (root-level questions) gets the base padding; each additional
 * level adds `DEPTH_INDENT_PX`.
 */
export function depthPadding(depth: number): number {
	return ROW_BASE_PADDING_X_PX + depth * DEPTH_INDENT_PX;
}
