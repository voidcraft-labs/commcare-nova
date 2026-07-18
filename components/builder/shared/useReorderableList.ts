// components/builder/shared/useReorderableList.ts
//
// Shared drag-and-drop reorder primitives for every list-shaped
// editor surface. Today's consumers:
//
//   - `concat.parts` (variadic text concatenation)
//   - `coalesce.values` (variadic fallback chain)
//   - `switch.cases` (multi-case dispatch)
//   - case-list display order + `sort` priority
//
// Each surface reorders inside ONE container; cross-container drops
// never apply. The hook is generic over `T` (the row payload type)
// and accepts a free-form `containerKind` discriminator so call
// sites pick their own scope token without coupling to a closed
// enum here.
//
// The pattern factors what `LogicalGroupCard`'s `AndOrBody`
// established (per-container monitor scoped by nodeKey, ref-stash so
// the monitor effect deps stay [containerKey], custom drag preview
// via `setCustomNativeDragPreview`, adjacency suppression so the
// preview doesn't flicker into the source's slot). Centralizing here
// keeps every consumer structurally identical — a behavior change
// lands in one place rather than drifting across N near-duplicates.
//
// Two pieces:
//
//   - `useReorderableList(...)` — installs the
//     `monitorForElements` for the container. Owns the monitor's
//     drag/drop bookkeeping, ref-stashes the latest items + reorder
//     callback, and tracks the active-drag indicator. Returns the
//     `pendingDrop` state so the caller can pass it to each row.
//
//   - `<ReorderableRow>` — per-row component that installs the
//     `draggable()` (on the row's grip handle) + `dropTargetForElements()`
//     (on the row's wrapper) + custom drag preview portal. Render one
//     per row inside the list; pass a render-prop child that consumes
//     the row's wiring (wrapper ref, handle setter, closest-edge,
//     preview portal, beingMoved flag).

"use client";
import { combine } from "@atlaskit/pragmatic-drag-and-drop/combine";
import {
	draggable,
	dropTargetForElements,
	monitorForElements,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { pointerOutsideOfPreview } from "@atlaskit/pragmatic-drag-and-drop/element/pointer-outside-of-preview";
import { setCustomNativeDragPreview } from "@atlaskit/pragmatic-drag-and-drop/element/set-custom-native-drag-preview";
import {
	attachClosestEdge,
	type Edge,
	extractClosestEdge,
} from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
	asDragPayload,
	type ListItemDragData,
	type ListItemDropData,
	readListItemDragData,
	readListItemDropData,
} from "./dragData";

/** Active-drag indicator state — the source row's index plus the
 *  resolved insertion index. The host card uses `fromIndex` to
 *  visually mark the source row as "being moved" and threads
 *  `toIndex` into a placeholder if needed. `null` means no drag in
 *  flight or cursor in dead space. */
export type PendingDrop = {
	/** Stable source identity; keeps the correct row marked when the list is
	 * reordered remotely before the next pointer event. */
	readonly itemKey: string;
	readonly fromIndex: number;
	readonly toIndex: number;
} | null;

/** The one item move that produced a reordered array. Consumers backed by
 * fractional keys use this metadata to write only the moved entity. */
export interface ReorderMove<T> {
	readonly item: T;
	readonly fromIndex: number;
	/** Final index after removing the item from `fromIndex`. */
	readonly toIndex: number;
}

/** Keyboard commands shared by every reorder handle. Home and End provide a
 * fast path through long authored lists; arrow keys make one-step changes. */
export type ReorderKeyboardKey = "ArrowUp" | "ArrowDown" | "Home" | "End";

/** Pure keyboard counterpart to drag reordering. Returns undefined at a list
 * boundary so the caller can announce that the item is already first/last
 * without emitting a no-op document mutation. */
export function reorderByKeyboard<T>(
	items: readonly T[],
	fromIndex: number,
	key: ReorderKeyboardKey,
): { readonly items: readonly T[]; readonly move: ReorderMove<T> } | undefined {
	const toIndex =
		key === "Home"
			? 0
			: key === "End"
				? items.length - 1
				: fromIndex + (key === "ArrowUp" ? -1 : 1);
	if (
		fromIndex < 0 ||
		fromIndex >= items.length ||
		toIndex < 0 ||
		toIndex >= items.length ||
		toIndex === fromIndex
	) {
		return undefined;
	}

	const reordered = [...items];
	const [moved] = reordered.splice(fromIndex, 1);
	if (moved === undefined) return undefined;
	reordered.splice(toIndex, 0, moved);
	return {
		items: reordered,
		move: { item: moved, fromIndex, toIndex },
	};
}

