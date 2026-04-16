/**
 * VirtualFormList — virtualized flat-row renderer for edit-mode forms.
 *
 * Performance model: only rows in the visible range (plus overscan +
 * the pinned selected row) are mounted, which turns the form-open mount
 * storm from `O(questions)` components into `O(viewport)` components.
 *
 * Drag-and-drop uses pragmatic-drag-and-drop (browser-native drag).
 * The row list stays completely stable during a drag — no array
 * reordering, no preview order, no virtualizer recalculation. Each
 * drop-target row renders a `position: absolute` indicator on its
 * closest edge (top or bottom) showing where the item will land. The
 * indicator lives inside the 24px insertion-point gap, so it's visible
 * without pushing any content around. The real mutation fires once on
 * drop; the virtualizer recalculates once at that point.
 *
 * This component owns:
 *   - The scroll container ref + `useVirtualizer` instance.
 *   - A single `monitorForElements` that handles drag lifecycle:
 *     `onDragStart` → clear selection + set dragActive,
 *     `onDrop`      → apply mutation + select dropped field + clear drag.
 *   - `autoScrollForElements` on the scroll container.
 *   - Cursor-velocity tracking for insertion-point hover gating.
 *   - The shared question-picker Base UI `Menu.Root`.
 */

"use client";
import {
	dropTargetForElements,
	monitorForElements,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { autoScrollForElements } from "@atlaskit/pragmatic-drag-and-drop-auto-scroll/element";
import { extractClosestEdge } from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge";
import { Menu } from "@base-ui/react/menu";
import {
	defaultRangeExtractor,
	type Range,
	useVirtualizer,
} from "@tanstack/react-virtual";
import {
	memo,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { DragStateProvider } from "@/components/builder/contexts/DragStateContext";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { notifyMoveRename } from "@/lib/doc/mutations/notify";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { asUuid, type Uuid } from "@/lib/doc/types";
import { useSelect, useSelectedQuestion } from "@/lib/routing/hooks";
import {
	QuestionPickerContext,
	type QuestionPickerPayload,
} from "../QuestionPickerContext";
import { QuestionTypePickerPopup } from "../QuestionTypePicker";
import {
	isDraggableQuestionData,
	isUuidInSubtree,
	readDropTargetData,
	targetContainerUuidFor,
} from "./dragData";
import type { FormRow } from "./rowModel";
import {
	depthPadding,
	EMPTY_CONTAINER_HEIGHT_PX,
	GROUP_BRACKET_HEIGHT_PX,
	INSERTION_REST_HEIGHT_PX,
} from "./rowStyles";
import { EmptyContainerRow } from "./rows/EmptyContainerRow";
import { GroupCloseRow, GroupOpenRow } from "./rows/GroupBracket";
import { InsertionPointRow } from "./rows/InsertionPointRow";
import { QuestionRow } from "./rows/QuestionRow";
import { useFormRows } from "./useFormRows";
import { VirtualFormProvider } from "./VirtualFormContext";

// ── Constants ─────────────────────────────────────────────────────────

const QUESTION_DEFAULT_HEIGHT_PX = 80;
const OVERSCAN = 10;
const CURSOR_EMA_ALPHA = 0.01;
const CURSOR_GAP_RESET_MS = 5000;

// ── Props ─────────────────────────────────────────────────────────────

interface VirtualFormListProps {
	readonly formUuid: Uuid;
}

// ── Implementation ────────────────────────────────────────────────────

export const VirtualFormList = memo(function VirtualFormList({
	formUuid,
}: VirtualFormListProps) {
	const docStore = useContext(BlueprintDocContext);
	const { moveQuestion } = useBlueprintMutations();
	const select = useSelect();
	const selectedQuestion = useSelectedQuestion();

	// ── Collapse ──────────────────────────────────────────────────────

	const [collapsed, setCollapsed] = useState<Set<Uuid>>(() => new Set<Uuid>());
	const toggleCollapse = useCallback((uuid: Uuid) => {
		setCollapsed((prev) => {
			const next = new Set(prev);
			if (next.has(uuid)) next.delete(uuid);
			else next.add(uuid);
			return next;
		});
	}, []);
	const isCollapsed = useCallback(
		(uuid: Uuid) => collapsed.has(uuid),
		[collapsed],
	);

	// ── Drag state ───────────────────────────────────────────────────

	const [dragActive, setDragActive] = useState(false);

	// Index in the `rows` array where a synthetic placeholder row is
	// spliced during drag. `null` outside of a drag or when the cursor
	// isn't over a valid drop target. Only changes when the drop target
	// changes (not every pixel), so the virtualizer recalculates at
	// most a few times per second during a drag.
	const [placeholderIndex, setPlaceholderIndex] = useState<number | null>(null);
	// Dedup ref — the row-index we last set, so `onDrag` (60fps) only
	// calls `setPlaceholderIndex` when the target actually changes.
	const lastPlaceholderRef = useRef<number | null>(null);
	// Depth of the placeholder — drives indentation.
	const placeholderDepthRef = useRef(0);
	// The dragged item's uuid — used for no-op detection on drop.
	const dragSourceUuidRef = useRef<string | null>(null);
	// The resolved drop intent — stored by `onDrag` so `onDrop` can
	// use the SAME position the user saw, even if the cursor is over
	// dead space (the placeholder gap) at drop time.
	const pendingDropRef = useRef<{
		drop: ReturnType<typeof readDropTargetData>;
		edge: ReturnType<typeof extractClosestEdge>;
	} | null>(null);

	// ── Rows ─────────────────────────────────────────────────────────

	const baseRows = useFormRows({
		formUuid,
		includeInsertionPoints: true,
		collapsed,
	});
	// Mirror into a ref so the monitor's onDrag can read the latest
	// rows without being in the effect's dependency array (which would
	// re-register the monitor on every row change).
	const baseRowsRef = useRef(baseRows);
	baseRowsRef.current = baseRows;

	// REPLACE the insertion row at the drop position with a taller
	// placeholder. The row count stays the same, every other row keeps
	// its index + key, and the virtualizer only needs to remeasure the
	// one swapped slot. The height difference (60px vs 24px) pushes
	// rows below apart, opening a visible gap.
	const rows: FormRow[] = useMemo(() => {
		if (placeholderIndex === null) return baseRows;
		const cloned = [...baseRows];
		cloned[placeholderIndex] = {
			kind: "drop-placeholder",
			id: "__drop-placeholder__",
			depth: placeholderDepthRef.current,
		};
		return cloned;
	}, [baseRows, placeholderIndex]);

	// ── Selected-row pinning ─────────────────────────────────────────

	const selectedIndex = useMemo(() => {
		const uuid = selectedQuestion?.uuid;
		if (!uuid) return -1;
		for (let i = 0; i < rows.length; i++) {
			const row = rows[i];
			if (row.kind === "question" && row.uuid === uuid) return i;
		}
		return -1;
	}, [rows, selectedQuestion?.uuid]);

	// ── Virtualizer wiring ───────────────────────────────────────────

	const scrollerRef = useRef<HTMLDivElement | null>(null);

	/** Height for the placeholder row — matches a typical question. */
	const DROP_PLACEHOLDER_HEIGHT_PX = 60;

	const estimateSize = useCallback(
		(index: number): number => {
			const row = rows[index];
			if (!row) return QUESTION_DEFAULT_HEIGHT_PX;
			switch (row.kind) {
				case "insertion":
					return INSERTION_REST_HEIGHT_PX;
				case "group-open":
				case "group-close":
					return GROUP_BRACKET_HEIGHT_PX;
				case "empty-container":
					return EMPTY_CONTAINER_HEIGHT_PX;
				case "drop-placeholder":
					return DROP_PLACEHOLDER_HEIGHT_PX;
				case "question":
					return QUESTION_DEFAULT_HEIGHT_PX;
			}
		},
		[rows],
	);

	const rangeExtractor = useCallback(
		(range: Range): number[] => {
			const base = defaultRangeExtractor(range);
			if (selectedIndex < 0) return base;
			if (selectedIndex >= range.startIndex && selectedIndex <= range.endIndex)
				return base;
			const set = new Set(base);
			set.add(selectedIndex);
			return Array.from(set).sort((a, b) => a - b);
		},
		[selectedIndex],
	);

	const getItemKey = useCallback(
		(index: number): string => rows[index]?.id ?? String(index),
		[rows],
	);

	const virtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement: () => scrollerRef.current,
		estimateSize,
		overscan: OVERSCAN,
		rangeExtractor,
		getItemKey,
	});

	// ── Auto-scroll ──────────────────────────────────────────────────

	useEffect(() => {
		const el = scrollerRef.current;
		if (!el) return;
		return autoScrollForElements({
			element: el,
			canScroll: ({ source }) => isDraggableQuestionData(source.data),
			getAllowedAxis: () => "vertical",
		});
	}, []);

	// ── Global monitor — drag lifecycle ──────────────────────────────
	// `onDragStart` clears selection + enables drag mode.
	// `onDrag` computes the placeholder row index from the hovered
	//   drop target — only fires setState when the index changes.
	// `onDrop` applies the mutation + selects the dropped field.

	useEffect(() => {
		const docs = docStore;
		if (!docs) return;
		return monitorForElements({
			canMonitor: ({ source }) => isDraggableQuestionData(source.data),

			onDragStart: ({ source }) => {
				setDragActive(true);
				lastPlaceholderRef.current = null;
				pendingDropRef.current = null;
				document.body.style.cursor = "grabbing";
				// Stash the source uuid so onDrop can detect no-op drops
				// (dropped at the same position).
				if (isDraggableQuestionData(source.data)) {
					dragSourceUuidRef.current = source.data.uuid;
				}
				select(undefined);
			},

			onDrag: ({ source, location }) => {
				if (!isDraggableQuestionData(source.data)) return;
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

				// Cycle guard — no placeholder for illegal drops.
				const targetContainer = targetContainerUuidFor(drop);
				if (
					isUuidInSubtree(
						docs.getState().questionOrder as Record<string, readonly string[]>,
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
				// between every pair of question/group rows:
				//   ins(0), Q(A), ins(1), Q(B), ins(2)
				// "top of B" and "bottom of A" both resolve to ins(1).
				// By targeting the insertion row, we:
				//   1. Place the placeholder in the natural gap (not
				//      kissing the question border).
				//   2. Eliminate edge thrashing — both edges of the
				//      boundary resolve to the same insertion row index.
				const edge = extractClosestEdge(innermost.data);
				const br = baseRowsRef.current;
				let insertionRowIndex = -1;
				let insertionDepth = 0;

				switch (drop.kind) {
					case "drop-question": {
						// Find the question row, then look for the adjacent
						// insertion row on the correct side. Group-open rows
						// never carry `drop-question` data (they use
						// `drop-group-header`), so only match `question` here.
						for (let i = 0; i < br.length; i++) {
							const r = br[i];
							const isTarget = r.kind === "question" && r.uuid === drop.uuid;
							if (!isTarget) continue;

							if (edge === "top") {
								// Look backward for the insertion row before this question.
								for (let j = i - 1; j >= 0; j--) {
									if (br[j].kind === "insertion") {
										insertionRowIndex = j;
										insertionDepth = br[j].depth;
										break;
									}
								}
							} else {
								// "bottom" or null — look forward for the insertion
								// row after this question (skipping group-close, etc.).
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
						// The first insertion row inside the group — the one
						// immediately after the group-open row.
						for (let i = 0; i < br.length; i++) {
							const r = br[i];
							if (r.kind === "group-open" && r.uuid === drop.uuid) {
								// The next row should be an insertion at depth+1.
								if (i + 1 < br.length && br[i + 1].kind === "insertion") {
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
				// the source (same position = no-op drop). Check if the
				// source row is immediately before or after this insertion.
				{
					// Suppress placeholder when it would appear adjacent
					// to the source (same position = no-op drop). Check
					// the rows immediately before/after the insertion row
					// for any row that belongs to the dragged item.
					const br = baseRowsRef.current;
					const before =
						insertionRowIndex > 0 ? br[insertionRowIndex - 1] : null;
					const after =
						insertionRowIndex < br.length - 1
							? br[insertionRowIndex + 1]
							: null;
					const isSource = (r: FormRow | null): boolean => {
						if (!r) return false;
						if (r.kind === "question" && r.uuid === dragUuid) return true;
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

				if (!isDraggableQuestionData(source.data)) return;
				const dragUuid = source.data.uuid;
				const { drop, edge } = pending;

				// Cycle guard.
				const targetContainer = targetContainerUuidFor(drop);
				if (
					isUuidInSubtree(
						docs.getState().questionOrder as Record<string, readonly string[]>,
						dragUuid,
						targetContainer,
					)
				) {
					return;
				}

				// No-op detection: if the source would land in the same
				// position it started (adjacent to itself), skip the
				// mutation entirely — it's a cancel, not a move.
				if (drop.kind === "drop-question") {
					const parentOrder =
						docs.getState().questionOrder[drop.parentUuid as Uuid] ?? [];
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

				let result: ReturnType<typeof moveQuestion> | undefined;

				switch (drop.kind) {
					case "drop-question": {
						if (drop.uuid === dragUuid) return;
						if (edge === "top") {
							result = moveQuestion(asUuid(dragUuid), {
								beforeUuid: drop.uuid,
								toParentUuid: drop.parentUuid,
							});
						} else {
							result = moveQuestion(asUuid(dragUuid), {
								afterUuid: drop.uuid,
								toParentUuid: drop.parentUuid,
							});
						}
						break;
					}

					case "drop-group-header": {
						if (drop.uuid === dragUuid) return;
						const firstChild =
							docs.getState().questionOrder[drop.uuid as Uuid]?.[0];
						result = firstChild
							? moveQuestion(asUuid(dragUuid), {
									toParentUuid: drop.uuid,
									beforeUuid: firstChild,
								})
							: moveQuestion(asUuid(dragUuid), {
									toParentUuid: drop.uuid,
								});
						break;
					}

					case "drop-empty-container": {
						result = moveQuestion(asUuid(dragUuid), {
							toParentUuid: drop.parentUuid,
						});
						break;
					}
				}

				if (result) notifyMoveRename(result);
				select(asUuid(dragUuid));
			},
		});
	}, [docStore, moveQuestion, select]);

	// ── Cursor-speed tracking (for InsertionPoint hover gating) ──────

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

	// ── Shared question-picker menu ──────────────────────────────────

	const questionPickerHandle = useMemo(
		() => Menu.createHandle<QuestionPickerPayload>(),
		[],
	);
	const closeListenersRef = useRef(new Set<() => void>());
	const subscribeClose = useCallback((listener: () => void) => {
		closeListenersRef.current.add(listener);
		return () => {
			closeListenersRef.current.delete(listener);
		};
	}, []);
	const onPickerOpenChange = useCallback((nextOpen: boolean) => {
		if (!nextOpen) {
			for (const listener of closeListenersRef.current) listener();
		}
	}, []);
	const questionPickerCtx = useMemo(
		() => ({ handle: questionPickerHandle, subscribeClose }),
		[questionPickerHandle, subscribeClose],
	);

	// ── Render ───────────────────────────────────────────────────────

	const virtualItems = virtualizer.getVirtualItems();
	const totalSize = virtualizer.getTotalSize();

	return (
		<QuestionPickerContext.Provider value={questionPickerCtx}>
			<VirtualFormProvider
				formUuid={formUuid}
				toggleCollapse={toggleCollapse}
				isCollapsed={isCollapsed}
			>
				<DragStateProvider isActive={dragActive} setActive={setDragActive}>
					<div
						ref={scrollerRef}
						data-preview-scroll-container
						className="relative h-full overflow-auto"
						style={{ contain: "strict" }}
					>
						<div
							style={{
								height: totalSize,
								width: "100%",
								position: "relative",
							}}
						>
							{virtualItems.map((vi) => {
								const row = rows[vi.index];
								if (!row) return null;
								return (
									<div
										key={vi.key}
										ref={virtualizer.measureElement}
										data-index={vi.index}
										style={{
											position: "absolute",
											top: 0,
											left: 0,
											width: "100%",
											transform: `translateY(${vi.start}px)`,
										}}
									>
										<RenderRow
											row={row}
											cursorSpeedRef={cursorSpeedRef}
											lastCursorRef={lastCursorRef}
											disableInsertion={dragActive}
										/>
									</div>
								);
							})}
						</div>
					</div>
				</DragStateProvider>

				<Menu.Root
					handle={questionPickerHandle}
					modal={false}
					onOpenChange={onPickerOpenChange}
				>
					{({ payload }: { payload: QuestionPickerPayload | undefined }) =>
						payload && (
							<QuestionTypePickerPopup
								atIndex={payload.atIndex}
								parentUuid={payload.parentUuid}
							/>
						)
					}
				</Menu.Root>
			</VirtualFormProvider>
		</QuestionPickerContext.Provider>
	);
});

// ── Row dispatch ─────────────────────────────────────────────────────

interface RenderRowProps {
	row: FormRow;
	cursorSpeedRef: React.RefObject<number>;
	lastCursorRef: React.RefObject<
		{ x: number; y: number; t: number } | undefined
	>;
	disableInsertion: boolean;
}

const RenderRow = memo(function RenderRow({
	row,
	cursorSpeedRef,
	lastCursorRef,
	disableInsertion,
}: RenderRowProps) {
	switch (row.kind) {
		case "insertion":
			return (
				<InsertionPointRow
					parentUuid={row.parentUuid}
					beforeIndex={row.beforeIndex}
					depth={row.depth}
					cursorSpeedRef={cursorSpeedRef}
					lastCursorRef={lastCursorRef}
					disabled={disableInsertion}
				/>
			);
		case "question":
			return (
				<QuestionRow
					uuid={row.uuid}
					parentUuid={row.parentUuid}
					siblingIndex={row.siblingIndex}
					depth={row.depth}
				/>
			);
		case "group-open":
			return (
				<GroupOpenRow
					uuid={row.uuid}
					parentUuid={row.parentUuid}
					siblingIndex={row.siblingIndex}
					depth={row.depth}
					collapsed={row.collapsed}
				/>
			);
		case "group-close":
			return <GroupCloseRow uuid={row.uuid} depth={row.depth} />;
		case "empty-container":
			return (
				<EmptyContainerRow parentUuid={row.parentUuid} depth={row.depth} />
			);
		case "drop-placeholder":
			return <DropPlaceholderRow depth={row.depth} />;
	}
});

// ── Drop placeholder row ────────────────────────────────────────────

/**
 * The visible gap that opens at the drop position during drag. Registered
 * as a `dropTargetForElements` so the browser accepts the native drop
 * (calls `preventDefault` on `dragover`) — without this, the browser
 * rejects the drop, plays its snap-back animation, and THEN our monitor
 * fires the mutation, producing a jarring delay.
 */
function DropPlaceholderRow({ depth }: { depth: number }) {
	const ref = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		return dropTargetForElements({
			element: el,
			// Accept anything — the monitor handles the actual mutation.
			getData: () => ({ kind: "drop-placeholder" }),
		});
	}, []);

	return (
		<div
			ref={ref}
			style={{
				paddingLeft: depthPadding(depth),
				paddingRight: depthPadding(0),
				paddingTop: INSERTION_REST_HEIGHT_PX / 2,
				paddingBottom: INSERTION_REST_HEIGHT_PX / 2,
			}}
		>
			<div className="h-[56px] rounded-lg border-2 border-dashed border-nova-violet bg-nova-violet/20" />
		</div>
	);
}
