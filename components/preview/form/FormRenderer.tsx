/**
 * FormRenderer — UUID-based rendering with per-entity subscriptions.
 *
 * Instead of receiving an assembled `Question[]` tree from FormScreen,
 * FormRenderer subscribes to `questionOrder[parentEntityId]` for the ordered
 * list of question UUIDs at this nesting level. Each SortableQuestion
 * subscribes to `s.questions[uuid]` for its own entity data. This means:
 *
 * - Editing question A only re-renders SortableQuestion(A) — not B, C, D.
 * - Adding/removing/reordering questions re-renders FormRenderer (UUID list
 *   changed) but not unaffected SortableQuestions.
 * - The FormEngine is read from context, not passed as props. Engine state
 *   changes (test-mode values, validation) trigger SortableQuestion re-renders
 *   via `useEngineState`, not via prop cascades.
 *
 * Drag-and-drop state is built from the store imperatively in `onDragStart` —
 * no reactive subscription to entity maps during drag.
 */
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
	memo,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { InlineSettingsPanel } from "@/components/builder/InlineSettingsPanel";
import {
	useBuilderEngine,
	useBuilderStore,
	useIsQuestionSelected,
} from "@/hooks/useBuilder";
import { useEditContext } from "@/hooks/useEditContext";
import { useEngineController, useEngineState } from "@/hooks/useFormEngine";
import { useTextEditSave } from "@/hooks/useTextEditSave";
import { LabelContent } from "@/lib/references/LabelContent";
import type { MoveQuestionResult } from "@/lib/services/builderStore";
import type { NQuestion } from "@/lib/services/normalizedState";
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

/** Stable empty array for UUID selectors that return no children. Prevents
 *  new array allocations on every render for leaf-level FormRenderers. */
const EMPTY_UUIDS: string[] = [];

// ── Drag state ───────────────────────────────────────────────────────────

