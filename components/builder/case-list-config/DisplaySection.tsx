// components/builder/case-list-config/DisplaySection.tsx
//
// Composes the case-list authoring surface's Display section. Owns
// `caseListConfig.columns` — the unified column list that carries
// display + sort + calc + visibility on each column. Two
// affordances mount above the column list:
//
//   - **Sort priority pill stack** — read-only ordered list of the
//     sorted columns in priority order. Surfaces the sort hierarchy
//     at-a-glance and lets the user drag to reorder priority. The
//     drag emits a new `priority` assignment on each affected column.
//   - **Live preview** — Postgres-backed table showing the current
//     case list with the authored sort, visibility filtering, and
//     calculated-column evaluation applied.
//
// Section ownership:
//
//   - **Display section (this file):** `caseListConfig.columns`.
//   - **Filters section (`FiltersSection`, separate file):**
//     `caseListConfig.filter`.
//   - **Search Inputs section (`SearchInputsSection`, separate file):**
//     `caseListConfig.searchInputs`.
//
// Section boundaries are explicit in the public contract:
// `DisplaySectionProps.value` is the full `CaseListConfig`, but this
// section only ever mutates the `columns` slot. The `filter` /
// `searchInputs` slots flow through verbatim — a parent composing
// the full panel mounts both this section and the Filters section
// against the same `CaseListConfig` source-of-truth, so each
// section's edits compose cleanly.
//
// Validity propagation: the section reflects the column list's
// inner-validity aggregation. The live-preview panel reads the
// same combined flag — when invalid, the preview falls back to a
// "preview paused — fix errors above" state rather than firing
// the Server Action against a malformed AST.

"use client";
import { Icon } from "@iconify/react/offline";
import tablerArrowsSort from "@iconify-icons/tabler/arrows-sort";
import tablerColumns from "@iconify-icons/tabler/columns";
import tablerEye from "@iconify-icons/tabler/eye";
import tablerGripVertical from "@iconify-icons/tabler/grip-vertical";
import tablerPlus from "@iconify-icons/tabler/plus";
import tablerSortAscending from "@iconify-icons/tabler/sort-ascending";
import tablerSortDescending from "@iconify-icons/tabler/sort-descending";
import tablerTrash from "@iconify-icons/tabler/trash";
import { useId, useMemo, useState } from "react";
import {
	type CaseListConfig,
	type CaseType,
	type Column,
	type ColumnSort,
	plainColumn,
} from "@/lib/domain";
import type { SearchInputDecl } from "@/lib/domain/predicate";
import { ColumnEditor } from "./ColumnEditor";
import { DisplayPreview } from "./DisplayPreview";
import {
	useInnerValidityShadow,
	useValidityPropagator,
} from "./useInnerValidityShadow";
import { ReorderableRow, useReorderableList } from "./useReorderableList";
import { newUuid } from "./uuid";

// ── Public types ──────────────────────────────────────────────────

export interface DisplaySectionProps {
	/** The current full case-list configuration. The Display section
	 *  reads `columns` and only emits changes to that slot; `filter`
	 *  / `searchInputs` flow through unchanged. */
	readonly value: CaseListConfig;
	/** Fired with the next configuration. The parent applies the
	 *  next config to its source-of-truth (typically the doc store's
	 *  module slot). */
	readonly onChange: (next: CaseListConfig) => void;
	/** Blueprint case-type definitions — drives every sub-editor's
	 *  property picker. */
	readonly caseTypes: readonly CaseType[];
	/** The case-type the case list reads against. The Display
	 *  section's column editors all resolve property references
	 *  against this scope; nested relation walks inside calculated-
	 *  column expressions flip the destination scope as authored. */
	readonly currentCaseType: string;
	/** Search-input declarations from the parent screen. Threaded
	 *  into calculated-column expressions so an `input(...)` term
	 *  resolves the binding name. */
	readonly knownInputs?: readonly SearchInputDecl[];
	/** The live preview's case-store query is scoped by appId. */
	readonly appId: string;
	/** Aggregated validity verdict — true iff every column reports
	 *  valid. Parent gates its save affordance on this. */
	readonly onValidityChange?: (valid: boolean) => void;
}

