import { type QuestionPath, qpath } from "./questionPath";

/** Minimal question shape for navigation — works with both Question and leaf schemas. */
interface QuestionLike {
	id: string;
	type: string;
	children?: QuestionLike[];
}

/**
 * Walk a question tree depth-first, returning an ordered list of QuestionPaths
 * in visual render order. Hidden questions are excluded — they have no rendered
 * surface and are invisible to keyboard navigation and form validation.
 *
 * When you need the full physical order (e.g. to find adjacency for move
 * operations), use `getQuestionMoveTargets` instead.
 */
export function flattenQuestionPaths(
	questions: QuestionLike[],
	parent?: QuestionPath,
): QuestionPath[] {
	const paths: QuestionPath[] = [];
	for (const q of questions) {
		if (q.type === "hidden") continue;
		const path = qpath(q.id, parent);
		paths.push(path);
		if (q.children) {
			paths.push(...flattenQuestionPaths(q.children, path));
		}
	}
	return paths;
}

/**
 * Walk a question tree depth-first, returning all QuestionPaths in physical
 * storage order — including hidden questions. Hidden questions live in the same
 * array as visible ones and must be included so move-up/down correctly places
 * any question type relative to its neighbors.
 *
 * This is an internal helper. Callers should use `getQuestionMoveTargets`.
 */
function flattenPhysicalPaths(
	questions: QuestionLike[],
	parent?: QuestionPath,
): QuestionPath[] {
	const paths: QuestionPath[] = [];
	for (const q of questions) {
		const path = qpath(q.id, parent);
		paths.push(path);
		if (q.children) {
			paths.push(...flattenPhysicalPaths(q.children, path));
		}
	}
	return paths;
}

/**
 * Compute the before/after move targets for a question in physical tree order.
 *
 * Returns the path that `moveQuestion` should use as `beforePath` (to move the
 * question up) and `afterPath` (to move it down). Either is `undefined` when
 * the question is already at that boundary.
 *
 * Hidden questions are included in the traversal so that all question types —
 * not just visible ones — can be reordered relative to each other. Callers
 * don't need to know this detail; the "full physical order" concern lives here.
 */
export function getQuestionMoveTargets(
	questions: QuestionLike[],
	questionPath: QuestionPath,
): {
	beforePath: QuestionPath | undefined;
	afterPath: QuestionPath | undefined;
} {
	const paths = flattenPhysicalPaths(questions);
	const idx = paths.indexOf(questionPath);
	if (idx === -1) return { beforePath: undefined, afterPath: undefined };
	return {
		beforePath: idx > 0 ? paths[idx - 1] : undefined,
		afterPath: idx < paths.length - 1 ? paths[idx + 1] : undefined,
	};
}
