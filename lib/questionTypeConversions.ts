/**
 * Field-kind conversion map — defines which field kinds can logically
 * convert to which other kinds. Conversions are restricted to kinds
 * within the same input paradigm where properties (validation,
 * relevancy, options, etc.) transfer meaningfully. Kinds with no valid
 * conversions render a disabled button in the footer.
 *
 * Rationale: changing a field's kind is rare — it takes the same number
 * of clicks to create a new field. The only reason to convert is when
 * you have properties set and want to keep them, which only makes sense
 * between nearly identical kinds.
 */

import type { FieldKind } from "@/lib/domain";

/** Strict conversion families — kinds map only to their logical siblings. */
const CONVERSION_MAP: Record<FieldKind, readonly FieldKind[]> = {
	/* Text input: both capture free-form text, secret just masks display */
	text: ["secret"],
	secret: ["text"],

	/* Numeric: both capture numbers, just precision difference */
	int: ["decimal"],
	decimal: ["int"],

	/* Temporal: all time-based inputs, properties transfer cleanly */
	date: ["time", "datetime"],
	time: ["date", "datetime"],
	datetime: ["date", "time"],

	/* Selection: same options/UI paradigm, just cardinality */
	single_select: ["multi_select"],
	multi_select: ["single_select"],

	/* Media capture: all binary capture with identical property sets */
	image: ["audio", "video", "signature"],
	audio: ["image", "video", "signature"],
	video: ["image", "audio", "signature"],
	signature: ["image", "audio", "video"],

	/* Structural: both contain children, repeat just adds iteration */
	group: ["repeat"],
	repeat: ["group"],

	/* Non-convertible: fundamentally unique input paradigms */
	hidden: [],
	label: [],
	geopoint: [],
	barcode: [],
};

/**
 * Returns the kinds a given field kind can logically convert to.
 * Empty array means the kind has no valid conversions (button should
 * be disabled).
 */
export function getConvertibleTypes(kind: FieldKind): readonly FieldKind[] {
	return CONVERSION_MAP[kind];
}
