// components/builder/shared/cards/MultiSelectContainsCard.tsx
//
// Renders the `multi-select-contains` predicate. Property dropdown
// (multi_select-typed only) + selectable token chips drawn from
// the property's declared `options` + Any / All quantifier toggle.
//
// Tokens edit as a list of `Literal`s; the schema's tuple-with-rest
// requires at least one. Each chip surfaces its index in the
// `values` array — type-checker errors land per-chip via the
// `[..., "values", i]` path.

"use client";
import { Icon } from "@iconify/react/offline";
import tablerCheck from "@iconify-icons/tabler/check";
import tablerPlus from "@iconify-icons/tabler/plus";
import tablerX from "@iconify-icons/tabler/x";
import { useMemo, useRef } from "react";
import { Button } from "@/components/shadcn/button";
import {
	DropdownMenu,
	DropdownMenuItem,
	DropdownMenuPopup,
	DropdownMenuPortal,
	DropdownMenuPositioner,
	DropdownMenuTrigger,
} from "@/components/shadcn/dropdown-menu";
import { SimpleTooltip } from "@/components/shadcn/tooltip";
import { type CaseProperty, canonicalCasePropertyName } from "@/lib/domain";
import {
	type Literal,
	literal,
	multiSelectAll,
	multiSelectAny,
	type Predicate,
	type PropertyRef,
	prop,
} from "@/lib/domain/predicate";
import { useEditorErrorsAt, usePredicateEditContext } from "../editorContext";
import type { PredicateEditContext } from "../editorSchemas";
import { removeAndRestoreFocus } from "../focusAfterRemoval";
import { appendSlot, appendSlotIndex, type EditorPath } from "../path";
import { InlineError } from "../primitives/CardShell";
import { PropertyRefPicker } from "../primitives/PropertyRefPicker";
import {
	type StableListOperation,
	useStableListIdentity,
} from "../useStableListIdentity";
import { PredicateVerbMenu } from "./PredicateVerbMenu";

/** Module-level filter so render-time identity stays stable —
 *  `PropertyPicker`'s `useMemo` on `[caseType, filter]` invalidates
 *  on each fresh-arrow filter, even when the actual selection rule
 *  is constant. */
const MULTI_SELECT_PROPERTY_FILTER = (p: { data_type?: string }): boolean =>
	p.data_type === "multi_select";

/**
 * Build the default `multi-select-contains` predicate. Picks the
 * first multi_select-typed property (the kind's only valid target
 * per the type checker) and seeds with the property's first
 * declared option as a single-token list — the schema requires at
 * least one value.
 */
export function multiSelectContainsDefault(
	ctx: PredicateEditContext,
): Extract<Predicate, { kind: "multi-select-contains" }> {
	const ct = ctx.caseTypes.find((c) => c.name === ctx.currentCaseType);
	const property = ct?.properties.find((p) => p.data_type === "multi_select");
	const propName = canonicalCasePropertyName(property?.name ?? "");
	const firstOption = property?.options?.[0]?.value ?? "";
	return multiSelectAny(
		prop(ctx.currentCaseType, propName),
		literal(firstOption),
	);
}

interface MultiSelectContainsCardProps {
	readonly value: Extract<Predicate, { kind: "multi-select-contains" }>;
	readonly onChange: (next: Predicate) => void;
	readonly path: EditorPath;
}

