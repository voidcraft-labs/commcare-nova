/**
 * useDragIntent: drag lifecycle + cursor velocity for the virtualized form.
 *
 * The hook owns everything that VirtualFormList used to carry inline about
 * dragging:
 *
 *   - `dragActive` state (true between `onDragStart` and `onDrop`).
 *   - `placeholderIndex` state: the row index where the synthetic drop
 *     placeholder is spliced into the rows array. Only changes when the
 *     resolved target changes (not every pixel of cursor motion), so the
 *     virtualizer recalculates a few times per drag at most.
 *   - `placeholderDepth` ref: indentation for the placeholder row,
 *     exposed as a plain number at render time.
 *   - The `monitorForElements` registration that runs the full drag
 *     lifecycle (~280 lines: onDragStart, onDrag intent resolution +
 *     dedup + cycle/no-op suppression, onDrop mutation application).
 *
 * Implicit contract with the caller:
 *
 *   - `baseRowsRef` is a live ref whose `.current` always points at the
 *     latest `baseRows` produced by `useFormRows`. The monitor reads it
 *     on every `onDrag`, so the caller must keep the ref up-to-date
 *     WITHOUT forcing the monitor effect to re-register (otherwise every
 *     row change would tear down the monitor mid-drag).
 *   - Consumers own the rows-array swap that turns `placeholderIndex`
 *     into a visible placeholder row; the hook only computes where the
 *     placeholder should go.
 */

import { monitorForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { extractClosestEdge } from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge";
import { useContext, useEffect, useRef, useState } from "react";
import { orderedFieldUuids } from "@/lib/doc/fieldWalk";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { asUuid, type Uuid } from "@/lib/doc/types";
import { useSelect } from "@/lib/routing/hooks";
import {
	isDraggableFieldData,
	readDropTargetData,
	targetContainerUuidFor,
} from "./dragData";
import { draggedRowSpan, isNoOpFieldDrop } from "./dropNoOp";
import { landingAllowed } from "./landingGuards";
import type { FormRow } from "./rowModel";

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
}

// ── Hook ──────────────────────────────────────────────────────────────

