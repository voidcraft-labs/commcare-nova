import type { Question } from "@/lib/schemas/blueprint";

/** Slash-delimited path identifying a question's position in the tree. e.g. "group1/child_q" or "top_level_q" */
export type QuestionPath = string & { readonly __brand: "QuestionPath" };

/** Build a path by appending a child ID to a parent path. */
export function qpath(id: string, parent?: QuestionPath): QuestionPath {
	return (parent ? `${parent}/${id}` : id) as QuestionPath;
}

/** Extract the bare ID (last segment) from a path. */
export function qpathId(path: QuestionPath): string {
	const idx = path.lastIndexOf("/");
	return idx === -1 ? path : path.slice(idx + 1);
}

/** Extract the parent path, or undefined for top-level. */
export function qpathParent(path: QuestionPath): QuestionPath | undefined {
	const idx = path.lastIndexOf("/");
	return idx === -1 ? undefined : (path.slice(0, idx) as QuestionPath);
}

// ── UUID helpers ─────────────────────────────────────────────────────

/**
 * Force-assign fresh UUIDs to every question in the tree.
 * Used after `structuredClone` in duplication — the clone must not share
 * the original's UUIDs since identity must be unique.
 */
export function reassignUuids(questions: Question[]): void {
	for (const q of questions) {
		q.uuid = crypto.randomUUID();
		if (q.children) reassignUuids(q.children);
	}
}

// ── Flattening helpers ───────────────────────────────────────────────

/** A question's stable identity (UUID) paired with its current tree path. */
export interface QuestionRef {
	path: QuestionPath;
	uuid: string;
}

/**
 * Walk a question tree depth-first, returning {path, uuid} pairs in visual
 * render order (skipping hidden questions). Use this instead of
 * `flattenQuestionPaths` when callers need both path (for mutations) and
 * UUID (for selection / DOM targeting).
 */
export function flattenQuestionRefs(
	questions: Question[],
	parent?: QuestionPath,
): QuestionRef[] {
	const refs: QuestionRef[] = [];
	for (const q of questions) {
		if (q.type === "hidden") continue;
		const path = qpath(q.id, parent);
		refs.push({ path, uuid: q.uuid });
		if (q.children) {
			refs.push(...flattenQuestionRefs(q.children, path));
		}
	}
	return refs;
}
