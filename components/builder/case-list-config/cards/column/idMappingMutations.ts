// Pure array mutations for the id-mapping column's variadic
// `mapping` slot. Each function takes the current mapping list +
// a position / patch / value and returns the next list. No React,
// no UI projection — these are the state-model functions the
// IdMappingCard's per-button handlers route through.

import { type IdMappingEntry, idMappingEntry } from "@/lib/domain";

/**
 * Append a fresh empty entry to the mapping list. The empty
 * `{ value: "", label: "" }` is the canonical seed the user
 * authors over via the per-row inputs.
 */
export function appendMappingEntry(
	mapping: readonly IdMappingEntry[],
): readonly IdMappingEntry[] {
	return [...mapping, idMappingEntry("", "")];
}

/**
 * Drop the entry at `index` from the mapping list. Out-of-range
 * indices produce an unchanged-shape copy — callers must validate
 * the index before invoking.
 */
export function removeMappingEntry(
	mapping: readonly IdMappingEntry[],
	index: number,
): readonly IdMappingEntry[] {
	return mapping.filter((_, i) => i !== index);
}

/**
 * Move the entry at `from` to position `to`. Bounds-checked: a
 * move past either end of the array, or a self-move, returns the
 * input unchanged so callers can route disabled-button presses
 * through without separate gating.
 */
export function moveMappingEntry(
	mapping: readonly IdMappingEntry[],
	from: number,
	to: number,
): readonly IdMappingEntry[] {
	if (to < 0 || to >= mapping.length || from === to) return mapping;
	if (from < 0 || from >= mapping.length) return mapping;
	const next = [...mapping];
	const [moved] = next.splice(from, 1);
	if (moved === undefined) return mapping;
	next.splice(to, 0, moved);
	return next;
}

/**
 * Apply a per-entry patch — overlay `patch` onto the entry at
 * `index`, leaving every other entry verbatim. The runtime
 * column-builder accepts both fields so a partial patch can
 * update just `value` or just `label` without re-emitting the
 * other.
 */
export function patchMappingEntry(
	mapping: readonly IdMappingEntry[],
	index: number,
	patch: Partial<IdMappingEntry>,
): readonly IdMappingEntry[] {
	return mapping.map((entry, i) =>
		i === index ? { ...entry, ...patch } : entry,
	);
}
