import {
	type CommCareDatePatternParseResult,
	parseCommCareDatePattern,
} from "@/lib/domain/commCareDatePattern";

export function insertDatePiece(
	draft: string,
	piece: string,
	start = draft.length,
	end = start,
) {
	return {
		draft: `${draft.slice(0, start)}${piece}${draft.slice(end)}`,
		caret: start + piece.length,
	};
}

/**
 * The problem a custom date style draft has, or `null` when it can be saved.
 * A case-list date column (`concrete`) also refuses a straight apostrophe,
 * which CommCare HQ's date column cannot store
 * (`CASE_LIST_DATE_PATTERN_APOSTROPHE`); a `format-date` expression
 * (`expression`) is printed by Nova itself and takes any character.
 */
export function datePatternProblem(
	pattern: string,
	patternVocabulary: "expression" | "concrete",
): string | null {
	if (pattern.length === 0) {
		return "Enter a custom style or choose a date piece";
	}
	const parsed = parseCommCareDatePattern(pattern);
	if (parsed.kind !== "parsed") return unsupportedPatternMessage(parsed);
	if (patternVocabulary === "concrete" && pattern.includes("'")) {
		return "A date style can't hold a straight apostrophe ('). You can use a curved one (’).";
	}
	return null;
}

function unsupportedPatternMessage(
	problem: Extract<
		CommCareDatePatternParseResult,
		{ kind: "unsupported-pattern" }
	>,
): string {
	return problem.escape === undefined
		? "Finish the date piece after % or remove it"
		: `${problem.escape} isn't a date piece. Choose another piece or remove it`;
}