interface UseReorderableListArgs<T> {
	/** Stable per-container identity. The monitor and the source /
	 *  target payloads scope drops to this key, so an outer container
	 *  with a sibling list at the same nesting level doesn't accept
	 *  drags from this list. Use a stable per-mount identifier such as
	 *  React's `useId()`: immutable edits replace AST envelope objects,
	 *  so a value envelope is not a container identity. */
	readonly containerKey: string;
	/** The container's discriminator — drives the source / target
	 *  payloads and gates the monitor against cross-container drops.
	 *  Free-form so call sites pick their own scope token; the
	 *  `nodeKey` is the strict scope, `containerKind` is the coarser
	 *  belt-and-suspenders gate. */
	readonly containerKind: string;
	/** The container's current item list. The hook ref-stashes a
	 *  reference; the monitor effect re-installs only when
	 *  `containerKey` / `containerKind` changes. */
	readonly items: readonly T[];
	/** Stable, occurrence-safe identities parallel to `items`. These must not
	 * depend on array position: a multiplayer update can reorder `items` while
	 * the pointer is still down. */
	readonly itemKeys: readonly string[];
	/** Fired when a drop produces a new item order. Collection-valued editors
	 *  rebuild from `next`; fractional-order surfaces use `move` to write only
	 *  the moved entity rather than resequencing its neighbors. */
	readonly onReorder: (next: readonly T[], move: ReorderMove<T>) => void;
}

interface UseReorderableListResult {
	/** The active drag's source/target indices, or `null` when no
	 *  drag is in flight. The host card threads this into each row
	 *  via `<ReorderableRow pendingDrop=...>` so the rows can render
	 *  the indicator at the resolved insertion edge. */
	readonly pendingDrop: PendingDrop;
}

/**
 * Install the reorder monitor for one list container. Returns the
 * pending-drop state for visual indicators. Render one
 * `<ReorderableRow>` per item; the row component owns the row-side
 * draggable + drop-target wiring.
 */
export function useReorderableList<T>(
	args: UseReorderableListArgs<T>,
): UseReorderableListResult {
	const { containerKey, containerKind, items, itemKeys, onReorder } = args;
	const [pendingDrop, setPendingDrop] = useState<PendingDrop>(null);

	// Ref-stash: write the latest items + onReorder during render so
	// the monitor effect's deps stay `[containerKey, containerKind]`.
	// Same pattern AndOrBody uses; without the stash the monitor
	// re-installs on every parent render that emits a fresh items
	// array.
	const itemsRef = useRef(items);
	const itemKeysRef = useRef(itemKeys);
	const onReorderRef = useRef(onReorder);
	itemsRef.current = items;
	itemKeysRef.current = itemKeys;
	onReorderRef.current = onReorder;

	useEffect(() => {
		const cleanup = monitorForElements({
			canMonitor: ({ source }) => {
				const data = readListItemDragData(source.data);
				return (
					data !== undefined &&
					data.nodeKey === containerKey &&
					data.containerKind === containerKind
				);
			},
			onDrop: ({ source, location }) => {
				setPendingDrop(null);
				const sourceData = readListItemDragData(source.data);
				if (
					sourceData === undefined ||
					sourceData.nodeKey !== containerKey ||
					sourceData.containerKind !== containerKind
				) {
					return;
				}
				const target = location.current.dropTargets[0];
				if (target === undefined) return;
				const targetData = readListItemDropData(target.data);
				if (
					targetData === undefined ||
					targetData.nodeKey !== containerKey ||
					targetData.containerKind !== containerKind
				) {
					return;
				}
				const edge = extractClosestEdge(target.data);
				const resolved = reorderByStableItemKey({
					items: itemsRef.current,
					itemKeys: itemKeysRef.current,
					sourceItemKey: sourceData.itemKey,
					targetItemKey: targetData.itemKey,
					placeAfterTarget: edge === "bottom" || edge === "right",
				});
				if (resolved === undefined) return;
				onReorderRef.current(resolved.items, resolved.move);
			},
			onDrag: ({ source, location }) => {
				const sourceData = readListItemDragData(source.data);
				if (
					sourceData === undefined ||
					sourceData.nodeKey !== containerKey ||
					sourceData.containerKind !== containerKind
				) {
					return;
				}
				const target = location.current.dropTargets[0];
				if (target === undefined) {
					setPendingDrop(null);
					return;
				}
				const targetData = readListItemDropData(target.data);
				if (
					targetData === undefined ||
					targetData.nodeKey !== containerKey ||
					targetData.containerKind !== containerKind
				) {
					setPendingDrop(null);
					return;
				}
				const edge = extractClosestEdge(target.data);
				const resolved = reorderByStableItemKey({
					items: itemsRef.current,
					itemKeys: itemKeysRef.current,
					sourceItemKey: sourceData.itemKey,
					targetItemKey: targetData.itemKey,
					placeAfterTarget: edge === "bottom" || edge === "right",
				});
				if (resolved === undefined) {
					// Adjacency suppression — drop would be a no-op.
					setPendingDrop(null);
					return;
				}
				setPendingDrop({
					itemKey: sourceData.itemKey,
					fromIndex: resolved.move.fromIndex,
					toIndex: resolved.move.toIndex,
				});
			},
		});
		return () => cleanup();
	}, [containerKey, containerKind]);

	return { pendingDrop };
}

