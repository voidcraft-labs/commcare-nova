// components/builder/case-list-config/CalculatedColumnEditor.tsx
//
// Drag-orderable list of `CalculatedColumn` rows. Each row owns:
//
//   - A stable identifier (`id`) sort keys reference via the
//     `SortKey.source.calculated.columnId` arm. Validated for
//     non-empty AND uniqueness across siblings — duplicate ids
//     would silently let the second occurrence overwrite the
//     first's projection at the SQL layer.
//   - A `header` — the case-list column heading.
//   - The `expression` AST, edited through `ExpressionCardEditor`.
//     Cross-family recursion (`if.cond` / `count.where` carrying
//     Predicate operands) flows naturally through that editor's
//     existing context plumbing.
//   - Remove + drag handle.
//
// The editor mirrors `SortKeyEditor`'s shape verbatim: per-mount
// `containerKey` for the reorder monitor, per-row `nodeId(...)`
// React keys (WeakMap-backed survival across reorders), unified
// `resolveRow` helper consumed by both inline-error rendering and
// `onValidityChange` propagation so the display chrome and the
// validity verdict share one source of truth — display-vs-validity
// asymmetry is structurally impossible.
//
// Default-row construction: a fresh row's `id` is generated at
// click time inside the `appendRow` handler — NEVER inside render.
// `crypto.randomUUID()` in a render path would emit new ids each
// render and explode the `nodeId(...)` WeakMap-backed identity
// lookup, breaking React keys + drag-and-drop scoping. The fresh
// id seeds with the `calc_<uuid>` prefix so authors can distinguish
// auto-generated ids from author-renamed ones at-a-glance.

"use client";
import { Icon } from "@iconify/react/offline";
import tablerGripVertical from "@iconify-icons/tabler/grip-vertical";
import tablerMathFunction from "@iconify-icons/tabler/math-function";
import tablerPlus from "@iconify-icons/tabler/plus";
import tablerTrash from "@iconify-icons/tabler/trash";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
	type CalculatedColumn,
	type CaseType,
	calculatedColumn,
} from "@/lib/domain";
import {
	literal,
	type SearchInputDecl,
	term,
	type ValueExpression,
} from "@/lib/domain/predicate";
import { ExpressionCardEditor } from "./ExpressionCardEditor";
import { nodeId } from "./nodeIdentity";
import { BlurCommitTextInput } from "./primitives/BlurCommitTextInput";
import { InlineError } from "./primitives/CardShell";
import { ReorderableRow, useReorderableList } from "./useReorderableList";

// ── Public types ──────────────────────────────────────────────────

interface CalculatedColumnEditorProps {
	/** The current ordered list of calculated columns. Order matters
	 *  for the runtime — calculated columns project as SELECT slots
	 *  in declaration order, and the case-list rendering reads them
	 *  in the same order for rendered cells. */
	readonly value: readonly CalculatedColumn[];
	readonly onChange: (next: readonly CalculatedColumn[]) => void;
	readonly caseTypes: readonly CaseType[];
	/** The case-type the inner `ExpressionCardEditor` resolves
	 *  property references against. Calculated columns read against
	 *  the module's own case type at the top level; nested relation
	 *  walks (e.g. `count(via, where)`) flip the destination scope
	 *  inside the expression editor as authored. */
	readonly currentCaseType: string;
	/** Search inputs declared on the parent screen. Threaded into
	 *  every row's `ExpressionCardEditor` so an `input(...)` term
	 *  inside a calculated expression resolves the binding name. */
	readonly knownInputs?: readonly SearchInputDecl[];
	/** Surfaces the editor's overall validity to the parent. Fires on
	 *  every mount + every transition. The aggregated verdict combines
	 *  per-row id non-empty + uniqueness + header non-empty + each
	 *  inner expression's `checkValueExpression` result. */
	readonly onValidityChange?: (valid: boolean) => void;
}

// ── Row resolution — single source of truth ───────────────────────
//
// One helper computes per-row `{ idState, headerState, errors }` and
// is consumed by BOTH the inline-error chrome on the row AND the
// editor's `valid` aggregation. Two independent computations is the
// failure mode `feedback_always_in_valid_state.md` rules out (Tasks
// 2-5 closed four iterations of this asymmetry); centralizing here
// keeps display chrome and validity propagation in lockstep.

