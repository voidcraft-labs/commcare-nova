/**
 * useRowDnd — shared drag + drop registration for virtualized form rows.
 *
 * Every row in the edit-mode form participates in drag-and-drop in one of
 * two flavors:
 *
 *   - **Draggable + drop target** (`FieldRow`, `GroupOpenRow`) — the
 *     row's own DOM element is the drag source AND a drop target for
 *     other rows. Questions + groups can be picked up, and other items
 *     can be dropped onto them.
 *   - **Drop-only** (`EmptyContainerRow`) — not draggable, only a drop
 *     target for the empty group/repeat's "sole child" landing zone.
 *
 * The rules are identical across both flavors:
 *   - Only accept sources whose data matches our own `draggable-field`
 *     tag (`isDraggableQuestionData`).
 *   - Reject a self-drop — a draggable row can't be a drop target for
 *     itself.
 *   - Reject cycle-creating drops — dragging a group onto its own
 *     descendant would reparent the group under itself. We read the
 *     doc's `questionOrder` imperatively in `canDrop` and consult
 *     `isUuidInSubtree`.
 *   - Track `isDraggingSelf`, `isDragOver`, and (optionally) the closest
 *     edge so each row can render its own visual feedback.
 *
 * Custom native drag preview: when a caller provides `renderPreview`, the
 * hook registers `onGenerateDragPreview` and tells the browser to use an
 * offscreen portal-rendered element as the drag image. Without this, the
 * browser snapshots the source row itself — which (a) can look chaotic
 * for a large row and (b) triggers `ResizeObserver` on
 * `virtualizer.measureElement`, making the row's neighbors "smoosh" as
 * the source momentarily reports a smaller rendered size. Providing a
 * custom preview means the browser never touches the source element, so
 * it stays at its original layout position + size.
 *
 * Keeping this logic in one hook means every row enforces the rules the
 * same way. The alternative — inlining the rules in each row component —
 * made `canDrop` look identical across three files and invited drift
 * when new drop kinds are added.
 */

