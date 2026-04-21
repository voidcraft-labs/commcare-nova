/**
 * useDragIntent — drag lifecycle + cursor velocity for the virtualized form.
 *
 * The hook owns everything that VirtualFormList used to carry inline about
 * dragging:
 *
 *   - `dragActive` state (true between `onDragStart` and `onDrop`).
 *   - `placeholderIndex` state — the row index where the synthetic drop
 *     placeholder is spliced into the rows array. Only changes when the
 *     resolved target changes (not every pixel of cursor motion), so the
 *     virtualizer recalculates a few times per drag at most.
 *   - `placeholderDepth` ref — indentation for the placeholder row,
 *     exposed as a plain number at render time.
 *   - The `monitorForElements` registration that runs the full drag
 *     lifecycle (~280 lines: onDragStart, onDrag intent resolution +
 *     dedup + cycle/no-op suppression, onDrop mutation application).
 *   - Cursor-velocity tracking via mousemove + wheel listeners — feeds
 *     InsertionPointRow's hover gating during drag.
 *
 * Implicit contract with the caller:
 *
 *   - `baseRowsRef` is a live ref whose `.current` always points at the
 *     latest `baseRows` produced by `useFormRows`. The monitor reads it
 *     on every `onDrag`, so the caller must keep the ref up-to-date
 *     WITHOUT forcing the monitor effect to re-register (otherwise every
 *     row change would tear down the monitor mid-drag).
 *   - The hook's cursor refs (`cursorSpeedRef`, `lastCursorRef`) are
 *     stable across re-registrations — the consumer hands them to
 *     InsertionPointRow without worrying about identity churn.
 *   - Consumers own the rows-array swap that turns `placeholderIndex`
 *     into a visible placeholder row; the hook only computes where the
 *     placeholder should go.
 */

import { monitorForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { extractClosestEdge } from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge";
import { useContext, useEffect, useRef, useState } from "react";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { notifyMoveRename } from "@/lib/doc/mutations/notify";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { asUuid, type Uuid } from "@/lib/doc/types";
import { useSelect } from "@/lib/routing/hooks";
import {
	isDraggableFieldData,
	isUuidInSubtree,
	readDropTargetData,
	targetContainerUuidFor,
} from "./dragData";
import type { FormRow } from "./rowModel";

// ── Cursor-velocity tuning ────────────────────────────────────────────

/**
 * EMA smoothing factor for cursor speed (px/ms). Small value biases toward
 * the long-running average so a single fast sample doesn't unlatch the
 * insertion-point hover.
 */
const CURSOR_EMA_ALPHA = 0.01;

/**
 * Gap beyond which the previous mousemove sample is treated as stale —
 * we reset the EMA to the current instantaneous speed rather than
 * folding a delta across a second of idle time.
 */
const CURSOR_GAP_RESET_MS = 5000;

// ── Types ─────────────────────────────────────────────────────────────

interface UseDragIntentParams {
	readonly formUuid: Uuid;
	readonly baseRowsRef: React.RefObject<readonly FormRow[]>;
}

interface UseDragIntentResult {
	readonly dragActive: boolean;
	/**
	 * Direct setter for `dragActive`. The hook flips the flag internally
	 * through the monitor lifecycle, but the setter is also exposed so
	 * the consumer can forward it to `DragStateProvider` in controlled
	 * mode (the provider's prop shape requires both or neither).
	 */
	readonly setDragActive: (active: boolean) => void;
	readonly placeholderIndex: number | null;
	readonly placeholderDepth: number;
	readonly cursorSpeedRef: React.RefObject<number>;
	readonly lastCursorRef: React.RefObject<
		{ x: number; y: number; t: number } | undefined
	>;
}

// ── Hook ──────────────────────────────────────────────────────────────

/**
 * Wire up pragmatic-drag-and-drop's global monitor plus cursor-velocity
 * tracking, returning the drag state the consumer needs to render the
 * placeholder row and gate insertion-point hover.
 *
 * `formUuid` is accepted for future scoping work even though the current
 * implementation uses a single global monitor — keeping the param keeps
 * the hook's signature ready for a per-form monitor without a breaking
 * change later.
 */
export function useDragIntent({
	// Reserved for future per-form scoping; not currently read because the
	// monitor is installed once and dispatches across every form.
	formUuid: _formUuid,
	baseRowsRef,
}: UseDragIntentParams): UseDragIntentResult {
	const docStore = useContext(BlueprintDocContext);
	const { moveField } = useBlueprintMutations();
	const select = useSelect();

	// ── Drag state ───────────────────────────────────────────────────

	const [dragActive, setDragActive] = useState(false);

	// Row index where a synthetic placeholder row is spliced during drag.
	// `null` outside of a drag or when the cursor isn't over a valid
	// drop target. Only changes when the drop target changes (not every
	// pixel), so the virtualizer recalculates at most a few times per
	// second during a drag.
	const [placeholderIndex, setPlaceholderIndex] = useState<number | null>(null);

	// Dedup ref — the row-index we last set, so `onDrag` (60fps) only
	// calls `setPlaceholderIndex` when the target actually changes.
	const lastPlaceholderRef = useRef<number | null>(null);

	// Depth of the placeholder — drives indentation. Kept in a ref
	// because it's read during render via the returned number but only
	// updated alongside the dedup'd `setPlaceholderIndex` call.
	const placeholderDepthRef = useRef(0);

	// The dragged item's uuid — used for no-op detection on drop.
	const dragSourceUuidRef = useRef<string | null>(null);

	// The resolved drop intent — stored by `onDrag` so `onDrop` can use
	// the SAME position the user saw, even if the cursor is over dead
	// space (the placeholder gap) at drop time.
	const pendingDropRef = useRef<{
		drop: ReturnType<typeof readDropTargetData>;
		edge: ReturnType<typeof extractClosestEdge>;
	} | null>(null);

	// ── Global monitor — drag lifecycle ──────────────────────────────
	// `onDragStart` clears selection + enables drag mode.
	// `onDrag`      computes the placeholder row index from the hovered
	//               drop target — only fires setState when the index
	//               changes.
	// `onDrop`      applies the mutation + selects the dropped field.
	//
	// Effect deps intentionally exclude `baseRowsRef` — callers mutate
	// the ref in-place (not its identity), so depending on it would
	// force a monitor re-register every time. `docStore` / `moveField`
	// / `select` come from context + hooks and are stable across
	// renders under the BlueprintDocProvider.

	useEffect(() => {
		const docs = docStore;
		if (!docs) return;
		return monitorForElements({
			canMonitor: ({ source }) => isDraggableFieldData(source.data),

			onDragStart: ({ source }) => {
				setDragActive(true);
				lastPlaceholderRef.current = null;
				pendingDropRef.current = null;
				document.body.style.cursor = "grabbing";
				// Stash the source uuid so onDrop can detect no-op drops
				// (dropped at the same position).
				if (isDraggableFieldData(source.data)) {
					dragSourceUuidRef.current = source.data.uuid;
				}
				select(undefined);
			},

			onDrag: ({ source, location }) => {
				if (!isDraggableFieldData(source.data)) return;
				const dragUuid = source.data.uuid;

				const innermost = location.current.dropTargets[0];
				// When the cursor is over dead space (the insertion gap
				// between rows, which has no drop target), keep the last
				// valid placeholder position. Clearing it would cause the
				// gap to collapse → rows shift → cursor re-enters a row →
				// gap re-opens → infinite flicker loop.
				if (!innermost) return;
				const drop = readDropTargetData(innermost.data);
				if (!drop) return;

				// Read the edge early — the group-header branch needs it
				// both to decide placeholder position AND (via the cycle
				// guard's `targetContainerUuidFor`) to pick the correct
				// landing container (parent vs group-self).
				const edge = extractClosestEdge(innermost.data);

				// Cycle guard — no placeholder for illegal drops.
				const targetContainer = targetContainerUuidFor(drop, edge);
				if (
					isUuidInSubtree(
						docs.getState().fieldOrder as Record<string, readonly string[]>,
						dragUuid,
						targetContainer,
					)
				) {
					if (lastPlaceholderRef.current !== null) {
						lastPlaceholderRef.current = null;
						setPlaceholderIndex(null);
					}
					return;
				}

				// Find the INSERTION ROW that corresponds to the drop
				// position. The row model interleaves insertion rows
				// between every pair of field/group rows:
				//   ins(0), Q(A), ins(1), Q(B), ins(2)
				// "top of B" and "bottom of A" both resolve to ins(1).
				// By targeting the insertion row, we:
				//   1. Place the placeholder in the natural gap (not
				//      kissing the field border).
				//   2. Eliminate edge thrashing — both edges of the
				//      boundary resolve to the same insertion row index.
				const br = baseRowsRef.current;
				let insertionRowIndex = -1;
				let insertionDepth = 0;

				switch (drop.kind) {
					case "drop-field": {
						// Find the field row, then look for the adjacent
						// insertion row on the correct side. Group-open rows
						// never carry `drop-field` data (they use
						// `drop-group-header`), so only match `field` here.
						for (let i = 0; i < br.length; i++) {
							const r = br[i];
							const isTarget = r.kind === "field" && r.uuid === drop.uuid;
							if (!isTarget) continue;

							if (edge === "top") {
								// Look backward for the insertion row before this field.
								for (let j = i - 1; j >= 0; j--) {
									if (br[j].kind === "insertion") {
										insertionRowIndex = j;
										insertionDepth = br[j].depth;
										break;
									}
								}
							} else {
								// "bottom" or null — look forward for the insertion
								// row after this field (skipping group-close, etc.).
								for (let j = i + 1; j < br.length; j++) {
									if (br[j].kind === "insertion") {
										insertionRowIndex = j;
										insertionDepth = br[j].depth;
										break;
									}
								}
							}
							break;
						}
						break;
					}
					case "drop-group-header": {
						// Group headers carry two positional intents keyed by
						// the closest edge (see GroupBracket.tsx):
						//   - edge === "top" → insert BEFORE the group at the
						//     parent level. Walk backward from the group-open
						//     row to the nearest parent-level insertion (the
						//     gap above the header). This is the ONLY path to
						//     "above the first child" when that child is a
						//     container, since the insertion-point rows are
						//     not drop targets themselves.
						//   - otherwise (edge === "bottom" | null) → insert as
						//     first child of the group. Walk forward to the
						//     first insertion row, which lives immediately
						//     after the group-open row at depth + 1.
						for (let i = 0; i < br.length; i++) {
							const r = br[i];
							if (r.kind === "group-open" && r.uuid === drop.uuid) {
								if (edge === "top") {
									for (let j = i - 1; j >= 0; j--) {
										if (br[j].kind === "insertion") {
											insertionRowIndex = j;
											insertionDepth = br[j].depth;
											break;
										}
									}
								} else if (
									i + 1 < br.length &&
									br[i + 1].kind === "insertion"
								) {
									insertionRowIndex = i + 1;
									insertionDepth = br[i + 1].depth;
								}
								break;
							}
						}
						break;
					}
					case "drop-empty-container": {
						// Target the empty-container row itself.
						for (let i = 0; i < br.length; i++) {
							const r = br[i];
							if (
								r.kind === "empty-container" &&
								r.parentUuid === drop.parentUuid
							) {
								insertionRowIndex = i;
								insertionDepth = r.depth;
								break;
							}
						}
						break;
					}
				}

				if (insertionRowIndex < 0) return;

				// Suppress placeholder when it would appear adjacent to
				// the source (same position = no-op drop). Check the rows
				// immediately before/after the insertion row for any row
				// that belongs to the dragged item.
				{
					const neighbors = baseRowsRef.current;
					const before =
						insertionRowIndex > 0 ? neighbors[insertionRowIndex - 1] : null;
					const after =
						insertionRowIndex < neighbors.length - 1
							? neighbors[insertionRowIndex + 1]
							: null;
					const isSource = (r: FormRow | null): boolean => {
						if (!r) return false;
						if (r.kind === "field" && r.uuid === dragUuid) return true;
						if (r.kind === "group-open" && r.uuid === dragUuid) return true;
						// group-close trailing a dragged group — the row
						// before the insertion is the group's close bracket.
						if (r.kind === "group-close" && r.uuid === dragUuid) return true;
						return false;
					};
					if (isSource(before) || isSource(after)) {
						if (lastPlaceholderRef.current !== null) {
							lastPlaceholderRef.current = null;
							pendingDropRef.current = null;
							setPlaceholderIndex(null);
						}
						return;
					}
				}

				// Dedup — only setState when the index changes.
				if (lastPlaceholderRef.current === insertionRowIndex) return;
				lastPlaceholderRef.current = insertionRowIndex;
				placeholderDepthRef.current = insertionDepth;
				// Stash the resolved drop intent so `onDrop` can use the
				// same position the user saw — at drop time the cursor may
				// be over the placeholder gap (no drop target), so
				// re-reading from `location` would fail.
				pendingDropRef.current = { drop, edge };
				setPlaceholderIndex(insertionRowIndex);
			},

			onDrop: ({ source }) => {
				setDragActive(false);
				setPlaceholderIndex(null);
				lastPlaceholderRef.current = null;
				dragSourceUuidRef.current = null;
				document.body.style.cursor = "";

				// Use the stashed intent from onDrag — at drop time the
				// cursor is likely over the placeholder gap (no drop target),
				// so re-reading from `location` would find nothing.
				const pending = pendingDropRef.current;
				pendingDropRef.current = null;
				if (!pending?.drop) return;

				if (!isDraggableFieldData(source.data)) return;
				const dragUuid = source.data.uuid;
				const { drop, edge } = pending;

				// Cycle guard — same edge-aware target-container resolution
				// as onDrag, so "drop before a group" doesn't get rejected
				// for a cycle against the group itself.
				const targetContainer = targetContainerUuidFor(drop, edge);
				if (
					isUuidInSubtree(
						docs.getState().fieldOrder as Record<string, readonly string[]>,
						dragUuid,
						targetContainer,
					)
				) {
					return;
				}

				// No-op detection: if the source would land in the same
				// position it started (adjacent to itself), skip the
				// mutation entirely — it's a cancel, not a move.
				if (drop.kind === "drop-field") {
					const parentOrder =
						docs.getState().fieldOrder[drop.parentUuid as Uuid] ?? [];
					const sourceIdx = parentOrder.indexOf(asUuid(dragUuid));
					const targetIdx = parentOrder.indexOf(drop.uuid);
					// Same parent, and the source is immediately before
					// (edge=top) or after (edge=bottom) the target — no-op.
					if (sourceIdx >= 0 && targetIdx >= 0) {
						if (edge === "top" && sourceIdx === targetIdx - 1) return;
						if (edge === "bottom" && sourceIdx === targetIdx + 1) return;
						// Dropping on immediate neighbor on the "touching" side.
						if (edge !== "top" && sourceIdx === targetIdx + 1) return;
					}
				}

				let result: ReturnType<typeof moveField> | undefined;

				switch (drop.kind) {
					case "drop-field": {
						if (drop.uuid === dragUuid) return;
						if (edge === "top") {
							result = moveField(asUuid(dragUuid), {
								beforeUuid: drop.uuid,
								toParentUuid: drop.parentUuid,
							});
						} else {
							result = moveField(asUuid(dragUuid), {
								afterUuid: drop.uuid,
								toParentUuid: drop.parentUuid,
							});
						}
						break;
					}

					case "drop-group-header": {
						if (drop.uuid === dragUuid) return;
						// edge === "top" means the user aimed at the gap ABOVE
						// the group header — insert the source at the parent
						// level immediately before the group, not as a child.
						// Mirrors the drop-field/top branch above.
						if (edge === "top") {
							result = moveField(asUuid(dragUuid), {
								beforeUuid: drop.uuid,
								toParentUuid: drop.parentUuid,
							});
							break;
						}
						const firstChild =
							docs.getState().fieldOrder[drop.uuid as Uuid]?.[0];
						result = firstChild
							? moveField(asUuid(dragUuid), {
									toParentUuid: drop.uuid,
									beforeUuid: firstChild,
								})
							: moveField(asUuid(dragUuid), {
									toParentUuid: drop.uuid,
								});
						break;
					}

					case "drop-empty-container": {
						result = moveField(asUuid(dragUuid), {
							toParentUuid: drop.parentUuid,
						});
						break;
					}
				}

				if (result) notifyMoveRename(result);
				select(asUuid(dragUuid));
			},
		});
	}, [docStore, moveField, select, baseRowsRef]);

	// ── Cursor-velocity tracking (for InsertionPoint hover gating) ──

	const cursorSpeedRef = useRef(0);
	const lastCursorRef = useRef<{ x: number; y: number; t: number } | undefined>(
		undefined,
	);
	useEffect(() => {
		const speedRef = cursorSpeedRef;
		const lastRef = lastCursorRef;
		const onMouseMove = (e: MouseEvent) => {
			const now = performance.now();
			const last = lastRef.current;
			if (last) {
				const dt = now - last.t;
				if (dt > 0) {
					const dx = e.clientX - last.x;
					const dy = e.clientY - last.y;
					const speed = Math.sqrt(dx * dx + dy * dy) / dt;
					speedRef.current =
						dt > CURSOR_GAP_RESET_MS
							? speed
							: CURSOR_EMA_ALPHA * speed +
								(1 - CURSOR_EMA_ALPHA) * speedRef.current;
				}
			}
			lastRef.current = { x: e.clientX, y: e.clientY, t: now };
		};
		const onWheel = (e: WheelEvent) => {
			const now = performance.now();
			const last = lastRef.current;
			if (last) {
				const dt = now - last.t;
				if (dt > 0) {
					const pxDelta = Math.abs(e.deltaY) * (e.deltaMode === 1 ? 16 : 1);
					const speed = pxDelta / dt;
					speedRef.current =
						dt > CURSOR_GAP_RESET_MS
							? speed
							: CURSOR_EMA_ALPHA * speed +
								(1 - CURSOR_EMA_ALPHA) * speedRef.current;
				}
				last.t = now;
			}
		};
		document.addEventListener("mousemove", onMouseMove);
		document.addEventListener("wheel", onWheel, { passive: true });
		return () => {
			document.removeEventListener("mousemove", onMouseMove);
			document.removeEventListener("wheel", onWheel);
		};
	}, []);

	return {
		dragActive,
		setDragActive,
		placeholderIndex,
		// Expose the depth as a plain number — the shell reads it alongside
		// `placeholderIndex`, whose state change drives the render.
		placeholderDepth: placeholderDepthRef.current,
		cursorSpeedRef,
		lastCursorRef,
	};
}