export function MultiSelectContainsCard({
	value,
	onChange,
	path,
}: MultiSelectContainsCardProps) {
	const ctx = usePredicateEditContext();
	const propertyErrors = useEditorErrorsAt(appendSlot(path, "property"));
	const rowIdentity = useStableListIdentity(value.values);

	const ct = useMemo(
		() => ctx.caseTypes.find((c) => c.name === ctx.currentCaseType),
		[ctx.caseTypes, ctx.currentCaseType],
	);
	const property = useMemo<CaseProperty | undefined>(
		() => ct?.properties.find((p) => p.name === value.property.property),
		[ct, value.property.property],
	);

	const allOptions = property?.options ?? [];
	const selectedValues = new Set<string>(
		value.values
			.map((v) => v.value)
			.filter((v): v is string => typeof v === "string"),
	);

	const setProperty = (next: PropertyRef) => {
		// On property switch, reset values to the new property's first
		// option (keeping the schema's non-empty invariant) — the
		// previous property's options have no semantic continuity with
		// the new property's tokens. The `next` ref carries the
		// preserved `via` walk (if any) verbatim — `PropertyRefPicker`'s
		// canonical-edit branch rebuilds via `prop(caseType, name, via)`.
		const nextProp = ct?.properties.find((p) => p.name === next.property);
		const seed = nextProp?.options?.[0]?.value ?? "";
		const builder =
			value.quantifier === "all" ? multiSelectAll : multiSelectAny;
		const firstValue = literal(seed);
		const nextValues = [firstValue];
		rowIdentity.stage(nextValues, { kind: "reset" });
		onChange(builder(next, firstValue));
	};

	const commitValues = (
		next: readonly Literal[],
		operation: StableListOperation,
	) => {
		// The schema rejects an empty values list. Keep the guard at the
		// mutation boundary even though the last chip has no remove action.
		if (next.length === 0) return;
		const builder =
			value.quantifier === "all" ? multiSelectAll : multiSelectAny;
		const [first, ...rest] = next;
		rowIdentity.stage(next, operation);
		onChange(builder(value.property, first, ...rest));
	};

	const addOption = (optionValue: string) => {
		if (selectedValues.has(optionValue)) return;
		commitValues([...value.values, literal(optionValue)], {
			kind: "splice",
			index: value.values.length,
			deleteCount: 0,
			insertCount: 1,
		});
	};

	const removeValueAt = (index: number) => {
		commitValues(
			value.values.filter((_, valueIndex) => valueIndex !== index),
			{
				kind: "splice",
				index,
				deleteCount: 1,
				insertCount: 0,
			},
		);
	};

	return (
		<div className="space-y-2">
			<div className="grid grid-cols-1 @md:grid-cols-[1fr_auto] gap-2 items-start">
				<div>
					<PropertyRefPicker
						mode="property-only"
						value={value.property}
						onChange={setProperty}
						filter={MULTI_SELECT_PROPERTY_FILTER}
						invalid={propertyErrors.length > 0}
						ariaLabel="Multiple-choice information"
					/>
					<InlineError errors={propertyErrors} />
				</div>
				{/* The verb carries the any/all quantifier — "includes any
				 *  of" / "includes all of" are two verbs, not a verb plus a
				 *  separate toggle. */}
				<PredicateVerbMenu value={value} onChange={onChange} />
			</div>

			{/* Token chip list. Each chip shows its label + X-to-remove;
			 *  per-chip type errors land at `[..., "values", i]`. */}
			<TokenList
				values={value.values}
				rowKeys={rowIdentity.keys}
				options={allOptions}
				selectedValues={selectedValues}
				onAddOption={addOption}
				onRemoveValue={removeValueAt}
				path={path}
			/>
		</div>
	);
}

function TokenList({
	values,
	rowKeys,
	options,
	selectedValues,
	onAddOption,
	onRemoveValue,
	path,
}: {
	readonly values: readonly Literal[];
	readonly rowKeys: readonly string[];
	readonly options: readonly { value: string; label: string }[];
	readonly selectedValues: ReadonlySet<string>;
	readonly onAddOption: (value: string) => void;
	readonly onRemoveValue: (index: number) => void;
	readonly path: EditorPath;
}) {
	if (options.length === 0) {
		return (
			<div className="rounded-md border border-dashed border-white/[0.06] px-3 py-2 text-[13px] text-nova-text-muted">
				This information has no choices yet
			</div>
		);
	}
	const labelCounts = new Map<string, number>();
	for (const option of options) {
		labelCounts.set(option.label, (labelCounts.get(option.label) ?? 0) + 1);
	}
	const ambiguousLabels = new Set(
		[...labelCounts].filter(([, count]) => count > 1).map(([label]) => label),
	);
	const lastSelectedIndex = values.length - 1;
	return (
		<div className="space-y-1.5">
			<div className="flex flex-wrap gap-1.5">
				{values.map((v, i) => {
					const optLabel =
						options.find((o) => o.value === v.value)?.label ?? String(v.value);
					return (
						<TokenChip
							key={rowKeys[i]}
							label={optLabel}
							disambiguator={
								ambiguousLabels.has(optLabel) ? String(v.value) : undefined
							}
							onRemove={() => onRemoveValue(i)}
							isOnlyOne={lastSelectedIndex === 0}
							indexPath={appendSlotIndex(path, "values", i)}
						/>
					);
				})}
				<OptionPicker
					options={options}
					selectedValues={selectedValues}
					ambiguousLabels={ambiguousLabels}
					onPick={onAddOption}
				/>
			</div>
		</div>
	);
}

