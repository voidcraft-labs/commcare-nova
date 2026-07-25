/**
 * One value for one piece of worker information, shared by the role and
 * persona editors.
 *
 * A property with an accepted-values list gets a chooser rather than a
 * text box, because CommCare rejects a worker whose value is off the list
 * — offering free text there would let an author type a value that only
 * fails much later, when the account is created.
 */
"use client";

import { useId } from "react";
import { Input } from "@/components/shadcn/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/shadcn/select";
import type { UserProperty } from "@/lib/domain";

/** The chooser's "no value" entry — a real absence, not an empty string. */
const NO_VALUE = "__nova_no_value";

export function ValueField({
	property,
	value,
	disabled,
	onChange,
	placeholder,
	describedBy,
}: {
	property: UserProperty;
	value: string;
	disabled: boolean;
	onChange: (value: string) => void;
	/** Shown in an empty input — an inherited value, for instance. */
	placeholder?: string;
	describedBy?: string;
}) {
	const inputId = useId();
	/* The chooser labels its trigger with `aria-label` (a Select is not a
	 * form control a `for` can point at); the text box takes the ordinary
	 * explicit association. */
	const label = (
		<span className="text-[12px] font-medium text-nova-text-secondary">
			{property.label}
			{property.required === true && (
				<span className="ml-1.5 font-normal text-nova-text-muted">
					required
				</span>
			)}
		</span>
	);

	if (property.choices !== undefined && property.choices.length > 0) {
		return (
			<div className="flex flex-col gap-1.5">
				{label}
				<Select
					value={value === "" ? NO_VALUE : value}
					disabled={disabled}
					onValueChange={(next) =>
						onChange(next === NO_VALUE ? "" : String(next))
					}
				>
					<SelectTrigger
						aria-label={property.label}
						aria-describedby={describedBy}
						className="min-h-11 w-full"
					>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value={NO_VALUE}>
							{placeholder ?? "No value"}
						</SelectItem>
						{property.choices.map((choice) => (
							<SelectItem key={choice} value={choice}>
								{choice}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-1.5">
			<label
				htmlFor={inputId}
				className="text-[12px] font-medium text-nova-text-secondary"
			>
				{property.label}
				{property.required === true && (
					<span className="ml-1.5 font-normal text-nova-text-muted">
						required
					</span>
				)}
			</label>
			<Input
				id={inputId}
				value={value}
				disabled={disabled}
				autoComplete="off"
				data-1p-ignore
				placeholder={placeholder}
				aria-describedby={describedBy}
				onChange={(e) => onChange(e.target.value)}
				className="min-h-11"
			/>
		</div>
	);
}
