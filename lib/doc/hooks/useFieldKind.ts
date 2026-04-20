/**
 * Named hooks for AppTree row rendering — narrow reads used by field
 * row + group-header components.
 *
 * Each hook selects only the primitive of interest (`kind` discriminant
 * or immediate-child count) rather than the full `fields[uuid]` entity.
 * Row re-renders fire only when that primitive actually changes, so
 * unrelated field edits (e.g. renaming a sibling) leave these rows
 * quiet.
 *
 * Both accept `Uuid | undefined` so call sites deriving the uuid from
 * discriminated-union URL selections don't need unsound casts.
 */

import type { Uuid } from "@/lib/doc/types";
import type { FieldKind } from "@/lib/domain";
import { useBlueprintDoc } from "./useBlueprintDoc";

/**
 * The `kind` discriminant of a field.
 *
 * Returns `undefined` when the uuid is missing or unresolved — callers
 * that want the rendered icon / label to fall back to a neutral state
 * pattern-match on `undefined` explicitly rather than guarding the hook
 * call.
 */
export function useFieldKind(uuid: Uuid | undefined): FieldKind | undefined {
	return useBlueprintDoc((s) => (uuid ? s.fields[uuid]?.kind : undefined));
}

/**
 * Count of immediate children under a form, group, or repeat.
 *
 * Reads `fieldOrder[parentUuid]?.length` — direct children only, not the
 * full descendant count. Returns 0 when the parent has no entry in
 * `fieldOrder` or when `parentUuid` is undefined. Driven by primitive
 * comparison, so zero-child containers don't re-render on sibling edits.
 */
export function useChildFieldCount(parentUuid: Uuid | undefined): number {
	return useBlueprintDoc((s) =>
		parentUuid ? (s.fieldOrder[parentUuid]?.length ?? 0) : 0,
	);
}
