// components/builder/case-list-config/moveAnnouncement.ts
//
// What a keyboard reorder SAYS after it lands. Pure, so the sentence is a unit
// test rather than a DOM assertion.
//
// The announcement is made AFTER the commit and reads the position the document
// actually holds — never the position the keypress asked for. A move can be
// refused (the commit gate, a peer edit landing first) or land somewhere the
// gesture did not name, and a pointer author sees that outcome on screen while a
// keyboard author has only this sentence. Announcing the request would report a
// move that did not happen, which is the defect this file exists to close.
//
// `CaseOperationsCanvas` announces the same shape for case changes; keep the two
// readings alike so a keyboard author hears one vocabulary across the builder.

/** The position a moved row landed on, read from the committed document. */
export interface LandedPlacement {
	/** Zero-based index in the surface's visible sequence. */
	readonly index: number;
	/** How many rows that sequence holds. */
	readonly total: number;
}

/**
 * What a move reports back to the surface that requested it.
 *
 * A move dispatch is synchronous, so `landed` is read from the document AFTER
 * the commit — the position the document holds, not the one the gesture asked
 * for. The refusal arm carries the commit gate's own message so the announcement
 * can say why rather than going silent.
 */
export type MoveOutcome =
	| { readonly ok: true; readonly landed: LandedPlacement }
	| { readonly ok: false; readonly messages: readonly string[] };

/**
 * A row moved and landed. Names the screen because the same row can sit on both
 * Results and Details at different positions, so "moved to 2 of 5" alone would
 * be ambiguous to someone who cannot see which screen has focus.
 */
export function movedAnnouncement(
	label: string,
	screenName: string,
	landed: LandedPlacement,
): string {
	return `${label} moved, now ${landed.index + 1} of ${landed.total} in ${screenName}.`;
}

/**
 * The row is already against the edge it was asked to move past. Not a failure
 * and not an error — the sequence is simply unchanged, which is exactly what a
 * pointer author would see when a drop zone refuses to open.
 */
export function atBoundaryAnnouncement(
	label: string,
	screenName: string,
	edge: "beginning" | "end",
): string {
	return `${label} is already at the ${edge} of ${screenName}.`;
}

/**
 * The move was refused. Carries the reason the commit gate gave, because a
 * keyboard author has no drop zone to read a refusal from and the press would
 * otherwise be indistinguishable from a no-op.
 */
export function refusedAnnouncement(
	label: string,
	screenName: string,
	reason: string,
): string {
	return `${label} was not moved in ${screenName}. ${reason}`;
}
