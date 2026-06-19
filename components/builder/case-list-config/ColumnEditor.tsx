// components/builder/case-list-config/ColumnEditor.tsx
//
// Inspector body for one `Column`. A column is one thing shown about
// each case, and the panel walks through it in plain sections:
//
//   - **Display** — what kind of thing this column shows (full-width
//     picker, every choice labeled and described) and the kind's own
//     fields (property, header, date pattern, mapping table, …).
//   - **Visibility** — labeled switches for the two surfaces a column
//     can appear on (the case list, the case detail).
//   - **Sorting** — a segmented Off / Ascending / Descending control,
//     plus the column's place in the sort order when several columns
//     sort.
//
// Every control carries a visible text label and a full-size target.
// The kind-vs-property applicability check surfaces inline next to
// the field picker AND propagates to the parent's `onValidityChange`
// so the surrounding save affordance can gate.

"use client";
import { Menu } from "@base-ui/react/menu";
import { Icon } from "@iconify/react/offline";
import tablerCheck from "@iconify-icons/tabler/check";
import { useMemo, useRef } from "react";
import {
	CONSOLE_MENU_ITEM_MIN,
	CONSOLE_TRIGGER_CLS,
	InspectorHint,
	InspectorSection,
	SegmentedRow,
	ToggleRow,
} from "@/components/builder/inspector/inspectorChrome";
import { PredicateEditProvider } from "@/components/builder/shared/editorContext";
import { useValidityPropagator } from "@/components/builder/shared/useInnerValidityShadow";
import type {
	CaseType,
	Column,
	ColumnKind,
	ColumnSort,
	SortDirection,
} from "@/lib/domain";
import {
	calculatedColumn,
	dateColumn,
	idMappingColumn,
	imageMapColumn,
	intervalColumn,
	phoneColumn,
	plainColumn,
} from "@/lib/domain";
import { literal, term } from "@/lib/domain/predicate";
import {
	MENU_ITEM_CLS,
	MENU_POPUP_CLS,
	MENU_POSITIONER_CLS,
} from "@/lib/styles";
import {
	type ColumnCardSchema,
	type ColumnEditContext,
	columnCardSchemaList,
	columnCardSchemas,
	resolveColumnProperty,
	resolveColumnPropertyDataType,
} from "./columnEditorSchemas";
import { NO_SEARCH_INPUTS } from "./searchInputResolution";

/**
 * Module-scoped empty validity-index passed to the predicate
 * provider. The column editor surfaces applicability errors via
 * the `errors` prop on each card (NOT through the
 * `useEditorErrorsAt` lookup the predicate / expression editors
 * use), so the index is unused at this level. Calculated columns'
 * inner `ExpressionCardEditor` builds its own validity index
 * downstream — this one only governs the column-card pickers.
 */
const EMPTY_VALIDITY_INDEX = new Map<string, readonly string[]>();

interface ColumnEditorProps {
	/** Current column AST node. */
	readonly value: Column;
	/** Fired with the next AST whenever the user mutates the
	 *  column. */
	readonly onChange: (next: Column) => void;
	/** Blueprint case-type definitions. Drives the property
	 *  picker's dropdown content. */
	readonly caseTypes: readonly CaseType[];
	/**
	 * The case-type the column reads against. The case list
	 * always reads against the module's case-type, so the editor
	 * doesn't take a relation walk — properties resolve against
	 * the originating scope only.
	 */
	readonly currentCaseType: string;
	/**
	 * Total number of columns in the current list whose `sort` slot
	 * is set. A freshly-switched-on sort lands at the end of the
	 * existing priority order, so the user's first sorted column is
	 * the primary.
	 */
	readonly sortedColumnCount: number;
	/**
	 * The column's resolved sort priority position among its sorted
	 * peers (1-based). `undefined` when the column isn't sorted.
	 */
	readonly sortPriorityPosition: number | undefined;
	/** Opens the case list's own settings (where the sort-order
	 *  stack lives) — surfaced when several columns sort and the
	 *  order between them matters. */
	readonly onEditSortOrder?: () => void;
	/**
	 * Surfaces the boolean validity verdict to the parent on
	 * every onChange. The parent gates its save affordance on
	 * this. The editor does not gate the onChange itself —
	 * invalid edits flow through so the user can keep authoring.
	 */
	readonly onValidityChange?: (valid: boolean) => void;
}