// ── Top-level component ───────────────────────────────────────────

/**
 * Composes the case-list Display section. One column list (the
 * unified `columns` array) plus the sort priority pill stack and
 * the live-preview panel. Sort and calc are no longer separate
 * sub-sections — sort is per-column on the column itself, calc is
 * a column kind.
 *
 * Validity propagation: the column list aggregates per-row inner
 * verdicts (kind-vs-property applicability + calc-arm
 * `ExpressionCardEditor` validity) and fires onValidityChange. This
 * section stashes the column-list verdict, propagates the same
 * verdict up to the workspace (so the save affordance gates), AND
 * threads it into `DisplayPreview` as `configValid` so the preview
 * suppresses its case-store load while the column list is invalid.
 *
 * Skipping the gate would let an invalid calculated-column
 * expression flow into `compileExpression` at the SQL layer, where
 * it would throw and surface a raw error arm to the user — the
 * structural defense the preview's file header pins. Mirrors
 * `FiltersSection`'s pattern verbatim (slot-presence-driven
 * `predicateValid` + `filterValid={isValid}`).
 */
export function DisplaySection({
	value,
	onChange,
	caseTypes,
	currentCaseType,
	appId,
	onValidityChange,
}: DisplaySectionProps) {
	// Aggregated column-list verdict. Default `true` — fresh-mount
	// state stays valid until the inner editors fire their first
	// verdicts; otherwise the preview would render its paused state
	// momentarily on every load while the column list is doing its
	// applicability pass.
	const [columnsValid, setColumnsValid] = useState(true);

	// Standardized parent-validity propagation — fires on mount + on
	// every transition, ref-stashed against fresh-each-render parent
	// callback identity.
	useValidityPropagator({ isValid: columnsValid, onValidityChange });

	// ── Per-slot mutator ──
	//
	// Column-list mutations route through the shared mutator. Every
	// other slot (`filter`, `searchInputs`) flows through unchanged.
	const setColumns = (next: readonly Column[]) => {
		onChange({ ...value, columns: [...next] });
	};

	return (
		<div className="space-y-4">
			{/* Sort priority pill stack — surfaces the column sort
			    hierarchy at-a-glance and lets the user drag to
			    rearrange priority. Renders only when at least one
			    column carries a sort directive. */}
			<SortPriorityStack value={value.columns} onChange={setColumns} />

			{/* Column list — owns add / remove / reorder + per-row
			    `ColumnEditor` mount. Every column kind (including
			    calculated) renders the same row chrome with the
			    affordances row in the card shell. The list's
			    aggregated verdict drives both the parent's save gate
			    and the preview's `configValid` below. */}
			<DisplaySubSection
				icon={tablerColumns}
				title="Columns"
				description="Each column renders one cell per row in the case list."
			>
				<ColumnList
					value={value.columns}
					onChange={setColumns}
					caseTypes={caseTypes}
					currentCaseType={currentCaseType}
					onValidityChange={setColumnsValid}
				/>
			</DisplaySubSection>

			{/* Live preview panel. Reads `caseListConfig` directly via
			    a Server Action that compiles every calculated column
			    inline as a SELECT projection. Suppresses the load when
			    the column list reports invalid — sending an invalid
			    expression AST to `compileExpression` would throw at
			    the SQL layer. */}
			<DisplaySubSection
				icon={tablerEye}
				title="Live preview"
				description="What the case list looks like with the current configuration."
			>
				<DisplayPreview
					appId={appId}
					caseListConfig={value}
					currentCaseType={currentCaseType}
					configValid={columnsValid}
				/>
			</DisplaySubSection>
		</div>
	);
}

// ── Sort priority stack ───────────────────────────────────────────
//
// Read-only ordered pill stack showing the sorted columns in
// priority order. Drag-to-reorder reassigns priorities 0..N-1
// across the dragged set so the visible order matches the wire-
// emitter's ascending-priority order.
//
// The schema doesn't guarantee priority uniqueness or contiguity:
// per-column `cycleSort` and `clearSort` (in
// `ColumnAffordancesRow`) drop a column's sort slot without
// renumbering its peers, which leaves gaps (e.g. priorities
// `[0, 1, 2]` with the middle column cleared becomes `[0, 2]`).
// The gaps are harmless — the wire emitter's tie-break to
// source-array index resolves any ambiguity, and `resolveSortedColumns`
// here uses the same tie-break — but the stack's drag handler
// always emits a clean 0..N-1 sequence so the visible order stays
// readable.

