"use client";

import { useId } from "react";
import { useBuilderLanguage } from "@/components/builder/localization/BuilderLocalizationProvider";
import {
	Combobox,
	ComboboxContent,
	ComboboxEmpty,
	ComboboxInput,
	ComboboxItem,
	ComboboxList,
} from "@/components/shadcn/combobox";
import type { ChoiceLayout } from "@/lib/domain";
import { choiceMatches } from "@/lib/preview/choiceMatch";
import { runtimeMessage } from "@/lib/preview/runtimeMessages";
import { usePreviewPlatformRules } from "@/lib/session/hooks";

type Choice = { key: string; value: string; label: string };
interface ChoicePresentationProps {
	layout: ChoiceLayout;
	options: readonly Choice[];
	value: string;
	labelledBy?: string;
	placeholder?: string;
	multiple?: boolean;
	onChange: (value: string) => void;
	onBlur: () => void;
}

/** Widgets with an interaction distinct from the ordinary radio/checkbox row.
 * A click or keyboard selection writes the same option value as a normal question. */
export function ChoicePresentation({
	layout,
	options,
	value,
	onChange,
	onBlur,
	labelledBy,
	placeholder,
	multiple,
}: ChoicePresentationProps) {
	const { choiceSearch } = usePreviewPlatformRules();
	const { language } = useBuilderLanguage();
	const id = useId();
	if (layout.kind === "headings")
		return (
			<fieldset className="flex gap-2" aria-labelledby={labelledBy}>
				{options.map((o) => (
					<span key={o.key} className="flex-1 text-center text-sm font-medium">
						{o.label}
					</span>
				))}
			</fieldset>
		);
	if (layout.kind === "buttons") {
		const current = options.findIndex((o) => o.value === value);
		const next = options[(current + 1) % options.length];
		return (
			<button
				type="button"
				disabled={!next}
				onBlur={onBlur}
				aria-labelledby={labelledBy ? `${labelledBy} ${id}` : undefined}
				id={id}
				className="nova-focusable rounded-lg border border-pv-input-border bg-pv-input-bg px-3 py-2"
				onClick={() => {
					if (next) onChange(next.value);
				}}
			>
				{next?.label}
			</button>
		);
	}
	if (layout.kind === "dropdown") {
		return (
			<select
				aria-labelledby={labelledBy}
				multiple={multiple}
				value={multiple ? value.split(" ").filter(Boolean) : value}
				onBlur={onBlur}
				className="nova-focusable min-h-11 w-full rounded-lg border border-pv-input-border bg-pv-input-bg px-3"
				onChange={(e) =>
					onChange(
						multiple
							? Array.from(
									e.currentTarget.selectedOptions,
									(o) => o.value,
								).join(" ")
							: e.currentTarget.value,
					)
				}
			>
				{!multiple && <option value="">{placeholder}</option>}
				{value && !multiple && !options.some((o) => o.value === value) && (
					<option value={value}>{value}</option>
				)}
				{options.map((o) => (
					<option key={o.key} value={o.value}>
						{o.label}
					</option>
				))}
			</select>
		);
	}
	if (layout.kind !== "search") return null;
	const current =
		options.find((option) => option.value === value) ??
		(value ? { key: value, value, label: value } : null);
	return (
		<Combobox
			items={options}
			value={current}
			itemToStringLabel={(item: Choice) => item.label}
			isItemEqualToValue={(a: Choice | null, b: Choice | null) =>
				a?.key === b?.key
			}
			filter={(option: Choice, query: string) =>
				choiceMatches(option.label, query, layout.matchWords, choiceSearch)
			}
			autoHighlight
			onInputValueChange={(query, event) => {
				// Android rejects an edit that leaves an empty suggestion list.
				// Its fuzzy rule accepts partial spellings while a worker types.
				if (
					choiceSearch === "filter-rule" &&
					query &&
					!layout.matchWords?.endsWith("fuzzy") &&
					!options.some((option) =>
						choiceMatches(option.label, query, layout.matchWords, choiceSearch),
					)
				)
					event.cancel();
			}}
			onValueChange={(option: Choice | null) => onChange(option?.value ?? "")}
		>
			<ComboboxInput
				aria-labelledby={labelledBy}
				onBlur={onBlur}
				autoComplete="off"
				placeholder={placeholder}
				showClear={Boolean(value)}
				clearLabel={runtimeMessage(language, "clear")}
				onClear={() => onChange("")}
			/>
			<ComboboxContent>
				<ComboboxEmpty>
					{runtimeMessage(language, "noChoicesMatch")}
				</ComboboxEmpty>
				<ComboboxList>
					{(item: Choice) => (
						<ComboboxItem key={item.key} value={item}>
							{item.label}
						</ComboboxItem>
					)}
				</ComboboxList>
			</ComboboxContent>
		</Combobox>
	);
}