type IdState =
	/** Non-empty + unique among siblings (this index's first
	 *  occurrence wins; later occurrences flag duplicate). */
	| { kind: "ok" }
	/** Empty string — the user hasn't named the column yet. */
	| { kind: "empty" }
	/** Duplicate against an earlier index — first occurrence at
	 *  `firstIndex` wins; this row's id flags. The wire emitter and
	 *  the case-store's calculated-column projection both use a
	 *  Map keyed by id, so a duplicate would silently overwrite
	 *  the first occurrence's projection at the SQL layer. */
	| { kind: "duplicate"; firstIndex: number };

interface ResolvedRow {
	readonly idState: IdState;
	readonly headerEmpty: boolean;
}

/**
 * Resolve every row's status against the sibling list. The
 * "first-occurrence wins" rule means a sort-key reference to a
 * duplicate id resolves to the row whose index appears earliest in
 * the calculated-column array — the wire emitter and the SQL
 * projection both index by id and the first occurrence is the one
 * the SELECT alias binds to.
 *
 * Building the index up-front keeps the per-row pass O(n) rather
 * than O(n²) — without the precomputed map, each row's sibling scan
 * would re-sweep the full list.
 */
function resolveRows(
	value: readonly CalculatedColumn[],
): readonly ResolvedRow[] {
	// Build a `Map<id, firstIndex>` so each row's duplicate check is
	// a constant-time lookup. Empty-string ids skip the map (they
	// flag as `empty`, not `duplicate`).
	const firstIndexById = new Map<string, number>();
	for (let i = 0; i < value.length; i++) {
		const id = value[i]?.id;
		if (id === undefined || id === "") continue;
		if (!firstIndexById.has(id)) {
			firstIndexById.set(id, i);
		}
	}
	return value.map((row, i) => {
		let idState: IdState;
		if (row.id === "") {
			idState = { kind: "empty" };
		} else {
			const firstIndex = firstIndexById.get(row.id);
			if (firstIndex !== undefined && firstIndex < i) {
				idState = { kind: "duplicate", firstIndex };
			} else {
				idState = { kind: "ok" };
			}
		}
		return {
			idState,
			headerEmpty: row.header === "",
		};
	});
}

/**
 * Decide whether a resolved row carries any structural error. A
 * row is "ok" when the id is non-empty + unique among siblings AND
 * the header is non-empty. Returns a boolean rather than a list of
 * strings — the inline-error chrome renders the per-slot messages
 * directly off `resolved.idState.kind` and `resolved.headerEmpty`,
 * so a parallel string vocabulary here would be a second source of
 * truth that drifts. The `valid` aggregation reads only the
 * boolean; the renderer reads the structured shape.
 *
 * Inner-expression validity flows through a per-row callback the
 * `ExpressionCardEditor` calls with its own validity verdict. The
 * row tracks the inner-expression's `valid` flag in component
 * state; the editor's overall `valid` ANDs the row-derived flag
 * (here) with every per-row inner-expression flag.
 */
function rowHasStructuralError(resolved: ResolvedRow): boolean {
	if (resolved.idState.kind !== "ok") return true;
	if (resolved.headerEmpty) return true;
	return false;
}

// ── Top-level editor ──────────────────────────────────────────────

