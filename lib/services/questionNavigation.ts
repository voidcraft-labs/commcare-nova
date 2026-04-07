import { type QuestionPath, qpath, qpathId, qpathParent } from "./questionPath";

/** Minimal question shape for navigation — works with both Question and leaf schemas. */
export interface QuestionLike {
	id: string;
	type: string;
	children?: QuestionLike[];
}

/** Whether a question type is a container that can hold children. */
function isContainer(q: QuestionLike): boolean {
	return q.type === "group" || q.type === "repeat";
}

/** A cross-level (indent/outdent) move target for a question.
 *  Spread `targetParentPath`, `beforePath`, `afterPath` directly into
 *  `moveQuestion` opts. `direction` is for UI labelling only. */
export interface CrossLevelMoveTarget {
	targetParentPath: QuestionPath | undefined;
	beforePath?: QuestionPath;
	afterPath?: QuestionPath;
	direction: "into" | "out";
}

/**
 * Walk a question tree depth-first, returning an ordered list of QuestionPaths
 * in visual render order. Hidden questions are excluded — they have no rendered
 * surface and are invisible to keyboard navigation and form validation.
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
 * Navigate to the children array at a given parent path, or return the
 * root-level array when parentPath is undefined. Walks each segment of the
 * slash-delimited path and descends into `.children` at each level.
 */
function findSiblings(
	questions: QuestionLike[],
	parentPath: QuestionPath | undefined,
): QuestionLike[] | undefined {
	if (!parentPath) return questions;
	const segments = parentPath.split("/");
	let current = questions;
	for (const seg of segments) {
		const parent = current.find((q) => q.id === seg);
		if (!parent?.children) return undefined;
		current = parent.children;
	}
	return current;
}

/**
 * Compute the before/after move targets for a question among its siblings.
 *
 * Returns the path of the previous sibling as `beforePath` (to move the
 * question up) and the next sibling as `afterPath` (to move it down).
 * Either is `undefined` when the question is already at that boundary —
 * the first child in a group gets `beforePath: undefined`, the last gets
 * `afterPath: undefined`.
 *
 * Operates at the sibling level, not depth-first — this matches
 * `moveQuestion`'s same-parent constraint when called without
 * `targetParentPath`. Hidden questions are included because they occupy
 * real positions in the ordering array and must be accounted for.
 */
export function getQuestionMoveTargets(
	questions: QuestionLike[],
	questionPath: QuestionPath,
): {
	beforePath: QuestionPath | undefined;
	afterPath: QuestionPath | undefined;
} {
	const parentPath = qpathParent(questionPath);
	const siblings = findSiblings(questions, parentPath);
	if (!siblings) return { beforePath: undefined, afterPath: undefined };

	const id = qpathId(questionPath);
	const idx = siblings.findIndex((q) => q.id === id);
	if (idx === -1) return { beforePath: undefined, afterPath: undefined };

	return {
		beforePath: idx > 0 ? qpath(siblings[idx - 1].id, parentPath) : undefined,
		afterPath:
			idx < siblings.length - 1
				? qpath(siblings[idx + 1].id, parentPath)
				: undefined,
	};
}

/**
 * Compute cross-level (indent/outdent) move targets for a question.
 *
 * **Up (Shift+↑):**
 * - First child in a group → outdent: place before the group in its parent.
 * - Previous sibling is a group/repeat → indent: append as last child.
 *
 * **Down (Shift+↓):**
 * - Last child in a group → outdent: place after the group in its parent.
 * - Next sibling is a group/repeat → indent: prepend as first child.
 *
 * Returns `undefined` for a direction when no cross-level move is possible.
 */
export function getCrossLevelMoveTargets(
	questions: QuestionLike[],
	questionPath: QuestionPath,
): {
	up: CrossLevelMoveTarget | undefined;
	down: CrossLevelMoveTarget | undefined;
} {
	const parentPath = qpathParent(questionPath);
	const siblings = findSiblings(questions, parentPath);
	if (!siblings) return { up: undefined, down: undefined };

	const id = qpathId(questionPath);
	const idx = siblings.findIndex((q) => q.id === id);
	if (idx === -1) return { up: undefined, down: undefined };

	let up: CrossLevelMoveTarget | undefined;
	let down: CrossLevelMoveTarget | undefined;

	/* ── Up: outdent if first child, else indent into previous group ── */
	if (idx === 0 && parentPath !== undefined) {
		up = {
			targetParentPath: qpathParent(parentPath),
			beforePath: parentPath,
			direction: "out",
		};
	} else if (idx > 0 && isContainer(siblings[idx - 1])) {
		const groupPath = qpath(siblings[idx - 1].id, parentPath);
		up = { targetParentPath: groupPath, direction: "into" };
	}

	/* ── Down: outdent if last child, else indent into next group ── */
	if (idx === siblings.length - 1 && parentPath !== undefined) {
		down = {
			targetParentPath: qpathParent(parentPath),
			afterPath: parentPath,
			direction: "out",
		};
	} else if (idx < siblings.length - 1 && isContainer(siblings[idx + 1])) {
		const groupPath = qpath(siblings[idx + 1].id, parentPath);
		const groupChildren = siblings[idx + 1].children;
		down = {
			targetParentPath: groupPath,
			...(groupChildren?.length
				? { beforePath: qpath(groupChildren[0].id, groupPath) }
				: {}),
			direction: "into",
		};
	}

	return { up, down };
}
