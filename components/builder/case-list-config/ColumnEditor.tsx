// components/builder/case-list-config/ColumnEditor.tsx
//
// Top-level Column authoring surface. Renders a single `Column`
// AST node as a card via the registry-driven dispatch in
// `columnEditorSchemas.ts`. The editor:
//
//   1. Mounts a `PredicateEditProvider` carrying the case-type
//      schema. The shared property pickers (`PropertyPicker` from
//      `primitives/`) read `caseTypes` / `currentCaseType` from
//      this provider, so column cards plug into the same context
//      machinery the predicate / expression editors use. Calculated
//      columns rely on the same provider for their nested
//      `ExpressionCardEditor` mount.
//
//   2. Computes the kind-vs-property-type applicability error list
//      for the current `value`. Calculated columns skip this check
//      entirely — they have no `field`, so per-property
//      applicability doesn't apply. Mismatches surface as inline
//      errors next to the field picker AND propagate to the
//      parent's `onValidityChange` so the surrounding save
//      affordance can gate.
//
//   3. Wraps the matched card in a `CardShell` styled to match
//      the predicate / expression cards (frosted glass, violet
//      accent, kebab-less header for the top-level mount). The
//      shell surfaces three pieces of chrome:
//        - kind-replace menu (swap kinds while preserving header)
//        - per-column visibility toggles (list / detail)
//        - per-column sort affordance (direction toggle + priority
//          badge)
//      All three live in the shell rather than inside per-kind
//      cards because they bind to slots (`sort`, `visibleInList`,
//      `visibleInDetail`) every kind shares — including the
//      field-less calculated arm.

"use client";
import { Menu } from "@base-ui/react/menu";
import { Icon } from "@iconify/react/offline";
import { useMemo, useRef } from "react";
import { PredicateEditProvider } from "@/components/builder/shared/editorContext";
import { CardShell } from "@/components/builder/shared/primitives/CardShell";
import { useValidityPropagator } from "@/components/builder/shared/useInnerValidityShadow";
import type { CaseType, Column, ColumnKind } from "@/lib/domain";
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
import { ColumnAffordancesRow } from "./cards/column/ColumnAffordancesRow";
import {
	type ColumnCardSchema,
	type ColumnEditContext,
	columnCardSchemaList,
	columnCardSchemas,
	resolveColumnProperty,
	resolveColumnPropertyDataType,
} from "./columnEditorSchemas";

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
	 * is set. Drives the `ColumnAffordancesRow`'s priority
	 * assignment for a freshly-toggled sort — the new column lands
	 * at the end of the existing priority order so the user's first
	 * sorted column is the primary.
	 */
	readonly sortedColumnCount: number;
	/**
	 * The column's resolved sort priority position among its sorted
	 * peers (1-based). `undefined` when the column isn't sorted.
	 * Drives the priority badge in `ColumnAffordancesRow`.
	 */
	readonly sortPriorityPosition: number | undefined;
	/**
	 * Surfaces the boolean validity verdict to the parent on
	 * every onChange. The parent gates its save affordance on
	 * this. The editor does not gate the onChange itself —
	 * invalid edits flow through so the user can keep authoring.
	 */
	readonly onValidityChange?: (valid: boolean) => void;
}

/**
 * Top-level Column card editor. The dispatch shell handles every
 * column kind via the registry; this file's job is the
 * applicability check, the kind-replace + visibility + sort
 * affordances, and the context plumbing into the shared
 * `PredicateEditProvider`.
 */