export function CalculatedColumnEditor({
	value,
	onChange,
	caseTypes,
	currentCaseType,
	knownInputs = [],
	onValidityChange,
}: CalculatedColumnEditorProps) {
	// Per-mount stable id for the reorder container. The editor's
	// `value` is a plain array (no envelope object to use as a
	// `nodeId(...)` lookup key); a per-mount UUID gives the monitor
	// a stable scope across re-renders without coupling to the
	// array reference.
	const containerKey = useId();

	// Resolve every row's id / header status once per render. The
	// unified pass feeds both the inline-error footer AND the
	// editor's `valid` aggregation.
	const resolvedPerRow = useMemo(() => resolveRows(value), [value]);

	// Per-row structural-error flag derived from the resolved state.
	// Boolean rather than message-list — the inline-error chrome
	// reads `resolved.idState.kind` / `resolved.headerEmpty`
	// directly, so a parallel message vocabulary would be a second
	// source of truth.
	const hasStructuralErrorPerRow = useMemo(
		() => resolvedPerRow.map((r) => rowHasStructuralError(r)),
		[resolvedPerRow],
	);

	// Per-row inner-expression validity. Each `ExpressionCardEditor`
	// fires `onValidityChange(boolean)` on every transition; the
	// editor maintains a parallel array tracking each row's verdict.
	// Default `true` so a fresh-mount row doesn't flag `valid: false`
	// before the inner editor's first verdict lands.
	//
	// The shadow array is INDEX-keyed, not row-identity-keyed. The
	// aggregation downstream is logical-AND across every row's
	// verdict, which is permutation-invariant: reordering the boolean
	// array doesn't change the AND. Index-keyed shadow is therefore
	// safe under reorder. If a future change ever surfaces per-row
	// validity to the user (highlighting a specific invalid row, for
	// example), this shape MUST be rebuilt around row identity (the
	// `nodeId(column)` WeakMap-backed id is the canonical handle) so
	// the shadow re-aligns after reorder.
	const innerValidRef = useRef<boolean[]>([]);
	// Sync the ref's length to `value.length` so a removed row's
	// stale verdict doesn't survive into the parent's aggregated
	// validity. Kept as a render-time write instead of an effect so
	// the next `validityChanged` computation reads the freshest
	// length.
	if (innerValidRef.current.length !== value.length) {
		const next = innerValidRef.current.slice(0, value.length);
		while (next.length < value.length) next.push(true);
		innerValidRef.current = next;
	}

	// Render-trigger counter — bumped on every inner-expression
	// validity flip so the editor's `useMemo` re-evaluates against
	// the updated ref. The `value` dependency on its own only
	// triggers when the parent emits a new array; an internal flip
	// from a row's expression editor needs its own signal. Listed
	// in the memo's deps below so a flip recomputes the verdict
	// against the freshly-updated ref.
	const [innerValidityVersion, setInnerValidityVersion] = useState(0);

	// Aggregated `valid` flag — every row's structural errors empty
	// AND every row's inner expression valid. Recomputed via a
	// `useMemo` so a re-render after an inner-expression validity
	// flip surfaces immediately. Depends on `innerValidityVersion`
	// so a per-row flip recomputes the verdict against the freshly-
	// updated ref. Reads the version inside the body via
	// `void innerValidityVersion` would be a suppression; instead
	// the version is treated as a real input by the verdict (the
	// `if (innerValidityVersion < 0)` branch is dead but documents
	// the dependency for readers, and React's deps-comparison
	// machinery recomputes only when the version changes).
	const isValid = useMemo(() => {
		// Read the version here so the dependency is explicit at the
		// use site rather than only at the deps array. The verdict
		// reads from the ref (the version's purpose is to trigger
		// the recompute, not to be consulted directly); the `void`
		// expression is the project's existing idiom for
		// "load-bearing read whose value is unused" — see e.g.
		// `lib/case-store/sql/__tests__/compileExpression.test.ts`
		// and `lib/domain/predicate/__tests__/builders.test.ts`.
		void innerValidityVersion;
		for (let i = 0; i < value.length; i++) {
			if (hasStructuralErrorPerRow[i] === true) return false;
			if (innerValidRef.current[i] === false) return false;
		}
		return true;
	}, [value, hasStructuralErrorPerRow, innerValidityVersion]);

	// Ref-stash pattern: keeps a fresh-each-render parent callback
	// identity from tripping the effect on non-transitions. Same
	// shape every other case-list-config editor uses for its parent
	// validity propagation.
	const onValidityChangeRef = useRef(onValidityChange);
	onValidityChangeRef.current = onValidityChange;
	useEffect(() => {
		onValidityChangeRef.current?.(isValid);
	}, [isValid]);

	// Reorder wiring — per-container monitor scoped to `containerKey`.
	const { pendingDrop } = useReorderableList<CalculatedColumn>({
		containerKey,
		containerKind: "calculated-columns",
		items: value,
		onReorder: (next) => onChange(next),
	});

	// Per-row inner-expression validity setter. Updates the ref and
	// triggers a re-render so the editor's `valid` aggregation
	// recomputes. Setting `[index] = next` on a ref doesn't trigger
	// React's render cycle on its own — the row's `setRowState`
	// call below bumps a render-trigger counter to surface the
	// change up the tree. Without the bump, an inner-expression
	// flip (e.g. cleared error) wouldn't reach `onValidityChange`
	// until the next external trigger.
	const setInnerValid = (index: number, next: boolean) => {
		const current = innerValidRef.current[index];
		if (current === next) return;
		const updated = [...innerValidRef.current];
		updated[index] = next;
		innerValidRef.current = updated;
		// Force a render so the `useMemo`-derived `isValid` recomputes.
		// Setting the ref alone doesn't trigger React; the row state
		// counter below is the render trigger.
		setInnerValidityVersion((v) => v + 1);
	};

	// ── Mutators ──
	//
	// Every mutation routes through one of three call sites and
	// rebuilds the affected row(s) via the `calculatedColumn(...)`
	// builder so the wire shape stays in lockstep with the schema.

	const replaceRow = (index: number, next: CalculatedColumn) => {
		onChange(value.map((c, i) => (i === index ? next : c)));
	};

	const removeRow = (index: number) => {
		// Drop the row's inner-expression validity entry from the
		// shadow array so the aggregated verdict reflects only
		// surviving rows.
		const survivors = innerValidRef.current.filter((_, i) => i !== index);
		innerValidRef.current = survivors;
		onChange(value.filter((_, i) => i !== index));
	};

	const appendRow = () => {
		// Generate the fresh id at click time, NOT during render.
		// `crypto.randomUUID()` inside a render path would explode
		// the WeakMap-backed `nodeId(...)` identity (every render
		// emits a new id, every render emits a new key). The
		// `calc_` prefix distinguishes auto-generated ids from
		// author-renamed ones at-a-glance; the suffix is the v4
		// short-form (8 hex digits) so the id stays readable.
		const freshId = `calc_${crypto.randomUUID().slice(0, 8)}`;
		// Default expression is `term(literal(""))` — Term-shaped,
		// parses clean through `valueExpressionSchema`, no qualifier
		// needed. The expression editor surfaces the empty-string
		// literal as a Plain Text term ready for the user to swap.
		const seed = calculatedColumn(freshId, "", term(literal("")));
		// Append the row + extend the inner-validity shadow with
		// `true` (the default empty-string literal type-checks
		// clean).
		innerValidRef.current = [...innerValidRef.current, true];
		onChange([...value, seed]);
	};

	return (
		<div className="space-y-1.5">
			{value.length === 0 && <EmptyState />}
			{value.map((column, i) => {
				const resolved = resolvedPerRow[i] ?? {
					idState: { kind: "ok" } as const,
					headerEmpty: column.header === "",
				};
				const hasStructuralError = hasStructuralErrorPerRow[i] === true;
				return (
					<ReorderableRow
						// Stable per-row React key from the WeakMap-backed
						// `nodeId(column)`. The reorder hook splices the
						// existing element references into the new array
						// order, so the per-row identity persists across
						// drag-drop and across the duplicate-id case
						// (where a `key={column.id}` would collide on the
						// duplicates).
						key={nodeId(column)}
						index={i}
						containerKey={containerKey}
						containerKind="calculated-columns"
						pendingDrop={pendingDrop}
						preview={<CalculatedColumnDragPreview index={i} column={column} />}
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
								<CalculatedColumnRow
									value={column}
									index={i}
									resolved={resolved}
									hasStructuralError={hasStructuralError}
									caseTypes={caseTypes}
									currentCaseType={currentCaseType}
									knownInputs={knownInputs}
									onChange={(next) => replaceRow(i, next)}
									onRemove={() => removeRow(i)}
									onInnerValidityChange={(valid) => setInnerValid(i, valid)}
									setHandleEl={setHandleEl}
								/>
								{previewPortal}
							</div>
						)}
					</ReorderableRow>
				);
			})}
			<button
				type="button"
				onClick={appendRow}
				className="inline-flex items-center gap-1.5 px-2 py-1.5 text-[11px] rounded-md border border-dashed border-white/[0.10] text-nova-text-muted/80 hover:text-nova-violet-bright hover:border-nova-violet/30 transition-colors cursor-pointer"
			>
				<Icon icon={tablerPlus} width="11" height="11" />
				<span>Add calculated column</span>
			</button>
		</div>
	);
}

