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

export function datePatternProblem(pattern: string): string | null {
	if (pattern.length === 0) {
		return "Enter a custom style or choose a date piece";
	}
	const parsed = parseCommCareDatePattern(pattern);
	if (parsed.kind === "parsed") return null;
	return unsupportedPatternMessage(parsed);
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
