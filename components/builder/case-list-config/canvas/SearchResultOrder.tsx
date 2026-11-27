"use client";

import { Button } from "@/components/shadcn/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/shadcn/select";
import type { SearchFilterOrder } from "@/lib/domain/modules";

interface Option {
	value: string;
	label: string;
}

function Choice({
	label,
	value,
	options,
	onChange,
}: {
	label: string;
	value: string;
	options: readonly Option[];
	onChange: (value: string) => void;
}) {
	return (
		<Select
			value={value}
			onValueChange={(next) => {
				if (next !== null) onChange(next);
			}}
		>
			<SelectTrigger aria-label={label}>
				<SelectValue>
					{options.find((option) => option.value === value)?.label ?? value}
				</SelectValue>
			</SelectTrigger>
			<SelectContent>
				{options.map((option) => (
					<SelectItem key={option.value} value={option.value}>
						{option.label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

const comparisons = [
	{ value: "text", label: "Text" },
	{ value: "number", label: "Number" },
	{ value: "date", label: "Date" },
] as const;
const fallbackComparison = {
	value: "indexed-fallback",
	label: "Numbers, dates, then text",
} as const;
const directions = [
	{ value: "ascending", label: "Ascending" },
	{ value: "descending", label: "Descending" },
] as const;

/** One order the server chooses its matches in: each row a property, how its
 *  values compare and a direction, the later rows breaking ties. */
export function SearchResultOrder({
	order,
	properties,
	fallbackProperties = [],
	onChange,
}: {
	order: SearchFilterOrder;
	properties: readonly Option[];
	fallbackProperties?: readonly string[];
	onChange: (next: SearchFilterOrder) => void;
}) {
	const saved = order.find((term) => term.comparison === "discarded");
	if (saved)
		return (
			<p className="text-xs text-nova-text-secondary">
				A later index fallback replaces the saved order on {saved.property}.
			</p>
		);
	return (
		<div className="space-y-2">
			{order.map((item, index) => {
				if (item.comparison === "discarded") return null;
				const fallback = item.comparison === "indexed-fallback";
				const eligible =
					order.length === 1 && fallbackProperties.includes(item.property);
				const propertyChoices = fallback
					? properties.filter((option) =>
							fallbackProperties.includes(option.value),
						)
					: properties;
				const options = propertyChoices.some(
					(option) => option.value === item.property,
				)
					? propertyChoices
					: [
							...propertyChoices,
							{ value: item.property, label: item.property },
						];
				// A patch names the flags a choice clears as `undefined`; the term
				// drops them, since a saved batch carries no `undefined` value.
				const change = (next: SearchFilterOrder[number]) =>
					onChange(
						order.map((existing, position) =>
							position === index
								? (Object.fromEntries(
										Object.entries(next).filter(
											([, value]) => value !== undefined,
										),
									) as typeof next)
								: existing,
						),
					);
				return (
					<div
						// A term has no identity of its own; its place is the key.
						// biome-ignore lint/suspicious/noArrayIndexKey: the order is the row's identity
						key={index}
						className="flex flex-wrap items-center gap-2"
					>
						<Choice
							label={`Order property ${index + 1}`}
							value={item.property}
							options={options}
							onChange={(property) =>
								change(
									fallback
										? { ...item, property }
										: { ...item, property, recordName: undefined },
								)
							}
						/>
						<Choice
							label={`Compare property ${index + 1} as`}
							value={item.comparison}
							options={
								fallback || eligible
									? [...comparisons, fallbackComparison]
									: comparisons
							}
							onChange={(value) => {
								if (value === "indexed-fallback") {
									change({
										property: item.property,
										comparison: value,
										direction: "ascending",
									});
									return;
								}
								const choice = comparisons.find(
									(option) => option.value === value,
								);
								if (choice)
									change({
										...item,
										comparison: choice.value,
										implicitComparison: undefined,
									});
							}}
						/>
						{fallback ? (
							<p className="text-xs text-nova-text-secondary">
								Ascending, with missing values last. Replaces earlier order
								filters.
							</p>
						) : (
							<Choice
								label={`Direction for property ${index + 1}`}
								value={item.direction}
								options={directions}
								onChange={(value) => {
									const choice = directions.find(
										(option) => option.value === value,
									);
									if (choice)
										change({
											...item,
											direction: choice.value,
											implicitDirection: undefined,
										});
								}}
							/>
						)}
						{index > 0 && (
							<Button
								variant="ghost"
								type="button"
								onClick={() => {
									const next = [...order];
									next.splice(index, 1);
									next.splice(index - 1, 0, item);
									onChange(next);
								}}
							>
								Move earlier
							</Button>
						)}
						<Button
							variant="ghost"
							type="button"
							onClick={() =>
								onChange(order.filter((_, position) => position !== index))
							}
						>
							Remove property
						</Button>
					</div>
				);
			})}
			{!order.some((term) => term.comparison === "indexed-fallback") && (
				<Button
					variant="outline"
					type="button"
					onClick={() =>
						onChange([
							...order,
							{
								property: properties[0]?.value ?? "case_name",
								comparison: "text",
								direction: "ascending",
							},
						])
					}
				>
					{order.length > 0 ? "Add tie-breaker" : "Choose order"}
				</Button>
			)}
		</div>
	);
}
