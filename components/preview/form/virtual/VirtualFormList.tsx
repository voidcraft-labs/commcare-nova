/**
 * VirtualFormList — virtualized flat-row renderer for edit-mode forms.
 *
 * Replaces the recursive `FormRenderer` → `GroupField`/`RepeatField` →
 * `FormRenderer` (nested) tree with a single flat virtualizer fed by the
 * row model. Only rows in the visible range (plus overscan + the pinned
 * selected row) are mounted, which turns the form-open mount storm from
 * `O(questions)` components into `O(viewport)` components.
 *
 * Ownership:
 *   - Scroll container (single `overflow: auto` div).
 *   - `useVirtualizer` instance, row-size estimates, measurement cache.
 *   - `rangeExtractor` that pins the selected question's row.
 *   - `DragDropProvider` wrapping the rendered rows so every sortable
 *     registered by a `QuestionRow` / `GroupOpenRow` in view shares one
 *     drag session.
 *   - Drag lifecycle: items-map build on start, `move()`-based updates
 *     on over, mutation + unfreeze on end. Rows are frozen while a drag
 *     is active so the virtualizer doesn't reshuffle the mounted set
 *     underneath dnd-kit.
 *   - Cursor-velocity tracking for insertion points' hover gating.
 *   - Shared question-picker menu handle (the Base UI `Menu.Root`).
 */

"use client";
import { Menu } from "@base-ui/react/menu";
import { PointerActivationConstraints } from "@dnd-kit/dom";
import { RestrictToElement } from "@dnd-kit/dom/modifiers";
import { move } from "@dnd-kit/helpers";
import { DragDropProvider, DragOverlay, PointerSensor } from "@dnd-kit/react";
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
import type { MoveQuestionResult } from "@/lib/doc/mutations/questions";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { asUuid, type Uuid } from "@/lib/doc/types";
import { useSelect, useSelectedQuestion } from "@/lib/routing/hooks";
import type { NQuestion } from "@/lib/services/normalizedState";
import {
	QuestionPickerContext,
	type QuestionPickerPayload,
} from "../QuestionPickerContext";
import { QuestionTypePickerPopup } from "../QuestionTypePicker";
import {
	DragReorderContext,
	type DragReorderState,
} from "./DragReorderContext";
import type { FormRow } from "./rowModel";
import {
	EMPTY_CONTAINER_HEIGHT_PX,
	GROUP_BRACKET_HEIGHT_PX,
	INSERTION_REST_HEIGHT_PX,
} from "./rowStyles";
import { EmptyContainerRow } from "./rows/EmptyContainerRow";
import { GroupCloseRow, GroupOpenRow } from "./rows/GroupBracket";
import { InsertionPointRow } from "./rows/InsertionPointRow";
import { QuestionRow } from "./rows/QuestionRow";
import { useFormRows } from "./useFormRows";
import {
	CONTAINER_SUFFIX,
	ROOT_GROUP,
	VirtualFormProvider,
} from "./VirtualFormContext";

// ── Constants ─────────────────────────────────────────────────────────

/** Default (unmeasured) height for question rows. Real heights replace
 *  this via `measureElement` + ResizeObserver. */
const QUESTION_DEFAULT_HEIGHT_PX = 80;

/** Rows above/below the visible range to keep mounted. Cheap insurance
 *  for fast drag-to-edge scrolling and for dnd-kit drop-zone collision
 *  at the edges of the viewport. */
const OVERSCAN = 10;

/** EMA smoothing factor for cursor velocity (matches the legacy
 *  FormRenderer — lower = smoother tracking). */
const CURSOR_EMA_ALPHA = 0.01;
/** After this idle time (ms), EMA resets to the raw speed instead of
 *  smoothing — prevents stale EMA after a long pause. */
const CURSOR_GAP_RESET_MS = 5000;

// ── Sensor config ─────────────────────────────────────────────────────

/** 5px pointer distance before drag activates — same threshold the
 *  legacy FormRenderer used to distinguish click from drag. */
const SENSORS = [
	PointerSensor.configure({
		activationConstraints: [
			new PointerActivationConstraints.Distance({ value: 5 }),
		],
	}),
];

// ── Props ─────────────────────────────────────────────────────────────