interface StableItemReorderArgs<T> {
	readonly items: readonly T[];
	readonly itemKeys: readonly string[];
	readonly sourceItemKey: string;
	readonly targetItemKey: string;
	readonly placeAfterTarget: boolean;
}

interface StableItemReorderResult<T> {
	readonly items: readonly T[];
	readonly move: ReorderMove<T>;
}

/**
 * Resolve a drag against the latest list snapshot by stable identity. The
 * source and target indices embedded in native drag payloads describe the DOM
 * at registration time, so they are unsafe after a remote multiplayer frame.
 * Missing source/target rows and adjacency no-ops deliberately produce no
 * mutation.
 */
export function reorderByStableItemKey<T>(
	args: StableItemReorderArgs<T>,
): StableItemReorderResult<T> | undefined {
	const { items, itemKeys, sourceItemKey, targetItemKey, placeAfterTarget } =
		args;
	if (itemKeys.length !== items.length) return undefined;
	const fromIndex = itemKeys.indexOf(sourceItemKey);
	const targetIndex = itemKeys.indexOf(targetItemKey);
	if (fromIndex < 0 || targetIndex < 0) return undefined;

	let toIndex = targetIndex + (placeAfterTarget ? 1 : 0);
	// Trello-style insertion semantics: removing an earlier source shifts the
	// target insertion slot left by one.
	if (fromIndex < toIndex) toIndex -= 1;
	if (fromIndex === toIndex) return undefined;

	const reordered = [...items];
	const [moved] = reordered.splice(fromIndex, 1);
	if (moved === undefined) return undefined;
	reordered.splice(toIndex, 0, moved);
	return {
		items: reordered,
		move: { item: moved, fromIndex, toIndex },
	};
}

/** Per-row wiring the host card's row component consumes via the
 *  render-prop child of `<ReorderableRow>`. */
export interface ReorderableRowWiring {
	/** Drop-target hit area — install on the row's outer wrapper as
	 *  `<div ref={wrapperRef}>`. Returning the `RefObject` directly
	 *  (rather than a callback) matches the canonical `useRowDnd`
	 *  pattern at `components/preview/form/virtual/useRowDnd.ts`:
	 *  React reads the same object identity every render, so the
	 *  binding doesn't detach + re-attach across re-renders. */
	readonly wrapperRef: React.RefObject<HTMLDivElement | null>;
	/** Ref-callback the row threads into the card's grip handle. The
	 *  row component installs `draggable()` on this element. */
	readonly setHandleEl: (el: HTMLElement | null) => void;
	/** `"top"` / `"bottom"` / `null`. The row renders a violet
	 *  insertion indicator at the matching edge during drag-over. */
	readonly closestEdge: Edge | null;
	/** The portal node to render alongside the row's own DOM. `null`
	 *  when no drag preview is in flight. */
	readonly previewPortal: ReactNode;
	/** Whether the row is the active drag source. Rows style themselves
	 *  with reduced opacity during drag. */
	readonly beingMoved: boolean;
}