export function ColumnEditor({
	value,
	onChange,
	caseTypes,
	currentCaseType,
	sortedColumnCount,
	sortPriorityPosition,
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

	return (
		<PredicateEditProvider
			caseTypes={caseTypes}
			currentCaseType={currentCaseType}
			knownInputs={[]}
			validityIndex={EMPTY_VALIDITY_INDEX}
		>
			<CardShell
				icon={schema.icon}
				label={schema.label}
				kindAccent={
					<span className="inline-flex items-center gap-2">
						<KindReplaceMenu
							currentValue={value}
							onChange={onChange}
							ctx={ctx}
						/>
						<ColumnAffordancesRow
							value={value}
							onChange={onChange}
							sortedColumnCount={sortedColumnCount}
							sortPriorityPosition={sortPriorityPosition}
						/>
					</span>
				}
			>
				<Component
					value={value}
					onChange={onChange}
					ctx={ctx}
					errors={applicabilityErrors}
				/>
			</CardShell>
		</PredicateEditProvider>
	);
}

interface KindReplaceMenuProps {
	readonly currentValue: Column;
	readonly onChange: (next: Column) => void;
	readonly ctx: ColumnEditContext;
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
 * Menu that replaces the current card's column kind with another.
 * Every kind transition preserves `header` (every kind shares the
 * slot); kind-specific extras (date pattern, threshold, mapping
 * table, expression) are preserved across structural-twin
 * transitions and reset to the target schema's defaults otherwise.
 * The `uuid` and optional common slots (`sort`, `visibleInList`,
 * `visibleInDetail`) thread through verbatim.
 *
 * Inapplicable kinds (per the schema's `applicableForProperty`
 * predicate against the current resolved property) render with
 * reduced opacity but stay clickable — same convention as the
 * predicate-side `KindReplaceMenu` in `ChildPredicateEditor`.
 * The applicability gate de-emphasizes structurally inadvisable
 * authoring without locking the author out (the inline error
 * surface and parent save affordance handle the structural
 * rejection). Calculated columns have no field, so the
 * applicability gate is skipped — every kind appears at full
 * opacity when the source is calc.
 */
function KindReplaceMenu({
	currentValue,
	onChange,
	ctx,
}: KindReplaceMenuProps) {
	const triggerRef = useRef<HTMLButtonElement>(null);
	const property =
		currentValue.kind === "calculated"
			? undefined
			: resolveColumnProperty(ctx, currentValue.field);
	const currentKind = currentValue.kind;

	const replaceWith = <K extends ColumnKind>(schema: ColumnCardSchema<K>) => {
		onChange(preservedColumnSwap(currentValue, schema.kind, ctx));
	};

	return (
		<Menu.Root>
			<Menu.Trigger
				ref={triggerRef}
				aria-label="Change column type"
				className="group flex items-center gap-1 px-1.5 py-0.5 text-[10px] uppercase tracking-wider rounded text-nova-text-muted/60 hover:text-nova-violet-bright hover:bg-white/[0.04] transition-colors cursor-pointer"
			>
				<span>Change</span>
				<svg
					aria-hidden="true"
					width="8"
					height="8"
					viewBox="0 0 10 10"
					className="shrink-0 transition-transform group-data-[popup-open]:rotate-180"
				>
					<path
						d="M2 3.5L5 6.5L8 3.5"
						stroke="currentColor"
						strokeWidth="1.4"
						fill="none"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			</Menu.Trigger>
			<Menu.Portal>
				<Menu.Positioner
					side="bottom"
					align="end"
					sideOffset={4}
					anchor={triggerRef}
					className={MENU_POSITIONER_CLS}
					style={{ maxHeight: 320 }}
				>
					<Menu.Popup
						className={`${MENU_POPUP_CLS} max-h-80 overflow-y-auto min-w-[18rem]`}
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
							const cls = [
								corners,
								MENU_ITEM_CLS,
								isCurrent ? "text-nova-violet-bright bg-nova-violet/10" : "",
								isApplicable ? "" : "opacity-40",
							].join(" ");
							return (
								<Menu.Item
									key={s.kind}
									onClick={() => replaceWith(s)}
									// The current kind would re-render and recompute
									// for a structurally identical column;
									// disabling stops the no-op click. Inapplicable
									// kinds stay clickable — same convention as the
									// predicate / expression kind menus — so authors
									// who want to switch kinds mid-edit aren't
									// locked out by transient property mismatches.
									disabled={isCurrent}
									className={cls}
								>
									<Icon
										icon={s.icon}
										width="14"
										height="14"
										className={
											isCurrent
												? "text-nova-violet-bright"
												: "text-nova-text-muted"
										}
									/>
									<span className="flex-1 text-left min-w-0">
										<div className="truncate">{s.label}</div>
										<div
											className={`text-[10px] truncate ${
												isCurrent
													? "text-nova-violet-bright/60"
													: "text-nova-text-muted"
											}`}
										>
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