function TokenChip({
	label,
	disambiguator,
	onRemove,
	isOnlyOne,
	indexPath,
}: {
	readonly label: string;
	readonly disambiguator: string | undefined;
	readonly onRemove: () => void;
	readonly isOnlyOne: boolean;
	readonly indexPath: EditorPath;
}) {
	const errors = useEditorErrorsAt(indexPath);
	const invalid = errors.length > 0;
	const cls = [
		"group inline-flex min-h-11 items-center gap-1 rounded-lg border py-0.5 pr-0.5 pl-3 text-sm transition-colors",
		invalid
			? "border-nova-rose/40 bg-nova-rose/10 text-nova-rose"
			: "border-nova-violet/25 bg-nova-violet/10 text-nova-violet-bright",
	].join(" ");
	return (
		<SimpleTooltip content={invalid ? errors.join("\n") : undefined}>
			<span className={cls} data-removal-focus-row>
				<span>{label}</span>
				{disambiguator !== undefined && (
					<span className="text-xs text-nova-text-muted">
						({disambiguator})
					</span>
				)}
				{!isOnlyOne && (
					<Button
						type="button"
						variant="ghost"
						size="icon-lg"
						aria-label={`Remove ${label}${disambiguator === undefined ? "" : `, saved as ${disambiguator}`}`}
						onClick={(event) =>
							removeAndRestoreFocus(event.currentTarget, onRemove)
						}
						data-removal-action
						className="size-11 rounded-md text-nova-text-muted not-disabled:hover:bg-white/[0.08] not-disabled:hover:text-nova-violet-bright dark:not-disabled:hover:bg-white/[0.08]"
					>
						<Icon icon={tablerX} width="12" height="12" />
					</Button>
				)}
			</span>
		</SimpleTooltip>
	);
}

function OptionPicker({
	options,
	selectedValues,
	ambiguousLabels,
	onPick,
}: {
	readonly options: readonly { value: string; label: string }[];
	readonly selectedValues: ReadonlySet<string>;
	readonly ambiguousLabels: ReadonlySet<string>;
	readonly onPick: (value: string) => void;
}) {
	const triggerRef = useRef<HTMLButtonElement>(null);
	const remaining = options.filter((o) => !selectedValues.has(o.value));
	if (remaining.length === 0) return null;

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				ref={triggerRef}
				aria-label="Add option"
				data-removal-focus-fallback
				render={
					<Button
						type="button"
						variant="outline"
						size="xl"
						className="gap-1.5 border-dashed border-white/[0.10] bg-transparent px-3 text-sm text-nova-text-muted not-disabled:hover:border-nova-violet/30 not-disabled:hover:bg-transparent not-disabled:hover:text-nova-violet-bright dark:bg-transparent dark:not-disabled:hover:bg-transparent"
					/>
				}
			>
				<Icon icon={tablerPlus} width="13" height="13" />
				<span>Add option</span>
			</DropdownMenuTrigger>
			<DropdownMenuPortal>
				<DropdownMenuPositioner
					side="bottom"
					align="start"
					sideOffset={4}
					anchor={triggerRef}
				>
					<DropdownMenuPopup className="max-h-72">
						{remaining.map((opt) => {
							return (
								<DropdownMenuItem
									key={opt.value}
									onClick={() => onPick(opt.value)}
								>
									<Icon
										icon={tablerCheck}
										width="14"
										height="14"
										className="opacity-0 group-data-[selected]:opacity-100"
									/>
									<span className="min-w-0 flex-1 text-left">
										<div className="break-words">{opt.label}</div>
										{ambiguousLabels.has(opt.label) && (
											<div className="break-words text-xs text-nova-text-muted">
												Saved as {opt.value}
											</div>
										)}
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