interface SortPriorityStackProps {
	readonly value: readonly Column[];
	readonly onChange: (next: readonly Column[]) => void;
}

/**
 * Sort priority pill stack. Renders the sorted columns in priority
 * order; each pill carries the column's header (or field), the sort
 * direction icon, and a drag handle. The stack hides when no column
 * is sorted — an empty stack would just clutter the layout.
 */
function SortPriorityStack({ value, onChange }: SortPriorityStackProps) {
	// Resolve the sorted columns ordered by priority ascending.
	// Tie-break to source-array index — same rule the saga / preview
	// / wire emitter use. Gaps in the priority sequence are tolerated
	// by every layer (the schema doesn't enforce uniqueness or
	// contiguity); the drag-reorder handler below normalizes to
	// 0..N-1 so the visible order stays readable.
	const sorted = useMemo(() => resolveSortedColumns(value), [value]);
	const containerKey = useId();

	const reorderSorted = (nextOrder: readonly Column[]) => {
		// Renumber the reordered sorted list 0..N-1, then write back
		// into the full column array preserving every non-sorted
		// column's position. The non-sorted columns keep their array
		// indices; only the sort fields on the sorted columns change.
		const priorityByUuid = new Map<string, number>();
		nextOrder.forEach((col, idx) => {
			priorityByUuid.set(col.uuid, idx);
		});
		const updated = value.map((col) => {
			if (col.sort === undefined) return col;
			const newPriority = priorityByUuid.get(col.uuid);
			if (newPriority === undefined) return col;
			if (col.sort.priority === newPriority) return col;
			const nextSort: ColumnSort = { ...col.sort, priority: newPriority };
			return { ...col, sort: nextSort } as Column;
		});
		onChange(updated);
	};

	const removeSort = (uuid: string) => {
		const updated = value.map((col) => {
			if (col.uuid !== uuid) return col;
			// Drop the sort slot via a key-stripping rebuild so the
			// schema's strip-mode parse omits the absent slot.
			const { sort: _s, ...rest } = col;
			return rest as Column;
		});
		onChange(updated);
	};

	const { pendingDrop } = useReorderableList<Column>({
		containerKey,
		containerKind: "sort-priority-stack",
		items: sorted,
		onReorder: reorderSorted,
	});

	if (sorted.length === 0) return null;

	return (
		<DisplaySubSection
			icon={tablerArrowsSort}
			title="Sort priority"
			description="Drag to rearrange the priority order; the first pill is the primary sort."
		>
			<div className="flex flex-wrap items-stretch gap-1.5">
				{sorted.map((col, i) => (
					<ReorderableRow
						key={col.uuid}
						index={i}
						containerKey={containerKey}
						containerKind="sort-priority-stack"
						pendingDrop={pendingDrop}
						preview={<SortPriorityDragPreview column={col} />}
					>
						{({
							wrapperRef,
							setHandleEl,
							closestEdge,
							previewPortal,
							beingMoved,
						}) => (
							<div
								ref={wrapperRef}
								className={`relative ${beingMoved ? "opacity-50" : ""}`}
							>
								{closestEdge !== null && (
									<div
										aria-hidden="true"
										className="absolute top-0 bottom-0 w-0.5 bg-nova-violet rounded-full"
										style={{
											left: closestEdge === "top" ? -3 : undefined,
											right: closestEdge === "bottom" ? -3 : undefined,
										}}
									/>
								)}
								<SortPriorityPill
									column={col}
									position={i + 1}
									setHandleEl={setHandleEl}
									onRemove={() => removeSort(col.uuid)}
								/>
								{previewPortal}
							</div>
						)}
					</ReorderableRow>
				))}
			</div>
		</DisplaySubSection>
	);
}

