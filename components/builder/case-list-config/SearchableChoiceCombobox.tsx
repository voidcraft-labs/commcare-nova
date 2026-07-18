"use client";

import { Icon, type IconifyIcon } from "@iconify/react/offline";
import tablerSearch from "@iconify-icons/tabler/search";
import type { ReactElement, ReactNode } from "react";
import { useMemo, useRef, useState } from "react";
import {
	Combobox,
	ComboboxCollection,
	ComboboxContent,
	ComboboxEmpty,
	ComboboxGroup,
	ComboboxInput,
	ComboboxItem,
	ComboboxLabel,
	ComboboxList,
	ComboboxTrigger,
} from "@/components/shadcn/combobox";
import { cn } from "@/lib/utils";

export interface SearchableChoice<T> {
	readonly id: string;
	readonly label: string;
	readonly detail?: string;
	readonly group: string;
	readonly icon?: IconifyIcon;
	readonly searchText?: string;
	readonly value: T;
	/** Use for a progressive choice that changes the choices in this same popup. */
	readonly keepOpen?: boolean;
	readonly quiet?: boolean;
	readonly tone?: "normal" | "attention";
}

interface SearchableChoiceGroup<T> {
	readonly value: string;
	readonly items: readonly SearchableChoice<T>[];
}

interface SearchableChoiceComboboxProps<T> {
	readonly choices: readonly SearchableChoice<T>[];
	readonly onChoose: (choice: SearchableChoice<T>) => void;
	readonly trigger: ReactElement;
	readonly triggerLabel: string;
	readonly triggerContent: ReactNode;
	readonly heading: string;
	readonly description?: string;
	readonly searchLabel: string;
	readonly searchPlaceholder: string;
	readonly emptyTitle?: string;
	readonly emptyDescription?: string;
	readonly selectedId?: string;
	readonly headerAction?: (clearSearch: () => void) => ReactNode;
	readonly contentClassName?: string;
	readonly onClosed?: () => void;
}

/**
 * Shared input-inside-popup combobox for the case workspace's searchable
 * choosers. Base UI owns focus, listbox semantics, arrow-key navigation,
 * selection, collision handling, and Escape dismissal; call sites only supply
 * domain labels and outcomes.
 */
