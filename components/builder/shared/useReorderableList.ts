// components/builder/shared/useReorderableList.ts
//
// Shared drag-and-drop reorder primitives for every list-shaped
// editor surface. Today's consumers:
//
//   - `concat.parts` (variadic text concatenation)
//   - `coalesce.values` (variadic fallback chain)
//   - `switch.cases` (multi-case dispatch)
//   - `sort` (case-list sort-key list)
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
	readonly fromIndex: number;
	readonly toIndex: number;
} | null;

interface UseReorderableListArgs<T> {
	/** Stable per-container identity. The monitor and the source /
	 *  target payloads scope drops to this key, so an outer container
	 *  with a sibling list at the same nesting level doesn't accept
	 *  drags from this list. Use `nodeId(value)` from
	 *  `nodeIdentity.ts` for AST-rooted containers; for non-AST
	 *  containers (e.g. the SortKey list, which has no envelope
	 *  object), use a stable per-mount identifier. */
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
	/** Fired when a drop produces a new item order. Receives the
	 *  reordered array; the caller rebuilds the list-owning AST via
	 *  the matching builder. */
	readonly onReorder: (next: readonly T[]) => void;
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
	const { containerKey, containerKind, items, onReorder } = args;
	const [pendingDrop, setPendingDrop] = useState<PendingDrop>(null);

	// Ref-stash: write the latest items + onReorder during render so
	// the monitor effect's deps stay `[containerKey, containerKind]`.
	// Same pattern AndOrBody uses; without the stash the monitor
	// re-installs on every parent render that emits a fresh items
	// array.
	const itemsRef = useRef(items);
	const onReorderRef = useRef(onReorder);
	itemsRef.current = items;
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
				const fromIndex = sourceData.itemIndex;
				let toIndex = targetData.itemIndex;
				const edge = extractClosestEdge(target.data);
				// "bottom" is the after-edge on the vertical axis; "right"
				// is its horizontal-axis twin (rows that opted into
				// `axis="horizontal"` on their `ReorderableRow`).
				if (edge === "bottom" || edge === "right") toIndex += 1;
				// Adjacency adjustment — Trello-style insertion semantics.
				if (fromIndex < toIndex) toIndex -= 1;
				if (fromIndex === toIndex) return;
				const reordered = [...itemsRef.current];
				const [moved] = reordered.splice(fromIndex, 1);
				reordered.splice(toIndex, 0, moved);
				onReorderRef.current(reordered);
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
				let to = targetData.itemIndex;
				if (edge === "bottom" || edge === "right") to += 1;
				if (sourceData.itemIndex < to) to -= 1;
				if (sourceData.itemIndex === to) {
					// Adjacency suppression — drop would be a no-op.
					setPendingDrop(null);
					return;
				}
				setPendingDrop({ fromIndex: sourceData.itemIndex, toIndex: to });
			},
		});
		return () => cleanup();
	}, [containerKey, containerKind]);

	return { pendingDrop };
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
			itemIndex: index,
			nodeKey: containerKey,
		};
		const dropData: ListItemDropData = {
			kind: "list-item-drop",
			containerKind,
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
	}, [containerKey, containerKind, handleEl, index, axis]);

	const beingMoved = pendingDrop !== null && pendingDrop.fromIndex === index;

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