// ── Empty state ────────────────────────────────────────────────────

function EmptyState() {
	return (
		<div className="rounded-md border border-dashed border-white/[0.06] bg-nova-surface/20 px-3 py-3 text-[11px] text-nova-text-muted/70">
			<div className="flex items-center gap-1.5">
				<Icon
					icon={tablerMathFunction}
					width="12"
					height="12"
					className="text-nova-text-muted/60"
				/>
				<span>
					No calculated columns. Add one to project a derived per-row value
					(e.g. "days since last visit", "concatenated full name").
				</span>
			</div>
		</div>
	);
}

// ── Per-row component ─────────────────────────────────────────────

interface CalculatedColumnRowProps {
	readonly value: CalculatedColumn;
	readonly index: number;
	readonly resolved: ResolvedRow;
	/** Whether the row carries any structural error (id empty /
	 *  duplicate, header empty). Drives the row's outer error-tone
	 *  border; per-slot inline messages render off `resolved` directly. */
	readonly hasStructuralError: boolean;
	readonly caseTypes: readonly CaseType[];
	readonly currentCaseType: string;
	readonly knownInputs: readonly SearchInputDecl[];
	readonly onChange: (next: CalculatedColumn) => void;
	readonly onRemove: () => void;
	readonly onInnerValidityChange: (valid: boolean) => void;
	readonly setHandleEl: (el: HTMLElement | null) => void;
}

