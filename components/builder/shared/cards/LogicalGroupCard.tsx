// components/builder/shared/cards/LogicalGroupCard.tsx
//
// Renders the logical operators `and` / `or` (multi-clause) and
// `not` (single-clause). Composing through this card is how
// authors stack predicates; drag-and-drop reorders clauses inside
// an and/or group via Atlassian's pragmatic-drag-and-drop, the
// same library the form-list reorder UI uses.
//
// Construction routes through the builders so reductions apply on
// every onChange — `and([single])` collapses to `single`, and
// `not(not(x))` collapses to `x` per the reduction module. The card
// emits the canonical reduced AST; the parent's onChange consumes
// it. Cards can therefore disappear mid-edit when their clause
// list collapses to one — the parent's state replaces the group
// with the unwrapped clause and the next render shows just the
// inner card.

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
import { Icon } from "@iconify/react/offline";
import tablerGripVertical from "@iconify-icons/tabler/grip-vertical";
import tablerPlus from "@iconify-icons/tabler/plus";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/shadcn/button";
import {
	DropdownMenu,
	DropdownMenuItem,
	DropdownMenuPopup,
	DropdownMenuPortal,
	DropdownMenuPositioner,
	DropdownMenuTrigger,
} from "@/components/shadcn/dropdown-menu";
import {
	and,
	matchAll,
	matchNone,
	not,
	or,
	type Predicate,
} from "@/lib/domain/predicate";
import { firstConditionSeed } from "../conditionSeed";
import {
	asDragPayload,
	type ClauseDragData,
	type ClauseDropData,
	readClauseDragData,
	readClauseDropData,
} from "../dragData";
import { usePredicateEditContext } from "../editorContext";
import {
	globalPlaceholderTruth,
	isAuthorablePredicateKind,
	type PredicateCardSchema,
	type PredicateEditContext,
	predicateCardSchemaList,
	predicateCardSchemas,
} from "../editorSchemas";
import { appendKindIndex, appendKindSlot, type EditorPath } from "../path";
import { useStableListIdentity } from "../useStableListIdentity";
import { ChildPredicateEditor } from "./ChildPredicateEditor";

// ── Default-value factories ─────────────────────────────────────────────
//
// Each logical default seeds the group with a non-empty clause list
// so the schema's tuple-with-rest invariant holds and the user
// immediately sees an editable inner card. The reductions in the
// builders WILL collapse `and([single])` → `single` on the next
// onChange — the user adds a second clause to keep the group around.

export function andDefault(
	ctx: PredicateEditContext,
): Extract<Predicate, { kind: "and" }> {
	const inner = firstConditionSeed(ctx);
	const second = firstConditionSeed(ctx);
	if (inner === undefined || second === undefined) {
		// Unreachable from the authoring menu: its applicability gate requires a
		// meaningful seed. Keep the total factory structurally and semantically
		// valid for registry consumers that call it directly.
		return { kind: "and", clauses: [matchAll(), matchAll()] };
	}
	// `and(p1, p2, ...)` resolves through the two-or-more overload
	// to `Extract<Predicate, { kind: "and" }>` directly — the
	// non-reducing path. Both inputs are non-sentinel comparison
	// shapes, so the reductions do not collapse and the envelope
	// shape is the contracted return type.
	return and(inner, second);
}

export function orDefault(
	ctx: PredicateEditContext,
): Extract<Predicate, { kind: "or" }> {
	const a = firstConditionSeed(ctx);
	const b = firstConditionSeed(ctx);
	if (a === undefined || b === undefined) {
		return { kind: "or", clauses: [matchNone(), matchNone()] };
	}
	return or(a, b);
}

export function notDefault(
	ctx: PredicateEditContext,
): Extract<Predicate, { kind: "not" }> {
	// The wrapper flips the truth, so the inner placeholder takes the
	// OPPOSITE polarity: a fresh "Exclude when" at the root of a global
	// slot excludes nothing (not(false) = true) until the author fills it.
	const inner = firstConditionSeed({
		...ctx,
		globalPlaceholderHolds: !globalPlaceholderTruth(ctx),
	});
	if (inner === undefined) return { kind: "not", clause: matchAll() };
	// Route through the builder so the reductions in
	// `lib/domain/predicate/reduction.ts` apply on every
	// construction call (per the file-level JSDoc on
	// `PredicateCardEditor`). The `inner` widens to `Predicate` at
	// the call boundary, which selects the catch-all `not(Predicate)
	// → Extract<Predicate, { kind: "not" }>` overload.
	return not(inner);
}