interface SortPriorityPillProps {
	readonly column: Column;
	readonly position: number;
	readonly setHandleEl: (el: HTMLElement | null) => void;
	readonly onRemove: () => void;
}

/** Single pill in the sort priority stack. Carries the column's
 *  label + a direction icon + a remove affordance. */
function SortPriorityPill({
	column,
	position,
	setHandleEl,
	onRemove,
}: SortPriorityPillProps) {
	const direction = column.sort?.direction ?? "asc";
	const directionIcon =
		direction === "asc" ? tablerSortAscending : tablerSortDescending;
	// Calculated columns have no `field`; use the header alone (or a
	// fallback marker when both are blank).
	const labelSource =
		column.kind === "calculated"
			? column.header || "(unnamed)"
			: column.header || column.field || "(unnamed)";
	return (
		<div className="inline-flex items-center gap-1.5 rounded-md border border-nova-violet/30 bg-nova-violet/[0.08] px-2 py-1 text-xs">
			<button
				type="button"
				ref={setHandleEl}
				aria-label={`Reorder sort priority for ${labelSource}`}
				className="cursor-grab text-nova-violet-bright/60 hover:text-nova-violet-bright transition-colors"
			>
				<Icon icon={tablerGripVertical} width="12" height="12" />
			</button>
			<span className="text-[10px] font-mono text-nova-violet-bright/60">
				{position}
			</span>
			<span className="truncate max-w-[160px] text-nova-text">
				{labelSource}
			</span>
			<Icon
				icon={directionIcon}
				width="12"
				height="12"
				className="text-nova-violet-bright/80"
				aria-label={`Sorted ${direction === "asc" ? "ascending" : "descending"}`}
			/>
			<button
				type="button"
				onClick={onRemove}
				aria-label={`Clear sort for ${labelSource}`}
				className="rounded p-0.5 text-nova-violet-bright/60 hover:text-nova-error hover:bg-white/[0.05] transition-colors cursor-pointer"
			>
				<Icon icon={tablerTrash} width="11" height="11" />
			</button>
		</div>
	);
}

function SortPriorityDragPreview({ column }: { readonly column: Column }) {
	const labelSource =
		column.kind === "calculated"
			? column.header || "(unnamed)"
			: column.header || column.field || "(unnamed)";
	return (
		<div className="inline-flex items-center gap-1.5 rounded-md border border-nova-violet/40 bg-nova-surface/95 px-2.5 py-1 text-xs text-nova-text shadow-lg backdrop-blur-sm">
			<Icon
				icon={tablerArrowsSort}
				width="12"
				height="12"
				className="text-nova-violet-bright/80"
			/>
			<span className="max-w-[200px] truncate">{labelSource}</span>
		</div>
	);
}

/**
 * Resolve the sorted columns ordered by `sort.priority` ascending.
 * Tie-break to source-array index — the column appearing earlier
 * in `value.columns` wins on a priority collision. Same rule the
 * saga / preview / wire layers use; the editor maintains
 * uniqueness on save but the tie-break exists for transient
 * (undo / partial-save) states.
 */
function resolveSortedColumns(value: readonly Column[]): readonly Column[] {
	const sorted: { column: Column; priority: number; index: number }[] = [];
	for (let i = 0; i < value.length; i++) {
		const col = value[i];
		if (col === undefined) continue;
		if (col.sort === undefined) continue;
		sorted.push({ column: col, priority: col.sort.priority, index: i });
	}
	sorted.sort((a, b) => {
		if (a.priority !== b.priority) return a.priority - b.priority;
		return a.index - b.index;
	});
	return sorted.map((entry) => entry.column);
}

// ── Sub-section chrome ────────────────────────────────────────────

interface DisplaySubSectionProps {
	readonly icon: React.ComponentProps<typeof Icon>["icon"];
	readonly title: string;
	readonly description: string;
	readonly children: React.ReactNode;
}

/**
 * Visual scaffold for each sub-section. Surface mirrors the editor
 * cards' frosted-glass language — rounded corners, hairline border,
 * subtle violet accent on the section header.
 */
