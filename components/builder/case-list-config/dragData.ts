// components/builder/case-list-config/dragData.ts
//
// Typed drag-and-drop payloads for the predicate card editor.
//
// Pragmatic-drag-and-drop stores arbitrary `Record<string | symbol,
// unknown>` on each source + drop target. The cast at the boundary
// loses our nominal `kind` discriminator, so we centralize the
// brand-and-cast in one helper rather than scattering
// `as unknown as Record<...>` casts at every registration site.
// Same pattern the form-virtual-list uses
// (`components/preview/form/virtual/dragData.ts`); a new drop-
// target `kind` lands as one entry here, not new casts at every
// call site.

/**
 * Source-side payload — identifies which clause is being dragged
 * inside which logical group. The `nodeKey` field is the parent
 * `and` / `or` group's stable id (per `nodeIdentity.ts`); it
 * scopes the drop to that group's clause list so a clause can
 * never reorder into a sibling group's list at the wire layer.
 */
export interface ClauseDragData {
	readonly kind: "predicate-clause-drag";
	readonly groupKind: "and" | "or";
	readonly clauseIndex: number;
	readonly nodeKey: string;
}

/**
 * Drop-target payload — identifies a row clause's slot inside a
 * group. Same `nodeKey` scoping as the source side; the monitor
 * pairs source + target by exact-match and rejects cross-group
 * drops.
 */
export interface ClauseDropData {
	readonly kind: "predicate-clause-drop";
	readonly groupKind: "and" | "or";
	readonly clauseIndex: number;
	readonly nodeKey: string;
}

/**
 * Lift a typed drag payload into the library's generic record
 * shape. Pragmatic-drag-and-drop's `getInitialData` /
 * `dropTargetForElements({ getData })` return types both require
 * `Record<string | symbol, unknown>`; the discriminator narrowing
 * happens at the read site via the matching `Partial<T>` cast.
 *
 * Centralizing the cast in this helper keeps every drag/drop
 * registration site a single typed call. Source citations for
 * the cast pattern: Atlassian's published examples
 * (https://atlassian.design/components/pragmatic-drag-and-drop)
 * and the form-virtual-list's `dragData.ts` use the same shape.
 */
export function asDragPayload<T extends { readonly kind: string }>(
	payload: T,
): Record<string | symbol, unknown> {
	return payload as unknown as Record<string | symbol, unknown>;
}

/**
 * Narrow a generic-record source data bag back into our typed
 * `ClauseDragData`. Returns `undefined` when the payload's `kind`
 * doesn't match — defensive against a concurrently-registered
 * unrelated drag source landing in the same monitor's
 * `source.data`. Mirrors `readDropTargetData` in the form-list
 * dragData module.
 */
export function readClauseDragData(
	data: Record<string | symbol, unknown>,
): ClauseDragData | undefined {
	const partial = data as Partial<ClauseDragData>;
	if (partial.kind !== "predicate-clause-drag") return undefined;
	if (partial.clauseIndex === undefined) return undefined;
	if (partial.nodeKey === undefined) return undefined;
	if (partial.groupKind !== "and" && partial.groupKind !== "or") {
		return undefined;
	}
	return {
		kind: "predicate-clause-drag",
		groupKind: partial.groupKind,
		clauseIndex: partial.clauseIndex,
		nodeKey: partial.nodeKey,
	};
}

/**
 * Symmetric reader for the drop-target side. Returns the typed
 * payload when the data bag's `kind` matches, otherwise `undefined`.
 */
export function readClauseDropData(
	data: Record<string | symbol, unknown>,
): ClauseDropData | undefined {
	const partial = data as Partial<ClauseDropData>;
	if (partial.kind !== "predicate-clause-drop") return undefined;
	if (partial.clauseIndex === undefined) return undefined;
	if (partial.nodeKey === undefined) return undefined;
	if (partial.groupKind !== "and" && partial.groupKind !== "or") {
		return undefined;
	}
	return {
		kind: "predicate-clause-drop",
		groupKind: partial.groupKind,
		clauseIndex: partial.clauseIndex,
		nodeKey: partial.nodeKey,
	};
}

// ── Expression-side reorder payloads ───────────────────────────────────
//
// Three drag surfaces inside the ValueExpression editor — `concat.parts`
// (variadic text concatenation), `coalesce.values` (variadic fallback
// chain), `switch.cases` (multi-case dispatch). Each surface reorders
// inside ONE container; cross-container drops never apply (a `concat`
// part can't move into a `coalesce` slot at the AST layer). Same
// nodeKey-scoped pattern as the predicate-clause drag/drop above —
// the monitor pairs source + target by exact match and rejects
// cross-container drops.
//
// One discriminated union per surface (drag vs drop) so the source
// `kind` discriminator stays the single dispatch key inside any
// monitor that owns multiple drag surfaces.

/** Source-side payload — identifies which item is being dragged in
 *  which container. The container kind ("concat" / "coalesce" /
 *  "switch") plus the container's stable nodeKey scopes the drop to
 *  the matching container's item list. */
export interface ExpressionItemDragData {
	readonly kind: "expression-item-drag";
	readonly containerKind: "concat" | "coalesce" | "switch";
	readonly itemIndex: number;
	readonly nodeKey: string;
}

/** Drop-target payload — symmetric with the source; identifies a
 *  target slot in the same container's item list. */
export interface ExpressionItemDropData {
	readonly kind: "expression-item-drop";
	readonly containerKind: "concat" | "coalesce" | "switch";
	readonly itemIndex: number;
	readonly nodeKey: string;
}

/** Narrow a source data bag back into the typed
 *  `ExpressionItemDragData`. Defensive against an unrelated drag
 *  source landing in the same monitor's `source.data`. */
export function readExpressionItemDragData(
	data: Record<string | symbol, unknown>,
): ExpressionItemDragData | undefined {
	const partial = data as Partial<ExpressionItemDragData>;
	if (partial.kind !== "expression-item-drag") return undefined;
	if (partial.itemIndex === undefined) return undefined;
	if (partial.nodeKey === undefined) return undefined;
	if (
		partial.containerKind !== "concat" &&
		partial.containerKind !== "coalesce" &&
		partial.containerKind !== "switch"
	) {
		return undefined;
	}
	return {
		kind: "expression-item-drag",
		containerKind: partial.containerKind,
		itemIndex: partial.itemIndex,
		nodeKey: partial.nodeKey,
	};
}

/** Symmetric reader for the drop-target side. */
export function readExpressionItemDropData(
	data: Record<string | symbol, unknown>,
): ExpressionItemDropData | undefined {
	const partial = data as Partial<ExpressionItemDropData>;
	if (partial.kind !== "expression-item-drop") return undefined;
	if (partial.itemIndex === undefined) return undefined;
	if (partial.nodeKey === undefined) return undefined;
	if (
		partial.containerKind !== "concat" &&
		partial.containerKind !== "coalesce" &&
		partial.containerKind !== "switch"
	) {
		return undefined;
	}
	return {
		kind: "expression-item-drop",
		containerKind: partial.containerKind,
		itemIndex: partial.itemIndex,
		nodeKey: partial.nodeKey,
	};
}
