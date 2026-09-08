/**
 * The named, ordered pieces a static system prompt is composed from.
 *
 * Every Nova system prompt is one string joined from a handful of top-level
 * blocks. Naming those blocks as data lets the composition be read piece by
 * piece (the dev-only agent anatomy at `/agents` renders each segment with
 * its weight) while the production string stays exactly the join of the same
 * array, so the two can never say different things.
 */

export interface PromptSegment {
	/** Stable identifier, kebab-case, unique within one composition. */
	readonly id: string;
	/** Short human title in Nova's voice (sentence case). */
	readonly title: string;
	/** The exact bytes this segment contributes. */
	readonly text: string;
	/** Names of generator functions whose output is interpolated inside
	 * `text` (for example `fieldKindGuide`), so a reader knows which parts of
	 * a segment are derived from domain schemas rather than hand-written. */
	readonly generated?: readonly string[];
}

/** The separator every composed system prompt places between segments. */
export const PROMPT_SEGMENT_SEPARATOR = "\n\n---\n\n";

export function joinPromptSegments(segments: readonly PromptSegment[]): string {
	return segments.map((segment) => segment.text).join(PROMPT_SEGMENT_SEPARATOR);
}
