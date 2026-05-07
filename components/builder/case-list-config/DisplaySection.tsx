// components/builder/case-list-config/DisplaySection.tsx
//
// Composes the case-list authoring surface's Display section. Mounts
// three sub-editors (Columns / Calculated Columns / Sort Keys) plus
// the live-preview panel that queries against the live Postgres
// runtime via `loadCaseListPreviewAction`.
//
// Section ownership:
//
//   - **Display section (this file):** `caseListConfig.columns`,
//     `caseListConfig.calculatedColumns`, `caseListConfig.sort`.
//   - **Filters section (`FiltersSection`, separate file):**
//     `caseListConfig.filter`.
//   - **Search Inputs section (`SearchInputsSection`, separate file):**
//     `caseListConfig.searchInputs`.
//
// Section boundaries are explicit in the public contract:
// `DisplaySectionProps.value` is the full `CaseListConfig`, but this
// section only ever mutates the three Display-owned slots. The
// `filter` / `searchInputs` slots flow through verbatim — a parent
// composing the full panel mounts both this section and the Filters
// section against the same `CaseListConfig` source-of-truth, so each
// section's edits compose cleanly.
//
// Validity propagation: the section ANDs the three sub-editors'
// verdicts (`columns valid` AND `calculated valid` AND `sort valid`)
// and reports the combined `valid` to the parent. The live-preview
// panel reads the same combined flag — when invalid, the preview
// falls back to a "preview paused — fix errors above" state rather
// than firing the Server Action against a malformed AST. Sending an
// invalid expression to `compileExpression` would throw at the SQL
// layer; the validity gate is the structural defense.

"use client";
import { Icon } from "@iconify/react/offline";
import tablerArrowsSort from "@iconify-icons/tabler/arrows-sort";
import tablerColumns from "@iconify-icons/tabler/columns";
import tablerEye from "@iconify-icons/tabler/eye";
import tablerGripVertical from "@iconify-icons/tabler/grip-vertical";
import tablerMathFunction from "@iconify-icons/tabler/math-function";
import tablerPlus from "@iconify-icons/tabler/plus";
import tablerTrash from "@iconify-icons/tabler/trash";
import { useId, useState } from "react";
import {
	type CalculatedColumn,
	type CaseListConfig,
	type CaseType,
	type Column,
	plainColumn,
	type SortKey,
} from "@/lib/domain";
import type { SearchInputDecl } from "@/lib/domain/predicate";
import { CalculatedColumnEditor } from "./CalculatedColumnEditor";
import { ColumnEditor } from "./ColumnEditor";
import { DisplayPreview } from "./DisplayPreview";
import { nodeId } from "./nodeIdentity";
import { SortKeyEditor } from "./SortKeyEditor";
import {
	useInnerValidityShadow,
	useValidityPropagator,
} from "./useInnerValidityShadow";
import { ReorderableRow, useReorderableList } from "./useReorderableList";

// ── Public types ──────────────────────────────────────────────────

export interface DisplaySectionProps {
	/** The current full case-list configuration. The Display section
	 *  reads `columns` / `calculatedColumns` / `sort` and only emits
	 *  changes to those three slots; `filter` / `searchInputs` /
	 *  `detailColumns` flow through unchanged. */
	readonly value: CaseListConfig;
	/** Fired with the next configuration. The parent applies the
	 *  next config to its source-of-truth (typically the doc store's
	 *  module slot). */
	readonly onChange: (next: CaseListConfig) => void;
	/** Blueprint case-type definitions — drives every sub-editor's
	 *  property picker. */
	readonly caseTypes: readonly CaseType[];
	/** The case-type the case list reads against. The Display
	 *  section's sub-editors all resolve property references against
	 *  this scope; nested relation walks inside calculated-column
	 *  expressions flip the destination scope as authored. */
	readonly currentCaseType: string;
	/** Search-input declarations from the parent screen. Threaded
	 *  into calculated-column expressions so an `input(...)` term
	 *  resolves the binding name. */
	readonly knownInputs?: readonly SearchInputDecl[];
	/** The live preview's case-store query is scoped by appId. */
	readonly appId: string;
	/** Aggregated validity verdict — true iff every sub-editor
	 *  reports valid. Parent gates its save affordance on this. */
	readonly onValidityChange?: (valid: boolean) => void;
}

// ── Top-level component ───────────────────────────────────────────

/**
 * Composes the case-list Display section. Three sub-editors stack
 * vertically inside a frosted-glass surface; the live-preview panel
 * sits beneath the editors and re-runs the case-store query on every
 * config change.
 */