/**
 * Column inspector body. Display (kind + per-kind fields) →
 * Visibility → Sorting, every control labeled.
 */
export function ColumnEditor({
	value,
	onChange,
	caseTypes,
	currentCaseType,
	sortedColumnCount,
	sortPriorityPosition,
	onEditSortOrder,
	onValidityChange,
}: ColumnEditorProps) {
	const ctx = useMemo<ColumnEditContext>(
		() => ({ caseTypes, currentCaseType }),
		[caseTypes, currentCaseType],
	);

	// Per-kind applicability check. Calculated columns have no
	// `field` slot to validate, so the check is skipped. For every
	// other kind, the schema's `applicableForProperty` predicate
	// against the resolved property is the structural gate;
	// mismatches surface inline next to the field picker.
	const applicabilityErrors = useMemo(() => {
		if (value.kind === "calculated") return [] as const;
		const property = resolveColumnProperty(ctx, value.field);
		const schema = columnCardSchemas[value.kind];
		if (schema.applicableForProperty(property)) return [] as const;
		const requirement =
			schema.applicabilityRequirement ?? "an applicable property";
		const dataType = resolveColumnPropertyDataType(ctx, value.field);
		return [
			`${schema.label} columns require ${requirement}; "${value.field}" is ${dataType ?? "untyped"}.`,
		] as const;
	}, [ctx, value]);

	// Standardized parent-validity propagation — fires on mount + on
	// every transition. The helper ref-stashes the callback so a
	// fresh-each-render parent identity doesn't trip the effect on
	// non-transitions.
	const isValid = applicabilityErrors.length === 0;
	useValidityPropagator({ isValid, onValidityChange });

	const schema = columnCardSchemas[value.kind];
	// Discriminated-union dispatch: each registry entry's
	// `component` is typed for its specific kind
	// (`Extract<Column, { kind: K }>`); the cast widens to the
	// `Column` union so the per-kind `value` / `onChange` types
	// land at the call site. TypeScript can't narrow per-kind
	// across a union dispatch (no flow-typing through an indexed
	// `record[discriminator]` access), so the same cast pattern
	// applies in `ChildPredicateEditor` and `ExpressionPicker`. The
	// `errors?: readonly string[]` slot is on the registry's
	// component type so a card that forgets to accept it fails to
	// compile rather than silently ignoring the prop.
	const Component = schema.component as React.ComponentType<{
		value: Column;
		onChange: (next: Column) => void;
		ctx: ColumnEditContext;
		errors?: readonly string[];
	}>;

	const visibleInList = value.visibleInList ?? true;
	const visibleInDetail = value.visibleInDetail ?? true;

	// Visibility toggles — the canonical "visible" default is absent;
	// toggling off writes `false`, toggling back to visible writes
	// `undefined` so the slot returns to absent and the parse stays
	// clean. (Schema reads `visibleInList ?? true` so absent ≡ true.)
	const setVisibleInList = (next: boolean) => {
		onChange(replaceSlot(value, "visibleInList", next ? undefined : false));
	};
	const setVisibleInDetail = (next: boolean) => {
		onChange(replaceSlot(value, "visibleInDetail", next ? undefined : false));
	};

	// Sort control — "off" drops the slot; switching on appends the
	// column at the end of the existing priority order; a direction
	// change preserves the existing priority. Per-column clears drop
	// the sort slot without renumbering peers, so the resulting
	// priority sequence may carry gaps (priorities `[0, 1, 2]` with
	// the middle column cleared becomes `[0, 2]`). Gaps are tolerated
	// by every layer — the schema doesn't enforce contiguity, the
	// wire emitter sorts by priority ascending, and
	// `resolveSortedColumns` tie-breaks to source-array index when
	// priorities collide. The list settings' sort-order stack
	// normalizes back to 0..N-1 the next time the user reorders.
	const sortSetting: "off" | SortDirection = value.sort?.direction ?? "off";
	const setSortSetting = (next: "off" | SortDirection) => {
		if (next === "off") {
			onChange(replaceSlot(value, "sort", undefined));
			return;
		}
		const priority = value.sort?.priority ?? sortedColumnCount;
		onChange(replaceSlot(value, "sort", { direction: next, priority }));
	};

	return (
		<PredicateEditProvider
			caseTypes={caseTypes}
			currentCaseType={currentCaseType}
			knownInputs={NO_SEARCH_INPUTS}
			validityIndex={EMPTY_VALIDITY_INDEX}
		>
			<InspectorSection label="Display">
				<KindPicker currentValue={value} onChange={onChange} ctx={ctx} />
				<Component
					value={value}
					onChange={onChange}
					ctx={ctx}
					errors={applicabilityErrors}
				/>
			</InspectorSection>

			<InspectorSection label="Visibility">
				<ToggleRow
					label="Show in the Case List"
					description="A column in the list itself."
					checked={visibleInList}
					onChange={setVisibleInList}
				/>
				<ToggleRow
					label="Show in Case Detail"
					description="A row on the screen that opens from the list."
					checked={visibleInDetail}
					onChange={setVisibleInDetail}
				/>
			</InspectorSection>

			<InspectorSection label="Sorting">
				<SegmentedRow
					legend="Sort the case list by this column"
					options={[
						{ value: "off", label: "Off" },
						{ value: "asc", label: "Ascending" },
						{ value: "desc", label: "Descending" },
					]}
					value={sortSetting}
					onChange={setSortSetting}
				/>
				<SortOrderNote
					position={sortPriorityPosition}
					sortedColumnCount={sortedColumnCount}
					onEditSortOrder={onEditSortOrder}
				/>
			</InspectorSection>
		</PredicateEditProvider>
	);
}

