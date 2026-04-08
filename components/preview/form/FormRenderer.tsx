"use client";
import { CollisionPriority } from "@dnd-kit/abstract";
import { PointerActivationConstraints } from "@dnd-kit/dom";
import { RestrictToElement } from "@dnd-kit/dom/modifiers";
import { move } from "@dnd-kit/helpers";
import { DragDropProvider, DragOverlay, PointerSensor } from "@dnd-kit/react";
import { useSortable } from "@dnd-kit/react/sortable";
import {
	createContext,
	Fragment,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { InlineSettingsPanel } from "@/components/builder/InlineSettingsPanel";
import { useBuilderEngine, useBuilderStore } from "@/hooks/useBuilder";
import { useEditContext } from "@/hooks/useEditContext";
import { useTextEditSave } from "@/hooks/useTextEditSave";
import type { FormEngine } from "@/lib/preview/engine/formEngine";
import { LabelContent } from "@/lib/references/LabelContent";
import type { Question } from "@/lib/schemas/blueprint";
import type { MoveQuestionResult } from "@/lib/services/builderStore";
import {
	type QuestionPath,
	qpath,
	qpathId,
	qpathParent,
} from "@/lib/services/questionPath";
import { EditableQuestionWrapper } from "./EditableQuestionWrapper";
import { FIELD_STYLES } from "./fieldStyles";
import { GroupField } from "./fields/GroupField";
import { HiddenField } from "./fields/HiddenField";
import { LabelField } from "./fields/LabelField";
import { RepeatField } from "./fields/RepeatField";
import { InsertionPoint } from "./InsertionPoint";
import { QuestionField } from "./QuestionField";
import { TextEditable } from "./TextEditable";

/** EMA smoothing factor for cursor velocity. Lower = smoother, slower response. */
const EMA_ALPHA = 0.01;
/** Time (ms) without mouse events before EMA resets to raw speed instead of smoothing. Prevents stale EMA from lingering after long pauses. */
const GAP_RESET = 5000;

/** Sentinel group identifier for root-level questions. */
const ROOT_GROUP = "__root__";

/** Suffix used on items-map keys for group/repeat containers, matching the
 *  `useDroppable` id in GroupField / RepeatField so the `move` helper can
 *  route dragged items into empty containers. */
const CONTAINER_SUFFIX = ":container";

interface FormRendererProps {
	questions: Question[];
	engine: FormEngine;
	prefix?: string;
	parentPath?: QuestionPath;
	/** Parent question's stable UUID — used for UUID-based dnd-kit group keys. */
	parentUuid?: string;
}

/** Sensor config: 5px distance to distinguish click from drag. */
const SENSORS = [
	PointerSensor.configure({
		activationConstraints: [
			new PointerActivationConstraints.Distance({ value: 5 }),
		],
	}),
];

// ── Controlled drag state ─────────────────────────────────────────────
// Follows the official dnd-kit "droppable columns" pattern: onDragOver +
// move() + React state + render from state. Required because the
// OptimisticSortingPlugin only processes SortableDroppable instances —
// plain useDroppable targets (used for empty group containers) are invisible
// to it. The controlled approach lets the move() helper detect container
// drops via target.id matching items-map keys.

interface DragReorderState {
	/** Group → ordered question UUIDs. Updated by `move` helper during drag. */
	itemsMap: Record<string, string[]>;
	/** Flat lookup: UUID → Question object (stable for the drag). */
	questionsById: Map<string, Question>;
	/** UUID → QuestionPath reverse lookup (for mutation calls in onDragEnd). */
	uuidToPath: Map<string, QuestionPath>;
	/** The UUID of the question currently being dragged. */
	activeUuid: string;
	/** The QuestionPath currently being dragged (kept for mutation calls). */
	activePath: QuestionPath;
}

const DragReorderContext = createContext<DragReorderState | null>(null);

/** Shared cursor speed refs from the root FormRenderer to all nested instances. */
const CursorSpeedContext = createContext<{
	speedRef: React.RefObject<number>;
	lastRef: React.RefObject<{ x: number; y: number; t: number } | undefined>;
} | null>(null);

/** Build controlled drag state from the question tree.
 *  Items are keyed by UUID (stable identity). Group keys use parent UUID
 *  with `:container` suffix, matching the droppable IDs in GroupField/RepeatField.
 *  A reverse `uuidToPath` map is built for mutation calls in onDragEnd. */
function buildDragState(
	questions: Question[],
	activeUuid: string,
): DragReorderState {
	const itemsMap: Record<string, string[]> = {};
	const questionsById = new Map<string, Question>();
	const uuidToPath = new Map<string, QuestionPath>();

	function walk(qs: Question[], groupKey: string, pathPrefix: string) {
		if (!itemsMap[groupKey]) itemsMap[groupKey] = [];
		for (const q of qs) {
			const uuid = q.uuid;
			const qPath = pathPrefix ? `${pathPrefix}/${q.id}` : q.id;
			itemsMap[groupKey].push(uuid);
			questionsById.set(uuid, q);
			uuidToPath.set(uuid, qPath as QuestionPath);
			if ((q.type === "group" || q.type === "repeat") && q.children) {
				const containerKey = `${uuid}${CONTAINER_SUFFIX}`;
				if (!itemsMap[containerKey]) itemsMap[containerKey] = [];
				walk(q.children, containerKey, qPath);
			}
		}
	}
	walk(questions, ROOT_GROUP, "");

	/* Derive activePath from the UUID→path map — no need to pass it separately. */
	const activePath = uuidToPath.get(activeUuid) ?? ("" as QuestionPath);
	return { itemsMap, questionsById, uuidToPath, activeUuid, activePath };
}

/** Find a question by bare ID anywhere in the tree. */
function findQuestionInTree(
	questions: Question[],
	id: string,
): Question | undefined {
	for (const q of questions) {
		if (q.id === id) return q;
		if (q.children) {
			const found = findQuestionInTree(q.children, id);
			if (found) return found;
		}
	}
	return undefined;
}

/** Strip the :container suffix to recover the actual QuestionPath. */
function stripContainerSuffix(group: string): string {
	return group.endsWith(CONTAINER_SUFFIX)
		? group.slice(0, -CONTAINER_SUFFIX.length)
		: group;
}

// ── SortableQuestion ──────────────────────────────────────────────────

function SortableQuestion({
	q,
	questionPath,
	sortIndex,
	path,
	engine,
	group,
	isActiveDrag,
}: {
	q: Question;
	questionPath: QuestionPath;
	sortIndex: number;
	path: string;
	engine: FormEngine;
	group: string;
	/** True if this item is the one currently being dragged. */
	isActiveDrag: boolean;
}) {
	const state = engine.getState(path);
	const ctx = useEditContext();
	const cursorMode = useBuilderStore((s) => s.cursorMode);
	const selected = useBuilderStore((s) => s.selected);
	const isEditMode = ctx?.mode === "edit";
	const saveField = useTextEditSave(questionPath);

	// Groups/repeats get Lowest collision priority so their inner container
	// droppable (Low) wins when items are dragged over the content area.
	const isContainer = q.type === "group" || q.type === "repeat";

	/* Disable all per-sortable plugins (OptimisticSortingPlugin, SortableKeyboardPlugin).
	 * We use the controlled state pattern: onDragOver → move() → React state → re-render.
	 * The OptimisticSortingPlugin independently calls move() on sortable instances AND
	 * reorders DOM elements directly, conflicting with React's reconciliation. The two
	 * systems fight: stale indices produce undefined entries in move()'s output, and
	 * the plugin then crashes setting .index on undefined. Disabling the plugin makes
	 * React the sole owner of DOM order. SortableKeyboardPlugin is also excluded since
	 * we only use PointerSensor. */
	const { ref, isDragging } = useSortable({
		id: q.uuid,
		index: sortIndex,
		group,
		type: "question",
		accept: "question",
		disabled: !isEditMode,
		plugins: [],
		...(isContainer && { collisionPriority: CollisionPriority.Lowest }),
	});

	/* Show inline settings panel below the selected question in inspect mode.
	 * Matches by UUID (stable across renames) instead of QuestionPath. */
	const isSelected =
		isEditMode &&
		cursorMode === "edit" &&
		selected?.type === "question" &&
		selected.moduleIndex === (ctx?.moduleIndex ?? -1) &&
		selected.formIndex === (ctx?.formIndex ?? -1) &&
		selected.questionUuid === q.uuid;

	/* Fulfill pending scroll after the panel mounts and the browser paints.
	 * useEffect (not useLayoutEffect) fires after paint — layout is stable and
	 * the browser's smooth-scroll algorithm can interpolate without being
	 * disrupted by concurrent layout shifts. The tradeoff is one painted frame
	 * at the un-scrolled position, but this is imperceptible because the smooth
	 * animation begins immediately after. */
	const engine_ = useBuilderEngine();
	useEffect(() => {
		if (isSelected) {
			engine_.fulfillPendingScroll(q.uuid);
		}
	}, [isSelected, q.uuid, engine_]);

	if (q.type === "hidden" && !isEditMode) return null;
	if (!isEditMode && !state.visible) return null;

	// Use isDragging from dnd-kit OR the context flag (covers cross-group remount where isDragging resets)
	const showAsPlaceholder = isDragging || isActiveDrag;

	// In edit mode: suppress validation display entirely
	const showInvalid = !isEditMode && state.touched && !state.valid;

	// In edit mode (preview): show clean inputs — no values, no validation errors.
	// Engine state is preserved internally for when the user switches back to live.
	const displayState = isEditMode
		? {
				...state,
				value: "",
				touched: false,
				valid: true,
				errorMessage: undefined,
			}
		: state;

	// Build content based on question type
	let content: React.ReactNode;

	if (q.type === "group") {
		content = (
			<EditableQuestionWrapper
				questionPath={questionPath}
				questionUuid={q.uuid}
				isDragging={showAsPlaceholder}
			>
				<GroupField
					question={q}
					path={path}
					questionPath={questionPath}
					engine={engine}
				/>
			</EditableQuestionWrapper>
		);
	} else if (q.type === "repeat") {
		content = (
			<EditableQuestionWrapper
				questionPath={questionPath}
				questionUuid={q.uuid}
				isDragging={showAsPlaceholder}
			>
				<RepeatField
					question={q}
					path={path}
					questionPath={questionPath}
					engine={engine}
				/>
			</EditableQuestionWrapper>
		);
	} else if (q.type === "label") {
		content = (
			<EditableQuestionWrapper
				questionPath={questionPath}
				questionUuid={q.uuid}
				isDragging={showAsPlaceholder}
			>
				<LabelField
					question={q}
					questionPath={questionPath}
					state={displayState}
				/>
			</EditableQuestionWrapper>
		);
	} else if (q.type === "hidden") {
		content = (
			<EditableQuestionWrapper
				questionPath={questionPath}
				questionUuid={q.uuid}
				isDragging={showAsPlaceholder}
			>
				<HiddenField question={q} />
			</EditableQuestionWrapper>
		);
	} else {
		content = (
			<EditableQuestionWrapper
				questionPath={questionPath}
				questionUuid={q.uuid}
				isDragging={showAsPlaceholder}
			>
				{/* Structural wrapper for label + hint + field. Uses a plain div
           instead of <label> to avoid: (1) native focus-forwarding that
           interfered with TextEditable in text mode, and (2) the biome
           noLabelWithoutControl violation from a <label> wrapping deeply
           nested inputs. Each select/input field component handles its own
           label association internally. */}
				<div className="block space-y-1.5">
					{q.label && (
						<div className="flex items-center gap-1">
							<div className="min-w-0 flex-1">
								<TextEditable
									value={q.label}
									onSave={saveField ? (v) => saveField("label", v) : undefined}
									fieldType="label"
								>
									<LabelContent
										label={q.label}
										resolvedLabel={state.resolvedLabel}
										isEditMode={isEditMode}
										className={FIELD_STYLES.label}
									/>
								</TextEditable>
							</div>
							{state.required && (
								<span className="text-nova-rose text-xs shrink-0">*</span>
							)}
						</div>
					)}
					{q.hint && (
						<TextEditable
							value={q.hint}
							onSave={saveField ? (v) => saveField("hint", v) : undefined}
							fieldType="hint"
						>
							<LabelContent
								label={q.hint}
								resolvedLabel={state.resolvedHint}
								isEditMode={isEditMode}
								className={FIELD_STYLES.hint}
							/>
						</TextEditable>
					)}
					<QuestionField
						question={q}
						state={displayState}
						onChange={(value) => engine.setValue(path, value)}
						onBlur={() => engine.touch(path)}
					/>
				</div>
			</EditableQuestionWrapper>
		);
	}

	/* The panel renders OUTSIDE the sortable element (as a sibling, not a child)
	 * so its expanded height doesn't inflate the sortable's collision shape.
	 * If the panel were inside <div ref={ref}>, dnd-kit would see a much taller
	 * element after selection — and when the panel collapses on the next drag
	 * start (deselect), the shape change mid-drag confuses collision detection
	 * for group droppables. Keeping them as siblings means the sortable shape
	 * is always just the question content, stable across selection changes. */
	return (
		<>
			<div
				ref={ref}
				/* In edit mode, InsertionPoints own the inter-question gap (24px
				 * resting height). In interact mode (no InsertionPoints), mb-6
				 * provides the same 24px gap so spacing is identical across modes. */
				className={`relative ${isEditMode ? "" : "mb-6"}`}
				data-invalid={showInvalid ? "true" : undefined}
				data-question-uuid={q.uuid}
			>
				{showAsPlaceholder && (
					<div className="absolute inset-0 rounded-lg border-2 border-dashed border-nova-violet/30 bg-nova-violet/[0.02]" />
				)}
				<div className={showAsPlaceholder ? "invisible" : undefined}>
					{content}
				</div>
			</div>
			{isSelected && ctx && (
				<div data-settings-panel>
					<InlineSettingsPanel question={q} />
				</div>
			)}
		</>
	);
}

// ── FormRenderer ──────────────────────────────────────────────────────

export function FormRenderer({
	questions,
	engine,
	prefix = "/data",
	parentPath,
	parentUuid,
}: FormRendererProps) {
	const ctx = useEditContext();
	const builderEngine = useBuilderEngine();

	const moveQuestion_ = useBuilderStore((s) => s.moveQuestion);
	const isEditMode = ctx?.mode === "edit";
	const isRoot = !parentPath;
	const [dragState, setDragState] = useState<DragReorderState | null>(null);

	/** Group identifier for sortable items at this level.
	 *  Uses the parent question's stable UUID so group keys survive renames.
	 *  Nested levels use the `:container` suffix to match the droppable id in
	 *  GroupField / RepeatField so the `move` helper can route items there. */
	const group = parentUuid ? `${parentUuid}${CONTAINER_SUFFIX}` : ROOT_GROUP;

	// Nested FormRenderers read drag state from context; root uses its own state.
	const dragCtx = useContext(DragReorderContext);
	const activeDragReorder = isRoot ? dragState : dragCtx;

	// Cursor velocity tracking (EMA-smoothed, document-level so EMA is warm before cursor reaches insertion points)
	// Root creates the refs and provides them via CursorSpeedContext; nested instances consume.
	const cursorCtx = useContext(CursorSpeedContext);
	const ownSpeedRef = useRef(0);
	const ownLastRef = useRef<{ x: number; y: number; t: number } | undefined>(
		undefined,
	);
	const cursorSpeedRef = isRoot
		? ownSpeedRef
		: (cursorCtx?.speedRef ?? ownSpeedRef);
	const lastCursorRef = isRoot
		? ownLastRef
		: (cursorCtx?.lastRef ?? ownLastRef);
	useEffect(() => {
		if (!isEditMode || !isRoot) return;
		// Use own refs directly — this effect only runs for the root instance,
		// so ownSpeedRef/ownLastRef are the canonical refs.
		const speedRef = ownSpeedRef;
		const lastRef = ownLastRef;
		const handler = (e: MouseEvent) => {
			const now = performance.now();
			const last = lastRef.current;
			if (last) {
				const dt = now - last.t;
				if (dt > 0) {
					const dx = e.clientX - last.x;
					const dy = e.clientY - last.y;
					const speed = Math.sqrt(dx * dx + dy * dy) / dt;
					// Long gap = cursor was stopped, EMA is stale — reset to raw speed
					speedRef.current =
						dt > GAP_RESET
							? speed
							: EMA_ALPHA * speed + (1 - EMA_ALPHA) * speedRef.current;
				}
			}
			lastRef.current = { x: e.clientX, y: e.clientY, t: now };
		};
		const wheelHandler = (e: WheelEvent) => {
			const now = performance.now();
			const last = lastRef.current;
			if (last) {
				const dt = now - last.t;
				if (dt > 0) {
					// Normalize: deltaMode 0=px, 1=lines (~16px each)
					const pxDelta = Math.abs(e.deltaY) * (e.deltaMode === 1 ? 16 : 1);
					const speed = pxDelta / dt;
					speedRef.current =
						dt > GAP_RESET
							? speed
							: EMA_ALPHA * speed + (1 - EMA_ALPHA) * speedRef.current;
				}
				// Update timestamp so poll knows there's activity; position stays unchanged
				last.t = now;
			}
		};
		document.addEventListener("mousemove", handler);
		document.addEventListener("wheel", wheelHandler, { passive: true });
		return () => {
			document.removeEventListener("mousemove", handler);
			document.removeEventListener("wheel", wheelHandler);
		};
	}, [isEditMode, isRoot]);

	// During drag: render from the controlled items map (reflects cross-group moves).
	// Otherwise: render from the questions prop.
	const visibleQuestions = useMemo(() => {
		if (activeDragReorder) {
			const ids = activeDragReorder.itemsMap[group] ?? [];
			return ids
				.map((id) => activeDragReorder.questionsById.get(id))
				.filter((q): q is Question => !!q);
		}
		// Filter hidden questions in preview mode — nothing to interact with, and
		// skipping them avoids unnecessary useSortable hook execution. In edit mode,
		// hidden questions are visible and draggable.
		const showHidden = isEditMode;
		return showHidden
			? questions
			: questions.filter((q) => q.type !== "hidden");
	}, [questions, activeDragReorder, group, isEditMode]);

	/* Restrict drag overlay to the visible editor viewport. Uses the scroll
	 * container (not the inner content div) so the restriction bounds match
	 * the visible area — the inner content can be taller than the viewport
	 * when scrolled, which would let the overlay escape above the form header. */
	const modifiers = useMemo(
		() => [
			RestrictToElement.configure({
				element: () =>
					document.querySelector<HTMLElement>(
						"[data-preview-scroll-container]",
					),
			}),
		],
		[],
	);

	// For root: search entire tree for the active question (supports nested items).
	const activePath = dragState?.activePath;
	const activeQuestion = activePath
		? findQuestionInTree(questions, qpathId(activePath))
		: undefined;
	const isDragging = !!activePath;

	/* In interact mode inside groups/repeats, pt-6 provides the top inset
	 * that InsertionPoints handle in edit mode. Bottom inset comes from the
	 * last question's mb-6 collapsing through to the container border. */
	const nestedTestPad = !isEditMode && !isRoot ? " pt-6" : "";

	const list = (
		<div className={`min-h-full pointer-events-auto${nestedTestPad}`}>
			{isEditMode && (
				<InsertionPoint
					atIndex={0}
					parentPath={parentPath}
					disabled={isDragging}
					cursorSpeedRef={cursorSpeedRef}
					lastCursorRef={lastCursorRef}
				/>
			)}
			{visibleQuestions.map((q, idx) => {
				const actualIdx = questions.indexOf(q);
				/* During drag, derive questionPath from the UUID→path map (items may
				 * have moved between groups). Outside drag, build from ID + parent. */
				const questionPath = activeDragReorder
					? (activeDragReorder.uuidToPath.get(q.uuid) ??
						qpath(q.id, parentPath))
					: qpath(q.id, parentPath);
				return (
					<Fragment key={q.uuid}>
						<SortableQuestion
							q={q}
							questionPath={questionPath}
							sortIndex={idx}
							path={`${prefix}/${q.id}`}
							engine={engine}
							group={group}
							isActiveDrag={
								!!activeDragReorder && q.uuid === activeDragReorder.activeUuid
							}
						/>
						{isEditMode && (
							<InsertionPoint
								atIndex={actualIdx >= 0 ? actualIdx + 1 : idx + 1}
								parentPath={parentPath}
								disabled={isDragging}
								cursorSpeedRef={cursorSpeedRef}
								lastCursorRef={lastCursorRef}
							/>
						)}
					</Fragment>
				);
			})}
		</div>
	);

	const cursorSpeedCtx = useMemo(
		() => ({ speedRef: cursorSpeedRef, lastRef: lastCursorRef }),
		[cursorSpeedRef, lastCursorRef],
	);

	// Non-edit mode or nested FormRenderers: just render items (no DragDropProvider).
	// Only the root FormRenderer creates the DragDropProvider so items can drag across all levels.
	if (!isEditMode || !isRoot) {
		return list;
	}

	return (
		<CursorSpeedContext.Provider value={cursorSpeedCtx}>
			<DragReorderContext.Provider value={dragState}>
				<DragDropProvider
					sensors={SENSORS}
					modifiers={modifiers}
					onDragStart={(event) => {
						const sourceUuid = event.operation.source?.id as string | undefined;
						if (sourceUuid) {
							setDragState(buildDragState(questions, sourceUuid));
						}
						document.body.style.cursor = "grabbing";
						if (ctx) {
							builderEngine.setDragging(true);
							builderEngine.select();
						}
					}}
					onDragOver={(event) => {
						setDragState((prev) => {
							if (!prev) return prev;
							const newMap = move(prev.itemsMap, event);
							if (newMap === prev.itemsMap) return prev;
							return { ...prev, itemsMap: newMap };
						});
					}}
					onDragEnd={(event) => {
						// Capture state before clearing — dnd-kit fires this during
						// useInsertionEffect where React 19 forbids setState, so defer cleanup.
						const ds = dragState;
						const canceled = event.canceled;

						queueMicrotask(() => {
							setDragState(null);
							document.body.style.cursor = "";
							if (ctx) builderEngine.setDragging(false);

							if (canceled || !ctx || !ds) return;

							const { activeUuid, activePath, itemsMap, uuidToPath } = ds;

							/* Helper: resolve a UUID from the items map to a QuestionPath
							 * for mutation calls. Falls back to the pre-drag path map. */
							const pathOf = (uuid: string): QuestionPath =>
								uuidToPath.get(uuid) ?? ("" as QuestionPath);

							// Find where the item ended up in the controlled items map
							let finalGroup: string | undefined;
							let finalIndex = -1;
							for (const [g, ids] of Object.entries(itemsMap)) {
								const idx = ids.indexOf(activeUuid);
								if (idx !== -1) {
									finalGroup = g;
									finalIndex = idx;
									break;
								}
							}

							if (finalGroup === undefined || finalIndex === -1) return;

							/* Determine the initial group from the dragged question's
							 * parent. The parent UUID is encoded in the container key
							 * for nested questions, or ROOT_GROUP for top-level ones. */
							const draggedParentPath = qpathParent(activePath);
							const draggedParentUuid = draggedParentPath
								? findQuestionInTree(questions, qpathId(draggedParentPath))
										?.uuid
								: undefined;
							const initialGroup = draggedParentUuid
								? `${draggedParentUuid}${CONTAINER_SUFFIX}`
								: ROOT_GROUP;

							const sameGroup = initialGroup === finalGroup;

							// Check if position actually changed
							if (sameGroup) {
								const initialMap = buildDragState(
									questions,
									activeUuid,
								).itemsMap;
								const initialIds = initialMap[initialGroup] ?? [];
								const finalIds = itemsMap[finalGroup] ?? [];
								const initialIdx = initialIds.indexOf(activeUuid);
								if (
									initialIdx === finalIndex &&
									initialIds.length === finalIds.length
								) {
									// No movement — just select
									builderEngine.select({
										type: "question",
										moduleIndex: ctx.moduleIndex,
										formIndex: ctx.formIndex,
										questionPath: activePath,
										questionUuid: activeUuid,
									});
									return;
								}
							}

							/* Resolve the target parent path from the final group key.
							 * Group keys are `${parentUuid}:container` — strip the suffix
							 * to get the parent UUID, then look up its QuestionPath. */
							const finalIds = itemsMap[finalGroup] ?? [];
							const targetParentUuid =
								finalGroup === ROOT_GROUP
									? undefined
									: stripContainerSuffix(finalGroup);
							const targetParentPath = targetParentUuid
								? pathOf(targetParentUuid)
								: undefined;

							let newPath: QuestionPath;

							if (sameGroup) {
								// Same-level reorder — no ID conflict possible
								if (finalIndex === 0) {
									if (finalIds.length > 1) {
										moveQuestion_(ctx.moduleIndex, ctx.formIndex, activePath, {
											beforePath: pathOf(finalIds[1]),
										});
									}
								} else {
									moveQuestion_(ctx.moduleIndex, ctx.formIndex, activePath, {
										afterPath: pathOf(finalIds[finalIndex - 1]),
									});
								}
								newPath = activePath;
							} else {
								// Cross-group transfer — resolve neighbor paths relative
								// to the target parent for correct tree placement.
								let moveResult: MoveQuestionResult;
								if (finalIds.length <= 1) {
									moveResult = moveQuestion_(
										ctx.moduleIndex,
										ctx.formIndex,
										activePath,
										{
											targetParentPath,
										},
									);
								} else if (finalIndex === 0) {
									const nextId = qpathId(pathOf(finalIds[1]));
									const beforePath = qpath(nextId, targetParentPath);
									moveResult = moveQuestion_(
										ctx.moduleIndex,
										ctx.formIndex,
										activePath,
										{
											beforePath,
											targetParentPath,
										},
									);
								} else {
									const prevId = qpathId(pathOf(finalIds[finalIndex - 1]));
									const afterPath = qpath(prevId, targetParentPath);
									moveResult = moveQuestion_(
										ctx.moduleIndex,
										ctx.formIndex,
										activePath,
										{
											afterPath,
											targetParentPath,
										},
									);
								}

								/* If the move triggered an auto-rename to avoid a sibling
								 * ID collision, use the renamed path and notify the user. */
								newPath = moveResult.renamed
									? moveResult.renamed.newPath
									: qpath(qpathId(activePath), targetParentPath);
								if (moveResult.renamed)
									builderEngine.setRenameNotice(moveResult.renamed);
							}

							builderEngine.select({
								type: "question",
								moduleIndex: ctx.moduleIndex,
								formIndex: ctx.formIndex,
								questionPath: newPath,
								questionUuid: activeUuid,
							});
						});
					}}
				>
					{list}
					<DragOverlay>
						{activeQuestion && (
							<div className="rounded-lg bg-nova-surface/80 border border-nova-violet/40 px-3 py-2 shadow-lg text-sm text-nova-text">
								{activeQuestion.label || activeQuestion.id}
							</div>
						)}
					</DragOverlay>
				</DragDropProvider>
			</DragReorderContext.Provider>
		</CursorSpeedContext.Provider>
	);
}