export function DisplaySection({
	value,
	onChange,
	caseTypes,
	currentCaseType,
	knownInputs = [],
	appId,
	onValidityChange,
}: DisplaySectionProps) {
	// Sub-editor validity verdicts. Default `true` so a fresh-mount
	// section doesn't flag invalid before the inner editors fire
	// their first verdicts.
	const [columnsValid, setColumnsValid] = useState(true);
	const [calculatedValid, setCalculatedValid] = useState(true);
	const [sortValid, setSortValid] = useState(true);

	const isValid = columnsValid && calculatedValid && sortValid;

	// Standardized parent-validity propagation — fires on mount + on
	// every transition, ref-stashed against fresh-each-render parent
	// callback identity.
	useValidityPropagator({ isValid, onValidityChange });

	// ── Per-slot mutators ──
	//
	// Each sub-editor mutates a single slot of the `CaseListConfig`.
	// The shared mutator threads the new slot value through `onChange`
	// preserving every other slot — including `filter` /
	// `searchInputs` / `detailColumns` which the Display section
	// doesn't own. Inline arrows rather than `useCallback` because
	// every config-changing edit replaces `value`, which would
	// invalidate any memoized identity anyway — `useCallback` here
	// would be decorative noise. Sub-editors capture the live closure
	// per render; they're stateful internally and don't depend on
	// callback-prop identity for correctness.
	const setColumns = (next: readonly Column[]) => {
		onChange({ ...value, columns: [...next] });
	};
	const setCalculated = (next: readonly CalculatedColumn[]) => {
		onChange({ ...value, calculatedColumns: [...next] });
	};
	const setSort = (next: readonly SortKey[]) => {
		onChange({ ...value, sort: [...next] });
	};

	return (
		<div className="space-y-4">
			{/* Columns sub-section. The `ColumnList` wrapper owns the
			    add / remove / reorder primitives; `ColumnEditor` only
			    edits one column at a time. */}
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

			{/* Calculated columns sub-section. Routes through
			    `ExpressionCardEditor` for the expression slot. */}
			<DisplaySubSection
				icon={tablerMathFunction}
				title="Calculated columns"
				description="Project a derived per-row value from properties or other expressions."
			>
				<CalculatedColumnEditor
					value={value.calculatedColumns}
					onChange={setCalculated}
					caseTypes={caseTypes}
					currentCaseType={currentCaseType}
					knownInputs={knownInputs}
					onValidityChange={setCalculatedValid}
				/>
			</DisplaySubSection>

			{/* Sort keys sub-section. Multi-key drag-orderable; sources
			    span both properties and calculated columns. */}
			<DisplaySubSection
				icon={tablerArrowsSort}
				title="Sort"
				description="Order rows by one or more keys; the first key is primary, subsequent keys break ties."
			>
				<SortKeyEditor
					value={value.sort}
					onChange={setSort}
					caseTypes={caseTypes}
					currentCaseType={currentCaseType}
					calculatedColumns={value.calculatedColumns}
					onValidityChange={setSortValid}
				/>
			</DisplaySubSection>

			{/* Live preview panel. Reads `caseListConfig` directly via
			    a Server Action that compiles every calculated column
			    inline as a SELECT projection. Suppresses the load when
			    `valid: false` to avoid throwing at the SQL layer with
			    an invalid AST. */}
			<DisplaySubSection
				icon={tablerEye}
				title="Live preview"
				description="What the case list looks like with the current configuration."
			>
				<DisplayPreview
					appId={appId}
					caseListConfig={value}
					currentCaseType={currentCaseType}
					configValid={isValid}
				/>
			</DisplaySubSection>
		</div>
	);
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
 * subtle violet accent on the section header. Keeps every
 * sub-section visually parallel without each one re-implementing
 * the chrome.
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
// `ColumnEditor` edits one column at a time. The Display
// section needs a list-shaped wrapper that owns the array, drag-
// reorder, add / remove, and validity aggregation. Mirrors
// `SortKeyEditor`'s shape verbatim: per-mount `containerKey` for
// the reorder monitor, per-row `nodeId(...)` React keys, unified
// validity aggregation across rows.
//
// Each row mounts a `ColumnEditor` for the column's per-kind body
// AND captures the column's `valid` verdict from `onValidityChange`.
// The wrapper ANDs every row's verdict and reports the aggregated
// flag to the host.

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
	// Per-mount stable id for the reorder container — same shape as
	// `SortKeyEditor` and `CalculatedColumnEditor`.
	const containerKey = useId();

	// Per-row inner-validity shadow. Each `ColumnEditor` fires
	// `onValidityChange(boolean)` on every transition; the shared
	// `useInnerValidityShadow` hook maintains a row-identity-keyed
	// `WeakMap<Column, boolean>` so a reorder-then-flip never races
	// against a stale index slot.
	const { aggregatedValid: isValid, setRowValid } =
		useInnerValidityShadow<Column>(value);

	// Standardized parent-validity propagation — fires on mount + on
	// every transition, ref-stashed against fresh-each-render parent
	// callback identity.
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
		const seed = plainColumn(firstProperty, "");
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
					// Stable per-row React key from `nodeId(column)`.
					// Survives reorders and the duplicate-field case
					// (two columns referencing the same case property).
					key={nodeId(column)}
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
										// Route the column's inner verdict through the
										// row-identity-keyed shadow. Passing `column`
										// (the current Column object) keys the WeakMap
										// entry to this row's reference so a reorder-
										// then-flip writes against the right slot.
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
 * Custom drag preview for column rows. Reads the column's header (or
 * field if header is empty) so the user sees what's being moved
 * without the snapshot defaulting to the 14×14 grip icon.
 */
function ColumnDragPreview({
	index,
	column,
}: {
	readonly index: number;
	readonly column: Column;
}) {
	const label = column.header || column.field || `Column ${index + 1}`;
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