function DisplaySubSection({
	icon,
	title,
	description,
	children,
}: DisplaySubSectionProps) {
	return (
		<section className="rounded-md border border-white/[0.04] bg-nova-surface/30 p-3">
			<header className="flex items-baseline gap-2 mb-2">
				<div className="w-0.5 h-3 rounded-full bg-nova-violet/40" />
				<Icon
					icon={icon}
					width="14"
					height="14"
					className="text-nova-violet-bright/80 self-center"
				/>
				<h3 className="text-[11px] font-semibold uppercase tracking-widest text-nova-text/90">
					{title}
				</h3>
				<span className="ml-1 text-[10px] text-nova-text-muted/70">
					{description}
				</span>
			</header>
			<div>{children}</div>
		</section>
	);
}

// ── Column list — drag-orderable wrapper around `ColumnEditor` ────
//
// `ColumnEditor` edits one column at a time. The Display section
// needs a list-shaped wrapper that owns the array, drag-reorder,
// add / remove, and validity aggregation. Mirrors the predicate-
// editor's reorderable-list contract; per-mount `containerKey` for
// the reorder monitor, per-row uuid React keys, unified validity
// aggregation across rows.
//
// React keys use the column's `uuid` directly — uuids are
// guaranteed unique across siblings and stable across edits, so
// the WeakMap-backed `nodeId(...)` is no longer needed for these
// keys (column identity is now durable on the value itself).

interface ColumnListProps {
	readonly value: readonly Column[];
	readonly onChange: (next: readonly Column[]) => void;
	readonly caseTypes: readonly CaseType[];
	readonly currentCaseType: string;
	readonly onValidityChange?: (valid: boolean) => void;
}

