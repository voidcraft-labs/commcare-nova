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
//      machinery the predicate / expression editors use. Column
//      editing has no relation walks and no search-input bindings,
//      so the validity index is built directly from the per-kind
//      applicability check rather than a recursive walker — but
//      the provider is still the right context type since the
//      pickers' contract is "read the active case-type from
//      here."
//
//   2. Computes the kind-vs-property-type applicability error
//      list for the current `value`. The kind's
//      `applicableForProperty(...)` predicate against the resolved
//      property is the structural gate; mismatches surface as
//      inline errors next to the field picker AND propagate to
//      the parent's `onValidityChange` so the surrounding save
//      affordance can gate.
//
//   3. Wraps the matched card in a `CardShell` styled to match
//      the predicate / expression cards (frosted glass, violet
//      accent, kebab-less header for the top-level mount). The
//      shell also surfaces a kind-replace menu that swaps the
//      column's `kind` while preserving `field` + `header` —
//      the two slots every kind shares.

"use client";
import { Menu } from "@base-ui/react/menu";
import { Icon } from "@iconify/react/offline";
import { useEffect, useMemo, useRef } from "react";
import type { CaseType, Column, ColumnKind } from "@/lib/domain";
import {
	dateColumn,
	idMappingColumn,
	lateFlagColumn,
	phoneColumn,
	plainColumn,
	searchOnlyColumn,
	timeSinceUntilColumn,
} from "@/lib/domain";
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
import { PredicateEditProvider } from "./editorContext";
import { CardShell } from "./primitives/CardShell";

/**
 * Module-scoped empty validity-index passed to the predicate
 * provider. The column editor surfaces applicability errors via
 * the `errors` prop on each card (NOT through the
 * `useEditorErrorsAt` lookup the predicate / expression editors
 * use), so the index is unused — but the provider's contract
 * requires one. Pinning a single empty Map avoids re-allocating
 * a fresh map on every render.
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
 * applicability check, the kind-replace menu, and the context
 * plumbing into the shared `PredicateEditProvider`.
 */
export function ColumnEditor({
	value,
	onChange,
	caseTypes,
	currentCaseType,
	onValidityChange,
}: ColumnEditorProps) {
	const ctx = useMemo<ColumnEditContext>(
		() => ({ caseTypes, currentCaseType }),
		[caseTypes, currentCaseType],
	);

	// Per-kind applicability check. The schema's
	// `applicableForProperty` predicate decides whether the
	// resolved property's data type is admissible for the kind;
	// mismatches surface inline next to the field picker. The
	// kind's `applicabilityRequirement` string names the
	// requirement in the inline hint — kinds with no requirement
	// (Plain / ID-Mapping / Search-Only) never reach this branch
	// because their applicability check always returns true.
	const applicabilityErrors = useMemo(() => {
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

	// Propagate the validity verdict to the parent. Same
	// ref-stash pattern as the predicate / expression editors —
	// keeps a fresh-each-render parent callback identity from
	// tripping the effect on non-transitions.
	const onValidityChangeRef = useRef(onValidityChange);
	onValidityChangeRef.current = onValidityChange;
	const isValid = applicabilityErrors.length === 0;
	useEffect(() => {
		onValidityChangeRef.current?.(isValid);
	}, [isValid]);

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
					<KindReplaceMenu currentValue={value} onChange={onChange} ctx={ctx} />
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
 * target kind. Every column kind carries `field: string` and
 * `header: string`, so a kind swap can ALWAYS preserve those two
 * slots verbatim — non-twin transitions reset the kind-specific
 * extras (date pattern, threshold, mapping table, etc.) to the
 * target schema's defaults.
 *
 * Returns the rebuilt column for every transition. Routes through
 * the per-kind builder so the constructed shape always matches
 * the schema; ad-hoc literals would drift if the schema's per-arm
 * shape ever changed. The target schema's `defaultValue(...)`
 * factory provides the kind-specific extras (calling
 * `defaultValue` and overwriting `field` + `header` would discard
 * the factory's chosen extras after they were just computed —
 * inverting through builders avoids the redundant pass).
 */
function preservedColumnSwap(
	currentValue: Column,
	targetKind: ColumnKind,
	ctx: ColumnEditContext,
): Column {
	const { field, header } = currentValue;
	switch (targetKind) {
		case "plain":
			return plainColumn(field, header);
		case "phone":
			return phoneColumn(field, header);
		case "search-only":
			return searchOnlyColumn(field, header);
		case "date": {
			// Twin: the source is already a date column → preserve the
			// pattern verbatim. Otherwise fall back to the target
			// schema's default pattern.
			const seed = columnCardSchemas.date.defaultValue(ctx);
			const pattern =
				currentValue.kind === "date" ? currentValue.pattern : seed.pattern;
			return dateColumn(field, header, pattern);
		}
		case "id-mapping": {
			// Twin: source is already id-mapping → preserve the table.
			const mapping =
				currentValue.kind === "id-mapping" ? currentValue.mapping : [];
			return idMappingColumn(field, header, mapping);
		}
		case "time-since-until": {
			// Twin pair: time-since-until ↔ late-flag share
			// `(threshold, unit)` — preserve the pair when the source
			// is either kind. The text slot (`displayLabel`) seeds from
			// the target schema's default for non-twin sources or the
			// source's own value when the kinds match.
			const seed = columnCardSchemas["time-since-until"].defaultValue(ctx);
			if (currentValue.kind === "time-since-until") {
				return timeSinceUntilColumn(
					field,
					header,
					currentValue.threshold,
					currentValue.unit,
					currentValue.displayLabel,
				);
			}
			if (currentValue.kind === "late-flag") {
				return timeSinceUntilColumn(
					field,
					header,
					currentValue.threshold,
					currentValue.unit,
					seed.displayLabel,
				);
			}
			return timeSinceUntilColumn(
				field,
				header,
				seed.threshold,
				seed.unit,
				seed.displayLabel,
			);
		}
		case "late-flag": {
			const seed = columnCardSchemas["late-flag"].defaultValue(ctx);
			if (currentValue.kind === "late-flag") {
				return lateFlagColumn(
					field,
					header,
					currentValue.threshold,
					currentValue.unit,
					currentValue.flagDisplayValue,
				);
			}
			if (currentValue.kind === "time-since-until") {
				return lateFlagColumn(
					field,
					header,
					currentValue.threshold,
					currentValue.unit,
					seed.flagDisplayValue,
				);
			}
			return lateFlagColumn(
				field,
				header,
				seed.threshold,
				seed.unit,
				seed.flagDisplayValue,
			);
		}
	}
}

/**
 * Menu that replaces the current card's column kind with another.
 * Every kind transition preserves `field` + `header` (every kind
 * shares both slots); kind-specific extras (date pattern,
 * threshold, mapping table) are preserved across structural-twin
 * transitions and reset to the target schema's defaults
 * otherwise.
 *
 * Inapplicable kinds (per the schema's `applicableForProperty`
 * predicate against the current resolved property) render with
 * reduced opacity but stay clickable — same convention as the
 * predicate-side `KindReplaceMenu` in `ChildPredicateEditor`.
 * The applicability gate de-emphasizes structurally inadvisable
 * authoring without locking the author out (the inline error
 * surface and parent save affordance handle the structural
 * rejection).
 */
function KindReplaceMenu({
	currentValue,
	onChange,
	ctx,
}: KindReplaceMenuProps) {
	const triggerRef = useRef<HTMLButtonElement>(null);
	const property = resolveColumnProperty(ctx, currentValue.field);
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
							const isApplicable = s.applicableForProperty(property);
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
