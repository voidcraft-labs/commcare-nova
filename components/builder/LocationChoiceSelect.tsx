"use client";

import type { ReactNode, Ref } from "react";
import { useEffect, useId, useMemo, useState } from "react";
import { Button } from "@/components/shadcn/button";
import { Input } from "@/components/shadcn/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/shadcn/select";
import { locationChoiceLabel } from "@/lib/organization/locationLabels";
import type { StoredLocation } from "@/lib/organization/types";
import {
	type PlacePageRow,
	type PlaceSearch,
	usePlacePage,
} from "@/lib/organization/usePlacePage";

const LOCATION_CHOICE_PAGE_SIZE = 50;
const NO_AVAILABLE_LOCATION = "__no_available_location__";

function LocalPlaceChoice({
	locations,
	value,
	onValueChange,
	ariaLabel,
	placeholder,
	disabled = false,
	triggerRef,
	triggerContent,
	className = "w-full",
	optionPrefix = "",
	issueFor,
	specialOptions = [],
	id,
}: {
	readonly locations: readonly (StoredLocation &
		Partial<Pick<PlacePageRow, "path">>)[];
	readonly value: string;
	readonly onValueChange: (locationId: string) => void;
	readonly ariaLabel: string;
	readonly placeholder: string;
	readonly disabled?: boolean;
	readonly triggerRef?: Ref<HTMLButtonElement>;
	readonly triggerContent?: ReactNode;
	readonly className?: string;
	readonly optionPrefix?: string;
	readonly specialOptions?: readonly {
		readonly value: string;
		readonly label: string;
	}[];
	/** Exact cross-store preflight. It runs only for one bounded result page. */
	readonly issueFor?: (
		location: StoredLocation & Partial<Pick<PlacePageRow, "path">>,
	) => string | undefined;
	readonly id?: string;
}) {
	const searchId = useId();
	const [query, setQuery] = useState("");
	const [page, setPage] = useState(0);
	const [open, setOpen] = useState(false);
	const normalizedQuery = query.trim().toLocaleLowerCase();
	const matching = useMemo(
		() =>
			locations.filter((location) =>
				normalizedQuery === ""
					? true
					: locationChoiceLabel(location)
							.toLocaleLowerCase()
							.includes(normalizedQuery),
			),
		[locations, normalizedQuery],
	);
	const pageCount = Math.max(
		1,
		Math.ceil(matching.length / LOCATION_CHOICE_PAGE_SIZE),
	);
	const shownPage = Math.min(page, pageCount - 1);
	const pageStart = shownPage * LOCATION_CHOICE_PAGE_SIZE;
	const pageLocations = useMemo(
		() => matching.slice(pageStart, pageStart + LOCATION_CHOICE_PAGE_SIZE),
		[matching, pageStart],
	);
	const pageChoices = useMemo(
		() =>
			pageLocations.map((location) => ({
				location,
				// The saved selection is already valid and choosing it is a no-op.
				// Do not spend a full cross-store preflight on it when a picker opens.
				issue: open && location.id !== value ? issueFor?.(location) : undefined,
			})),
		[issueFor, open, pageLocations, value],
	);
	const selected = locations.find((location) => location.id === value);

	useEffect(() => {
		setPage((current) => Math.min(current, pageCount - 1));
	}, [pageCount]);

	return (
		<div className="flex min-w-0 flex-col gap-1.5">
			{locations.length > LOCATION_CHOICE_PAGE_SIZE && (
				<div className="flex flex-col gap-1">
					<label
						htmlFor={searchId}
						className="text-[12px] text-nova-text-muted"
					>
						Search {ariaLabel.toLocaleLowerCase()}
					</label>
					<Input
						id={searchId}
						value={query}
						onChange={(event) => {
							setQuery(event.target.value);
							setPage(0);
						}}
						placeholder="Name or site code"
						autoComplete="off"
						data-1p-ignore
						disabled={disabled}
					/>
				</div>
			)}
			<Select
				open={open}
				onOpenChange={setOpen}
				value={value}
				disabled={disabled}
				onValueChange={(next) => {
					if (
						typeof next !== "string" ||
						next === "" ||
						next === NO_AVAILABLE_LOCATION
					) {
						return;
					}
					onValueChange(next);
				}}
			>
				<SelectTrigger
					id={id}
					ref={triggerRef}
					wrapValue
					aria-label={ariaLabel}
					className={className}
				>
					{triggerContent ?? (
						<SelectValue placeholder={placeholder}>
							{selected === undefined
								? value === ""
									? undefined
									: "A place that is no longer available"
								: locationChoiceLabel(selected)}
						</SelectValue>
					)}
				</SelectTrigger>
				<SelectContent>
					{specialOptions.map((option) => (
						<SelectItem key={option.value} value={option.value}>
							{option.label}
						</SelectItem>
					))}
					{pageChoices.length === 0 && specialOptions.length === 0 ? (
						<SelectItem disabled value={NO_AVAILABLE_LOCATION}>
							No places match this search
						</SelectItem>
					) : (
						pageChoices.map(({ location, issue }) => (
							<SelectItem
								wrap
								key={location.id}
								value={location.id}
								disabled={issue !== undefined}
							>
								<span className="flex min-w-0 flex-col gap-0.5">
									<span>
										{optionPrefix}
										{locationChoiceLabel(location)}
									</span>
									{location.path && location.path.length > 0 && (
										<span className="whitespace-normal text-[11px] leading-snug text-nova-text-muted">
											{location.path
												.map((ancestor) => ancestor.name || ancestor.siteCode)
												.join(" / ")}
										</span>
									)}
									{issue !== undefined && (
										<span className="whitespace-normal text-[11px] leading-snug text-nova-red">
											{issue}
										</span>
									)}
								</span>
							</SelectItem>
						))
					)}
				</SelectContent>
			</Select>
			{pageCount > 1 && (
				<div className="flex items-center justify-between gap-2">
					<Button
						type="button"
						variant="ghost"
						className="min-h-11 px-2 text-[12px]"
						disabled={disabled || shownPage === 0}
						onClick={() => setPage((current) => Math.max(0, current - 1))}
					>
						Previous
					</Button>
					<span className="text-[12px] text-nova-text-muted" aria-live="polite">
						{pageStart + 1}–
						{Math.min(pageStart + LOCATION_CHOICE_PAGE_SIZE, matching.length)}{" "}
						of {matching.length}
					</span>
					<Button
						type="button"
						variant="ghost"
						className="min-h-11 px-2 text-[12px]"
						disabled={disabled || shownPage === pageCount - 1}
						onClick={() =>
							setPage((current) => Math.min(pageCount - 1, current + 1))
						}
					>
						Next
					</Button>
				</div>
			)}
		</div>
	);
}

