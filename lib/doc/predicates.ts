/**
 * Pure, non-React predicates over the doc-store shape.
 *
 * This module exists as the single source of truth for "does the doc
 * have data?" and any future whole-doc predicate. Subscription callbacks
 * outside React (e.g. the `useAutoSave` store subscriber), reactive
 * hooks (`useDocHasData`, `useBuilderPhase`), and pure tests all consume
 * the same implementation — if the definition ever grows (e.g. also
 * requires a non-empty `formOrder`), every call site updates in lockstep.
 *
 * The type signature intentionally structurally narrows to the fields
 * actually inspected, so a caller can pass a `BlueprintDocState`, a
 * `PersistableDoc`, or a synthetic test fixture without an unsafe cast.
 */

/**
 * True when the doc has at least one module — i.e. the user has a
 * usable blueprint. "Empty doc" means `moduleOrder.length === 0`
 * regardless of how many orphan entities may exist in the maps.
 *
 * Structural param typing: we only need to read `moduleOrder.length`,
 * so accepting any shape that exposes a `readonly unknown[]` there lets
 * both the doc-store state and the persisted snapshot satisfy it
 * without duplication or casts.
 */
export function docHasData(doc: {
	readonly moduleOrder: readonly unknown[];
}): boolean {
	return doc.moduleOrder.length > 0;
}