// ── Card implementation ────────────────────────────────────────────────

interface LogicalGroupCardProps {
	readonly value: Extract<Predicate, { kind: "and" | "or" | "not" }>;
	readonly onChange: (next: Predicate) => void;
	readonly path: EditorPath;
}

export function LogicalGroupCard({
	value,
	onChange,
	path,
}: LogicalGroupCardProps) {
	if (value.kind === "not") {
		return <NotBody value={value} onChange={onChange} path={path} />;
	}
	return <AndOrBody value={value} onChange={onChange} path={path} />;
}

interface NotBodyProps {
	readonly value: Extract<Predicate, { kind: "not" }>;
	readonly onChange: (next: Predicate) => void;
	readonly path: EditorPath;
}

function NotBody({ value, onChange, path }: NotBodyProps) {
	const setClause = (next: Predicate) => {
		// `not(...)` builder applies double-negation elimination and
		// sentinel collapsing; the construction is canonical.
		onChange(not(next));
	};
	return (
		<div>
			<div className="mb-1.5 text-[13px] font-medium text-nova-text-secondary">
				Cases must not match this condition
			</div>
			<ChildPredicateEditor
				value={value.clause}
				onChange={setClause}
				path={appendKindSlot(path, "not", "clause")}
				variant="nested"
			/>
		</div>
	);
}

interface AndOrBodyProps {
	readonly value: Extract<Predicate, { kind: "and" | "or" }>;
	readonly onChange: (next: Predicate) => void;
	readonly path: EditorPath;
}

/**
 * Apply the and/or builder against a non-empty clause array. The
 * builders' two-or-more overload requires at least one rest member,
 * which TS can't prove from a spread of an arbitrary
 * `readonly Predicate[]`. The cast widens `and` / `or` to a single
 * accepting signature; callers guarantee the array is non-empty by
 * construction (the surrounding card collapses an empty clauses
 * list to a sentinel before reaching this helper, and the schema
 * layer rejects an empty list at parse time).
 */
function applyLogical(
	kind: "and" | "or",
	clauses: readonly Predicate[],
): Predicate {
	const builder = kind === "or" ? or : and;
	return (builder as (...args: Predicate[]) => Predicate)(...clauses);
}

