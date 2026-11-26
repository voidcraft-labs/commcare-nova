"use client";
import { useId } from "react";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "./select";

/** A labeled single choice whose saved identity and displayed words differ. */
export function LabeledSelect<T extends string>({
	label,
	choices,
	value,
	placeholder,
	select,
}: {
	label: string;
	choices: readonly { value: T; label: string }[];
	value: T | undefined;
	placeholder?: string;
	select: (value: T) => void;
}) {
	const id = useId();
	return (
		<div>
			<label htmlFor={id}>{label}</label>
			<Select<T>
				value={value ?? null}
				items={choices}
				onValueChange={(next) => {
					if (next !== null) select(next);
				}}
			>
				<SelectTrigger id={id} wrapValue className="mt-1 w-full">
					<SelectValue placeholder={placeholder} />
				</SelectTrigger>
				<SelectContent>
					{choices.map((choice) => (
						<SelectItem key={choice.value} value={choice.value} wrap>
							{choice.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</div>
	);
}
