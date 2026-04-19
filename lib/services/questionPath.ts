/**
 * Slash-delimited id path — render-tree identity for the preview renderer
 * and a display key in a handful of UI surfaces.
 *
 * Used by:
 *   - `lib/references/**` — reference parser / renderer stores `#form/...`
 *     label anchors as question paths.
 *   - `components/preview/form/**` — the preview renderer threads paths
 *     through `GroupField` / `RepeatField` / `FormRenderer` as render-tree
 *     identity for label/value wiring.
 *   - `components/builder/appTree/useSearchFilter.ts` — the sidebar
 *     search walk keys its match map by question path so the renderer
 *     can look up highlight ranges without re-deriving paths.
 *   - `components/builder/appTree/useFieldIconMap.ts` — the per-form
 *     icon map walk keys icons by question path so inline reference
 *     chips can resolve the correct type icon.
 *   - `lib/doc/mutations/fields.ts` — mutation result types carry a
 *     `newPath: QuestionPath` for toast telemetry.
 *
 * Pure navigation (keyboard shortcuts, move targets, delete-neighbor
 * resolution) moved to uuid-keyed domain primitives in
 * `lib/doc/navigation.ts`. Paths should NOT be used as identity for new
 * code — uuids are the stable identity across renames.
 *
 * These helpers are string primitives only: they don't know about the
 * wire `Question` shape or the domain `Field` shape. The path format is
 * the same on both sides of the boundary.
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
