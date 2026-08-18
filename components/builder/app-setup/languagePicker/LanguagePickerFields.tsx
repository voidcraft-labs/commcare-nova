"use client";

// The shared Language → Writing system → Regional conventions field stack the
// Add-language and Change-language dialogs render. Every choice rule lives in
// pickerModel.ts; this component binds that pure model to the shadcn
// Combobox/Select/Field primitives. ISO codes stay match keys here: every
// visible string is a registry derivation, never an identifier.

import { useMemo } from "react";
import {
	Combobox,
	ComboboxCollection,
	ComboboxContent,
	ComboboxEmpty,
	ComboboxGroup,
	ComboboxInput,
	ComboboxItem,
	ComboboxList,
} from "@/components/shadcn/combobox";
import { Field, FieldError, FieldLabel } from "@/components/shadcn/field";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/shadcn/select";
import type { LanguageTag } from "@/lib/domain";
import type { LanguageRegistrySearch } from "@/lib/domain/languageRegistry/load";
import {
	chooseLanguage,
	chooseRegion,
	chooseScript,
	duplicateLanguageRefusal,
	hiddenMatchesLine,
	type LanguagePickerChoice,
	type LanguagePickerRow,
	pickerRowForCode,
	regionalConventionOptions,
	resolvedLanguageSelection,
	searchLanguageRows,
	selectionPreview,
	writingSystemOptions,
} from "./pickerModel";

/** The region Select's spelling of "no region" — outside `^[A-Z]{2}$`. */
const GENERAL_REGION_VALUE = "general";

interface RowGroup {
	readonly value: "notice" | "matches";
	readonly items: readonly LanguagePickerRow[];
}

export interface LanguagePickerFieldsProps {
	readonly data: LanguageRegistrySearch;
	readonly choice: LanguagePickerChoice;
	readonly onChoiceChange: (choice: LanguagePickerChoice) => void;
	readonly query: string;
	readonly onQueryChange: (query: string) => void;
	/** Tags already in the app; drives disabled scripts and the duplicate refusal. */
	readonly existingTags: readonly LanguageTag[];
	/** Prefix for control ids, so two dialogs can mount the stack independently. */
	readonly idPrefix: string;
}

