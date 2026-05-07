// components/builder/case-list-config/SortKeyEditor.tsx
//
// Multi-key drag-orderable sort-key editor. Renders the case list's
// `sort: SortKey[]` slot as a vertical card list — each row carries
// a source picker (case property OR calculated column), a comparator
// type picker, and a direction toggle. The runtime applies the keys
// in declaration order: row 1 is the primary sort, each subsequent
// row acts as a tiebreaker on the previous keys.
//
// Source UI shape: a single combined Base UI Menu lists both
// case-type properties and calculated columns under per-section
// headers. The selected source's discriminator (property vs
// calculated) determines the leading icon and the displayed value;
// authors click the trigger, see both classes side-by-side, and
// pick whichever one they want without flipping a separate mode
// switch first. The picker is a bespoke `SourcePicker` rather than
// the shared `PropertyPicker` because it composes the property +
// calculated-column branches under one menu.
//
// Reorder uses the shared `useReorderableList` + `<ReorderableRow>`
// primitives — same monitor / preview / adjacency-suppression
// contract as `ConcatCard` / `CoalesceCard` / `SwitchCard`. The
// sort-key list has no envelope object (it's a plain `SortKey[]` on
// the case-list config), so the container's stable identity is a
// per-mount UUID rather than a `nodeId(...)` lookup against an AST
// envelope. Per-row React keys use `nodeId(key)` against the
// `SortKey` object — the WeakMap-backed identity helper handles
// the duplicate-source case (two keys on the same property with
// different types / directions) that an index-or-source-name key
// would collide on.

"use client";
import { Menu } from "@base-ui/react/menu";
import { Icon, type IconifyIcon } from "@iconify/react/offline";
import tablerArrowsSort from "@iconify-icons/tabler/arrows-sort";
import tablerCheck from "@iconify-icons/tabler/check";
import tablerDatabase from "@iconify-icons/tabler/database";
import tablerExclamationCircle from "@iconify-icons/tabler/exclamation-circle";
import tablerGripVertical from "@iconify-icons/tabler/grip-vertical";
import tablerMathFunction from "@iconify-icons/tabler/math-function";
import tablerPlus from "@iconify-icons/tabler/plus";
import tablerSortAscending from "@iconify-icons/tabler/sort-ascending";
import tablerSortDescending from "@iconify-icons/tabler/sort-descending";
import tablerTrash from "@iconify-icons/tabler/trash";
import { useId, useMemo, useRef } from "react";
import {
	applicableSortTypes,
	type CalculatedColumn,
	type CasePropertyDataType,
	type CaseType,
	calculatedSortSource,
	effectiveDataType,
	propertySortSource,
	SORT_TYPES,
	type SortDirection,
	type SortKey,
	type SortKeySource,
	type SortType,
	sortKey,
} from "@/lib/domain";
import {
	MENU_ITEM_BASE,
	MENU_ITEM_CLS,
	MENU_POPUP_CLS,
	MENU_POSITIONER_CLS,
} from "@/lib/styles";
import { nodeId } from "./nodeIdentity";
import { InlineError } from "./primitives/CardShell";
import { useValidityPropagator } from "./useInnerValidityShadow";
import { ReorderableRow, useReorderableList } from "./useReorderableList";

// ── Public type-picker label table ────────────────────────────────
//
// The `SortType` enum's string values are wire-shaped (`integer` /
// `decimal` / `date` / `plain`); the picker UI shows author-friendly
// labels keyed off the same enum. Centralizing here keeps the
// labels consistent across the type-picker menu and the inline
// error messages and prevents drift.

const SORT_TYPE_LABELS: Record<SortType, string> = {
	plain: "Plain",
	date: "Date",
	integer: "Integer",
	decimal: "Decimal",
};

// ── Public direction-toggle label table ───────────────────────────

const SORT_DIRECTION_LABELS: Record<SortDirection, string> = {
	asc: "Ascending",
	desc: "Descending",
};

const SORT_DIRECTION_ICONS: Record<SortDirection, IconifyIcon> = {
	asc: tablerSortAscending,
	desc: tablerSortDescending,
};

// ── Top-level props ────────────────────────────────────────────────