type PlaceChoiceProps = Parameters<typeof LocalPlaceChoice>[0];

export function LocationChoiceSelect(
	props: PlaceChoiceProps & {
		remote?: PlaceSearch;
		onSelectRow?: (row: PlacePageRow) => void;
	},
) {
	return props.remote ? (
		<SearchedPlaceChoice {...props} remote={props.remote} />
	) : (
		<LocalPlaceChoice {...props} />
	);
}

function SearchedPlaceChoice({
	remote,
	onSelectRow,
	...props
}: PlaceChoiceProps & {
	remote: PlaceSearch;
	onSelectRow?: (row: PlacePageRow) => void;
}) {
	const [query, setQuery] = useState("");
	const [selected, setSelected] = useState<StoredLocation>();
	const id = useId();
	const result = usePlacePage(remote, query.trim());
	const choices = result.page?.locations ?? [];
	const chosen =
		(selected?.id === props.value ? selected : undefined) ??
		props.locations.find((row) => row.id === props.value) ??
		choices.find((row) => row.id === props.value);
	return (
		<div className="flex min-w-0 flex-col gap-1.5">
			<label htmlFor={id} className="text-[12px] text-nova-text-muted">
				Search {props.ariaLabel.toLocaleLowerCase()}
			</label>
			<Input
				id={id}
				value={query}
				placeholder="Name or site code"
				disabled={props.disabled}
				onChange={(e) => setQuery(e.target.value)}
			/>
			<LocalPlaceChoice
				{...props}
				locations={choices}
				disabled={props.disabled || result.loading || !!result.error}
				triggerContent={
					props.specialOptions?.find((item) => item.value === props.value)
						?.label ??
					(chosen
						? props.optionPrefix
							? props.optionPrefix + locationChoiceLabel(chosen)
							: locationChoiceLabel(chosen)
						: props.triggerContent)
				}
				onValueChange={(id) => {
					const row = choices.find((place) => place.id === id);
					if (row) {
						setSelected(row);
						onSelectRow?.(row);
					}
					props.onValueChange(id);
				}}
			/>
			{result.loading && (
				<span role="status" className="text-xs text-nova-text-muted">
					Looking for places
				</span>
			)}
			{result.error && (
				<p role="alert" className="text-xs text-nova-red">
					{result.error}{" "}
					<Button type="button" variant="ghost" onClick={result.retry}>
						Try again
					</Button>
				</p>
			)}
			{(result.previous || result.next) && (
				<div className="flex gap-2">
					<Button
						type="button"
						variant="ghost"
						disabled={!result.previous}
						onClick={result.previous}
					>
						Previous places
					</Button>
					<Button
						type="button"
						variant="ghost"
						disabled={!result.next}
						onClick={result.next}
					>
						Next places
					</Button>
				</div>
			)}
		</div>
	);
}