export function LanguagePickerFields({
	data,
	choice,
	onChoiceChange,
	query,
	onQueryChange,
	existingTags,
	idPrefix,
}: LanguagePickerFieldsProps) {
	const view = useMemo(() => searchLanguageRows(data, query), [data, query]);
	const groups = useMemo<RowGroup[]>(() => {
		const noticeRows = view.notice?.rows ?? [];
		return noticeRows.length > 0
			? [
					{ value: "notice", items: noticeRows },
					{ value: "matches", items: view.rows },
				]
			: [{ value: "matches", items: view.rows }];
	}, [view]);
	const hiddenLine = hiddenMatchesLine(view.hiddenMatchCount);

	const selectedRow =
		choice.language === undefined
			? null
			: pickerRowForCode(data, choice.language);
	const scriptOptions =
		choice.language === undefined
			? []
			: writingSystemOptions(choice.language, existingTags);
	const selectedScriptOption = scriptOptions.find(
		(option) => option.script === choice.script,
	);
	// The region question waits until the writing-system question (when the
	// language poses one) is answered.
	const regionOptions =
		choice.language !== undefined &&
		(scriptOptions.length === 0 || selectedScriptOption !== undefined)
			? regionalConventionOptions(
					data,
					choice.language,
					selectedScriptOption?.script,
				)
			: [];
	const selectedRegionOption = regionOptions.find(
		(option) => option.region === choice.region,
	);

	const selection = resolvedLanguageSelection(choice);
	const preview =
		selection === undefined
			? undefined
			: selectionPreview(data, selection.identity);
	const refusal =
		selection === undefined
			? undefined
			: duplicateLanguageRefusal(data, selection, existingTags);

	return (
		<div className="flex flex-col gap-4">
			<Field>
				<FieldLabel htmlFor={`${idPrefix}-language`}>Language</FieldLabel>
				<Combobox
					items={groups}
					value={selectedRow}
					inputValue={query}
					onInputValueChange={(value: string) => onQueryChange(value)}
					onValueChange={(row: LanguagePickerRow | null) => {
						if (row !== null) onChoiceChange(chooseLanguage(choice, row.code));
					}}
					itemToStringLabel={(row: LanguagePickerRow) => row.primaryLabel}
					isItemEqualToValue={(
						a: LanguagePickerRow | null,
						b: LanguagePickerRow | null,
					) => a?.code === b?.code}
					// Rows arrive pre-ranked from the registry search; the primitive's
					// own substring filter would re-hide them.
					filter={() => true}
					autoHighlight
				>
					<ComboboxInput
						id={`${idPrefix}-language`}
						placeholder="Search for a language"
						autoComplete="off"
						data-1p-ignore
					/>
					<ComboboxContent>
						{view.notice !== undefined && (
							<p className="shrink-0 border-b border-white/[0.06] px-3 py-2.5 text-xs leading-relaxed text-nova-text-secondary">
								{view.notice.message}
							</p>
						)}
						<ComboboxEmpty>
							No language matches that search. Try another spelling or its
							English name
						</ComboboxEmpty>
						<ComboboxList>
							{(group: RowGroup) => (
								<ComboboxGroup
									key={group.value}
									items={group.items}
									className={
										group.value === "notice"
											? "mb-1 border-b border-white/[0.06] pb-1"
											: undefined
									}
								>
									<ComboboxCollection>
										{(row: LanguagePickerRow) => (
											<ComboboxItem
												key={row.code}
												value={row}
												// The empty query renders the full catalog; rows off
												// screen skip layout and paint.
												className="[contain-intrinsic-size:auto_44px] [content-visibility:auto]"
											>
												<span className="flex min-w-0 flex-1 flex-col">
													<bdi className="truncate">{row.primaryLabel}</bdi>
													{row.secondaryLabel !== undefined && (
														<span className="truncate text-xs text-nova-text-muted">
															{row.secondaryLabel}
														</span>
													)}
												</span>
											</ComboboxItem>
										)}
									</ComboboxCollection>
								</ComboboxGroup>
							)}
						</ComboboxList>
						{hiddenLine !== undefined && (
							<p className="shrink-0 border-t border-white/[0.06] px-3 py-2 text-xs text-nova-text-muted">
								{hiddenLine}
							</p>
						)}
					</ComboboxContent>
				</Combobox>
			</Field>

			{scriptOptions.length > 0 && (
				<Field>
					<FieldLabel htmlFor={`${idPrefix}-script`}>Writing system</FieldLabel>
					<Select
						value={choice.script ?? null}
						onValueChange={(value: string | null) => {
							if (typeof value === "string") {
								onChoiceChange(chooseScript(choice, value));
							}
						}}
					>
						<SelectTrigger id={`${idPrefix}-script`} className="w-full">
							<SelectValue placeholder="Choose a writing system">
								{selectedScriptOption?.label}
							</SelectValue>
						</SelectTrigger>
						<SelectContent>
							{scriptOptions.map((option) => (
								<SelectItem
									key={option.script}
									value={option.script}
									disabled={option.disabledReason !== undefined}
									wrap
								>
									<span className="flex min-w-0 flex-col">
										<span>{option.label}</span>
										{option.disabledReason !== undefined && (
											<span className="text-xs text-nova-text-muted">
												{option.disabledReason}
											</span>
										)}
									</span>
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</Field>
			)}

			{regionOptions.length > 0 && (
				<Field>
					<FieldLabel htmlFor={`${idPrefix}-region`}>
						Regional conventions
					</FieldLabel>
					<Select
						value={choice.region ?? GENERAL_REGION_VALUE}
						onValueChange={(value: string | null) => {
							if (typeof value === "string") {
								onChoiceChange(
									chooseRegion(
										choice,
										value === GENERAL_REGION_VALUE ? undefined : value,
									),
								);
							}
						}}
					>
						<SelectTrigger id={`${idPrefix}-region`} className="w-full">
							<SelectValue>{selectedRegionOption?.label}</SelectValue>
						</SelectTrigger>
						<SelectContent>
							{regionOptions.map((option) => (
								<SelectItem
									key={option.region ?? GENERAL_REGION_VALUE}
									value={option.region ?? GENERAL_REGION_VALUE}
									wrap
								>
									<span className="flex min-w-0 flex-col">
										<span>{option.label}</span>
										{option.description !== undefined && (
											<span className="text-xs text-nova-text-muted">
												{option.description}
											</span>
										)}
									</span>
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</Field>
			)}

			{preview !== undefined && (
				<p className="text-sm text-nova-text-secondary">
					Workers see{" "}
					<bdi dir={preview.direction} className="font-medium text-nova-text">
						{preview.label}
					</bdi>{" "}
					· {preview.directionWord}
				</p>
			)}
			<FieldError>{refusal}</FieldError>
		</div>
	);
}