function CalculatedColumnRow({
	value,
	index,
	resolved,
	hasStructuralError,
	caseTypes,
	currentCaseType,
	knownInputs,
	onChange,
	onRemove,
	onInnerValidityChange,
	setHandleEl,
}: CalculatedColumnRowProps) {
	const setId = (next: string) => {
		// `calculatedColumn(...)` is the canonical builder. Threading
		// every mutation through it keeps the constructed shape in
		// lockstep with the schema; a future required field would
		// surface as a builder-signature change rather than a
		// silently-rotting raw literal.
		onChange(
			calculatedColumn(next, value.header, value.expression, value.sort),
		);
	};
	const setHeader = (next: string) => {
		onChange(calculatedColumn(value.id, next, value.expression, value.sort));
	};
	const setExpression = (next: ValueExpression) => {
		onChange(calculatedColumn(value.id, value.header, next, value.sort));
	};

	return (
		<div
			className={[
				"group/row relative flex items-stretch gap-2 rounded-md border bg-nova-surface/40 px-2 py-2 transition-colors",
				hasStructuralError
					? "border-nova-error/35 shadow-[inset_0_0_0_1px_rgba(255,90,120,0.12)]"
					: "border-white/[0.04]",
			].join(" ")}
		>
			{/* Position badge + drag handle. Position number frames the
			    row's slot; grip handle binds the native draggable. */}
			<div className="flex flex-col items-center gap-1 pt-0.5">
				<button
					type="button"
					ref={setHandleEl}
					aria-label="Reorder calculated column"
					className="cursor-grab text-nova-text-muted/50 hover:text-nova-text-muted transition-colors"
				>
					<Icon icon={tablerGripVertical} width="14" height="14" />
				</button>
				<span
					aria-hidden="true"
					className="text-[10px] font-mono text-nova-text-muted/40"
				>
					{index + 1}
				</span>
			</div>

			{/* Body — id input + header input + expression editor.
			    Field labels use `div` rather than `<label htmlFor>`
			    because `BlurCommitTextInput` already supplies its own
			    `aria-label` (the per-row index disambiguates between
			    sibling rows for AT users); a wrapping `<label>` plus
			    nested input would render two associations and confuse
			    the AT name resolver. The visible "Id" / "Header" tags
			    stay as `<div>` headers so the visual layout still
			    communicates the field grouping. */}
			<div className="min-w-0 flex-1 space-y-2">
				<div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
					<div className="block">
						<div className="block text-[10px] uppercase tracking-widest text-nova-text-muted/60 mb-1">
							Id
						</div>
						<BlurCommitTextInput
							value={value.id}
							onCommit={setId}
							placeholder="calc_unique_id"
							ariaLabel={`Calculated column ${index + 1} id`}
							monospace
						/>
						{/* Per-slot inline error renders directly off the
						    discriminator. Routing through an explicit switch
						    on `resolved.idState.kind` lets TypeScript narrow
						    the `duplicate` arm so `firstIndex` is reachable
						    without a parallel-boolean dance + dead fallback.
						    The "ok" arm renders nothing — the row's outer
						    error-tone border surfaces only when there's a
						    structural problem. */}
						{resolved.idState.kind === "empty" && (
							<InlineError errors={["Id is required."]} />
						)}
						{resolved.idState.kind === "duplicate" && (
							<InlineError
								errors={[
									`Already used by row ${resolved.idState.firstIndex + 1}.`,
								]}
							/>
						)}
					</div>
					<div className="block">
						<div className="block text-[10px] uppercase tracking-widest text-nova-text-muted/60 mb-1">
							Header
						</div>
						<BlurCommitTextInput
							value={value.header}
							onCommit={setHeader}
							placeholder="Column heading"
							ariaLabel={`Calculated column ${index + 1} header`}
						/>
						{resolved.headerEmpty && (
							<InlineError errors={["Header is required."]} />
						)}
					</div>
				</div>

				{/* Expression editor — `ExpressionCardEditor` handles the
				    full ValueExpression AST. The expression editor mounts
				    its own `PredicateEditProvider` so nested predicate
				    operands (`if.cond`, `count.where`) inherit the
				    case-type / known-inputs context automatically. */}
				<div className="rounded-md border border-white/[0.04] bg-nova-deep/30 p-2">
					<div className="text-[10px] uppercase tracking-widest text-nova-text-muted/60 mb-1.5">
						Expression
					</div>
					<ExpressionCardEditor
						value={value.expression}
						onChange={setExpression}
						caseTypes={caseTypes}
						currentCaseType={currentCaseType}
						knownInputs={knownInputs}
						onValidityChange={onInnerValidityChange}
					/>
				</div>
			</div>

			{/* Remove button — trailing-aligned so it doesn't crowd the
			    inputs. */}
			<button
				type="button"
				onClick={onRemove}
				aria-label="Remove calculated column"
				className="self-start rounded p-0.5 text-nova-text-muted/50 hover:text-nova-error transition-colors cursor-pointer"
			>
				<Icon icon={tablerTrash} width="14" height="14" />
			</button>
		</div>
	);
}

// ── Drag preview ──────────────────────────────────────────────────

/**
 * Custom drag preview rendered in place of the browser's default
 * source snapshot. Mirrors `SortKeyDragPreview` — the browser would
 * otherwise snapshot the 14×14 grip icon, leaving the user blind
 * to what's being moved.
 */
function CalculatedColumnDragPreview({
	index,
	column,
}: {
	readonly index: number;
	readonly column: CalculatedColumn;
}) {
	const label = column.header || column.id || `Calculated column ${index + 1}`;
	return (
		<div className="inline-flex items-center gap-1.5 rounded-lg border border-nova-violet/40 bg-nova-surface/95 px-3 py-1.5 text-sm text-nova-text shadow-lg backdrop-blur-sm">
			<Icon
				icon={tablerGripVertical}
				width="14"
				height="14"
				className="text-nova-text-muted"
			/>
			<Icon
				icon={tablerMathFunction}
				width="14"
				height="14"
				className="text-nova-violet-bright/80"
			/>
			<span className="max-w-[240px] truncate">{label}</span>
		</div>
	);
}