function AndOrBody({ value, onChange, path }: AndOrBodyProps) {
	const ctx = usePredicateEditContext();
	// Memoize the editor-context view so the addClause callback's
	// dependency array stays stable across renders. The values
	// driving it (`caseTypes` / `currentCaseType` / `knownInputs`)
	// already come from the editor's React context, which itself
	// memoizes the value object via `useMemo` in the provider.
	const editCtx = useMemo<PredicateEditContext>(
		() => ({
			caseTypes: ctx.caseTypes,
			currentCaseType: ctx.currentCaseType,
			knownInputs: ctx.knownInputs,
			caseDataScope: ctx.caseDataScope,
			// A clause added to THIS group must be neutral for its
			// combinator, so the group's (and therefore the rule's)
			// meaning is unchanged until the author edits the new row.
			globalPlaceholderHolds: value.kind !== "or",
		}),
		[
			ctx.caseTypes,
			ctx.currentCaseType,
			ctx.knownInputs,
			ctx.caseDataScope,
			value.kind,
		],
	);
	const containerKey = useId();
	const rowIdentity = useStableListIdentity(value.clauses);

	// Track per-clause drag state so the editor can render an
	// insertion indicator. Pragmatic DnD's `monitorForElements` is
	// the single owner of the drop logic — same pattern the form
	// virtual list uses.
	const [pendingDrop, setPendingDrop] = useState<{
		itemKey: string;
	} | null>(null);

	// Stash the latest `value.clauses` / `value.kind` / `onChange` in
	// refs so the monitor effect doesn't reinstall on every parent
	// render that produces a new clauses array. The monitor's
	// callbacks read the current ref values at drag-event time. Same
	// pattern `useRowDnd` uses for `renderPreview` — write the ref
	// directly during render so the value is current even before
	// the commit phase, not deferred into an effect. Effect deps
	// shrink to `[containerKey]` — the only value that genuinely
	// identifies a new monitor scope.
	const clausesRef = useRef(value.clauses);
	const rowKeysRef = useRef(rowIdentity.keys);
	const stageIdentityRef = useRef(rowIdentity.stage);
	const kindRef = useRef(value.kind);
	const onChangeRef = useRef(onChange);
	clausesRef.current = value.clauses;
	rowKeysRef.current = rowIdentity.keys;
	stageIdentityRef.current = rowIdentity.stage;
	kindRef.current = value.kind;
	onChangeRef.current = onChange;

	useEffect(() => {
		const cleanup = monitorForElements({
			canMonitor: ({ source }) => {
				const data = readClauseDragData(source.data);
				return data !== undefined && data.nodeKey === containerKey;
			},
			onDrop: ({ source, location }) => {
				setPendingDrop(null);
				const sourceData = readClauseDragData(source.data);
				if (sourceData === undefined || sourceData.nodeKey !== containerKey) {
					return;
				}
				const target = location.current.dropTargets[0];
				if (target === undefined) return;
				const targetData = readClauseDropData(target.data);
				if (targetData === undefined || targetData.nodeKey !== containerKey) {
					return;
				}
				const fromIndex = rowKeysRef.current.indexOf(sourceData.itemKey);
				let toIndex = rowKeysRef.current.indexOf(targetData.itemKey);
				if (fromIndex < 0 || toIndex < 0) return;
				const edge = extractClosestEdge(target.data);
				// Translate the edge into an insertion index — bottom
				// edge inserts after the target row.
				if (edge === "bottom") toIndex += 1;
				// Adjust for the source position being removed before
				// insert — matches Trello-style insertion semantics.
				if (fromIndex < toIndex) toIndex -= 1;
				if (fromIndex === toIndex) return;
				const reordered = [...clausesRef.current];
				const [moved] = reordered.splice(fromIndex, 1);
				reordered.splice(toIndex, 0, moved);
				stageIdentityRef.current(reordered, {
					kind: "move",
					fromIndex,
					toIndex,
				});
				onChangeRef.current(applyLogical(kindRef.current, reordered));
			},
			onDrag: ({ source, location }) => {
				const sourceData = readClauseDragData(source.data);
				if (sourceData === undefined || sourceData.nodeKey !== containerKey) {
					return;
				}
				const target = location.current.dropTargets[0];
				if (target === undefined) {
					setPendingDrop(null);
					return;
				}
				const targetData = readClauseDropData(target.data);
				if (targetData === undefined || targetData.nodeKey !== containerKey) {
					setPendingDrop(null);
					return;
				}
				const edge = extractClosestEdge(target.data);
				const fromIndex = rowKeysRef.current.indexOf(sourceData.itemKey);
				let to = rowKeysRef.current.indexOf(targetData.itemKey);
				if (fromIndex < 0 || to < 0) {
					setPendingDrop(null);
					return;
				}
				if (edge === "bottom") to += 1;
				if (fromIndex < to) to -= 1;
				if (fromIndex === to) {
					setPendingDrop(null);
					return;
				}
				setPendingDrop({ itemKey: sourceData.itemKey });
			},
		});
		return () => cleanup();
	}, [containerKey]);

	const removeClause = useCallback(
		(index: number) => {
			const filtered = value.clauses.filter((_, i) => i !== index);
			rowIdentity.stage(filtered, {
				kind: "splice",
				index,
				deleteCount: 1,
				insertCount: 0,
			});
			if (filtered.length === 0) {
				// All clauses removed — replace the group with the
				// algebraic identity element. AND collapses to
				// match-all (the conjunction identity); OR collapses
				// to match-none (the disjunction identity). Authors
				// then add the first new clause to rebuild.
				onChange(value.kind === "or" ? matchNone() : matchAll());
				return;
			}
			// `or(single)` / `and(single)` collapses to `single` per
			// the reductions — the parent's onChange replaces the
			// group with the unwrapped clause.
			onChange(applyLogical(value.kind, filtered));
		},
		[onChange, rowIdentity, value.clauses, value.kind],
	);

	const updateClause = useCallback(
		(index: number, next: Predicate) => {
			const updated = value.clauses.map((clause, clauseIndex) =>
				clauseIndex === index ? next : clause,
			);
			rowIdentity.stage(updated, { kind: "replace" });
			onChange(applyLogical(value.kind, updated));
		},
		[onChange, rowIdentity, value.clauses, value.kind],
	);

	const addClause = useCallback(
		(schema: PredicateCardSchema<Predicate["kind"]>) => {
			const next = schema.defaultValue(editCtx);
			const clauses = [...value.clauses, next];
			rowIdentity.stage(clauses, {
				kind: "splice",
				index: value.clauses.length,
				deleteCount: 0,
				insertCount: 1,
			});
			onChange(applyLogical(value.kind, clauses));
		},
		[editCtx, onChange, rowIdentity, value.clauses, value.kind],
	);

	return (
		<div className="space-y-2">
			<div className="space-y-1.5">
				{value.clauses.map((clause, i) => (
					<ClauseRow
						key={rowIdentity.keys[i]}
						clause={clause}
						itemKey={rowIdentity.keys[i]}
						clauseIndex={i}
						containerKey={containerKey}
						groupKind={value.kind}
						onChange={(next) => updateClause(i, next)}
						onRemove={() => removeClause(i)}
						path={appendKindIndex(path, value.kind, i)}
						pendingDrop={pendingDrop}
					/>
				))}
			</div>
			<AddClauseMenu onAdd={addClause} />
		</div>
	);
}

