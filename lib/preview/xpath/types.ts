/** XPath value types — nodesets not needed for MVP (form paths resolve to scalars). */
export type XPathValue = string | number | boolean;

/** Context for evaluating XPath expressions within a form. */
export interface EvalContext {
	/** Resolve an absolute path (/data/question_id) to its current value. */
	getValue(path: string): string | undefined;
	/** Resolve a hashtag ref (#case/prop, #user/prop, #form/question_id) to a value. */
	resolveHashtag(ref: string): string;
	/** Current question path (for '.') */
	contextPath: string;
	/** Current repeat position (for position()) — 1-based */
	position: number;
	/** Current repeat size (for last()) */
	size: number;
}
