// components/builder/case-list-config/cards/LogicalGroupCard.tsx
//
// Renders the logical operators `and` / `or` (multi-clause) and
// `not` (single-clause). Composing through this card is how
// authors stack predicates; drag-and-drop reorders clauses inside
// an and/or group via Atlassian's pragmatic-drag-and-drop (the
// same library the form-list reorder UI uses, per
// `components/builder/CLAUDE.md` § "Drag-and-drop").
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
import {
	attachClosestEdge,
	type Edge,
	extractClosestEdge,
} from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge";
import { Menu } from "@base-ui/react/menu";
import { Icon } from "@iconify/react/offline";
import tablerPlus from "@iconify-icons/tabler/plus";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	and,
	matchAll,
	matchNone,
	not,
	or,
	type Predicate,
} from "@/lib/domain/predicate";
import {
	MENU_ITEM_CLS,
	MENU_POPUP_CLS,
	MENU_POSITIONER_CLS,
} from "@/lib/styles";
import { usePredicateEditContext } from "../editorContext";
import {
	type PredicateCardSchema,
	type PredicateEditContext,
	predicateCardSchemaList,
	predicateCardSchemas,
} from "../editorSchemas";
import { nodeId } from "../nodeIdentity";
import { appendKindIndex, appendKindSlot, type EditorPath } from "../path";
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
	const inner = predicateCardSchemas.eq.defaultValue(ctx);
	const second = predicateCardSchemas.eq.defaultValue(ctx);
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
	const a = predicateCardSchemas.eq.defaultValue(ctx);
	const b = predicateCardSchemas.eq.defaultValue(ctx);
	return or(a, b);
}

