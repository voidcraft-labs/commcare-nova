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

export function ValueField({
	property,
	value,
	disabled,
	onChange,
	inheritedValue,
	describedBy,
}: {
	property: UserProperty;
	/** `undefined` inherits/has no authored value; `""` is an explicit blank. */
	value: string | undefined;
	disabled: boolean;
	onChange: (value: string | undefined) => void;
	/** Role default shown while a persona has no own override. */
	inheritedValue?: string;
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
		const choiceIndex =
			value === undefined || value === ""
				? -1
				: property.choices.indexOf(value);
		const selectedValue =
			value === undefined ? -1 : value === "" ? 0 : choiceIndex + 1;
		const selectedLabel =
			value === undefined
				? inheritedValue === undefined
					? "No value"
					: `Use role value: ${inheritedValue}`
				: value === ""
					? "Blank"
					: value;
		return (
			<div className="flex flex-col gap-1.5">
				{label}
				<Select
					value={selectedValue}
					disabled={disabled}
					onValueChange={(next) => {
						const index = Number(next);
						if (index === -1) onChange(undefined);
						else if (index === 0) onChange("");
						else onChange(property.choices?.[index - 1]);
					}}
				>
					<SelectTrigger
						aria-label={property.label}
						aria-describedby={describedBy}
						className="min-h-11 w-full"
					>
						<SelectValue>{selectedLabel}</SelectValue>
					</SelectTrigger>
					<SelectContent>
						<SelectItem value={-1}>
							{inheritedValue === undefined
								? "No value"
								: `Use role value: ${inheritedValue}`}
						</SelectItem>
						<SelectItem value={0}>Blank</SelectItem>
						{property.choices.map((choice, index) => (
							<SelectItem key={choice} value={index + 1}>
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
				value={value ?? ""}
				disabled={disabled}
				autoComplete="off"
				data-1p-ignore
				placeholder={inheritedValue}
				aria-describedby={describedBy}
				onChange={(e) => onChange(e.target.value)}
				className="min-h-11"
			/>
			{value !== undefined && (
				<button
					type="button"
					disabled={disabled}
					onClick={() => onChange(undefined)}
					className="min-h-8 self-start text-[12px] font-medium text-nova-accent hover:underline disabled:cursor-not-allowed disabled:opacity-40"
				>
					{inheritedValue === undefined ? "Remove value" : "Use role value"}
				</button>
			)}
		</div>
	);
}
