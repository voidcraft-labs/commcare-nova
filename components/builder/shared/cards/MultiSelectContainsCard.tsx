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
import { Menu } from "@base-ui/react/menu";
import { Icon } from "@iconify/react/offline";
import tablerCheck from "@iconify-icons/tabler/check";
import tablerPlus from "@iconify-icons/tabler/plus";
import tablerX from "@iconify-icons/tabler/x";
import { useMemo, useRef } from "react";
import { Tooltip } from "@/components/ui/Tooltip";
import type { CaseProperty } from "@/lib/domain";
import {
	type Literal,
	literal,
	multiSelectAll,
	multiSelectAny,
	type Predicate,
	type PropertyRef,
	prop,
} from "@/lib/domain/predicate";
import {
	MENU_ITEM_CLS,
	MENU_POPUP_CLS,
	MENU_POSITIONER_CLS,
} from "@/lib/styles";
import { useEditorErrorsAt, usePredicateEditContext } from "../editorContext";
import type { PredicateEditContext } from "../editorSchemas";
import { nodeId } from "../nodeIdentity";
import { appendSlot, appendSlotIndex, type EditorPath } from "../path";
import { InlineError } from "../primitives/CardShell";
import { PropertyRefPicker } from "../primitives/PropertyRefPicker";
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
	const propName = property?.name ?? "";
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
		onChange(builder(next, literal(seed)));
	};

	const toggleOption = (optionValue: string) => {
		const next = selectedValues.has(optionValue)
			? value.values.filter((v) => v.value !== optionValue)
			: [...value.values, literal(optionValue)];
		// The schema rejects an empty values list. When the toggle
		// would empty the list, ignore the click — the author must
		// pick at least one token. Surface the constraint subtly via
		// the disabled-styled X button on the last remaining chip.
		if (next.length === 0) return;
		const builder =
			value.quantifier === "all" ? multiSelectAll : multiSelectAny;
		const [first, ...rest] = next;
		onChange(builder(value.property, first, ...rest));
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
						ariaLabel="Multi-select property"
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
				options={allOptions}
				selectedValues={selectedValues}
				toggleOption={toggleOption}
				path={path}
			/>
		</div>
	);
}

function TokenList({
	values,
	options,
	selectedValues,
	toggleOption,
	path,
}: {
	readonly values: readonly Literal[];
	readonly options: readonly { value: string; label: string }[];
	readonly selectedValues: ReadonlySet<string>;
	readonly toggleOption: (value: string) => void;
	readonly path: EditorPath;
}) {
	if (options.length === 0) {
		return (
			<div className="text-xs text-nova-text-muted/60 px-2 py-1.5 rounded-md border border-dashed border-white/[0.06]">
				This property has no options to pick from yet.
			</div>
		);
	}
	const lastSelectedIndex = values.length - 1;
	return (
		<div className="space-y-1.5">
			<div className="flex flex-wrap gap-1.5">
				{values.map((v, i) => {
					const optLabel =
						options.find((o) => o.value === v.value)?.label ?? String(v.value);
					return (
						<TokenChip
							key={nodeId(v)}
							label={optLabel}
							value={String(v.value)}
							onRemove={() => toggleOption(String(v.value))}
							isOnlyOne={lastSelectedIndex === 0}
							indexPath={appendSlotIndex(path, "values", i)}
						/>
					);
				})}
				<OptionPicker
					options={options}
					selectedValues={selectedValues}
					onPick={toggleOption}
				/>
			</div>
		</div>
	);
}

function TokenChip({
	label,
	value,
	onRemove,
	isOnlyOne,
	indexPath,
}: {
	readonly label: string;
	readonly value: string;
	readonly onRemove: () => void;
	readonly isOnlyOne: boolean;
	readonly indexPath: EditorPath;
}) {
	const errors = useEditorErrorsAt(indexPath);
	const invalid = errors.length > 0;
	const cls = [
		"group inline-flex items-center gap-1 pl-2.5 pr-0.5 min-h-11 text-[12px] rounded-lg border transition-colors",
		invalid
			? "border-nova-error/40 bg-nova-error/10 text-nova-error/90"
			: "border-nova-violet/25 bg-nova-violet/10 text-nova-violet-bright",
	].join(" ");
	return (
		<Tooltip
			content={
				invalid ? errors.join("\n") : value !== label ? value : undefined
			}
		>
			<span className={cls}>
				<span className="font-mono">{label}</span>
				{!isOnlyOne && (
					<button
						type="button"
						aria-label={`Remove ${label}`}
						onClick={onRemove}
						className="size-11 grid place-items-center rounded-md text-current/70 hover:text-current hover:bg-white/[0.08] cursor-pointer"
					>
						<Icon icon={tablerX} width="12" height="12" />
					</button>
				)}
			</span>
		</Tooltip>
	);
}

function OptionPicker({
	options,
	selectedValues,
	onPick,
}: {
	readonly options: readonly { value: string; label: string }[];
	readonly selectedValues: ReadonlySet<string>;
	readonly onPick: (value: string) => void;
}) {
	const triggerRef = useRef<HTMLButtonElement>(null);
	const remaining = options.filter((o) => !selectedValues.has(o.value));
	if (remaining.length === 0) return null;

	return (
		<Menu.Root>
			<Menu.Trigger
				ref={triggerRef}
				aria-label="Add option"
				className="inline-flex items-center gap-1.5 px-3 min-h-11 text-[12px] rounded-lg border border-dashed border-white/[0.10] text-nova-text-muted/80 hover:text-nova-violet-bright hover:border-nova-violet/30 transition-colors cursor-pointer"
			>
				<Icon icon={tablerPlus} width="13" height="13" />
				<span>Add option</span>
			</Menu.Trigger>
			<Menu.Portal>
				<Menu.Positioner
					side="bottom"
					align="start"
					sideOffset={4}
					anchor={triggerRef}
					className={MENU_POSITIONER_CLS}
				>
					<Menu.Popup className={`${MENU_POPUP_CLS} max-h-72 overflow-y-auto`}>
						{remaining.map((opt, i) => {
							const last = remaining.length - 1;
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
									key={opt.value}
									onClick={() => onPick(opt.value)}
									className={`${corners} ${MENU_ITEM_CLS}`}
								>
									<Icon
										icon={tablerCheck}
										width="14"
										height="14"
										className="opacity-0 group-data-[selected]:opacity-100"
									/>
									<span className="flex-1 text-left">
										<div className="truncate">{opt.label}</div>
										{opt.label !== opt.value && (
											<div className="text-[10px] font-mono text-nova-text-muted truncate">
												{opt.value}
											</div>
										)}
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