export function notDefault(
	ctx: PredicateEditContext,
): Extract<Predicate, { kind: "not" }> {
	const inner = predicateCardSchemas.eq.defaultValue(ctx);
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
			<div className="text-[10px] text-nova-text-muted/70 uppercase tracking-wider mb-1.5">
				Inverts the inner clause
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
 * variadic-with-required-first builder signature can't accept a
 * direct rest-spread of a `Predicate[]` (TS doesn't know whether
 * the rest is empty at the call site, and the two-or-more overload
 * requires at least one rest member). Routing the array through
 * `Reflect.apply` against the builder bypasses the overload
 * resolution and trusts the runtime guarantee that the builder
 * accepts any non-empty Predicate list — the schema layer rejects
 * the empty case.
 */
function applyLogical(
	kind: "and" | "or",
	clauses: readonly Predicate[],
): Predicate {
	const builder = kind === "or" ? or : and;
	return (builder as (...args: Predicate[]) => Predicate)(...clauses);
}

interface ClauseDragData {
	readonly kind: "predicate-clause-drag";
	readonly groupKind: "and" | "or";
	readonly clauseIndex: number;
	readonly nodeKey: string;
}

interface ClauseDropData {
	readonly kind: "predicate-clause-drop";
	readonly groupKind: "and" | "or";
	readonly clauseIndex: number;
	readonly nodeKey: string;
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
		}),
		[ctx.caseTypes, ctx.currentCaseType, ctx.knownInputs],
	);
	const containerKey = nodeId(value);

	// Track per-clause drag state so the editor can render an
	// insertion indicator. Pragmatic DnD's `monitorForElements` is
	// the single owner of the drop logic — same pattern the form
	// virtual list uses.
	const [pendingDrop, setPendingDrop] = useState<{
		fromIndex: number;
		toIndex: number;
	} | null>(null);

	useEffect(() => {
		const cleanup = monitorForElements({
			canMonitor: ({ source }) => {
				const data = source.data as Partial<ClauseDragData>;
				return (
					data.kind === "predicate-clause-drag" && data.nodeKey === containerKey
				);
			},
			onDrop: ({ source, location }) => {
				setPendingDrop(null);
				const sourceData = source.data as Partial<ClauseDragData>;
				if (
					sourceData.kind !== "predicate-clause-drag" ||
					sourceData.nodeKey !== containerKey ||
					sourceData.clauseIndex === undefined
				) {
					return;
				}
				const target = location.current.dropTargets[0];
				if (target === undefined) return;
				const targetData = target.data as Partial<ClauseDropData>;
				if (
					targetData.kind !== "predicate-clause-drop" ||
					targetData.nodeKey !== containerKey ||
					targetData.clauseIndex === undefined
				) {
					return;
				}
				const fromIndex = sourceData.clauseIndex;
				let toIndex = targetData.clauseIndex;
				const edge = extractClosestEdge(target.data);
				// Translate the edge into an insertion index — bottom
				// edge inserts after the target row.
				if (edge === "bottom") toIndex += 1;
				// Adjust for the source position being removed before
				// insert — matches Trello-style insertion semantics.
				if (fromIndex < toIndex) toIndex -= 1;
				if (fromIndex === toIndex) return;
				const reordered = [...value.clauses];
				const [moved] = reordered.splice(fromIndex, 1);
				reordered.splice(toIndex, 0, moved);
				onChange(applyLogical(value.kind, reordered));
			},
			onDrag: ({ source, location }) => {
				const sourceData = source.data as Partial<ClauseDragData>;
				if (
					sourceData.kind !== "predicate-clause-drag" ||
					sourceData.nodeKey !== containerKey ||
					sourceData.clauseIndex === undefined
				) {
					return;
				}
				const target = location.current.dropTargets[0];
				if (target === undefined) {
					setPendingDrop(null);
					return;
				}
				const targetData = target.data as Partial<ClauseDropData>;
				if (
					targetData.kind !== "predicate-clause-drop" ||
					targetData.nodeKey !== containerKey ||
					targetData.clauseIndex === undefined
				) {
					setPendingDrop(null);
					return;
				}
				const edge = extractClosestEdge(target.data);
				let to = targetData.clauseIndex;
				if (edge === "bottom") to += 1;
				if (sourceData.clauseIndex < to) to -= 1;
				if (sourceData.clauseIndex === to) {
					setPendingDrop(null);
					return;
				}
				setPendingDrop({ fromIndex: sourceData.clauseIndex, toIndex: to });
			},
		});
		return () => cleanup();
	}, [containerKey, onChange, value.clauses, value.kind]);

	const removeClause = useCallback(
		(index: number) => {
			const filtered = value.clauses.filter((_, i) => i !== index);
			if (filtered.length === 0) {
				// All clauses removed — replace the group with the
				// algebraic identity / absorbing element. AND collapses
				// to match-all (the conjunction identity); OR collapses
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
		[onChange, value.clauses, value.kind],
	);

	const updateClause = useCallback(
		(index: number, next: Predicate) => {
			const updated = value.clauses.map((c, i) => (i === index ? next : c));
			onChange(applyLogical(value.kind, updated));
		},
		[onChange, value.clauses, value.kind],
	);

	const addClause = useCallback(
		(schema: PredicateCardSchema<Predicate["kind"]>) => {
			const next = schema.defaultValue(editCtx);
			onChange(applyLogical(value.kind, [...value.clauses, next]));
		},
		[editCtx, onChange, value.clauses, value.kind],
	);

	return (
		<div className="space-y-2">
			<div className="space-y-1.5">
				{value.clauses.map((clause, i) => (
					<ClauseRow
						key={nodeId(clause as object)}
						clause={clause}
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
	readonly clauseIndex: number;
	readonly containerKey: string;
	readonly groupKind: "and" | "or";
	readonly onChange: (next: Predicate) => void;
	readonly onRemove: () => void;
	readonly path: EditorPath;
	readonly pendingDrop: { fromIndex: number; toIndex: number } | null;
}

function ClauseRow({
	clause,
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

	useEffect(() => {
		const wrapper = wrapperRef.current;
		if (wrapper === null) return;

		const dragData: ClauseDragData = {
			kind: "predicate-clause-drag",
			groupKind,
			clauseIndex,
			nodeKey: containerKey,
		};
		const dropData: ClauseDropData = {
			kind: "predicate-clause-drop",
			groupKind,
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
						getInitialData: () =>
							dragData as unknown as Record<string, unknown>,
					})
				: () => {},
			dropTargetForElements({
				element: wrapper,
				canDrop: ({ source }) => {
					const d = source.data as Partial<ClauseDragData>;
					return (
						d.kind === "predicate-clause-drag" && d.nodeKey === containerKey
					);
				},
				getData: ({ input, element }) =>
					attachClosestEdge(dropData as unknown as Record<string, unknown>, {
						input,
						element,
						allowedEdges: ["top", "bottom"],
					}) as Record<string | symbol, unknown>,
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
	}, [clauseIndex, containerKey, groupKind, handleEl]);

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
	const beingMoved =
		pendingDrop !== null && pendingDrop.fromIndex === clauseIndex;

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
	};

	return (
		<Menu.Root>
			<Menu.Trigger
				ref={triggerRef}
				className="inline-flex items-center gap-1.5 px-2 py-1.5 text-[11px] rounded-md border border-dashed border-white/[0.10] text-nova-text-muted/80 hover:text-nova-violet-bright hover:border-nova-violet/30 transition-colors cursor-pointer"
				aria-label="Add clause"
			>
				<Icon icon={tablerPlus} width="11" height="11" />
				<span>Add clause</span>
			</Menu.Trigger>
			<Menu.Portal>
				<Menu.Positioner
					side="bottom"
					align="start"
					sideOffset={4}
					anchor={triggerRef}
					className={MENU_POSITIONER_CLS}
					style={{ maxHeight: 320 }}
				>
					<Menu.Popup
						className={`${MENU_POPUP_CLS} max-h-80 overflow-y-auto min-w-[18rem]`}
					>
						{predicateCardSchemaList.map((s, i) => {
							const isApplicable = s.applicable(editCtx);
							const last = predicateCardSchemaList.length - 1;
							const corners =
								i === 0 && i === last
									? "rounded-xl"
									: i === 0
										? "rounded-t-xl"
										: i === last
											? "rounded-b-xl"
											: "";
							const cls = [
								corners,
								MENU_ITEM_CLS,
								isApplicable ? "" : "opacity-40",
							].join(" ");
							return (
								<Menu.Item
									key={s.kind}
									onClick={() => onAdd(s)}
									disabled={!isApplicable}
									className={cls}
								>
									<Icon
										icon={s.icon}
										width="14"
										height="14"
										className="text-nova-text-muted"
									/>
									<span className="flex-1 text-left min-w-0">
										<div className="truncate">{s.label}</div>
										<div className="text-[10px] text-nova-text-muted truncate">
											{s.description}
										</div>
									</span>
								</Menu.Item>
							);
						})}
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	);
}