interface VirtualFormListProps {
	/** The form's uuid — root parent of the flat row walk and the key used
	 *  to disambiguate root-level sortables from nested ones. */
	readonly formUuid: Uuid;
}

// ── Implementation ────────────────────────────────────────────────────

export const VirtualFormList = memo(function VirtualFormList({
	formUuid,
}: VirtualFormListProps) {
	// The BlueprintDoc store — needed for imperative reads during drag
	// lifecycle (items-map build, parent lookup on drop). We don't
	// subscribe to the entity maps here; drags are a snapshot.
	const docStore = useContext(BlueprintDocContext);
	const { moveQuestion } = useBlueprintMutations();
	const select = useSelect();
	const selectedQuestion = useSelectedQuestion();

	// Collapse state is local to this list — no reason to pay for global
	// Zustand storage; expanding/collapsing doesn't need to survive
	// remounts. If users complain we can promote to BuilderSession later.
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

	// Drag state — owned here so the entire drag lifecycle coordinates
	// with row freezing + virtualizer pinning in one place.
	const [dragState, setDragState] = useState<DragReorderState | null>(null);
	const [dragActive, setDragActive] = useState(false);
	const isDragging = dragState !== null;

	// Mirror `dragState` into a ref so `handleDragEnd` can read the
	// latest value without being recreated on every `onDragOver` tick.
	// Without this, updating dragState on each over event would create a
	// fresh handler identity and force the DragDropProvider to rebind
	// listeners repeatedly during a drag.
	const dragStateRef = useRef<DragReorderState | null>(null);
	dragStateRef.current = dragState;

	// Flat rows — frozen while a drag is in flight so the virtualizer
	// doesn't remount rows underneath dnd-kit.
	const rows = useFormRows({
		formUuid,
		includeInsertionPoints: true,
		collapsed,
		frozen: isDragging,
	});

	// The selected-row index, used by the rangeExtractor to pin it into
	// the mounted range so the inline settings panel stays alive when
	// the user scrolls far enough to push the selected row out of view.
	// Computed via findIndex once per rows-reference change.
	const selectedIndex = useMemo(() => {
		const uuid = selectedQuestion?.uuid;
		if (!uuid) return -1;
		for (let i = 0; i < rows.length; i++) {
			const row = rows[i];
			if (row.kind === "question" && row.uuid === uuid) return i;
		}
		return -1;
	}, [rows, selectedQuestion?.uuid]);

	// ── Virtualizer wiring ────────────────────────────────────────────

	const scrollerRef = useRef<HTMLDivElement | null>(null);

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
			// Pin the selected row by merging its index with the default set
			// and re-sorting. The returned array must be sorted ascending or
			// the virtualizer's translateY accounting breaks.
			const set = new Set(base);
			set.add(selectedIndex);
			return Array.from(set).sort((a, b) => a - b);
		},
		[selectedIndex],
	);

	// Row identity — stable key per row (uuid-derived or positional-
	// derived via the walker) so measured heights survive reorder.
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

	// ── Drag-overlay modifier ────────────────────────────────────────

	const modifiers = useMemo(
		() => [
			RestrictToElement.configure({
				element: () => scrollerRef.current,
			}),
		],
		[],
	);

	// ── Cursor-speed tracking ────────────────────────────────────────

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

	// ── Shared question-picker menu (detached triggers) ─────────────

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

	// ── Drag lifecycle ───────────────────────────────────────────────

	const handleDragStart = useCallback(
		(
			event: Parameters<
				NonNullable<
					React.ComponentProps<typeof DragDropProvider>["onDragStart"]
				>
			>[0],
		) => {
			const sourceUuid = event.operation.source?.id as string | undefined;
			if (!sourceUuid || !docStore) return;
			const doc = docStore.getState();
			const itemsMap = buildItemsMapFromDoc(
				doc.questions as Record<string, NQuestion>,
				doc.questionOrder as Record<string, string[]>,
				formUuid,
			);
			setDragState({ itemsMap, activeUuid: sourceUuid });
			setDragActive(true);
			document.body.style.cursor = "grabbing";
			// Clear selection at drag start so the inline panel doesn't
			// visually collide with the overlay. (Matches the legacy
			// FormRenderer behavior.)
			select(undefined);
		},
		[docStore, formUuid, select],
	);

	const handleDragOver = useCallback(
		(
			event: Parameters<
				NonNullable<React.ComponentProps<typeof DragDropProvider>["onDragOver"]>
			>[0],
		) => {
			setDragState((prev) => {
				if (!prev) return prev;
				const newMap = move(prev.itemsMap, event);
				if (newMap === prev.itemsMap) return prev;
				return { ...prev, itemsMap: newMap };
			});
		},
		[],
	);

	const handleDragEnd = useCallback(
		(
			event: Parameters<
				NonNullable<React.ComponentProps<typeof DragDropProvider>["onDragEnd"]>
			>[0],
		) => {
			// Read the latest drag state from the ref (mirror set in render)
			// so this handler stays stable across the many `onDragOver` ticks
			// that fire during a single drag.
			const ds = dragStateRef.current;
			const canceled = event.canceled;

			// Defer state cleanup to a microtask — dnd-kit fires onDragEnd
			// inside React 19's useInsertionEffect where setState is
			// forbidden.
			queueMicrotask(() => {
				setDragState(null);
				setDragActive(false);
				document.body.style.cursor = "";

				if (canceled || !ds || !docStore) return;

				const { activeUuid: dragUuid, itemsMap } = ds;

				// Locate the dragged UUID in the reordered items map —
				// scans buckets to find where it landed.
				let finalGroup: string | undefined;
				let finalIndex = -1;
				for (const [g, ids] of Object.entries(itemsMap)) {
					const i = ids.indexOf(dragUuid);
					if (i !== -1) {
						finalGroup = g;
						finalIndex = i;
						break;
					}
				}
				if (!finalGroup || finalIndex === -1) return;

				const currentDoc = docStore.getState();
				// Initial group = scan questionOrder for the parent that
				// contains the dragged UUID, then map to bucket-key format.
				let initialParentUuid: string | undefined;
				for (const [pUuid, order] of Object.entries(
					currentDoc.questionOrder as Record<string, string[]>,
				)) {
					if (order.includes(dragUuid)) {
						initialParentUuid = pUuid;
						break;
					}
				}
				const initialGroup = initialParentUuid
					? initialParentUuid === formUuid
						? ROOT_GROUP
						: `${initialParentUuid}${CONTAINER_SUFFIX}`
					: ROOT_GROUP;

				const sameGroup = initialGroup === finalGroup;
				const finalIds = itemsMap[finalGroup] ?? [];

				// No-op same-group drop (same index, same bucket).
				if (sameGroup) {
					const initialOrder =
						currentDoc.questionOrder[(initialParentUuid ?? formUuid) as Uuid] ??
						[];
					const initialIndex = initialOrder.indexOf(asUuid(dragUuid));
					if (initialIndex === finalIndex) {
						select(asUuid(dragUuid));
						return;
					}
				}

				const targetParentUuid =
					finalGroup === ROOT_GROUP
						? formUuid
						: asUuid(stripContainerSuffix(finalGroup));

				// Build moveQuestion args: prefer beforeUuid/afterUuid when
				// neighbors exist; fall through to bare toParentUuid when
				// the target is empty.
				let result: MoveQuestionResult | undefined;
				if (sameGroup) {
					if (finalIndex === 0) {
						if (finalIds.length > 1) {
							result = moveQuestion(asUuid(dragUuid), {
								beforeUuid: asUuid(finalIds[1]),
							});
						} else {
							// Only one item and it's already at index 0 — no-op.
							select(asUuid(dragUuid));
							return;
						}
					} else {
						result = moveQuestion(asUuid(dragUuid), {
							afterUuid: asUuid(finalIds[finalIndex - 1]),
						});
					}
				} else if (finalIds.length <= 1) {
					result = moveQuestion(asUuid(dragUuid), {
						toParentUuid: targetParentUuid,
					});
				} else if (finalIndex === 0) {
					result = moveQuestion(asUuid(dragUuid), {
						toParentUuid: targetParentUuid,
						beforeUuid: asUuid(finalIds[1]),
					});
				} else {
					result = moveQuestion(asUuid(dragUuid), {
						toParentUuid: targetParentUuid,
						afterUuid: asUuid(finalIds[finalIndex - 1]),
					});
				}

				// `notifyMoveRename` is a no-op when nothing was renamed, but
				// calling it unconditionally matches the legacy contract and
				// keeps correctness independent of `moveQuestion`'s internal
				// rules for when dedup fires.
				if (result) notifyMoveRename(result);
				select(asUuid(dragUuid));
			});
		},
		[docStore, formUuid, moveQuestion, select],
	);

	// ── Active-drag overlay label ───────────────────────────────────

	const activeUuid = dragState?.activeUuid;
	const activeLabel = useMemo(() => {
		if (!activeUuid || !docStore) return undefined;
		const q = docStore.getState().questions[activeUuid as Uuid];
		return q ? q.label || q.id : undefined;
	}, [activeUuid, docStore]);

	// ── Render ──────────────────────────────────────────────────────

	const virtualItems = virtualizer.getVirtualItems();
	const totalSize = virtualizer.getTotalSize();

	return (
		<QuestionPickerContext.Provider value={questionPickerCtx}>
			<VirtualFormProvider
				formUuid={formUuid}
				toggleCollapse={toggleCollapse}
				isCollapsed={isCollapsed}
			>
				<DragReorderContext.Provider value={dragState}>
					<DragStateProvider isActive={dragActive} setActive={setDragActive}>
						<DragDropProvider
							sensors={SENSORS}
							modifiers={modifiers}
							onDragStart={handleDragStart}
							onDragOver={handleDragOver}
							onDragEnd={handleDragEnd}
						>
							{/* Scroll container. `data-preview-scroll-container`
							 *  makes `RestrictToElement` find us.
							 *
							 *  `contain: strict` is a virtualizer performance
							 *  win — it isolates layout/paint from the rest of
							 *  the page — but it also creates a new containing
							 *  block for `position: fixed` descendants. dnd-kit's
							 *  `DragOverlay` uses viewport-relative fixed
							 *  positioning, so the overlay must live OUTSIDE
							 *  this container (but still inside
							 *  `DragDropProvider`) or the overlay appears
							 *  offset by the scroll container's viewport
							 *  distance. */}
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
													disableInsertion={isDragging}
												/>
											</div>
										);
									})}
								</div>
							</div>

							<DragOverlay>
								{activeLabel && (
									<div className="rounded-lg bg-nova-surface/80 border border-nova-violet/40 px-3 py-2 shadow-lg text-sm text-nova-text">
										{activeLabel}
									</div>
								)}
							</DragOverlay>
						</DragDropProvider>
					</DragStateProvider>
				</DragReorderContext.Provider>

				{/* Shared menu root for all insertion-point triggers. Renders
				 *  via portal — lives outside the DragDropProvider tree so
				 *  dnd-kit's collision doesn't register the popup. */}
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