/**
 * What the sort setting means right now, in a sentence — and, when
 * several columns sort, the way to the list settings where their
 * order is arranged.
 */
function SortOrderNote({
	position,
	sortedColumnCount,
	onEditSortOrder,
}: {
	readonly position: number | undefined;
	readonly sortedColumnCount: number;
	readonly onEditSortOrder?: () => void;
}) {
	if (position === undefined) {
		return (
			<InspectorHint>
				Ascending runs A to Z, oldest to newest, lowest to highest.
			</InspectorHint>
		);
	}
	if (sortedColumnCount <= 1) {
		return <InspectorHint>The list follows this column's order.</InspectorHint>;
	}
	return (
		<div className="space-y-2">
			<InspectorHint>
				{position === 1
					? `First of ${sortedColumnCount} in the sort order — it sorts the whole list.`
					: `${ordinalWord(position)} of ${sortedColumnCount} in the sort order — it breaks ties left by the ones above it.`}
			</InspectorHint>
			{onEditSortOrder !== undefined && (
				<button
					type="button"
					onClick={onEditSortOrder}
					className="w-full min-h-11 px-3 text-[13px] rounded-lg border border-white/[0.06] text-nova-text-secondary hover:text-nova-violet-bright hover:border-nova-violet/30 transition-colors cursor-pointer"
				>
					Arrange the Sort Order…
				</button>
			)}
		</div>
	);
}

/** Ordinal words for sort positions — sorted-column lists are short,
 *  so the numeric fallback rarely shows. */
function ordinalWord(n: number): string {
	const words = ["First", "Second", "Third", "Fourth", "Fifth", "Sixth"];
	return words[n - 1] ?? `${n}th`;
}

/**
 * Map a kind to the field-and-header-preserving rebuild for the
 * target kind. The five non-calc kinds carry `field: string`, so a
 * kind swap among them ALWAYS preserves the field verbatim — non-
 * twin transitions reset the kind-specific extras (date pattern,
 * threshold, mapping table) to the target schema's defaults.
 *
 * Calculated columns have no `field`. Swapping FROM calc into a
 * field-bearing kind seeds the new column's field via the target
 * schema's default-value factory; swapping TO calc drops the
 * field entirely. Header is preserved on every transition. The
 * column's `uuid` and optional common slots (`sort`,
 * `visibleInList`, `visibleInDetail`) thread through verbatim —
 * they're identity / surface-visibility shape, not kind-specific.
 *
 * Exported as part of the module's tested surface — the
 * transformation is the contract (the emitted Column shape), so the
 * unit tests call it directly rather than driving the menu chrome.
 */