export function SearchableChoiceCombobox<T>({
	choices,
	onChoose,
	trigger,
	triggerLabel,
	triggerContent,
	heading,
	description,
	searchLabel,
	searchPlaceholder,
	emptyTitle = "No matching information",
	emptyDescription = "Try a different search",
	selectedId,
	headerAction,
	contentClassName,
	onClosed,
}: SearchableChoiceComboboxProps<T>) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const keepOpenAfterChoiceRef = useRef(false);
	const groups = useMemo<readonly SearchableChoiceGroup<T>[]>(() => {
		const groupOrder: string[] = [];
		const grouped = new Map<string, SearchableChoice<T>[]>();
		for (const choice of choices) {
			if (!grouped.has(choice.group)) {
				grouped.set(choice.group, []);
				groupOrder.push(choice.group);
			}
			grouped.get(choice.group)?.push(choice);
		}
		return groupOrder.map((value) => ({
			value,
			items: grouped.get(value) ?? [],
		}));
	}, [choices]);
	const selectedChoice =
		selectedId === undefined
			? null
			: (choices.find((choice) => choice.id === selectedId) ?? null);

	const close = () => {
		setQuery("");
		setOpen(false);
		onClosed?.();
	};

	return (
		<Combobox
			items={groups}
			value={selectedChoice}
			open={open}
			onOpenChange={(nextOpen) => {
				if (nextOpen) {
					setOpen(true);
					return;
				}
				if (keepOpenAfterChoiceRef.current) {
					keepOpenAfterChoiceRef.current = false;
					setOpen(true);
					return;
				}
				close();
			}}
			inputValue={query}
			onInputValueChange={(nextQuery, details) => {
				setQuery(details.reason === "item-press" ? "" : nextQuery);
			}}
			onValueChange={(choice) => {
				if (choice === null) return;
				if (choice.keepOpen) keepOpenAfterChoiceRef.current = true;
				setQuery("");
				onChoose(choice);
			}}
			autoHighlight
			itemToStringLabel={(choice: SearchableChoice<T>) => choice.label}
			itemToStringValue={(choice: SearchableChoice<T>) => choice.id}
			isItemEqualToValue={(choice, value) => choice.id === value.id}
			filter={(choice: SearchableChoice<T>, currentQuery) => {
				const normalized = currentQuery.trim().toLocaleLowerCase();
				if (normalized === "") return true;
				return `${choice.label} ${choice.detail ?? ""} ${choice.searchText ?? ""}`
					.toLocaleLowerCase()
					.includes(normalized);
			}}
		>
			<ComboboxTrigger
				render={trigger}
				aria-label={triggerLabel}
				className="cursor-pointer"
			>
				{triggerContent}
			</ComboboxTrigger>
			<ComboboxContent
				align="start"
				aria-label={heading}
				className={cn("w-80", contentClassName)}
			>
				<header className="flex shrink-0 items-start gap-2 px-3 pb-2.5 pt-3">
					{headerAction?.(() => setQuery(""))}
					<div className="min-w-0">
						<h3 className="font-display text-[15px] font-semibold text-nova-text">
							{heading}
						</h3>
						{description !== undefined && (
							<p className="mt-1 text-xs leading-relaxed text-nova-text-muted">
								{description}
							</p>
						)}
					</div>
				</header>
				<div className="shrink-0 border-y border-white/[0.06] pb-2">
					<ComboboxInput
						aria-label={searchLabel}
						placeholder={searchPlaceholder}
						showTrigger={false}
						showClear={query !== ""}
						clearLabel="Clear search"
						onClear={() => setQuery("")}
						startAdornment={
							<Icon
								icon={tablerSearch}
								width="15"
								height="15"
								className="text-nova-text-muted"
							/>
						}
						autoComplete="off"
						data-1p-ignore
						className="mx-2 mt-2 w-auto"
					/>
				</div>
				<div
					data-combobox-scroll-region
					className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
				>
					<ComboboxEmpty>
						<div>
							<p className="font-medium text-nova-text">{emptyTitle}</p>
							<p className="mt-1 text-xs text-nova-text-muted">
								{emptyDescription}
							</p>
						</div>
					</ComboboxEmpty>
					<ComboboxList className="flex-none overflow-visible">
						{(group: SearchableChoiceGroup<T>) => (
							<ComboboxGroup key={group.value} items={group.items}>
								<ComboboxLabel>{group.value}</ComboboxLabel>
								<ComboboxCollection>
									{(choice: SearchableChoice<T>) => (
										<ComboboxItem
											key={choice.id}
											value={choice}
											className={cn(
												"min-w-0 whitespace-normal",
												choice.quiet && "text-nova-text-secondary",
											)}
										>
											{choice.icon !== undefined && (
												<Icon
													icon={choice.icon}
													width="16"
													height="16"
													className="shrink-0 text-nova-text-muted"
												/>
											)}
											<span className="min-w-0 flex-1 text-left">
												<span className="block whitespace-normal break-words font-medium">
													{choice.label}
												</span>
												{choice.detail !== undefined && (
													<span
														className={cn(
															"mt-0.5 block whitespace-normal break-words text-xs leading-relaxed",
															choice.tone === "attention"
																? "text-nova-rose"
																: "text-nova-text-muted",
														)}
													>
														{choice.detail}
													</span>
												)}
											</span>
										</ComboboxItem>
									)}
								</ComboboxCollection>
							</ComboboxGroup>
						)}
					</ComboboxList>
				</div>
			</ComboboxContent>
		</Combobox>
	);
}