"use client";
import { combine } from "@atlaskit/pragmatic-drag-and-drop/combine";
import {
	draggable,
	dropTargetForElements,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { pointerOutsideOfPreview } from "@atlaskit/pragmatic-drag-and-drop/element/pointer-outside-of-preview";
import { setCustomNativeDragPreview } from "@atlaskit/pragmatic-drag-and-drop/element/set-custom-native-drag-preview";
import {
	type Edge,
	extractClosestEdge,
} from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge";
import { type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BlueprintDocContext } from "@/lib/doc/provider";
import type { Uuid } from "@/lib/doc/types";
import {
	isDraggableQuestionData,
	isUuidInSubtree,
	makeDraggableQuestionData,
} from "./dragData";

/** Signature the pragmatic-dnd adapter expects for `getData`. Derived
 *  directly from the library so the hook's contract stays in lockstep
 *  with upstream changes. */
type GetDropData = NonNullable<
	Parameters<typeof dropTargetForElements>[0]["getData"]
>;

/** The preview portal's lifecycle, stored in local state. The hook
 *  swaps between `idle` (no drag in flight) and `active` (browser has
 *  created a container for our custom preview and we need to fill it). */
type PreviewState =
	| { readonly type: "idle" }
	| { readonly type: "active"; readonly container: HTMLElement };

// ── Public API ────────────────────────────────────────────────────────

export interface UseRowDndOptions {
	/**
	 * This row's own uuid when it is ALSO draggable. Pass `null` for
	 * drop-only rows (empty-container). When non-null, the hook registers
	 * a `draggable()` adapter and filters self-drops from the drop target.
	 */
	readonly draggableUuid: Uuid | null;

	/**
	 * The container uuid under which the dragged source would land if
	 * dropped here. Used for cycle detection — if the source is that
	 * container (self-drop into self, already caught above) or an ancestor
	 * of it, the drop is rejected.
	 *
	 *   - For field rows, this is the field's parent (source
	 *     becomes a sibling).
	 *   - For group-header drops, this is the group's own uuid (source
	 *     becomes a child).
	 *   - For empty-container drops, this is the empty container uuid.
	 */
	readonly cycleTargetContainerUuid: Uuid;

	/**
	 * Build the drop-target data payload. Pragmatic DnD calls this on
	 * every drag-move while the cursor is over the element. Callers must
	 * provide a reference-stable function (e.g. via `useCallback`) so
	 * the hook's effect doesn't thrash on each parent render.
	 */
	readonly buildDropData: GetDropData;

	/**
	 * Enable closest-edge tracking — only relevant for row-between drop
	 * targets (field rows). When true, the hook listens to `onDrag`,
	 * extracts the closest edge from `self.data`, and exposes it as
	 * `dropEdge`. Callers render an edge indicator based on this state.
	 */
	readonly trackEdge?: boolean;

	/**
	 * Render the contents of the custom drag preview. When provided (and
	 * the row is draggable), the hook tells the browser to use an
	 * offscreen container as the drag image rather than snapshotting the
	 * row itself. Ignored when `draggableUuid` is `null` — a non-draggable
	 * row has no drag to preview.
	 */
	readonly renderPreview?: () => ReactNode;
}

export interface UseRowDndReturn {
	/** Attach to the row's root DOM element via `<div ref={...}>`. */
	readonly ref: React.RefObject<HTMLDivElement | null>;
	/** `true` while the user is dragging THIS row. Meaningful only when
	 *  `draggableUuid` was non-null. */
	readonly isDraggingSelf: boolean;
	/** `true` when a valid drag source is currently hovering over this
	 *  row. Cleared on drag leave or drop. */
	readonly isDragOver: boolean;
	/** The closest edge of the hovered row, when `trackEdge` is true.
	 *  `null` otherwise, or when the hit resolved away from the allowed
	 *  edges. */
	readonly dropEdge: Edge | null;
	/** JSX node the caller MUST render somewhere in its return — usually
	 *  at the end of the root fragment. `null` outside of an active drag.
	 *  Internally a `createPortal` into a library-owned container at
	 *  document.body, so it never affects the row's layout. */
	readonly preview: ReactNode;
}

// ── Hook ──────────────────────────────────────────────────────────────

export function useRowDnd(options: UseRowDndOptions): UseRowDndReturn {
	const {
		draggableUuid,
		cycleTargetContainerUuid,
		buildDropData,
		trackEdge = false,
		renderPreview,
	} = options;
	const docStore = useContext(BlueprintDocContext);

	const ref = useRef<HTMLDivElement | null>(null);
	const [isDraggingSelf, setIsDraggingSelf] = useState(false);
	const [isDragOver, setIsDragOver] = useState(false);
	const [dropEdge, setDropEdge] = useState<Edge | null>(null);
	const [previewState, setPreviewState] = useState<PreviewState>({
		type: "idle",
	});

	// Latest `renderPreview` held in a ref so the draggable effect doesn't
	// re-register every time the caller's callback identity changes —
	// the `onGenerateDragPreview` closure reads the current ref value at
	// drag start, which is all we need.
	const renderPreviewRef = useRef(renderPreview);
	renderPreviewRef.current = renderPreview;

	useEffect(() => {
		const el = ref.current;
		if (!el) return;

		const cleanups: Array<() => void> = [];

		// Drag source — only when this row is itself draggable.
		if (draggableUuid !== null) {
			cleanups.push(
				draggable({
					element: el,
					getInitialData: () => makeDraggableQuestionData(draggableUuid),
					onGenerateDragPreview: ({ nativeSetDragImage }) => {
						// If the caller provided a preview renderer, hand the
						// browser an offscreen container to snapshot; React
						// fills the container via the `createPortal` in the
						// returned JSX. If not, fall through to the browser's
						// default (snapshot the source element) — but note
						// this reintroduces the measure-observer smoosh.
						const render = renderPreviewRef.current;
						if (!render) return;
						setCustomNativeDragPreview({
							nativeSetDragImage,
							getOffset: pointerOutsideOfPreview({ x: "16px", y: "8px" }),
							render: ({ container }) => {
								setPreviewState({ type: "active", container });
								return () => setPreviewState({ type: "idle" });
							},
						});
					},
					onDragStart: () => setIsDraggingSelf(true),
					onDrop: () => {
						setIsDraggingSelf(false);
						setDropEdge(null);
						setIsDragOver(false);
					},
				}),
			);
		}

		// Drop target — every row accepts drops from our own drag sources.
		cleanups.push(
			dropTargetForElements({
				element: el,
				canDrop: ({ source }) => {
					if (!isDraggableQuestionData(source.data)) return false;
					// Self-drop rejection: a draggable row can't be a target
					// for itself. (Drop-only rows have `draggableUuid: null`
					// and skip this check.)
					if (draggableUuid !== null && source.data.uuid === draggableUuid) {
						return false;
					}
					// Cycle guard: dropping a group onto its own descendant
					// would reparent the group under itself.
					const doc = docStore?.getState();
					if (!doc) return true;
					return !isUuidInSubtree(
						doc.fieldOrder as Record<string, readonly string[]>,
						source.data.uuid,
						cycleTargetContainerUuid,
					);
				},
				getData: buildDropData,
				onDragEnter: () => setIsDragOver(true),
				onDragLeave: () => {
					setIsDragOver(false);
					setDropEdge(null);
				},
				// `onDrag` fires for every mouse-move while the cursor is
				// over the element. Only subscribe when the caller actually
				// wants edge tracking — this keeps the adapter lightweight
				// for drop targets that don't have top/bottom semantics.
				...(trackEdge && {
					onDrag: ({ self }) => {
						const edge = extractClosestEdge(self.data);
						setDropEdge((prev) => (prev === edge ? prev : edge));
					},
				}),
				onDrop: () => {
					setIsDragOver(false);
					setDropEdge(null);
				},
			}),
		);

		return combine(...cleanups);
	}, [
		docStore,
		draggableUuid,
		cycleTargetContainerUuid,
		buildDropData,
		trackEdge,
	]);

	// Build the preview portal. Only alive while the library's container
	// is mounted; the cleanup returned from `render` clears it back to
	// `idle`, which React removes the portal for.
	const preview: ReactNode =
		previewState.type === "active" && renderPreview
			? createPortal(renderPreview(), previewState.container)
			: null;

	return { ref, isDraggingSelf, isDragOver, dropEdge, preview };
}