interface ClauseRowProps {
	readonly clause: Predicate;
	readonly itemKey: string;
	readonly clauseIndex: number;
	readonly containerKey: string;
	readonly groupKind: "and" | "or";
	readonly onChange: (next: Predicate) => void;
	readonly onRemove: () => void;
	readonly path: EditorPath;
	readonly pendingDrop: { itemKey: string } | null;
}

/** Custom drag preview rendered in place of the browser's default
 *  source snapshot — without it, the browser would snapshot the
 *  14×14 grip icon (the draggable element) and the user couldn't
 *  see what's being moved. The preview shows the matching kind
 *  icon + label so the dragged identity is unambiguous. Mirrors
 *  `DragPreviewPill` in the form-list pattern. */
function ClauseDragPreview({ kind }: { readonly kind: Predicate["kind"] }) {
	const schema = predicateCardSchemas[kind];
	return (
		<div className="inline-flex items-center gap-1.5 rounded-lg border border-nova-violet/40 bg-nova-surface/95 px-3 py-1.5 text-sm text-nova-text shadow-lg backdrop-blur-sm">
			<Icon
				icon={tablerGripVertical}
				width="14"
				height="14"
				className="text-nova-text-muted"
			/>
			<Icon
				icon={schema.icon}
				width="14"
				height="14"
				className="text-nova-violet-bright"
			/>
			<span className="max-w-[240px] truncate">{schema.label}</span>
		</div>
	);
}

/** The preview portal's lifecycle, stored in local state. The card
 *  swaps between `idle` (no drag in flight) and `active` (the
 *  library has created a container the React preview should fill).
 *  Same shape `useRowDnd`'s `PreviewState` uses. */
type PreviewState =
	| { readonly type: "idle" }
	| { readonly type: "active"; readonly container: HTMLElement };

