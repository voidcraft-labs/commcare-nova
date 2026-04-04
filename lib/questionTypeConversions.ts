/**
 * Type conversion map — defines which question types can logically convert
 * to which other types. Conversions are restricted to types within the same
 * input paradigm where properties (validation, relevancy, options, etc.)
 * transfer meaningfully. Types with no valid conversions render a disabled
 * button in the footer.
 *
 * Rationale: changing a question type is rare — it takes the same number of
 * clicks to create a new question. The only reason to convert is when you
 * have properties set and want to keep them, which only makes sense between
 * nearly identical types.
 */

import type { Question } from "@/lib/schemas/blueprint";

type QuestionType = Question["type"];

/** Strict conversion families — types map only to their logical siblings. */
const CONVERSION_MAP: Record<QuestionType, readonly QuestionType[]> = {
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
 * Returns the types a given question type can logically convert to.
 * Empty array means the type has no valid conversions (button should be disabled).
 */
export function getConvertibleTypes(
	type: QuestionType,
): readonly QuestionType[] {
	return CONVERSION_MAP[type];
}
