/**
 * VirtualFormList — virtualized flat-row renderer for edit-mode forms.
 *
 * Performance model: only rows in the visible range (plus overscan +
 * the pinned selected row) are mounted, which turns the form-open mount
 * storm from `O(questions)` components into `O(viewport)` components.
 *
 * Drag-and-drop uses pragmatic-drag-and-drop (browser-native drag).
 * The row list stays completely stable during a drag — no array
 * reordering, no preview order, no virtualizer recalculation. When the
 * cursor resolves to an insertion row, that row is REPLACED in place
 * with a taller `drop-placeholder` row (dashed violet outline). Row
 * count stays constant and only the swapped slot remeasures, so the
 * virtualizer produces a single remeasure per distinct drop target.
 * The real mutation fires once on drop.
 *
 * This shell owns:
 *   - The scroll container ref + `useVirtualizer` instance.
 *   - The rows-array swap that turns the `placeholderIndex` from
 *     `useDragIntent` into a visible placeholder row.
 *   - `autoScrollForElements` on the scroll container.
 *   - The shared field-picker Base UI `Menu.Root`.
 *
 * The drag lifecycle (global `monitorForElements`, cursor-velocity
 * tracking, placeholder resolution) lives in `./useDragIntent`.
 */

"use client";
import { dropTargetForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { autoScrollForElements } from "@atlaskit/pragmatic-drag-and-drop-auto-scroll/element";
import { Menu } from "@base-ui/react/menu";
import {
	defaultRangeExtractor,
	type Range,
	useVirtualizer,
} from "@tanstack/react-virtual";
import {
	memo,
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
} from "react";
import { DragStateProvider } from "@/components/builder/contexts/DragStateContext";
import type { Uuid } from "@/lib/doc/types";
import { useSelectedField } from "@/lib/routing/hooks";
import {
	FieldPickerContext,
	type FieldPickerPayload,
} from "../FieldPickerContext";
import { FieldTypePickerPopup } from "../FieldTypePicker";
import { useFormLayout } from "../FormLayoutContext";
import { isDraggableQuestionData } from "./dragData";
import type { FormRow } from "./rowModel";
import {
	depthPadding,
	EMPTY_CONTAINER_HEIGHT_PX,
	GROUP_BRACKET_HEIGHT_PX,
	INSERTION_REST_HEIGHT_PX,
} from "./rowStyles";
import { EmptyContainerRow } from "./rows/EmptyContainerRow";
import { FieldRow } from "./rows/FieldRow";
import { GroupCloseRow, GroupOpenRow } from "./rows/GroupBracket";
import { InsertionPointRow } from "./rows/InsertionPointRow";
import { useDragIntent } from "./useDragIntent";
import { useFormRows } from "./useFormRows";
import { VirtualFormProvider } from "./VirtualFormContext";

// ── Constants ─────────────────────────────────────────────────────────

const QUESTION_DEFAULT_HEIGHT_PX = 80;
const OVERSCAN = 10;

// ── Props ─────────────────────────────────────────────────────────────

interface VirtualFormListProps {
	readonly formUuid: Uuid;
}

// ── Implementation ────────────────────────────────────────────────────

export const VirtualFormList = memo(function VirtualFormList({
	formUuid,
}: VirtualFormListProps) {
	const selectedField = useSelectedField();

	// ── Collapse (shared across edit + live via FormLayoutContext) ───
	// FormLayoutProvider in FormScreen owns the canonical Set so the same
	// group stays folded whether the user is in the virtualized editor,
	// the interactive pointer preview, or test mode.

	const { collapsed, toggleCollapse, isCollapsed } = useFormLayout();

	// ── Rows ─────────────────────────────────────────────────────────

	const baseRows = useFormRows({
		formUuid,
		includeInsertionPoints: true,
		collapsed,
	});
	// Mirror into a ref so the drag monitor's onDrag can read the latest
	// rows without being in the effect's dependency array (which would
	// re-register the monitor on every row change).
	const baseRowsRef = useRef(baseRows);
	baseRowsRef.current = baseRows;

	// ── Drag state (owned by useDragIntent) ─────────────────────────
	// The hook wires the pragmatic-drag-and-drop global monitor and the
	// cursor-velocity listeners. The shell only needs the reactive
	// placeholder position + the cursor refs to forward to insertion
	// point rows.

	const {
		dragActive,
		setDragActive,
		placeholderIndex,
		placeholderDepth,
		cursorSpeedRef,
		lastCursorRef,
	} = useDragIntent({ formUuid, baseRowsRef });

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
			depth: placeholderDepth,
		};
		return cloned;
	}, [baseRows, placeholderIndex, placeholderDepth]);

	// ── Selected-row pinning ─────────────────────────────────────────

	const selectedIndex = useMemo(() => {
		const uuid = selectedField?.uuid;
		if (!uuid) return -1;
		for (let i = 0; i < rows.length; i++) {
			const row = rows[i];
			if (row.kind === "field" && row.uuid === uuid) return i;
		}
		return -1;
	}, [rows, selectedField?.uuid]);

	// ── Virtualizer wiring ───────────────────────────────────────────

	const scrollerRef = useRef<HTMLDivElement | null>(null);

	/** Height for the placeholder row — matches a typical field. */
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
				case "field":
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

	// ── Shared field-picker menu ──────────────────────────────────

	const questionPickerHandle = useMemo(
		() => Menu.createHandle<FieldPickerPayload>(),
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
		<FieldPickerContext.Provider value={questionPickerCtx}>
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
					{({ payload }: { payload: FieldPickerPayload | undefined }) =>
						payload && (
							<FieldTypePickerPopup
								atIndex={payload.atIndex}
								parentUuid={payload.parentUuid}
							/>
						)
					}
				</Menu.Root>
			</VirtualFormProvider>
		</FieldPickerContext.Provider>
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
	/* Group nesting rails — left/right borders at each ancestor group's
	 * depth connecting the group-open and group-close brackets into a
	 * continuous visual box. Inside the memo so scroll-driven re-renders
	 * of the virtualizer don't rebuild the rail elements. */
	const rails = row.depth > 0 ? <GroupNestingRails depth={row.depth} /> : null;

	switch (row.kind) {
		case "insertion":
			return (
				<>
					{rails}
					<InsertionPointRow
						parentUuid={row.parentUuid}
						beforeIndex={row.beforeIndex}
						depth={row.depth}
						cursorSpeedRef={cursorSpeedRef}
						lastCursorRef={lastCursorRef}
						disabled={disableInsertion}
					/>
				</>
			);
		case "field":
			return (
				<>
					{rails}
					<FieldRow
						uuid={row.uuid}
						parentUuid={row.parentUuid}
						siblingIndex={row.siblingIndex}
						depth={row.depth}
					/>
				</>
			);
		case "group-open":
			return (
				<>
					{rails}
					<GroupOpenRow
						uuid={row.uuid}
						parentUuid={row.parentUuid}
						siblingIndex={row.siblingIndex}
						depth={row.depth}
						collapsed={row.collapsed}
					/>
				</>
			);
		case "group-close":
			return (
				<>
					{rails}
					<GroupCloseRow uuid={row.uuid} depth={row.depth} />
				</>
			);
		case "empty-container":
			return (
				<>
					{rails}
					<EmptyContainerRow parentUuid={row.parentUuid} depth={row.depth} />
				</>
			);
		case "drop-placeholder":
			return (
				<>
					{rails}
					<DropPlaceholderRow depth={row.depth} />
				</>
			);
	}
});