function ClauseRow({
	clause,
	itemKey,
	clauseIndex,
	containerKey,
	groupKind,
	onChange,
	onRemove,
	path,
	pendingDrop,
}: ClauseRowProps) {
	const wrapperRef = useRef<HTMLDivElement>(null);
	// `handleEl` flows into the `useEffect` below as a state
	// dependency so the effect re-runs when the grip mounts /
	// unmounts. Using a useState (rather than a useRef) is the
	// React-19 idiom for "act on a DOM element after it lands":
	// state changes trigger the effect, refs do not.
	const [handleEl, setHandleEl] = useState<HTMLElement | null>(null);
	const [closestEdge, setClosestEdge] = useState<Edge | null>(null);
	const [previewState, setPreviewState] = useState<PreviewState>({
		type: "idle",
	});

	useEffect(() => {
		const wrapper = wrapperRef.current;
		if (wrapper === null) return;

		const dragData: ClauseDragData = {
			kind: "predicate-clause-drag",
			groupKind,
			itemKey,
			clauseIndex,
			nodeKey: containerKey,
		};
		const dropData: ClauseDropData = {
			kind: "predicate-clause-drop",
			groupKind,
			itemKey,
			clauseIndex,
			nodeKey: containerKey,
		};

		// `combine(...)` registers both draggable + drop-target on the
		// same row. The handle element is the drag-trigger; the
		// wrapper is the drop-target hit area. Atlassian's
		// `attachClosestEdge` adds top/bottom edge resolution so the
		// monitor knows whether the drop is above or below the row.
		const cleanup = combine(
			handleEl !== null
				? draggable({
						element: handleEl,
						getInitialData: () => asDragPayload(dragData),
						// Hand the browser an offscreen container to
						// snapshot in place of the 14×14 grip element.
						// React fills the container via the
						// `createPortal` in the JSX returned below; the
						// cleanup callback resets the portal back to
						// idle when the drag ends.
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
					const d = readClauseDragData(source.data);
					return d !== undefined && d.nodeKey === containerKey;
				},
				getData: ({ input, element }) =>
					attachClosestEdge(asDragPayload(dropData), {
						input,
						element,
						allowedEdges: ["top", "bottom"],
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
	}, [clauseIndex, containerKey, groupKind, handleEl, itemKey]);

	// Visual indicator: a violet outline at the closest-edge position
	// during a drag-over. Pinned via `closestEdge` state, cleared on
	// drag leave / drop.
	const indicator =
		closestEdge !== null ? (
			<div
				aria-hidden="true"
				className="absolute left-0 right-0 h-0.5 bg-nova-violet rounded-full"
				style={{
					top: closestEdge === "top" ? -3 : undefined,
					bottom: closestEdge === "bottom" ? -3 : undefined,
				}}
			/>
		) : null;

	// Highlight the row currently being moved during drag.
	const beingMoved = pendingDrop !== null && pendingDrop.itemKey === itemKey;

	// Portal the custom preview into the library-owned container
	// while a drag is in flight. The container lives outside this
	// row's DOM (it sits at document.body via the library), so it
	// never affects layout.
	const previewPortal: ReactNode =
		previewState.type === "active"
			? createPortal(
					<ClauseDragPreview kind={clause.kind} />,
					previewState.container,
				)
			: null;

	return (
		<div
			ref={wrapperRef}
			className={`relative ${beingMoved ? "opacity-50" : ""}`}
		>
			{indicator}
			<ChildPredicateEditor
				value={clause}
				onChange={onChange}
				onRemove={onRemove}
				path={path}
				variant="nested"
				dragHandleRef={setHandleEl}
			/>
			{previewPortal}
		</div>
	);
}

interface AddClauseMenuProps {
	readonly onAdd: (schema: PredicateCardSchema<Predicate["kind"]>) => void;
}

function AddClauseMenu({ onAdd }: AddClauseMenuProps) {
	const triggerRef = useRef<HTMLButtonElement>(null);
	const ctx = usePredicateEditContext();
	const editCtx: PredicateEditContext = {
		caseTypes: ctx.caseTypes,
		currentCaseType: ctx.currentCaseType,
		knownInputs: ctx.knownInputs,
		caseDataScope: ctx.caseDataScope,
	};

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				ref={triggerRef}
				aria-label="Add condition"
				render={
					<Button
						type="button"
						variant="outline"
						size="xl"
						className="w-full gap-2 border-dashed border-white/[0.10] bg-transparent px-3 text-sm text-nova-text-muted not-disabled:hover:border-nova-violet/30 not-disabled:hover:bg-transparent not-disabled:hover:text-nova-violet-bright dark:bg-transparent dark:not-disabled:hover:bg-transparent"
					/>
				}
			>
				<Icon icon={tablerPlus} width="14" height="14" />
				<span>Add condition</span>
			</DropdownMenuTrigger>
			<DropdownMenuPortal>
				<DropdownMenuPositioner
					side="bottom"
					align="start"
					sideOffset={4}
					anchor={triggerRef}
					style={{ minWidth: "18rem", maxHeight: 320 }}
				>
					<DropdownMenuPopup className="max-h-80 min-w-0">
						{predicateCardSchemaList
							.filter((s) => isAuthorablePredicateKind(s.kind))
							.map((s) => {
								const isApplicable = s.applicable(editCtx);
								return (
									<DropdownMenuItem
										key={s.kind}
										onClick={() => onAdd(s)}
										disabled={!isApplicable}
									>
										<Icon
											icon={s.icon}
											width="14"
											height="14"
											className="text-nova-text-muted"
										/>
										<span className="flex-1 text-left min-w-0">
											<div className="break-words">{s.label}</div>
											<div className="break-words text-xs text-nova-text-muted">
												{s.description}
											</div>
										</span>
									</DropdownMenuItem>
								);
							})}
					</DropdownMenuPopup>
				</DropdownMenuPositioner>
			</DropdownMenuPortal>
		</DropdownMenu>
	);
}
