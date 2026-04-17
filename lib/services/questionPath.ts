import type { Question } from "@/lib/schemas/blueprint";

/**
 * Slash-delimited id path. Still used by:
 *   - `lib/references/**` — reference parser / renderer stores `#form/...`
 *     label anchors as question paths.
 *   - `components/preview/form/**` — the preview renderer threads paths
 *     through `GroupField` / `RepeatField` / `FormRenderer` as render-tree
 *     identity for label/value wiring.
 *   - `components/builder/AppTree.tsx` — tree-sidebar walk builds a
 *     local path→uuid index.
 *   - `lib/doc/mutations/fields.ts` — mutation result types carry a
 *     `newPath: QuestionPath` for toast telemetry.
 *
 * Pure navigation (keyboard shortcuts, move targets, delete-neighbor
 * resolution) moved to uuid-keyed domain primitives in
 * `lib/doc/navigation.ts`. Paths should NOT be used as identity for new
 * code — uuids are the stable identity across renames.
 */
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
