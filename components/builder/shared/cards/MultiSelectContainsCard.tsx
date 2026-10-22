// components/builder/shared/cards/MultiSelectContainsCard.tsx
//
// Renders the `multi-select-contains` predicate. Property dropdown
// (multi_select-typed only) + selectable token chips drawn from
// the property's declared `options` + Any / All quantifier toggle.
//
// Values edit as one list: fixed choices render as chips, and values
// worked out when the rule runs ("Add a value from") render
// through `ExpressionPicker`. The schema's tuple-with-rest requires at least
// one. Each value keeps its index in the `values` array: type-checker
// errors land per value via the `[..., "values", i]` path.

"use client";

import { Icon } from "@iconify/react/offline";
import tablerCheck from "@iconify-icons/tabler/check";
import tablerPlus from "@iconify-icons/tabler/plus";
import tablerVariable from "@iconify-icons/tabler/variable";
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
import { useProseProjection } from "@/lib/doc/hooks/useProseProjection";
import type { ExpressionOfKind } from "@/lib/domain/expression";
import {
	type Expression,
	type Literal,
	literal,
	multiSelectAny,
	type PropertyRef,
	prop,
} from "@/lib/domain/expression";
import {
	useEditorErrorsAt,
	useEditorExpressionContext,
	usePredicateEditContext,
} from "../editorContext";
import type { PredicateEditContext } from "../editorSchemas";
import { removeAndRestoreFocus } from "../focusAfterRemoval";
import {
	addMultiSelectValueOffer,
	isEditableMultiSelectValues,
	isRuntimeMultiSelectValue,
	type MultiSelectValueOffer,
	multiSelectProperty,
	multiSelectValueConstraint,
	replaceMultiSelectProperty,
	replaceMultiSelectValues,
} from "../multiSelectModel";
import { appendSlot, appendSlotIndex, type EditorPath } from "../path";
import { InlineError } from "../primitives/CardShell";
import { ExpressionPicker } from "../primitives/ExpressionPicker";
import { PropertyRefPicker } from "../primitives/PropertyRefPicker";
import {
	type StableListOperation,
	useStableListIdentity,
} from "../useStableListIdentity";
import { PredicateVerbMenu } from "./PredicateVerbMenu";

/** Module-level filter so render-time identity stays stable:
 *  `PropertyPicker`'s `useMemo` on `[caseType, filter]` invalidates
 *  on each fresh-arrow filter, even when the actual selection rule
 *  is constant. */
const MULTI_SELECT_PROPERTY_FILTER = (p: { data_type?: string }): boolean =>
	p.data_type === "multi_select";

/**
 * Build the default `multi-select-contains` predicate. Picks the
 * first multi_select-typed property (the kind's only valid target
 * per the type checker) and seeds with the property's first
 * declared option as a single-token list: the schema requires at
 * least one value.
 */
export function multiSelectContainsDefault(
	ctx: PredicateEditContext,
): ExpressionOfKind<"multi-select-contains"> {
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
	readonly value: ExpressionOfKind<"multi-select-contains">;
	readonly onChange: (next: Expression) => void;
	readonly path: EditorPath;
}

export function MultiSelectContainsCard(props: MultiSelectContainsCardProps) {
	if (
		props.value.property.kind !== "prop" ||
		!isEditableMultiSelectValues(props.value.values)
	)
		return (
			<p role="status">This saved expression cannot be edited here yet.</p>
		);
	return (
		<EditableMultiSelectContainsCard
			{...props}
			value={{
				...props.value,
				property: props.value.property,
				values: props.value.values,
			}}
		/>
	);
}