export function preservedColumnSwap(
	currentValue: Column,
	targetKind: ColumnKind,
	ctx: ColumnEditContext,
): Column {
	const { uuid, header } = currentValue;
	const slots = {
		sort: currentValue.sort,
		visibleInList: currentValue.visibleInList,
		visibleInDetail: currentValue.visibleInDetail,
	};
	// Field source: the current value's field if the source has one;
	// otherwise the target schema's default-picked field.
	const sourceField = "field" in currentValue ? currentValue.field : "";

	switch (targetKind) {
		case "plain":
			return plainColumn(
				uuid,
				sourceField || pickFieldFromTarget(ctx, "plain"),
				header,
				slots,
			);
		case "phone":
			return phoneColumn(
				uuid,
				sourceField || pickFieldFromTarget(ctx, "phone"),
				header,
				slots,
			);
		case "date": {
			// Twin: source is already a date column → preserve the
			// pattern verbatim. Otherwise fall back to the target
			// schema's default pattern.
			const seed = columnCardSchemas.date.defaultValue(ctx);
			const pattern =
				currentValue.kind === "date" ? currentValue.pattern : seed.pattern;
			return dateColumn(
				uuid,
				sourceField || seed.field,
				header,
				pattern,
				slots,
			);
		}
		case "id-mapping": {
			// Twin: source is already id-mapping → preserve the table.
			const mapping =
				currentValue.kind === "id-mapping" ? currentValue.mapping : [];
			return idMappingColumn(
				uuid,
				sourceField || pickFieldFromTarget(ctx, "id-mapping"),
				header,
				mapping,
				slots,
			);
		}
		case "image-map": {
			// Twin: source is already image-map → preserve the value→image
			// table. id-mapping's table has incompatible entry shape
			// ({value,label} vs {value,assetId}), so a cross-kind swap
			// starts empty rather than mis-mapping labels onto images.
			const mapping =
				currentValue.kind === "image-map" ? currentValue.mapping : [];
			return imageMapColumn(
				uuid,
				sourceField || pickFieldFromTarget(ctx, "image-map"),
				header,
				mapping,
				slots,
			);
		}
		case "interval": {
			// Twin: source is already interval → preserve every
			// kind-specific extra (threshold, unit, display, text).
			// Non-twin sources seed the extras from the target schema's
			// default factory.
			const seed = columnCardSchemas.interval.defaultValue(ctx);
			if (currentValue.kind === "interval") {
				return intervalColumn(
					uuid,
					currentValue.field,
					header,
					currentValue.threshold,
					currentValue.unit,
					currentValue.display,
					currentValue.text,
					slots,
				);
			}
			return intervalColumn(
				uuid,
				sourceField || seed.field,
				header,
				seed.threshold,
				seed.unit,
				seed.display,
				seed.text,
				slots,
			);
		}
		case "calculated": {
			// Twin: source is already calculated → preserve the
			// expression verbatim. Non-twin sources seed an empty-
			// string literal expression — the same shape the schema's
			// `defaultValue` factory uses, kept inline here so a kind
			// swap doesn't pull a fresh uuid via the factory.
			const expression =
				currentValue.kind === "calculated"
					? currentValue.expression
					: term(literal(""));
			return calculatedColumn(uuid, header, expression, slots);
		}
	}
}

/** Pick the target schema's default field for a non-calc kind. The
 *  default factory mints a uuid we don't want here (the kind swap
 *  preserves the source's uuid), so the helper invokes the factory
 *  and discards everything but the field. */
function pickFieldFromTarget(
	ctx: ColumnEditContext,
	target: Exclude<ColumnKind, "calculated">,
): string {
	const seed = columnCardSchemas[target].defaultValue(ctx);
	return seed.field;
}

/**
 * Full-width "Display as" picker — swaps the column's kind while
 * preserving the header (every kind shares the slot) and the
 * kind-specific extras across structural-twin transitions (see
 * `preservedColumnSwap`).
 *
 * Kinds the current property can't run (a date format over a text
 * property, say) stay clickable — same convention as the predicate /
 * expression kind menus, so authors switching kinds mid-edit aren't
 * locked out by transient property mismatches — but dim and say what
 * they need instead of their normal description.
 */
