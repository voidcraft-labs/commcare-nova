// components/builder/case-list-config/path.ts
//
// Path-encoding helpers for the predicate card editor.
//
// `checkPredicate` (in `lib/domain/predicate/typeChecker.ts`) emits
// `CheckError.path: (string | number)[]` segments locating each
// violation inside the AST. The shape matches the walker's structure
// in `walk(...)` — recursive wrappers (`and` / `or` / `not` /
// `when-input-present` / `exists` / `missing`) push their `kind`
// segment first, then either an array index (`and` / `or`) or a slot
// name (`clause` / `where` / `input`); leaf operators push only the
// slot name (`left`, `right`, `property`, `center`, `values`, etc.).
//
// The card editor mirrors that path structure when rendering each
// card so the editor's path-building stays in lockstep with the
// checker's path-emitting. Errors flow from the checker's verdict
// into a `validityIndex` keyed by the path's serialized form;
// individual cards look up their own path's errors when rendering
// inline diagnostics. Cards do NOT recompute paths from the AST
// shape directly — they receive their own path as a prop and pass
// extended copies to nested children, mirroring the walker's
// `[...path, ...]` accumulation pattern.

/**
 * A path through the predicate AST. Mirrors `CheckPath` from
 * `lib/domain/predicate/typeChecker.ts`. Strings name slots
 * (`"left"`, `"property"`, `"clause"`, etc.) or operator-kind
 * segments (`"and"`, `"or"`, `"not"`, `"when-input-present"`,
 * `"exists"`, `"missing"`); numbers locate clauses or values inside
 * an array.
 */
export type EditorPath = readonly (string | number)[];

/**
 * Empty path — the root of the predicate AST. Operator-level errors
 * (e.g. "between has lower > upper") attach here.
 */
export const ROOT_PATH: EditorPath = [];

/**
 * Append a slot name to a path. Used by leaf operators when threading
 * the slot's path into a child input.
 *
 * Example: a `comparison` card holding the `left` operand passes
 * `appendSlot(path, "left")` to its operand input.
 */
export function appendSlot(path: EditorPath, slot: string): EditorPath {
	return [...path, slot];
}

/**
 * Append an operator-kind segment plus a slot name. Used by recursive
 * wrappers when descending into a single-slot child (`not.clause`,
 * `when-input-present.clause`, `exists.where`).
 *
 * Mirrors the walker's pattern in `lib/domain/predicate/typeChecker.ts`:
 *   `walk(p.clause, ctx, errors, [...path, p.kind, "clause"])`
 */
export function appendKindSlot(
	path: EditorPath,
	kind: string,
	slot: string,
): EditorPath {
	return [...path, kind, slot];
}

/**
 * Append an operator-kind segment plus an array index. Used by `and`
 * / `or` when descending into a clause:
 *   `walk(p.clauses[i], ctx, errors, [...path, p.kind, i])`
 */
export function appendKindIndex(
	path: EditorPath,
	kind: string,
	index: number,
): EditorPath {
	return [...path, kind, index];
}

/**
 * Append an indexed slot. Used by leaf operators with array operand
 * slots (`in.values`, `multi-select-contains.values`):
 *   `[...path, "values", i]`
 */
export function appendSlotIndex(
	path: EditorPath,
	slot: string,
	index: number,
): EditorPath {
	return [...path, slot, index];
}

/**
 * Serialize a path into a stable string suitable for Map keys. Two
 * paths with identical segments produce identical strings; segments
 * are joined by `\0` (the null byte) which never appears in a CCHQ
 * identifier or a slot name, so collisions are structurally
 * impossible. The `\0` separator is a stricter choice than `/` —
 * neither character appears in slot names today, but the null
 * byte's absence from the ASCII printable range makes the
 * separator unambiguously non-content.
 */
export function serializePath(path: EditorPath): string {
	return path.map(String).join("\0");
}

/**
 * Reverse of `serializePath` — used in tests / debugging only. The
 * runtime editor never deserializes; it routes through map lookups
 * by serialized key.
 */
export function deserializePath(serialized: string): EditorPath {
	if (serialized === "") return ROOT_PATH;
	return serialized.split("\0").map((segment) => {
		const asNumber = Number(segment);
		// Numeric segments are array indices; everything else is a
		// slot name or operator kind. The structural check
		// distinguishes the two without committing to a per-slot
		// schema.
		return Number.isInteger(asNumber) && String(asNumber) === segment
			? asNumber
			: segment;
	});
}