interface ReorderableRowProps {
	readonly index: number;
	/** Stable identity from the parallel `itemKeys` vector in the container hook. */
	readonly itemKey: string;
	readonly containerKey: string;
	readonly containerKind: string;
	readonly pendingDrop: PendingDrop;
	/** Which way the list flows. Vertical rows (default) hit-test the
	 *  top/bottom edges; horizontal rows (e.g. table header cells)
	 *  hit-test left/right so the insertion point follows the pointer
	 *  along the row instead of within each cell's height. */
	readonly axis?: "vertical" | "horizontal";
	/** The custom drag preview React tree. The browser snapshots the
	 *  rendered tree as the native drag image; the tree lives in a
	 *  library-owned offscreen container outside the row's DOM, so
	 *  layout isn't affected. */
	readonly preview: ReactNode;
	/** Render-prop child receiving the per-row wiring. Wires the
	 *  wrapper ref, the grip-handle setter, the closest-edge
	 *  indicator, and the preview portal into the row's DOM. */
	readonly children: (wiring: ReorderableRowWiring) => ReactNode;
}

/**
 * Per-row scope owning the row's wrapper drop-target + grip
 * draggable + custom-preview portal. Render one per row inside the
 * list container; pass a render-prop child that consumes the row's
 * `ReorderableRowWiring` to wire its grip handle and closest-edge
 * indicator into its DOM.
 */
export function ReorderableRow(props: ReorderableRowProps): ReactNode {
	const {
		index,
		itemKey,
		containerKey,
		containerKind,
		pendingDrop,
		preview,
		children,
		axis = "vertical",
	} = props;
	const wrapperElRef = useRef<HTMLDivElement | null>(null);
	const [handleEl, setHandleEl] = useState<HTMLElement | null>(null);
	const [closestEdge, setClosestEdge] = useState<Edge | null>(null);
	const [previewState, setPreviewState] = useState<
		| { readonly type: "idle" }
		| { readonly type: "active"; readonly container: HTMLElement }
	>({ type: "idle" });

	useEffect(() => {
		const wrapper = wrapperElRef.current;
		if (wrapper === null) return;
		const dragData: ListItemDragData = {
			kind: "list-item-drag",
			containerKind,
			itemKey,
			itemIndex: index,
			nodeKey: containerKey,
		};
		const dropData: ListItemDropData = {
			kind: "list-item-drop",
			containerKind,
			itemKey,
			itemIndex: index,
			nodeKey: containerKey,
		};
		const cleanup = combine(
			handleEl !== null
				? draggable({
						element: handleEl,
						getInitialData: () => asDragPayload(dragData),
						onGenerateDragPreview: ({ nativeSetDragImage }) => {
							setCustomNativeDragPreview({
								nativeSetDragImage,
								getOffset: pointerOutsideOfPreview({
									x: "16px",
									y: "8px",
								}),
								render: ({ container }) => {
									setPreviewState({ type: "active", container });
									return () => setPreviewState({ type: "idle" });
								},
							});
						},
					})
				: () => {},
			dropTargetForElements({
				element: wrapper,
				canDrop: ({ source }) => {
					const d = readListItemDragData(source.data);
					return (
						d !== undefined &&
						d.nodeKey === containerKey &&
						d.containerKind === containerKind
					);
				},
				getData: ({ input, element }) =>
					attachClosestEdge(asDragPayload(dropData), {
						input,
						element,
						allowedEdges:
							axis === "horizontal" ? ["left", "right"] : ["top", "bottom"],
					}),
				onDrag: ({ self }) => {
					setClosestEdge(extractClosestEdge(self.data));
				},
				onDragLeave: () => {
					setClosestEdge(null);
				},
				onDrop: () => {
					setClosestEdge(null);
				},
			}),
		);
		return () => cleanup();
	}, [containerKey, containerKind, handleEl, index, itemKey, axis]);

	const beingMoved = pendingDrop !== null && pendingDrop.itemKey === itemKey;

	const previewPortal: ReactNode =
		previewState.type === "active"
			? createPortal(preview, previewState.container)
			: null;

	return children({
		wrapperRef: wrapperElRef,
		setHandleEl,
		closestEdge,
		previewPortal,
		beingMoved,
	});
}
