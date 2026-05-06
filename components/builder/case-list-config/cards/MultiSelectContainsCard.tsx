// components/builder/case-list-config/cards/MultiSelectContainsCard.tsx
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
import type { CaseProperty } from "@/lib/domain";
import {
	type Literal,
	literal,
	type MultiSelectQuantifier,
	multiSelectAll,
	multiSelectAny,
	type Predicate,
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
import { PropertyPicker } from "../primitives/PropertyPicker";

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

	const setProperty = (propertyName: string) => {
		// On property switch, reset values to the new property's first
		// option (keeping the schema's non-empty invariant) — the
		// previous property's options have no semantic continuity with
		// the new property's tokens.
		const next = ctx.caseTypes
			.find((c) => c.name === ctx.currentCaseType)
			?.properties.find((p) => p.name === propertyName);
		const seed = next?.options?.[0]?.value ?? "";
		const builder =
			value.quantifier === "all" ? multiSelectAll : multiSelectAny;
		onChange(builder(prop(ctx.currentCaseType, propertyName), literal(seed)));
	};

	const setQuantifier = (q: MultiSelectQuantifier) => {
		// Switching quantifier rebuilds via the corresponding builder
		// to keep the canonical AST shape. The values list is preserved
		// verbatim — the meaning of the membership flips from "any of"
		// to "all of" without losing the author's selections.
		const builder = q === "all" ? multiSelectAll : multiSelectAny;
		const [first, ...rest] = value.values;
		onChange(builder(value.property, first, ...rest));
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
			<div className="grid grid-cols-[1fr_auto] gap-2 items-start">
				<div>
					<PropertyPicker
						value={value.property.property || undefined}
						onChange={setProperty}
						filter={(p) => p.data_type === "multi_select"}
						invalid={propertyErrors.length > 0}
						ariaLabel="Multi-select property"
					/>
					{propertyErrors.length > 0 && (
						<div className="mt-1 text-[11px] leading-snug text-nova-error/90">
							{propertyErrors.map((m) => (
								<div key={m}>{m}</div>
							))}
						</div>
					)}
				</div>
				<QuantifierMenu
					quantifier={value.quantifier}
					setQuantifier={setQuantifier}
				/>
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

function QuantifierMenu({
	quantifier,
	setQuantifier,
}: {
	readonly quantifier: MultiSelectQuantifier;
	readonly setQuantifier: (q: MultiSelectQuantifier) => void;
}) {
	const triggerRef = useRef<HTMLButtonElement>(null);
	const items: readonly { q: MultiSelectQuantifier; label: string }[] = [
		{ q: "any", label: "Any of" },
		{ q: "all", label: "All of" },
	];
	const current = items.find((i) => i.q === quantifier) ?? items[0];

	return (
		<Menu.Root>
			<Menu.Trigger
				ref={triggerRef}
				aria-label={`Quantifier: ${current.label}`}
				className="group flex items-center gap-1 px-3 py-1.5 text-xs rounded-md border border-white/[0.06] bg-nova-deep/50 text-nova-violet-bright hover:border-nova-violet/30 transition-colors cursor-pointer"
			>
				<span>{current.label}</span>
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
			</Menu.Trigger>
			<Menu.Portal>
				<Menu.Positioner
					side="bottom"
					align="end"
					sideOffset={4}
					anchor={triggerRef}
					className={MENU_POSITIONER_CLS}
				>
					<Menu.Popup className={MENU_POPUP_CLS}>
						{items.map((it, i) => {
							const isActive = it.q === quantifier;
							const last = items.length - 1;
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
									key={it.q}
									onClick={() => setQuantifier(it.q)}
									className={`${corners} ${MENU_ITEM_CLS} ${
										isActive ? "text-nova-violet-bright bg-nova-violet/10" : ""
									}`}
								>
									<span>{it.label}</span>
								</Menu.Item>
							);
						})}
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
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
			<div className="text-xs text-nova-text-muted/60 italic px-2 py-1.5 rounded-md border border-dashed border-white/[0.06]">
				This property has no declared options to pick from
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
		"group inline-flex items-center gap-1 pl-2 pr-1 py-1 text-[11px] rounded-md border transition-colors",
		invalid
			? "border-nova-error/40 bg-nova-error/10 text-nova-error/90"
			: "border-nova-violet/25 bg-nova-violet/10 text-nova-violet-bright",
	].join(" ");
	return (
		<span
			className={cls}
			title={invalid ? errors.join("\n") : value !== label ? value : undefined}
		>
			<span className="font-mono">{label}</span>
			{!isOnlyOne && (
				<button
					type="button"
					aria-label={`Remove ${label}`}
					onClick={onRemove}
					className="rounded text-current/70 hover:text-current hover:bg-white/[0.08] p-0.5 cursor-pointer"
				>
					<Icon icon={tablerX} width="10" height="10" />
				</button>
			)}
		</span>
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
				aria-label="Add token"
				className="inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded-md border border-dashed border-white/[0.10] text-nova-text-muted/80 hover:text-nova-violet-bright hover:border-nova-violet/30 transition-colors cursor-pointer"
			>
				<Icon icon={tablerPlus} width="11" height="11" />
				<span>Add token</span>
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