// ── Group nesting rails ─────────────────────────────────────────────

/**
 * Decorative left/right borders drawn behind row content to connect the
 * `group-open` and `group-close` brackets into a continuous visual box.
 *
 * For a row at nesting depth `d`, one rail is drawn for each ancestor
 * group (depths 0 through d−1). Each rail aligns its left AND right
 * edges with the ancestor bracket's own borders (both at
 * `depthPadding(i)` from the respective form edge) so every nested
 * group is symmetrically inset from its parent — children never kiss
 * the parent's right border the way they did when the right pin was
 * fixed at `depthPadding(0)`.
 *
 * Rails render BEFORE the row content in the DOM, so they paint behind
 * it — field cards, insertion lines, and bracket decorations all sit
 * above the rails in the stacking order.
 */
function GroupNestingRails({ depth }: { depth: number }) {
	const rails: ReactNode[] = [];
	for (let i = 0; i < depth; i++) {
		rails.push(
			<div
				key={`rail-${i}`}
				className="absolute top-0 bottom-0 border-l border-r border-pv-input-border pointer-events-none"
				style={{
					left: depthPadding(i),
					right: depthPadding(i),
				}}
			/>,
		);
	}
	return <>{rails}</>;
}

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
				paddingRight: depthPadding(depth),
				paddingTop: INSERTION_REST_HEIGHT_PX / 2,
				paddingBottom: INSERTION_REST_HEIGHT_PX / 2,
			}}
		>
			<div className="h-[56px] rounded-lg border-2 border-dashed border-nova-violet bg-nova-violet/20" />
		</div>
	);
}
