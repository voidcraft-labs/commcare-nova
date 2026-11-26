"use client";

import { Button } from "@/components/shadcn/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/shadcn/select";
import type { SearchRequestOrder } from "@/lib/domain/modules";

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
const directions = [
	{ value: "ascending", label: "Ascending" },
	{ value: "descending", label: "Descending" },
] as const;

/** One order the server chooses its matches in: each row a property, how its
 *  values compare and a direction, the later rows breaking ties. */
export function SearchResultOrder({
	order,
	properties,
	onChange,
}: {
	order: SearchRequestOrder;
	properties: readonly Option[];
	onChange: (next: SearchRequestOrder) => void;
}) {
	return (
		<div className="space-y-2">
			{order.map((item, index) => {
				const options = properties.some(
					(option) => option.value === item.property,
				)
					? properties
					: [...properties, { value: item.property, label: item.property }];
				const change = (patch: Partial<typeof item>) =>
					onChange(
						order.map((existing, position) =>
							position === index ? { ...existing, ...patch } : existing,
						) as SearchRequestOrder,
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
								change({ property, recordName: undefined })
							}
						/>
						<Choice
							label={`Compare property ${index + 1} as`}
							value={item.comparison}
							options={comparisons}
							onChange={(value) => {
								const choice = comparisons.find(
									(option) => option.value === value,
								);
								if (choice)
									change({
										comparison: choice.value,
										implicitComparison: undefined,
									});
							}}
						/>
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
										direction: choice.value,
										implicitDirection: undefined,
									});
							}}
						/>
						{index > 0 && (
							<Button
								variant="ghost"
								type="button"
								onClick={() => {
									const next = [...order];
									next.splice(index, 1);
									next.splice(index - 1, 0, item);
									onChange(next as SearchRequestOrder);
								}}
							>
								Move earlier
							</Button>
						)}
						<Button
							variant="ghost"
							type="button"
							onClick={() =>
								onChange(
									order.filter(
										(_, position) => position !== index,
									) as SearchRequestOrder,
								)
							}
						>
							Remove property
						</Button>
					</div>
				);
			})}
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
		</div>
	);
}
