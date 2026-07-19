// components/builder/shared/dragData.ts
//
// Typed drag-and-drop payloads for the predicate / expression /
// sort-key card editors.
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
 * `and` / `or` group's stable per-mount id (`useId()`); it
 * scopes the drop to that group's clause list so a clause can
 * never reorder into a sibling group's list at the wire layer.
 */
export interface ClauseDragData {
	readonly kind: "predicate-clause-drag";
	readonly groupKind: "and" | "or";
	readonly itemKey: string;
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
	readonly itemKey: string;
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
	if (typeof partial.itemKey !== "string") return undefined;
	if (partial.clauseIndex === undefined) return undefined;
	if (partial.nodeKey === undefined) return undefined;
	if (partial.groupKind !== "and" && partial.groupKind !== "or") {
		return undefined;
	}
	return {
		kind: "predicate-clause-drag",
		groupKind: partial.groupKind,
		itemKey: partial.itemKey,
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
	if (typeof partial.itemKey !== "string") return undefined;
	if (partial.clauseIndex === undefined) return undefined;
	if (partial.nodeKey === undefined) return undefined;
	if (partial.groupKind !== "and" && partial.groupKind !== "or") {
		return undefined;
	}
	return {
		kind: "predicate-clause-drop",
		groupKind: partial.groupKind,
		itemKey: partial.itemKey,
		clauseIndex: partial.clauseIndex,
		nodeKey: partial.nodeKey,
	};
}

// ── Generic list-item reorder payloads ─────────────────────────────────
//
// Generic list-reorder surface used by every list-shaped editor that
// reorders inside ONE container. Today's call sites:
//
//   - `concat.parts` — variadic text concatenation
//   - `coalesce.values` — variadic fallback chain
//   - `switch.cases` — multi-case dispatch
//   - `sort` — case-list sort-key list
//
// Each surface reorders inside its own container; cross-container drops
// never apply (a `concat` part can't move into a `coalesce` slot at the
// AST layer; a sort key can't move into a `switch` cases list). The
// monitor pairs source + target by exact `nodeKey` AND `containerKind`
// match and rejects cross-container drops.
//
// `containerKind` is a free-form `string` so call sites pick their own
// scope tokens without coupling to a closed enum here. The `nodeKey`
// is the strict scope (a stable id per mounted container); `containerKind` is
// a coarser belt-and-suspenders
// gate that catches a misregistered monitor before it ever reads the
// nodeKey. Same pattern the predicate-clause payload above uses with
// its own discriminator.

/** Source-side payload — identifies which item is being dragged in
 *  which container. The container kind plus the container's stable
 *  nodeKey scopes the drop to the matching container's item list. */
export interface ListItemDragData {
	readonly kind: "list-item-drag";
	readonly containerKind: string;
	/** Stable identity for the dragged item. Array positions can change while a
	 * drag is in flight when another collaborator reorders the same list. */
	readonly itemKey: string;
	/** Position at drag start. Used only for immediate visual feedback; drop
	 * resolution finds `itemKey` in the latest item list. */
	readonly itemIndex: number;
	readonly nodeKey: string;
}

/** Drop-target payload — symmetric with the source; identifies a
 *  target slot in the same container's item list. */
export interface ListItemDropData {
	readonly kind: "list-item-drop";
	readonly containerKind: string;
	/** Stable identity for the target item. The monitor resolves its current
	 * position at drag/drop time rather than trusting `itemIndex`. */
	readonly itemKey: string;
	readonly itemIndex: number;
	readonly nodeKey: string;
}

/** Narrow a source data bag back into the typed
 *  `ListItemDragData`. Defensive against an unrelated drag source
 *  landing in the same monitor's `source.data`. */
export function readListItemDragData(
	data: Record<string | symbol, unknown>,
): ListItemDragData | undefined {
	const partial = data as Partial<ListItemDragData>;
	if (partial.kind !== "list-item-drag") return undefined;
	if (typeof partial.itemKey !== "string") return undefined;
	if (partial.itemIndex === undefined) return undefined;
	if (partial.nodeKey === undefined) return undefined;
	if (typeof partial.containerKind !== "string") return undefined;
	return {
		kind: "list-item-drag",
		containerKind: partial.containerKind,
		itemKey: partial.itemKey,
		itemIndex: partial.itemIndex,
		nodeKey: partial.nodeKey,
	};
}

/** Symmetric reader for the drop-target side. */
export function readListItemDropData(
	data: Record<string | symbol, unknown>,
): ListItemDropData | undefined {
	const partial = data as Partial<ListItemDropData>;
	if (partial.kind !== "list-item-drop") return undefined;
	if (typeof partial.itemKey !== "string") return undefined;
	if (partial.itemIndex === undefined) return undefined;
	if (partial.nodeKey === undefined) return undefined;
	if (typeof partial.containerKind !== "string") return undefined;
	return {
		kind: "list-item-drop",
		containerKind: partial.containerKind,
		itemKey: partial.itemKey,
		itemIndex: partial.itemIndex,
		nodeKey: partial.nodeKey,
	};
}
