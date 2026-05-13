// components/builder/shared/nodeIdentity.ts
//
// Stable per-AST-node identity for the predicate card editor.
//
// The Predicate AST has no built-in uuids — it's a value-typed
// discriminated union persisted as plain JSON, and the type-checker
// + reducers + wire emitters all consume the typed shape directly.
// Adding uuids to the AST would pollute every persisted shape,
// every wire emitter, and the SA tool surface for a concern that's
// purely UI-local (React keys, drag-and-drop ids, DOM selectors).
//
// Instead, the editor maintains a `WeakMap<Predicate, string>` that
// hands out a stable id the first time it sees a given object
// reference. Reducers like `reduceAnd(...)` produce new array
// objects whose CLAUSES retain reference identity (the reducer
// re-uses the input clauses verbatim — see
// `lib/domain/predicate/reduction.ts`), so a clause swap inside an
// `and` group preserves the per-clause identity and React's key
// stability across re-renders. A clause that's genuinely new
// (constructed from a default-value factory in `editorSchemas.ts`)
// gets a fresh id on first lookup.
//
// The WeakMap is module-scoped because identity must persist across
// every render and across every PredicateCardEditor instance — two
// nested editors operating on the same AST subtree should agree on
// each node's id. The map is GC-driven: when a clause leaves the AST
// (e.g. removed from an and's clauses), the reducer drops its
// reference and the WeakMap entry is collected.

const nodeIds = new WeakMap<object, string>();

/**
 * Return the stable id for an AST node. Allocates and caches a fresh
 * id on first lookup; returns the cached id on subsequent calls
 * against the same object reference.
 *
 * Generic on `T extends object` so the helper works against
 * `Predicate`, `ValueExpression`, `Term`, and any other AST node
 * with reference identity. Primitives (string / number literals)
 * have no reference identity to track and never reach this helper —
 * literal values flow through their parent's path-derived key
 * instead.
 */
export function nodeId<T extends object>(node: T): string {
	const existing = nodeIds.get(node);
	if (existing !== undefined) return existing;
	// `crypto.randomUUID` is the platform identity primitive; the
	// editor only consumes the result for React keys and DOM ids,
	// so any unique opaque string suffices. The UUID format also
	// makes the ids inspectable in DevTools without ambiguity.
	const id = crypto.randomUUID();
	nodeIds.set(node, id);
	return id;
}