interface SortKeyEditorProps {
	/** The current ordered list of sort keys. Order matters — the
	 *  first key is the primary sort, subsequent keys are tiebreakers. */
	readonly value: readonly SortKey[];
	readonly onChange: (next: readonly SortKey[]) => void;
	readonly caseTypes: readonly CaseType[];
	/** The case-type the editor's property picker resolves against —
	 *  the module's own case type (sort keys read directly off the
	 *  module's case list, no relation walks). */
	readonly currentCaseType: string;
	/** The set of calculated columns available for the calculated-
	 *  source mode. Drives the source picker's calculated-column
	 *  option list and resolves the displayed header for a chosen
	 *  `columnId`. */
	readonly calculatedColumns: readonly CalculatedColumn[];
	/** Surfaces the editor's overall validity to the parent so the
	 *  surrounding save affordance can gate. Fires on every onChange. */
	readonly onValidityChange?: (valid: boolean) => void;
}

/**
 * Multi-key sort editor. Drag-orderable rows; per-row source +
 * type + direction; inline type-mismatch errors when the picked
 * type isn't compatible with the source's resolved data type.
 */
export function SortKeyEditor({
	value,
	onChange,
	caseTypes,
	currentCaseType,
	calculatedColumns,
	onValidityChange,
}: SortKeyEditorProps) {
	// Per-mount stable id for the reorder container. The `SortKey[]`
	// list has no envelope object to use as a `nodeId(...)` lookup
	// key; a per-mount UUID gives the monitor a stable scope across
	// re-renders without coupling to the array reference.
	const containerKey = useId();

	// Resolve every row's source once. The unified `resolveSource`
	// helper feeds both the inline-error computation and the per-row
	// `SourcePicker`'s trigger chrome (via `<SortKeyRow>`'s pass-
	// through), so the editor's display and its validity propagation
	// share one source of truth — the trigger's red error chrome and
	// `valid: false` agree on every `resolved.state` value.
	const resolvedPerRow = useMemo(
		() =>
			value.map((key) =>
				resolveSource(
					key.source,
					caseTypes,
					currentCaseType,
					calculatedColumns,
				),
			),
		[value, caseTypes, currentCaseType, calculatedColumns],
	);

	// Per-row inline-error list. Two independent failure classes
	// surface here:
	//
	//   - **Source not resolvable** — empty source string ("Pick a
	//     source") or stale name (property renamed / deleted, or a
	//     calculated columnId that's no longer in the list). Without
	//     this gate, the editor would propagate `valid: true` while
	//     visually rendering the red exclamation chrome — the host's
	//     save affordance would let the user export an unbuildable
	//     case list. Per `feedback_always_in_valid_state.md`, an app
	//     in this shape MUST report `valid: false`.
	//   - **Type mismatch** — only checked once the source is
	//     `resolved`. Calculated sources stay permissive (the
	//     expression's return type isn't known at the source layer
	//     so any sort type is admitted). Property sources gate
	//     against `applicableSortTypes(dataType)`.
	const errorsPerRow = useMemo(
		() =>
			value.map((key, i) => {
				const resolved = resolvedPerRow[i];
				if (resolved.state === "empty") {
					return [
						`Sort source not selected; pick a property or calculated column.`,
					] as const;
				}
				if (resolved.state === "missing") {
					// Discriminate on the source's typed `kind` directly
					// rather than round-tripping through the display-shaped
					// `kindLabel` string. The discriminated union is the
					// canonical contract; keeping this gate coupled to it
					// means renaming `kindLabel` for visual reasons can
					// never accidentally widen the noun branch.
					const noun =
						key.source.kind === "property" ? "property" : "calculated column";
					return [
						`Sort source "${resolved.displayLabel}" is no longer a declared ${noun}.`,
					] as const;
				}
				// `state === "resolved"`. Calculated sources skip the
				// type-mismatch gate (any type admitted); property
				// sources gate against the property-type compatibility
				// table. By this point `resolved.dataType` is always the
				// `effectiveDataType(property)` non-undefined string —
				// the empty / missing arms returned earlier and
				// `effectiveDataType` falls back to `"text"` for
				// un-annotated properties — so no fallback is needed in
				// the message body.
				if (key.source.kind === "calculated") return [] as const;
				const allowed = applicableSortTypes(resolved.dataType);
				if (allowed.includes(key.type)) return [] as const;
				const labelList = allowed.map((t) => SORT_TYPE_LABELS[t]).join(", ");
				return [
					`${SORT_TYPE_LABELS[key.type]} comparison isn't valid for ${resolved.dataType} properties; pick ${labelList}.`,
				] as const;
			}),
		[value, resolvedPerRow],
	);

	const isValid = errorsPerRow.every((errors) => errors.length === 0);

	// Standardized parent-validity propagation — fires on mount + on
	// every transition, ref-stashed against fresh-each-render parent
	// callback identity.
	useValidityPropagator({ isValid, onValidityChange });

	// Reorder wiring — installs the per-container monitor scoped to
	// `containerKey`. The reordered array's entries are reference-
	// preserved (the hook splices the existing element references
	// into the new order); passing the array straight through keeps
	// `nodeId(key)`-backed React keys stable across the reorder so
	// transient row state survives.
	const { pendingDrop } = useReorderableList<SortKey>({
		containerKey,
		containerKind: "sort-keys",
		items: value,
		onReorder: (next) => onChange(next),
	});

	// ── Mutators ──
	//
	// Every mutation routes through one of three call sites
	// (`replaceRow`, `removeRow`, `appendRow`); each rebuilds the
	// affected row(s) via the `sortKey(...)` builder so the wire-
	// shape stays in lockstep with the schema.

	const replaceRow = (index: number, next: SortKey) => {
		onChange(value.map((k, i) => (i === index ? next : k)));
	};

	const removeRow = (index: number) => {
		onChange(value.filter((_, i) => i !== index));
	};

	const appendRow = () => {
		const seedSource = pickDefaultSource(caseTypes, currentCaseType);
		// New rows seed with `plain` + `asc`. Plain is structurally
		// the most-permissive comparator (admitted by every data type
		// per `applicableSortTypes`), so the seed never fires the
		// inline type-mismatch even when the seeded source's data
		// type narrows the admitted set.
		const seed = sortKey(seedSource, "plain", "asc");
		onChange([...value, seed]);
	};

	return (
		<div className="space-y-1.5">
			{value.length === 0 && <EmptyState />}
			{value.map((key, i) => (
				<ReorderableRow
					// Stable per-row React key from the WeakMap-backed
					// `nodeId(key)`. The reorder hook splices the existing
					// element references into the new array order, so the
					// per-row identity persists across drag-drop AND
					// across the duplicate-source case (two keys on the
					// same property with different types / directions
					// would collide on an index-or-source-name key).
					key={nodeId(key)}
					index={i}
					containerKey={containerKey}
					containerKind="sort-keys"
					pendingDrop={pendingDrop}
					preview={<SortKeyDragPreview index={i} />}
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
							<SortKeyRow
								value={key}
								index={i}
								caseTypes={caseTypes}
								currentCaseType={currentCaseType}
								calculatedColumns={calculatedColumns}
								resolved={resolvedPerRow[i]}
								errors={errorsPerRow[i]}
								onChange={(next) => replaceRow(i, next)}
								onRemove={() => removeRow(i)}
								setHandleEl={setHandleEl}
							/>
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
				<span>Add sort key</span>
			</button>
		</div>
	);
}

// ── Source resolution ──────────────────────────────────────────────
//
// One helper resolves a `SortKeySource` against the editor's
// `caseTypes` + `calculatedColumns` context and returns everything
// every consumer needs:
//
//   - `state` — `"resolved"` (the source points at an existing
//     property / calculated column), `"empty"` (the source is unset
//     — empty property name / empty columnId), or `"missing"` (the
//     source names something the case-type / calculated-column list
//     no longer declares).
//   - `displayLabel` — author-facing label for the trigger button +
//     aria-label. `"Pick a source"` when empty; the property name /
//     calculated column header otherwise.
//   - `kindLabel` — the discriminator name (`"Property"` /
//     `"Calculated column"`) — surfaced in the aria-label so AT
//     users can tell the two source kinds apart without the visual
//     icon.
//   - `dataType` — effective property data type when the source is
//     a resolved property; `undefined` for calculated sources (the
//     expression's return type isn't known at the source layer)
//     AND for empty / missing sources (no property to read).
//   - `monospaceLabel` — purely visual: render the trigger label in
//     `font-mono` for property names (wire-form codes) and
//     proportional for calculated headers / placeholder.
//
// Both `errorsPerRow` (validity propagation) and `SourcePicker`
// (visual chrome + aria-label) consume the same helper output, so
// the two halves of the editor agree on what "this source is
// broken" means. Two independent computations of resolvability
// would let the trigger's red error chrome and `valid` (the host's
// save gate) drift — surfacing a UI that screams "broken" while
// the host saves the doc anyway, exactly the failure mode
// `feedback_always_in_valid_state.md` rules out.

type SourceResolutionState = "resolved" | "empty" | "missing";

interface ResolvedSource {
	readonly state: SourceResolutionState;
	readonly displayLabel: string;
	readonly kindLabel: string;
	/** Effective `data_type` of the resolved source. `undefined` for
	 *  calculated sources (the expression's return type isn't known
	 *  at the source layer) AND for empty / missing sources (no
	 *  property to read). The narrower `CasePropertyDataType` enum
	 *  matches `effectiveDataType`'s strict return type so the
	 *  per-property compatibility table (`applicableSortTypes`)
	 *  consumes the value without a string-vs-enum cast. */
	readonly dataType: CasePropertyDataType | undefined;
	readonly monospaceLabel: boolean;
}

/**
 * Resolve a `SortKeySource` into the shape every consumer needs.
 * Single source of truth for "is this source resolvable" — the
 * `state` discriminator drives both inline-error rendering AND the
 * trigger's missing-source chrome, so the editor's display and
 * its validity propagation share one computation.
 */
function resolveSource(
	source: SortKeySource,
	caseTypes: readonly CaseType[],
	currentCaseType: string,
	calculatedColumns: readonly CalculatedColumn[],
): ResolvedSource {
	if (source.kind === "property") {
		// Empty-string check before the property lookup — an empty
		// source name has no chance of matching anything in the
		// case-type's `properties` array, so the find() would always
		// miss; ordering the empty guard first short-circuits the
		// scan.
		if (source.property === "") {
			return {
				state: "empty",
				displayLabel: "Pick a source",
				kindLabel: "Property",
				dataType: undefined,
				monospaceLabel: false,
			};
		}
		const ct = caseTypes.find((c) => c.name === currentCaseType);
		const property = ct?.properties.find((p) => p.name === source.property);
		if (property === undefined) {
			return {
				state: "missing",
				displayLabel: source.property,
				kindLabel: "Property",
				dataType: undefined,
				monospaceLabel: true,
			};
		}
		return {
			state: "resolved",
			displayLabel: source.property,
			kindLabel: "Property",
			dataType: effectiveDataType(property),
			monospaceLabel: true,
		};
	}
	// Same ordering on the calculated arm — empty-string columnId
	// can't match any list entry, so the find() runs only when the
	// columnId is non-empty.
	if (source.columnId === "") {
		return {
			state: "empty",
			displayLabel: "Pick a source",
			kindLabel: "Calculated column",
			dataType: undefined,
			monospaceLabel: false,
		};
	}
	const calcCol = calculatedColumns.find((c) => c.id === source.columnId);
	if (calcCol === undefined) {
		return {
			state: "missing",
			displayLabel: source.columnId,
			kindLabel: "Calculated column",
			dataType: undefined,
			monospaceLabel: false,
		};
	}
	return {
		state: "resolved",
		displayLabel: calcCol.header || calcCol.id,
		kindLabel: "Calculated column",
		// Calculated sources admit all four sort types regardless of
		// the expression's structural type — the runtime evaluates the
		// expression and the comparator coerces. `dataType` stays
		// `undefined` so the type-picker filter / type-mismatch check
		// know to skip the per-property compatibility table.
		dataType: undefined,
		monospaceLabel: false,
	};
}

/**
 * Seed source for a freshly-appended sort key. Picks the first
 * declared property of the editor's `currentCaseType`. When the
 * case-type has no properties (or isn't declared on the schema),
 * seeds with an empty property name — the row's inline picker
 * surfaces the unset state as `"Pick a source"` AND `errorsPerRow`
 * surfaces an inline "source not selected" message + flips
 * `valid: false`, so the host's save affordance gates correctly.
 */
function pickDefaultSource(
	caseTypes: readonly CaseType[],
	currentCaseType: string,
): SortKeySource {
	const ct = caseTypes.find((c) => c.name === currentCaseType);
	const firstProperty = ct?.properties[0]?.name ?? "";
	return propertySortSource(firstProperty);
}

// ── Empty state ────────────────────────────────────────────────────

function EmptyState() {
	return (
		<div className="rounded-md border border-dashed border-white/[0.06] bg-nova-surface/20 px-3 py-3 text-[11px] text-nova-text-muted/70">
			<div className="flex items-center gap-1.5">
				<Icon
					icon={tablerArrowsSort}
					width="12"
					height="12"
					className="text-nova-text-muted/60"
				/>
				<span>
					No sort keys. The case list will display rows in their storage order.
				</span>
			</div>
		</div>
	);
}

// ── Per-row component ─────────────────────────────────────────────

interface SortKeyRowProps {
	readonly value: SortKey;
	readonly index: number;
	readonly caseTypes: readonly CaseType[];
	readonly currentCaseType: string;
	readonly calculatedColumns: readonly CalculatedColumn[];
	/** Resolved-source descriptor from the editor's top-level
	 *  `resolveSource(...)` pass. Threaded through so the row's
	 *  `SourcePicker` and the row's `TypePicker` filter share the
	 *  same resolution the editor's validity gate consumed —
	 *  display chrome and validity propagation can't drift. */
	readonly resolved: ResolvedSource;
	readonly errors: readonly string[];
	readonly onChange: (next: SortKey) => void;
	readonly onRemove: () => void;
	readonly setHandleEl: (el: HTMLElement | null) => void;
}

/**
 * One sort-key row — drag handle, source picker, type picker,
 * direction toggle, remove button. Inline error renders below the
 * type picker when the picked type isn't admissible for the source.
 */
function SortKeyRow({
	value,
	index,
	caseTypes,
	currentCaseType,
	calculatedColumns,
	resolved,
	errors,
	onChange,
	onRemove,
	setHandleEl,
}: SortKeyRowProps) {
	// Calculated sources admit all four sort types regardless of the
	// source's resolution state — the runtime evaluates the
	// expression and the comparator coerces. Property sources gate
	// against `applicableSortTypes(dataType)`; the unresolved /
	// missing case collapses to `["plain"]` which is the safest
	// default while the user is still picking a property.
	const allowedTypes =
		value.source.kind === "calculated"
			? SORT_TYPES
			: applicableSortTypes(resolved.dataType);

	const setSource = (next: SortKeySource) => {
		// Source change preserves type + direction. The applicability
		// check fires on the next render; if the new source narrows
		// the admitted set so the current type is no longer valid,
		// the inline error surfaces and the row reports invalid —
		// authors then either flip the type or revert the source.
		// Rebuilding the type silently would surprise the user.
		onChange(sortKey(next, value.type, value.direction));
	};

	const setType = (next: SortType) => {
		onChange(sortKey(value.source, next, value.direction));
	};

	const toggleDirection = () => {
		const next: SortDirection = value.direction === "asc" ? "desc" : "asc";
		onChange(sortKey(value.source, value.type, next));
	};

	const hasError = errors.length > 0;

	return (
		<div
			className={[
				"group/row relative flex items-stretch gap-2 rounded-md border bg-nova-surface/40 px-2 py-2 transition-colors",
				hasError
					? "border-nova-error/35 shadow-[inset_0_0_0_1px_rgba(255,90,120,0.12)]"
					: "border-white/[0.04]",
			].join(" ")}
		>
			{/* Position badge + drag handle. The position number gives
			    visual weight to the row's primary-vs-tiebreaker
			    semantics; the grip handle binds the native draggable. */}
			<div className="flex flex-col items-center gap-1 pt-0.5">
				<button
					type="button"
					ref={setHandleEl}
					aria-label="Reorder sort key"
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

			{/* Body — the three pickers + the inline error. */}
			<div className="min-w-0 flex-1 space-y-1.5">
				<div className="flex items-stretch gap-1.5">
					<div className="min-w-0 flex-1">
						<SourcePicker
							value={value.source}
							resolved={resolved}
							onChange={setSource}
							caseTypes={caseTypes}
							currentCaseType={currentCaseType}
							calculatedColumns={calculatedColumns}
						/>
					</div>
					<TypePicker
						value={value.type}
						onChange={setType}
						allowed={allowedTypes}
						invalid={hasError}
					/>
					<DirectionToggle value={value.direction} onToggle={toggleDirection} />
				</div>
				<InlineError errors={errors} />
			</div>

			{/* Remove button. Per-row remove sits trailing-aligned so
			    it doesn't crowd the pickers; click reveals on hover
			    via the row's `group/row` modifier. */}
			<button
				type="button"
				onClick={onRemove}
				aria-label="Remove sort key"
				className="self-start rounded p-0.5 text-nova-text-muted/50 hover:text-nova-error transition-colors cursor-pointer"
			>
				<Icon icon={tablerTrash} width="14" height="14" />
			</button>
		</div>
	);
}

// ── Source picker ──────────────────────────────────────────────────

interface SourcePickerProps {
	readonly value: SortKeySource;
	/** Resolved-source descriptor produced by the editor's top-level
	 *  `resolveSource(...)` pass. Drives the trigger label, the
	 *  missing-source chrome, and the aria-label so the picker's
	 *  visual state and the editor's validity gate share one
	 *  computation. */
	readonly resolved: ResolvedSource;
	readonly onChange: (next: SortKeySource) => void;
	readonly caseTypes: readonly CaseType[];
	readonly currentCaseType: string;
	readonly calculatedColumns: readonly CalculatedColumn[];
}

/**
 * Combined source picker. Single Base UI Menu listing the case-
 * type's properties under a "Properties" section header and the
 * available calculated columns under a "Calculated columns"
 * header. Selecting a property emits a `propertySortSource(name)`;
 * selecting a calculated column emits a
 * `calculatedSortSource(columnId)`. The trigger's leading icon
 * follows `value.kind` (database vs math function) so the
 * discriminator stays visible at-a-glance even when the source is
 * unresolved / missing; the icon's color flips to error red when
 * `resolved.state === "missing"`.
 */
function SourcePicker({
	value,
	resolved,
	onChange,
	caseTypes,
	currentCaseType,
	calculatedColumns,
}: SourcePickerProps) {
	const triggerRef = useRef<HTMLButtonElement>(null);

	// Resolve the case type's properties for the property section.
	const properties = useMemo(() => {
		const ct = caseTypes.find((c) => c.name === currentCaseType);
		return ct?.properties ?? [];
	}, [caseTypes, currentCaseType]);

	// Section headers ("Properties" / "Calculated columns") only
	// render when both classes are on offer. With one class alone,
	// the header reads as decoration above an unambiguous list.
	const showSectionHeaders =
		properties.length > 0 && calculatedColumns.length > 0;

	// Trigger icon follows the discriminator regardless of
	// resolution. A `"missing"` state recolors the icon to error
	// red but keeps the kind shape so the user sees what kind of
	// source the row was set to.
	const triggerIcon =
		value.kind === "property" ? tablerDatabase : tablerMathFunction;

	const triggerIsMissing = resolved.state === "missing";

	// AT-readable aria-label disambiguating the source kind. Without
	// the kind prefix, "Days since visit" reads identically whether
	// it's a property or a calculated column header — the visual
	// icon (database vs math function) carries the discriminator
	// only for sighted users. The "(missing)" suffix surfaces the
	// resolved-source error chrome for AT.
	const ariaLabel = `Sort source: ${resolved.kindLabel} "${resolved.displayLabel}"${
		triggerIsMissing ? " (missing)" : ""
	}`;

	const triggerClass = [
		"group w-full flex items-center justify-between px-2 py-1.5 text-xs rounded-md border transition-colors cursor-pointer text-nova-text bg-nova-deep/50 border-white/[0.06] hover:border-nova-violet/30",
	].join(" ");

	const labelClass = [
		"truncate",
		resolved.monospaceLabel ? "font-mono" : "",
		triggerIsMissing ? "text-nova-error/90" : "text-nova-text",
	]
		.filter(Boolean)
		.join(" ");

	return (
		<Menu.Root>
			<Menu.Trigger
				ref={triggerRef}
				aria-label={ariaLabel}
				className={triggerClass}
			>
				<span className="flex items-center gap-1.5 min-w-0">
					<Icon
						icon={triggerIcon}
						width="14"
						height="14"
						className={
							triggerIsMissing
								? "text-nova-error/80"
								: "text-nova-violet-bright/80"
						}
					/>
					<span className={labelClass}>{resolved.displayLabel}</span>
					{triggerIsMissing && (
						<Icon
							icon={tablerExclamationCircle}
							width="14"
							height="14"
							className="text-nova-error/80"
							aria-label="Source is no longer declared"
						/>
					)}
				</span>
				<Chevron />
			</Menu.Trigger>
			<Menu.Portal>
				<Menu.Positioner
					side="bottom"
					align="start"
					sideOffset={4}
					anchor={triggerRef}
					className={MENU_POSITIONER_CLS}
					style={{ minWidth: "var(--anchor-width)", maxHeight: 320 }}
				>
					<Menu.Popup className={`${MENU_POPUP_CLS} max-h-80 overflow-y-auto`}>
						{/* Section headers are organizational — they only earn
						    their visual weight when both source classes are
						    present and the user needs a divider to navigate
						    between them. With only one class on offer, the
						    header reads as decoration. */}
						{properties.length > 0 && (
							<>
								{showSectionHeaders && (
									<SectionHeader label="Properties" icon={tablerDatabase} />
								)}
								{properties.map((p) => {
									const isActive =
										value.kind === "property" && value.property === p.name;
									return (
										<Menu.Item
											key={`prop:${p.name}`}
											onClick={() => onChange(propertySortSource(p.name))}
											className={
												isActive
													? `${MENU_ITEM_BASE} text-nova-violet-bright bg-nova-violet/10 cursor-pointer`
													: MENU_ITEM_CLS
											}
										>
											<Icon
												icon={tablerDatabase}
												width="14"
												height="14"
												className={
													isActive
														? "text-nova-violet-bright"
														: "text-nova-text-muted"
												}
											/>
											<span className="flex-1 text-left min-w-0">
												<div className="font-mono truncate">{p.name}</div>
												<div
													className={`text-[10px] uppercase tracking-wider ${
														isActive
															? "text-nova-violet-bright/60"
															: "text-nova-text-muted"
													}`}
												>
													{effectiveDataType(p)}
												</div>
											</span>
										</Menu.Item>
									);
								})}
							</>
						)}
						{calculatedColumns.length > 0 && (
							<>
								{showSectionHeaders && (
									<SectionHeader
										label="Calculated columns"
										icon={tablerMathFunction}
									/>
								)}
								{calculatedColumns.map((c) => {
									const isActive =
										value.kind === "calculated" && value.columnId === c.id;
									return (
										<Menu.Item
											key={`calc:${c.id}`}
											onClick={() => onChange(calculatedSortSource(c.id))}
											className={
												isActive
													? `${MENU_ITEM_BASE} text-nova-violet-bright bg-nova-violet/10 cursor-pointer`
													: MENU_ITEM_CLS
											}
										>
											<Icon
												icon={tablerMathFunction}
												width="14"
												height="14"
												className={
													isActive
														? "text-nova-violet-bright"
														: "text-nova-text-muted"
												}
											/>
											<span className="flex-1 text-left min-w-0">
												<div className="truncate">{c.header || c.id}</div>
												<div
													className={`text-[10px] truncate font-mono ${
														isActive
															? "text-nova-violet-bright/60"
															: "text-nova-text-muted"
													}`}
												>
													{c.id}
												</div>
											</span>
										</Menu.Item>
									);
								})}
							</>
						)}
						{properties.length === 0 && calculatedColumns.length === 0 && (
							<div className={`${MENU_ITEM_BASE} text-nova-text-muted italic`}>
								No properties or calculated columns available
							</div>
						)}
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	);
}

// ── Type picker ───────────────────────────────────────────────────

interface TypePickerProps {
	readonly value: SortType;
	readonly onChange: (next: SortType) => void;
	/** The set of `SortType` values the source's resolved data type
	 *  admits. Inapplicable types still render in the menu (and stay
	 *  clickable) at reduced opacity — same convention as the
	 *  column-kind menu in `ColumnEditor`'s `KindReplaceMenu`. The
	 *  inline error surface gates validity once the user picks an
	 *  inapplicable type; hiding the option would lock authors out
	 *  of overrides when they know better. */
	readonly allowed: readonly SortType[];
	readonly invalid: boolean;
}

function TypePicker({ value, onChange, allowed, invalid }: TypePickerProps) {
	const triggerRef = useRef<HTMLButtonElement>(null);
	const allowedSet = useMemo(() => new Set(allowed), [allowed]);
	const triggerClass = [
		"group flex items-center gap-1.5 px-2 py-1.5 text-xs rounded-md border transition-colors cursor-pointer text-nova-text bg-nova-deep/50 whitespace-nowrap",
		invalid
			? "border-nova-error/40 hover:border-nova-error/60"
			: "border-white/[0.06] hover:border-nova-violet/30",
	].join(" ");

	return (
		<Menu.Root>
			<Menu.Trigger
				ref={triggerRef}
				aria-label={`Sort type: ${SORT_TYPE_LABELS[value]}`}
				className={triggerClass}
			>
				<span
					className={invalid ? "text-nova-error/90" : "text-nova-text-muted"}
				>
					{SORT_TYPE_LABELS[value]}
				</span>
				<Chevron />
			</Menu.Trigger>
			<Menu.Portal>
				<Menu.Positioner
					side="bottom"
					align="end"
					sideOffset={4}
					anchor={triggerRef}
					className={MENU_POSITIONER_CLS}
				>
					<Menu.Popup className={`${MENU_POPUP_CLS} min-w-[10rem]`}>
						{SORT_TYPES.map((t, i) => {
							const isActive = t === value;
							const isAllowed = allowedSet.has(t);
							const last = SORT_TYPES.length - 1;
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
								isActive ? "text-nova-violet-bright bg-nova-violet/10" : "",
								// Inapplicable types stay clickable (same convention
								// as the column kind menu) so authors can override
								// when they know better — the inline error makes the
								// rejection visible rather than hiding the option.
								isAllowed ? "" : "opacity-40",
							].join(" ");
							return (
								<Menu.Item key={t} onClick={() => onChange(t)} className={cls}>
									<span className="flex-1 text-left">
										{SORT_TYPE_LABELS[t]}
									</span>
									{isActive && (
										<Icon
											icon={tablerCheck}
											width="14"
											height="14"
											className="text-nova-violet-bright"
										/>
									)}
								</Menu.Item>
							);
						})}
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	);
}

// ── Direction toggle ──────────────────────────────────────────────

interface DirectionToggleProps {
	readonly value: SortDirection;
	readonly onToggle: () => void;
}

/**
 * Single icon button that flips ascending ↔ descending. The
 * `aria-pressed` attribute exposes the toggle state to assistive
 * tech without a separate label.
 */
function DirectionToggle({ value, onToggle }: DirectionToggleProps) {
	return (
		<button
			type="button"
			onClick={onToggle}
			aria-label={`Direction: ${SORT_DIRECTION_LABELS[value]}`}
			aria-pressed={value === "desc"}
			title={SORT_DIRECTION_LABELS[value]}
			className="flex items-center gap-1 px-2 py-1.5 text-xs rounded-md border border-white/[0.06] bg-nova-deep/50 text-nova-violet-bright/80 hover:border-nova-violet/30 hover:text-nova-violet-bright transition-colors cursor-pointer"
		>
			<Icon icon={SORT_DIRECTION_ICONS[value]} width="14" height="14" />
		</button>
	);
}

// ── Helper components ────────────────────────────────────────────

interface SectionHeaderProps {
	readonly label: string;
	readonly icon: IconifyIcon;
}

function SectionHeader({ label, icon }: SectionHeaderProps) {
	return (
		<div className="flex items-center gap-1.5 px-3 py-1.5 text-[10px] uppercase tracking-widest text-nova-text-muted/60">
			<Icon icon={icon} width="11" height="11" />
			<span>{label}</span>
		</div>
	);
}

function Chevron() {
	return (
		<svg
			aria-hidden="true"
			width="10"
			height="10"
			viewBox="0 0 10 10"
			className="shrink-0 text-nova-text-muted transition-transform group-data-[popup-open]:rotate-180"
		>
			<path
				d="M2 3.5L5 6.5L8 3.5"
				stroke="currentColor"
				strokeWidth="1.2"
				fill="none"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

// ── Drag preview ─────────────────────────────────────────────────

/**
 * Custom drag preview rendered in place of the browser's default
 * source snapshot. Without it, the browser would snapshot the 14×14
 * grip icon and the user couldn't see what's being moved. Mirrors
 * `ConcatPartDragPreview` and `SwitchCaseDragPreview`.
 */
function SortKeyDragPreview({ index }: { readonly index: number }) {
	return (
		<div className="inline-flex items-center gap-1.5 rounded-lg border border-nova-violet/40 bg-nova-surface/95 px-3 py-1.5 text-sm text-nova-text shadow-lg backdrop-blur-sm">
			<Icon
				icon={tablerGripVertical}
				width="14"
				height="14"
				className="text-nova-text-muted"
			/>
			<Icon
				icon={tablerArrowsSort}
				width="14"
				height="14"
				className="text-nova-violet-bright/80"
			/>
			<span className="max-w-[240px] truncate">Sort key {index + 1}</span>
		</div>
	);
}