interface DragReorderState {
	/** Group → ordered question UUIDs. Updated by `move` helper during drag. */
	itemsMap: Record<string, string[]>;
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

/** Sensor config: 5px distance to distinguish click from drag. */
const SENSORS = [
	PointerSensor.configure({
		activationConstraints: [
			new PointerActivationConstraints.Distance({ value: 5 }),
		],
	}),
];

/**
 * Build controlled drag state from the store's normalized entity maps.
 *
 * Walks the `questionOrder` tree to build an items map (group → ordered UUIDs)
 * and a UUID → QuestionPath reverse map for mutation calls. Called imperatively
 * in `onDragStart` — no reactive subscription to entity maps during drag.
 */
function buildDragStateFromStore(
	questions: Record<string, NQuestion>,
	questionOrder: Record<string, string[]>,
	parentEntityId: string,
	activeUuid: string,
): DragReorderState {
	const itemsMap: Record<string, string[]> = {};
	const uuidToPath = new Map<string, QuestionPath>();

	function walk(parentId: string, groupKey: string, pathPrefix: string) {
		const childUuids = questionOrder[parentId] ?? [];
		itemsMap[groupKey] = [...childUuids];
		for (const uuid of childUuids) {
			const q = questions[uuid];
			if (!q) continue;
			const qPath = pathPrefix ? `${pathPrefix}/${q.id}` : q.id;
			uuidToPath.set(uuid, qPath as QuestionPath);
			if (q.type === "group" || q.type === "repeat") {
				walk(uuid, `${uuid}${CONTAINER_SUFFIX}`, qPath);
			}
		}
	}
	walk(parentEntityId, ROOT_GROUP, "");

	const activePath = uuidToPath.get(activeUuid) ?? ("" as QuestionPath);
	return { itemsMap, uuidToPath, activeUuid, activePath };
}

/** Strip the :container suffix to recover the actual QuestionPath. */
function stripContainerSuffix(group: string): string {
	return group.endsWith(CONTAINER_SUFFIX)
		? group.slice(0, -CONTAINER_SUFFIX.length)
		: group;
}

// ── SortableQuestion ──────────────────────────────────────────────────

/**
 * Renders a single question in the form preview. Subscribes to its own
 * entity in the builder store (`s.questions[uuid]`) and engine state via
 * `useEngineState`. Only re-renders when THIS question's entity or engine
 * state changes — not when other questions in the form change.
 */
function SortableQuestion({
	uuid,
	sortIndex,
	prefix,
	parentPath,
	group,
	isActiveDrag,
}: {
	uuid: string;
	sortIndex: number;
	/** XForm data path prefix (e.g. "/data" or "/data/group_id"). */
	prefix: string;
	parentPath?: QuestionPath;
	group: string;
	/** True if this item is the one currently being dragged. */
	isActiveDrag: boolean;
}) {
	/* Subscribe to this question's entity — only re-renders when THIS entity
	 * changes. Other questions in the same form don't trigger a re-render
	 * because Immer structural sharing keeps unchanged entity references stable. */
	const q = useBuilderStore((s) => s.questions[uuid]);

	/* Derive paths from the entity's ID. These are stable as long as the
	 * question hasn't been renamed. */
	const qId = q?.id ?? "";
	const path = `${prefix}/${qId}`;
	const questionPath = qpath(qId, parentPath);

	/* Subscribe to this question's runtime state by UUID. The EngineController's
	 * Zustand store is keyed by UUID — aligned with the blueprint store. Only
	 * re-renders when THIS question's computed state changes (visibility,
	 * required, value, validation). */
	const state = useEngineState(uuid);
	const controller = useEngineController();

	const ctx = useEditContext();
	const cursorMode = useBuilderStore((s) => s.cursorMode);
	const isEditMode = ctx?.mode === "edit";
	const saveField = useTextEditSave(questionPath);

	/* Boolean selector — returns true only for the one selected question.
	 * When selection changes, only the old and new selected components
	 * re-render (true→false, false→true). All other SortableQuestions stay
	 * false→false and skip re-rendering via Object.is. */
	const isQuestionSelected = useIsQuestionSelected(
		ctx?.moduleIndex ?? -1,
		ctx?.formIndex ?? -1,
		uuid,
	);
	const isSelected = isEditMode && cursorMode === "edit" && isQuestionSelected;

	// Groups/repeats get Lowest collision priority so their inner container
	// droppable (Low) wins when items are dragged over the content area.
	const isContainer = q?.type === "group" || q?.type === "repeat";

	/* Disable all per-sortable plugins (OptimisticSortingPlugin, SortableKeyboardPlugin).
	 * We use the controlled state pattern: onDragOver → move() → React state → re-render.
	 * The OptimisticSortingPlugin independently calls move() on sortable instances AND
	 * reorders DOM elements directly, conflicting with React's reconciliation. */
	const { ref, isDragging } = useSortable({
		id: uuid,
		index: sortIndex,
		group,
		type: "question",
		accept: "question",
		disabled: !isEditMode,
		plugins: [],
		...(isContainer && { collisionPriority: CollisionPriority.Lowest }),
	});

	/* Fulfill pending scroll after the panel mounts and the browser paints. */
	const builderEngine = useBuilderEngine();
	useEffect(() => {
		if (isSelected) {
			builderEngine.fulfillPendingScroll(uuid);
		}
	}, [isSelected, uuid, builderEngine]);

	if (!q) return null;
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
				questionUuid={uuid}
				isDragging={showAsPlaceholder}
			>
				<GroupField question={q} path={path} questionPath={questionPath} />
			</EditableQuestionWrapper>
		);
	} else if (q.type === "repeat") {
		content = (
			<EditableQuestionWrapper
				questionPath={questionPath}
				questionUuid={uuid}
				isDragging={showAsPlaceholder}
			>
				<RepeatField question={q} path={path} questionPath={questionPath} />
			</EditableQuestionWrapper>
		);
	} else if (q.type === "label") {
		content = (
			<EditableQuestionWrapper
				questionPath={questionPath}
				questionUuid={uuid}
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
				questionUuid={uuid}
				isDragging={showAsPlaceholder}
			>
				<HiddenField question={q} />
			</EditableQuestionWrapper>
		);
	} else {
		content = (
			<EditableQuestionWrapper
				questionPath={questionPath}
				questionUuid={uuid}
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
						onChange={(value) => controller.onValueChange(uuid, value)}
						onBlur={() => controller.onTouch(uuid)}
					/>
				</div>
			</EditableQuestionWrapper>
		);
	}

	/* The panel renders OUTSIDE the sortable element (as a sibling, not a child)
	 * so its expanded height doesn't inflate the sortable's collision shape. */
	return (
		<>
			<div
				ref={ref}
				/* In edit mode, InsertionPoints own the inter-question gap (24px
				 * resting height). In interact mode (no InsertionPoints), mb-6
				 * provides the same 24px gap so spacing is identical across modes. */
				className={`relative ${isEditMode ? "" : "mb-6"}`}
				data-invalid={showInvalid ? "true" : undefined}
				data-question-uuid={uuid}
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

interface FormRendererProps {
	/** Entity ID that owns questions at this level — formId for root,
	 *  parent group/repeat UUID for nested levels. */
	parentEntityId: string;
	/** XForm data path prefix. Defaults to "/data" for root. */
	prefix?: string;
	/** Blueprint question path of the parent (for nested FormRenderers). */
	parentPath?: QuestionPath;
}

/**
 * Renders an ordered list of questions at one nesting level.
 *
 * Subscribes to `questionOrder[parentEntityId]` for the UUID list — only
 * re-renders when questions are added, removed, or reordered at this level.
 * Individual question content changes are handled by SortableQuestion's
 * per-entity subscriptions.
 *
 * Wrapped in React.memo because its props are stable primitives (parentEntityId,
 * prefix, parentPath). When the parent re-renders (e.g., FormScreen due to
 * engine schema update), memo bails out since the props haven't changed.
 */
export const FormRenderer = memo(function FormRenderer({
	parentEntityId,
	prefix = "/data",
	parentPath,
}: FormRendererProps) {
	const ctx = useEditContext();
	const builderEngine = useBuilderEngine();

	const moveQuestion_ = useBuilderStore((s) => s.moveQuestion);
	const isEditMode = ctx?.mode === "edit";
	const isRoot = !parentPath;
	const [dragState, setDragState] = useState<DragReorderState | null>(null);

	/** Subscribe to the question UUID order for this level. Stable reference
	 *  when order hasn't changed — Immer structural sharing on the array. */
	const questionUuids = useBuilderStore(
		(s) => s.questionOrder[parentEntityId] ?? EMPTY_UUIDS,
	);

	/** Group identifier for sortable items at this level.
	 *  Uses the parent entity ID — for nested levels this is the parent
	 *  question's UUID with `:container` suffix to match droppable IDs. */
	const group = parentPath
		? `${parentEntityId}${CONTAINER_SUFFIX}`
		: ROOT_GROUP;

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
					const pxDelta = Math.abs(e.deltaY) * (e.deltaMode === 1 ? 16 : 1);
					const speed = pxDelta / dt;
					speedRef.current =
						dt > GAP_RESET
							? speed
							: EMA_ALPHA * speed + (1 - EMA_ALPHA) * speedRef.current;
				}
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

	/* During drag: render from the reordered items map (reflects cross-group
	 * moves). Outside drag: render from the store's question order. */
	const orderedUuids = useMemo(() => {
		if (activeDragReorder) {
			return activeDragReorder.itemsMap[group] ?? [];
		}
		return questionUuids;
	}, [activeDragReorder, group, questionUuids]);

	/* Restrict drag overlay to the visible editor viewport. */
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

	const activePath = dragState?.activePath;
	const isDragging = !!activePath;

	/* Read the active question's label for the drag overlay. Subscribes to
	 * just the single active entity — not the entire questions map. */
	const activeUuid = dragState?.activeUuid;
	const activeLabel = useBuilderStore((s) => {
		if (!activeUuid) return undefined;
		const q = s.questions[activeUuid];
		return q ? q.label || q.id : undefined;
	});

	/* In interact mode inside groups/repeats, pt-6 provides the top inset
	 * that InsertionPoints handle in edit mode. Bottom inset comes from the
	 * last question's mb-6, contained by the parent's flow-root BFC. */
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
			{orderedUuids.map((uuid, idx) => (
				<Fragment key={uuid}>
					<SortableQuestion
						uuid={uuid}
						sortIndex={idx}
						prefix={prefix}
						parentPath={parentPath}
						group={group}
						isActiveDrag={
							!!activeDragReorder && uuid === activeDragReorder.activeUuid
						}
					/>
					{isEditMode && (
						<InsertionPoint
							atIndex={idx + 1}
							parentPath={parentPath}
							disabled={isDragging}
							cursorSpeedRef={cursorSpeedRef}
							lastCursorRef={lastCursorRef}
						/>
					)}
				</Fragment>
			))}
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
							/* Read entity maps imperatively from the store — no reactive
							 * subscription. Drag state is a snapshot, not a live view. */
							const s = builderEngine.store.getState();
							setDragState(
								buildDragStateFromStore(
									s.questions,
									s.questionOrder,
									parentEntityId,
									sourceUuid,
								),
							);
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

							const {
								activeUuid: dragUuid,
								activePath: dragPath,
								itemsMap,
								uuidToPath,
							} = ds;

							/* Helper: resolve a UUID from the items map to a QuestionPath
							 * for mutation calls. Falls back to the pre-drag path map. */
							const pathOf = (u: string): QuestionPath =>
								uuidToPath.get(u) ?? ("" as QuestionPath);

							// Find where the item ended up in the controlled items map
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

							if (finalGroup === undefined || finalIndex === -1) return;

							/* Determine the initial group from the dragged question's
							 * parent. The parent UUID is encoded in the container key
							 * for nested questions, or ROOT_GROUP for top-level ones. */
							const draggedParentPath = qpathParent(dragPath);
							const draggedParentUuid = draggedParentPath
								? (() => {
										/* Look up the parent question's UUID from the store
										 * by finding the question whose id matches the
										 * last segment of the parent path. */
										const parentId = qpathId(draggedParentPath);
										for (const [u, p] of uuidToPath.entries()) {
											if (qpathId(p) === parentId) return u;
										}
										return undefined;
									})()
								: undefined;
							const initialGroup = draggedParentUuid
								? `${draggedParentUuid}${CONTAINER_SUFFIX}`
								: ROOT_GROUP;

							const sameGroup = initialGroup === finalGroup;

							// Check if position actually changed
							if (sameGroup) {
								const initialState = buildDragStateFromStore(
									builderEngine.store.getState().questions,
									builderEngine.store.getState().questionOrder,
									parentEntityId,
									dragUuid,
								);
								const initialIds = initialState.itemsMap[initialGroup] ?? [];
								const finalIds = itemsMap[finalGroup] ?? [];
								const initialIdx = initialIds.indexOf(dragUuid);
								if (
									initialIdx === finalIndex &&
									initialIds.length === finalIds.length
								) {
									// No movement — just select
									builderEngine.select({
										type: "question",
										moduleIndex: ctx.moduleIndex,
										formIndex: ctx.formIndex,
										questionPath: dragPath,
										questionUuid: dragUuid,
									});
									return;
								}
							}

							/* Resolve the target parent path from the final group key. */
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
										moveQuestion_(ctx.moduleIndex, ctx.formIndex, dragPath, {
											beforePath: pathOf(finalIds[1]),
										});
									}
								} else {
									moveQuestion_(ctx.moduleIndex, ctx.formIndex, dragPath, {
										afterPath: pathOf(finalIds[finalIndex - 1]),
									});
								}
								newPath = dragPath;
							} else {
								// Cross-group transfer — resolve neighbor paths relative
								// to the target parent for correct tree placement.
								let moveResult: MoveQuestionResult;
								if (finalIds.length <= 1) {
									moveResult = moveQuestion_(
										ctx.moduleIndex,
										ctx.formIndex,
										dragPath,
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
										dragPath,
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
										dragPath,
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
									: qpath(qpathId(dragPath), targetParentPath);
								if (moveResult.renamed)
									builderEngine.setRenameNotice(moveResult.renamed);
							}

							builderEngine.select({
								type: "question",
								moduleIndex: ctx.moduleIndex,
								formIndex: ctx.formIndex,
								questionPath: newPath,
								questionUuid: dragUuid,
							});
						});
					}}
				>
					{list}
					<DragOverlay>
						{activeLabel && (
							<div className="rounded-lg bg-nova-surface/80 border border-nova-violet/40 px-3 py-2 shadow-lg text-sm text-nova-text">
								{activeLabel}
							</div>
						)}
					</DragOverlay>
				</DragDropProvider>
			</DragReorderContext.Provider>
		</CursorSpeedContext.Provider>
	);
});