/**
 * Wire up pragmatic-drag-and-drop's global monitor plus cursor-velocity
 * tracking, returning the drag state the consumer needs to render the
 * placeholder row and gate insertion-point hover.
 *
 * `formUuid` is accepted for future scoping work even though the current
 * implementation uses a single global monitor: keeping the param keeps
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

	// Dedup ref: the row-index we last set, so `onDrag` (60fps) only
	// calls `setPlaceholderIndex` when the target actually changes.
	const lastPlaceholderRef = useRef<number | null>(null);

	// Depth of the placeholder: drives indentation. Kept in a ref
	// because it's read during render via the returned number but only
	// updated alongside the dedup'd `setPlaceholderIndex` call.
	const placeholderDepthRef = useRef(0);

	// The dragged item's uuid: used for no-op detection on drop.
	const dragSourceUuidRef = useRef<string | null>(null);

	// The resolved drop intent: stored by `onDrag` so `onDrop` can use
	// the SAME position the user saw, even if the cursor is over dead
	// space (the placeholder gap) at drop time.
	const pendingDropRef = useRef<{
		drop: ReturnType<typeof readDropTargetData>;
		edge: ReturnType<typeof extractClosestEdge>;
	} | null>(null);

	// ── Global monitor: drag lifecycle ──────────────────────────────
	// `onDragStart` clears selection + enables drag mode.
	// `onDrag`      computes the placeholder row index from the hovered
	//               drop target: only fires setState when the index
	//               changes.
	// `onDrop`      applies the mutation + selects the dropped field.
	//
	// Effect deps intentionally exclude `baseRowsRef`: callers mutate
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

				// Read the edge early: the group-header branch needs it
				// both to decide placeholder position AND (via the cycle
				// guard's `targetContainerUuidFor`) to pick the correct
				// landing container (parent vs group-self).
				const edge = extractClosestEdge(innermost.data);
				const sectionDrag =
					docs.getState().fields[asUuid(dragUuid)]?.kind === "section";

				// Cycle guard + placement guard: no placeholder for a drop the
				// gate would refuse. The placement verdict is re-asked here,
				// with the resolved edge, because a header row's `canDrop`
				// accepts when EITHER of its two landings is legal.
				const targetContainer = targetContainerUuidFor(drop, edge, sectionDrag);
				if (!landingAllowed(docs.getState(), dragUuid, targetContainer)) {
					if (lastPlaceholderRef.current !== null) {
						lastPlaceholderRef.current = null;
						pendingDropRef.current = null;
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
				//   2. Eliminate edge thrashing: both edges of the
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
								// "bottom" or null: look forward for the insertion
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
					case "drop-group-header":
					case "drop-section-header": {
						// Headers carry two positional intents keyed by the
						// closest edge (see GroupBracket.tsx / SectionHeaderRow):
						//   - edge === "top" → insert BEFORE the container at the
						//     parent level. Walk backward from the header row to
						//     the nearest parent-level insertion (the gap above
						//     the header). This is the ONLY path to "above the
						//     first child" when that child is a container, since
						//     the insertion-point rows are not drop targets.
						//   - otherwise (edge === "bottom" | null) → insert as
						//     first child. Walk forward to the first insertion
						//     row, which lives immediately after the header.
						const headerKind =
							drop.kind === "drop-group-header"
								? "group-open"
								: "section-header";
						for (let i = 0; i < br.length; i++) {
							const r = br[i];
							if (r.kind === headerKind && r.uuid === drop.uuid) {
								if (edge === "top") {
									for (let j = i - 1; j >= 0; j--) {
										if (br[j].kind === "insertion") {
											insertionRowIndex = j;
											insertionDepth = br[j].depth;
											break;
										}
									}
								} else if (sectionDrag && drop.kind === "drop-section-header") {
									// A dragged page lands AFTER this page at the
									// root (pages never nest), so the line is the
									// root-level gap that follows this page's span.
									const span = draggedRowSpan(br, drop.uuid);
									const j = span === null ? -1 : span[1] + 1;
									const gap = j >= 0 ? br[j] : undefined;
									if (
										gap?.kind === "insertion" &&
										gap.parentUuid === drop.parentUuid
									) {
										insertionRowIndex = j;
										insertionDepth = gap.depth;
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
				// the source (same position = no-op drop): the insertion row
				// immediately before or after the dragged item's row span.
				{
					const span = draggedRowSpan(baseRowsRef.current, asUuid(dragUuid));
					if (
						span !== null &&
						(insertionRowIndex === span[0] - 1 ||
							insertionRowIndex === span[1] + 1)
					) {
						if (lastPlaceholderRef.current !== null) {
							lastPlaceholderRef.current = null;
							pendingDropRef.current = null;
							setPlaceholderIndex(null);
						}
						return;
					}
				}

				// Dedup: only setState when the index changes.
				if (lastPlaceholderRef.current === insertionRowIndex) return;
				lastPlaceholderRef.current = insertionRowIndex;
				placeholderDepthRef.current = insertionDepth;
				// Stash the resolved drop intent so `onDrop` can use the
				// same position the user saw: at drop time the cursor may
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

				// Use the stashed intent from onDrag: at drop time the
				// cursor is likely over the placeholder gap (no drop target),
				// so re-reading from `location` would find nothing.
				const pending = pendingDropRef.current;
				pendingDropRef.current = null;
				if (!pending?.drop) return;

				if (!isDraggableFieldData(source.data)) return;
				const dragUuid = source.data.uuid;
				const { drop, edge } = pending;
				const sectionDrag =
					docs.getState().fields[asUuid(dragUuid)]?.kind === "section";

				// Cycle + placement guard: same edge-aware target-container
				// resolution as onDrag, so "drop before a group" doesn't get
				// rejected for a cycle against the group itself, and a stale
				// intent can't commit a landing the gate refuses.
				const targetContainer = targetContainerUuidFor(drop, edge, sectionDrag);
				if (!landingAllowed(docs.getState(), dragUuid, targetContainer)) {
					return;
				}

				// No-op detection: if the source would land in the same
				// `fieldOrder` position, skip the mutation entirely: it's a
				// cancel, not a move. For a header's top edge the siblings
				// are the header's own level; for its bottom edge the no-op
				// is "already the first child".
				if (drop.kind === "drop-field") {
					const siblings = orderedFieldUuids(
						docs.getState(),
						asUuid(drop.parentUuid),
					);
					if (isNoOpFieldDrop(siblings, asUuid(dragUuid), drop.uuid, edge)) {
						return;
					}
				} else if (
					drop.kind === "drop-group-header" ||
					drop.kind === "drop-section-header"
				) {
					if (edge === "top" || sectionDrag) {
						const siblings = orderedFieldUuids(
							docs.getState(),
							asUuid(drop.parentUuid),
						);
						if (
							isNoOpFieldDrop(
								siblings,
								asUuid(dragUuid),
								drop.uuid,
								edge === "top" ? "top" : "bottom",
							)
						) {
							return;
						}
					} else if (
						orderedFieldUuids(docs.getState(), asUuid(drop.uuid))[0] ===
						dragUuid
					) {
						return;
					}
				}

				switch (drop.kind) {
					case "drop-field": {
						if (drop.uuid === dragUuid) return;
						if (edge === "top") {
							moveField(asUuid(dragUuid), {
								beforeUuid: drop.uuid,
								toParentUuid: drop.parentUuid,
							});
						} else {
							moveField(asUuid(dragUuid), {
								afterUuid: drop.uuid,
								toParentUuid: drop.parentUuid,
							});
						}
						break;
					}

					case "drop-group-header":
					case "drop-section-header": {
						if (drop.uuid === dragUuid) return;
						// A dragged page lands beside pages: before on the top
						// half, after on the bottom, never inside a container.
						if (sectionDrag && edge !== "top") {
							moveField(asUuid(dragUuid), {
								afterUuid: drop.uuid,
								toParentUuid: drop.parentUuid,
							});
							break;
						}
						// edge === "top" means the user aimed at the gap ABOVE
						// the header: insert the source at the parent level
						// immediately before the container, not as a child.
						// Mirrors the drop-field/top branch above.
						if (edge === "top") {
							moveField(asUuid(dragUuid), {
								beforeUuid: drop.uuid,
								toParentUuid: drop.parentUuid,
							});
							break;
						}
						// The `fieldOrder` head is the visually first child.
						const firstChild = orderedFieldUuids(
							docs.getState(),
							asUuid(drop.uuid),
						)[0];
						firstChild
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
						moveField(asUuid(dragUuid), {
							toParentUuid: drop.parentUuid,
						});
						break;
					}
				}

				select(asUuid(dragUuid));
			},
		});
	}, [docStore, moveField, select, baseRowsRef]);

	return {
		dragActive,
		setDragActive,
		placeholderIndex,
		// Expose the depth as a plain number: the shell reads it alongside
		// `placeholderIndex`, whose state change drives the render.
		placeholderDepth: placeholderDepthRef.current,
	};
}