function KindPicker({
	currentValue,
	onChange,
	ctx,
}: {
	readonly currentValue: Column;
	readonly onChange: (next: Column) => void;
	readonly ctx: ColumnEditContext;
}) {
	const triggerRef = useRef<HTMLButtonElement>(null);
	const property =
		currentValue.kind === "calculated"
			? undefined
			: resolveColumnProperty(ctx, currentValue.field);
	const currentKind = currentValue.kind;
	const currentSchema = columnCardSchemas[currentKind];

	const replaceWith = <K extends ColumnKind>(schema: ColumnCardSchema<K>) => {
		onChange(preservedColumnSwap(currentValue, schema.kind, ctx));
	};

	return (
		<Menu.Root>
			<Menu.Trigger
				ref={triggerRef}
				aria-label={`Display as: ${currentSchema.label}`}
				className={CONSOLE_TRIGGER_CLS}
			>
				<Icon
					icon={currentSchema.icon}
					width="16"
					height="16"
					className="text-nova-violet-bright shrink-0"
				/>
				<span className="flex-1 min-w-0 text-left">
					<span className="block text-nova-text">{currentSchema.label}</span>
					<span className="block text-[11px] text-nova-text-muted truncate">
						{currentSchema.description}
					</span>
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
					style={{ minWidth: "var(--anchor-width)", maxHeight: 360 }}
				>
					<Menu.Popup
						className={`${MENU_POPUP_CLS} max-h-[22.5rem] overflow-y-auto min-w-[19rem]`}
					>
						{columnCardSchemaList.map((s, i) => {
							const isCurrent = s.kind === currentKind;
							// Calculated source has no property; every target kind
							// stays at full opacity. Otherwise consult the
							// per-target schema's applicability predicate against
							// the current property.
							const isApplicable =
								currentValue.kind === "calculated"
									? true
									: s.applicableForProperty(property);
							const last = columnCardSchemaList.length - 1;
							const corners =
								i === 0 && i === last
									? "rounded-xl"
									: i === 0
										? "rounded-t-xl"
										: i === last
											? "rounded-b-xl"
											: "";
							return (
								<Menu.Item
									key={s.kind}
									onClick={() => replaceWith(s)}
									disabled={isCurrent}
									className={`${corners} ${MENU_ITEM_CLS} ${CONSOLE_MENU_ITEM_MIN} ${
										isCurrent ? "text-nova-violet-bright bg-nova-violet/10" : ""
									} ${isApplicable ? "" : "opacity-45"}`}
								>
									<Icon
										icon={s.icon}
										width="15"
										height="15"
										className={
											isCurrent
												? "text-nova-violet-bright"
												: "text-nova-text-muted"
										}
									/>
									<span className="flex-1 text-left min-w-0">
										<div className="truncate">{s.label}</div>
										<div
											className={`text-[11px] truncate ${
												isCurrent
													? "text-nova-violet-bright"
													: "text-nova-text-muted"
											}`}
										>
											{isApplicable
												? s.description
												: `Needs ${s.applicabilityRequirement ?? "a different property"}.`}
										</div>
									</span>
									{isCurrent && (
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

// ── Slot replacement helper ────────────────────────────────────────
//
// `replaceSlot` produces a fresh column object with one optional slot
// replaced. Drops keys whose value is `undefined` so the output shape
// round-trips equal to a freshly-built column under the schema's
// strip-mode parse. The discriminated-union narrowing is preserved
// because `Pick<Column, "kind" | ...required>` is intersected with
// the rebuilt optional slots — TypeScript carries the kind discriminator
// through the spread on each arm.

function replaceSlot<K extends "sort" | "visibleInList" | "visibleInDetail">(
	value: Column,
	key: K,
	next: Column[K],
): Column {
	const baseSlots = {
		sort: value.sort,
		visibleInList: value.visibleInList,
		visibleInDetail: value.visibleInDetail,
	};
	const merged = { ...baseSlots, [key]: next };
	const optional: {
		sort?: ColumnSort;
		visibleInList?: boolean;
		visibleInDetail?: boolean;
	} = {};
	if (merged.sort !== undefined) optional.sort = merged.sort;
	if (merged.visibleInList !== undefined)
		optional.visibleInList = merged.visibleInList;
	if (merged.visibleInDetail !== undefined)
		optional.visibleInDetail = merged.visibleInDetail;
	// Strip the existing optional slots from the incoming column then
	// reapply the cleaned set. This keeps the column's required slots
	// (uuid, kind, field/header/etc.) intact while ensuring the
	// optional slots reflect the updated state — including absent keys
	// when the user toggles a slot back to its default.
	const {
		sort: _s,
		visibleInList: _v,
		visibleInDetail: _d,
		...required
	} = value;
	return { ...required, ...optional } as Column;
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