/**
 * Single-component switch over `FormRow.kind`. Kept as its own component
 * so each row kind is wrapped in a memo boundary at the virtualizer level
 * — changing the row object reference is the only way to trigger a
 * re-render from here.
 */
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
	}
});

// ── Helpers ───────────────────────────────────────────────────────────

/** Walk `questionOrder` to build the items-map `move()` expects. Buckets
 *  are keyed by `ROOT_GROUP` or `<uuid>:container` to match the
 *  `useDroppable` id emitted by `EmptyContainerRow` / `GroupBracket`. */
function buildItemsMapFromDoc(
	questions: Record<string, NQuestion>,
	questionOrder: Record<string, string[]>,
	formUuid: Uuid,
): Record<string, string[]> {
	const itemsMap: Record<string, string[]> = {};
	function recurse(parentUuid: string, groupKey: string) {
		// questionOrder keys are branded Uuids at the type level but
		// plain strings at runtime — parent ids come in unbranded from
		// the recursive walk.
		const childUuids =
			(questionOrder as Record<string, string[]>)[parentUuid] ?? [];
		itemsMap[groupKey] = [...childUuids];
		for (const uuid of childUuids) {
			const q = questions[uuid];
			if (!q) continue;
			if (q.type === "group" || q.type === "repeat") {
				recurse(uuid, `${uuid}${CONTAINER_SUFFIX}`);
			}
		}
	}
	recurse(formUuid, ROOT_GROUP);
	return itemsMap;
}

/** Strip the `:container` suffix to recover the bare parent uuid. */
function stripContainerSuffix(group: string): string {
	return group.endsWith(CONTAINER_SUFFIX)
		? group.slice(0, -CONTAINER_SUFFIX.length)
		: group;
}