function EditableMultiSelectContainsCard({
	value,
	onChange,
	path,
}: Omit<MultiSelectContainsCardProps, "value"> & {
	readonly value: Omit<
		MultiSelectContainsCardProps["value"],
		"property" | "values"
	> & {
		readonly property: PropertyRef;
		readonly values: [Literal | Expression, ...(Literal | Expression)[]];
	};
}) {
	const ctx = usePredicateEditContext();
	const expressionContext = useEditorExpressionContext();
	const projectProse = useProseProjection();
	const propertyErrors = useEditorErrorsAt(appendSlot(path, "property"));
	const rowIdentity = useStableListIdentity(value.values);

	const property = useMemo(
		() =>
			multiSelectProperty(value.property, ctx.caseTypes, ctx.currentCaseType),
		[value.property, ctx.caseTypes, ctx.currentCaseType],
	);

	const allOptions =
		property?.options?.map((option) => ({
			value: option.value,
			label: projectProse(option.label),
		})) ?? [];
	const selectedValues = new Set<string>(
		value.values
			.flatMap((v) => (v.kind === "literal" ? [v.value] : []))
			.filter((v): v is string => typeof v === "string"),
	);
	const valueOffer = addMultiSelectValueOffer(
		value,
		{
			context: expressionContext,
			knownInputs: ctx.knownInputs,
			userProperties: ctx.userProperties,
		},
		ctx.admitExpressionChange === undefined
			? undefined
			: (next) => ctx.admitExpressionChange?.(path, next) ?? { admitted: true },
	);
	const runtimeConstraint = multiSelectValueConstraint(expressionContext);

	const setProperty = (next: PropertyRef) => {
		// On property switch, reset values to the new property's first
		// option (keeping the schema's non-empty invariant): the
		// previous property's options have no semantic continuity with
		// the new property's tokens. The `next` ref carries the
		// preserved `via` walk (if any) verbatim: `PropertyRefPicker`'s
		// canonical-edit branch rebuilds via `prop(caseType, name, via)`.
		const nextValue = replaceMultiSelectProperty(
			value,
			next,
			ctx.caseTypes,
			ctx.currentCaseType,
		);
		if (!isEditableMultiSelectValues(nextValue.values)) return;
		rowIdentity.stage(nextValue.values, { kind: "reset" });
		onChange(nextValue);
	};

	const commitValues = (
		next: readonly (Literal | Expression)[],
		operation: StableListOperation,
	) => {
		const result = replaceMultiSelectValues(value, next);
		if (result === undefined) return;
		rowIdentity.stage(next, operation);
		onChange(result);
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

	const addRuntimeValue = () => {
		if (!valueOffer.admitted) return;
		commitValues([...value.values, valueOffer.added], {
			kind: "splice",
			index: value.values.length,
			deleteCount: 0,
			insertCount: 1,
		});
	};

	const replaceValueAt = (index: number, next: Expression) => {
		commitValues(
			value.values.map((current, valueIndex) =>
				valueIndex === index ? next : current,
			),
			{ kind: "replace" },
		);
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
				{/* The verb carries the any/all quantifier: "includes any
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
				valueOffer={valueOffer}
				onAddValue={addRuntimeValue}
			/>

			{value.values.map((v, i) =>
				isRuntimeMultiSelectValue(v) ? (
					<ExpressionPicker
						key={rowIdentity.keys[i]}
						value={v}
						onChange={(next) => replaceValueAt(i, next)}
						onRemove={
							value.values.length > 1 ? () => removeValueAt(i) : undefined
						}
						path={appendSlotIndex(path, "values", i)}
						constraint={runtimeConstraint}
						variant="nested"
					/>
				) : null,
			)}
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
	valueOffer,
	onAddValue,
}: {
	readonly values: readonly (Literal | Expression)[];
	readonly rowKeys: readonly string[];
	readonly options: readonly { value: string; label: string }[];
	readonly selectedValues: ReadonlySet<string>;
	readonly onAddOption: (value: string) => void;
	readonly onRemoveValue: (index: number) => void;
	readonly path: EditorPath;
	readonly valueOffer: MultiSelectValueOffer;
	readonly onAddValue: () => void;
}) {
	const addValue = (
		<SimpleTooltip
			content={valueOffer.admitted ? undefined : valueOffer.reason}
		>
			<Button
				type="button"
				variant="ghost"
				className="nova-add-slot gap-1.5"
				disabled={!valueOffer.admitted}
				onClick={onAddValue}
			>
				<Icon icon={tablerVariable} width="13" height="13" />
				<span>Add a value from</span>
			</Button>
		</SimpleTooltip>
	);
	if (options.length === 0) {
		return (
			<div className="space-y-1.5">
				<div className="rounded-md border border-dashed border-white/[0.06] px-3 py-2 text-[13px] text-nova-text-muted">
					This information has no choices yet
				</div>
				{addValue}
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
	const isOnlyOne = values.length === 1;
	return (
		<div className="space-y-1.5">
			<div className="flex flex-wrap gap-1.5">
				{values.map((v, i) => {
					if (v.kind !== "literal") return null;
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
							isOnlyOne={isOnlyOne}
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
				{addValue}
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
						size="icon"
						aria-label={`Remove ${label}${disambiguator === undefined ? "" : `, saved as ${disambiguator}`}`}
						onClick={(event) =>
							removeAndRestoreFocus(event.currentTarget, onRemove)
						}
						data-removal-action
						className="rounded-md text-nova-text-muted not-disabled:hover:bg-white/[0.08] not-disabled:hover:text-nova-violet-bright dark:not-disabled:hover:bg-white/[0.08]"
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
						variant="ghost"
						className="nova-add-slot gap-1.5"
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