function ColumnList({
	value,
	onChange,
	caseTypes,
	currentCaseType,
	onValidityChange,
}: ColumnListProps) {
	const containerKey = useId();

	// Resolve sort priority positions per column so each row's
	// `ColumnEditor` knows where the column sits in the sorted set.
	// `sortedColumns` order matches the priority ordering used at the
	// wire layer; `position - 1` is the column's index in that list.
	const sortedColumns = useMemo(() => resolveSortedColumns(value), [value]);
	const sortPriorityPositionByUuid = useMemo(() => {
		const map = new Map<string, number>();
		sortedColumns.forEach((col, i) => {
			map.set(col.uuid, i + 1);
		});
		return map;
	}, [sortedColumns]);

	// Per-row inner-validity shadow. Each `ColumnEditor` fires
	// `onValidityChange(boolean)` on every transition; the shared
	// `useInnerValidityShadow` hook maintains a row-identity-keyed
	// `WeakMap<Column, boolean>` so a reorder-then-flip never races
	// against a stale index slot.
	const { aggregatedValid: isValid, setRowValid } =
		useInnerValidityShadow<Column>(value);

	useValidityPropagator({ isValid, onValidityChange });

	const { pendingDrop } = useReorderableList<Column>({
		containerKey,
		containerKind: "case-list-columns",
		items: value,
		onReorder: (next) => onChange(next),
	});

	const replaceRow = (index: number, next: Column) => {
		onChange(value.map((c, i) => (i === index ? next : c)));
	};

	const removeRow = (index: number) => {
		// Row-identity-keyed shadow auto-collects entries for removed
		// rows once the reference leaves React state — no manual
		// "drop this index" cleanup needed.
		onChange(value.filter((_, i) => i !== index));
	};

	const appendRow = () => {
		// Default new column: a Plain text column referencing the
		// case type's first property (or empty if none). The user
		// then renames the header / picks a different kind via the
		// kind-replace menu inside `ColumnEditor`. The shadow's
		// "missing entry → trivially valid" default covers the fresh
		// row until its inner editor fires its first verdict.
		const ct = caseTypes.find((c) => c.name === currentCaseType);
		const firstProperty = ct?.properties[0]?.name ?? "";
		const seed = plainColumn(newUuid(), firstProperty, "");
		onChange([...value, seed]);
	};

	return (
		<div className="space-y-1.5">
			{value.length === 0 && (
				<div className="rounded-md border border-dashed border-white/[0.06] bg-nova-surface/20 px-3 py-3 text-[11px] text-nova-text-muted/70">
					<div className="flex items-center gap-1.5">
						<Icon
							icon={tablerColumns}
							width="12"
							height="12"
							className="text-nova-text-muted/60"
						/>
						<span>
							No columns. Add one to render a per-row cell in the case list.
						</span>
					</div>
				</div>
			)}
			{value.map((column, i) => (
				<ReorderableRow
					// Stable per-row React key from the column's `uuid` — the
					// canonical identity now lives on the column itself.
					key={column.uuid}
					index={i}
					containerKey={containerKey}
					containerKind="case-list-columns"
					pendingDrop={pendingDrop}
					preview={<ColumnDragPreview index={i} column={column} />}
				>
					{({
						wrapperRef,
						setHandleEl,
						closestEdge,
						previewPortal,
						beingMoved,
					}) => (
						<div
							ref={wrapperRef}
							className={`relative ${beingMoved ? "opacity-50" : ""}`}
						>
							{closestEdge !== null && (
								<div
									aria-hidden="true"
									className="absolute left-0 right-0 h-0.5 bg-nova-violet rounded-full"
									style={{
										top: closestEdge === "top" ? -3 : undefined,
										bottom: closestEdge === "bottom" ? -3 : undefined,
									}}
								/>
							)}
							<div className="flex items-stretch gap-2">
								<div className="flex flex-col items-center gap-1 pt-1.5">
									<button
										type="button"
										ref={setHandleEl}
										aria-label="Reorder column"
										className="cursor-grab text-nova-text-muted/50 hover:text-nova-text-muted transition-colors"
									>
										<Icon icon={tablerGripVertical} width="14" height="14" />
									</button>
									<span
										aria-hidden="true"
										className="text-[10px] font-mono text-nova-text-muted/40"
									>
										{i + 1}
									</span>
								</div>
								<div className="min-w-0 flex-1">
									<ColumnEditor
										value={column}
										onChange={(next) => replaceRow(i, next)}
										caseTypes={caseTypes}
										currentCaseType={currentCaseType}
										sortedColumnCount={sortedColumns.length}
										sortPriorityPosition={sortPriorityPositionByUuid.get(
											column.uuid,
										)}
										onValidityChange={(valid) => setRowValid(column, valid)}
									/>
								</div>
								<button
									type="button"
									onClick={() => removeRow(i)}
									aria-label="Remove column"
									className="self-start rounded p-0.5 text-nova-text-muted/50 hover:text-nova-error transition-colors cursor-pointer mt-1.5"
								>
									<Icon icon={tablerTrash} width="14" height="14" />
								</button>
							</div>
							{previewPortal}
						</div>
					)}
				</ReorderableRow>
			))}
			<button
				type="button"
				onClick={appendRow}
				className="inline-flex items-center gap-1.5 px-2 py-1.5 text-[11px] rounded-md border border-dashed border-white/[0.10] text-nova-text-muted/80 hover:text-nova-violet-bright hover:border-nova-violet/30 transition-colors cursor-pointer"
			>
				<Icon icon={tablerPlus} width="11" height="11" />
				<span>Add column</span>
			</button>
		</div>
	);
}

// ── Drag preview ──────────────────────────────────────────────────

/**
 * Custom drag preview for column rows. Reads the column's header
 * (or field, when set) so the user sees what's being moved without
 * the snapshot defaulting to the 14×14 grip icon.
 */
function ColumnDragPreview({
	index,
	column,
}: {
	readonly index: number;
	readonly column: Column;
}) {
	const labelSource =
		column.kind === "calculated"
			? column.header
			: column.header || column.field;
	const label = labelSource || `Column ${index + 1}`;
	return (
		<div className="inline-flex items-center gap-1.5 rounded-lg border border-nova-violet/40 bg-nova-surface/95 px-3 py-1.5 text-sm text-nova-text shadow-lg backdrop-blur-sm">
			<Icon
				icon={tablerGripVertical}
				width="14"
				height="14"
				className="text-nova-text-muted"
			/>
			<Icon
				icon={tablerColumns}
				width="14"
				height="14"
				className="text-nova-violet-bright/80"
			/>
			<span className="max-w-[240px] truncate">{label}</span>
		</div>
	);
}
