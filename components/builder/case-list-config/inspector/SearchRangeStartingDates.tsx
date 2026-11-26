"use client";

import { useId, useState } from "react";
import { Button } from "@/components/shadcn/button";
import { DatePicker } from "@/components/shadcn/date-picker";
import { Field, FieldLabel } from "@/components/shadcn/field";
import { fixedSearchRangeExpression } from "@/lib/doc/expressionText";
import { searchStartingDatesSchema } from "@/lib/domain";
import type { Expression } from "@/lib/domain/expression";

/** Stage the whole answer. Choosing the first date cannot save a partial
 * range or discard the calculation that currently supplies it. */
export function SearchRangeStartingDates({
	initial,
	onChange,
	onClose,
}: {
	initial?: { from: string; to: string };
	onChange: (expression: Expression) => void;
	onClose: () => void;
}) {
	const id = useId();
	const [from, setFrom] = useState(initial?.from ?? "");
	const [to, setTo] = useState(initial?.to ?? "");
	return (
		<div className="space-y-2">
			<Field>
				<FieldLabel htmlFor={`${id}-from`}>Start date</FieldLabel>
				<DatePicker id={`${id}-from`} value={from} onValueChange={setFrom} />
			</Field>
			<Field>
				<FieldLabel htmlFor={`${id}-to`}>End date</FieldLabel>
				<DatePicker id={`${id}-to`} value={to} onValueChange={setTo} />
			</Field>
			{to && from && to < from && (
				<p role="status">The end date comes before the start date.</p>
			)}
			<div className="flex gap-2">
				<Button
					type="button"
					disabled={!searchStartingDatesSchema.safeParse({ from, to }).success}
					onClick={() => {
						if (from !== initial?.from || to !== initial?.to)
							onChange(fixedSearchRangeExpression(from, to));
						onClose();
					}}
				>
					Use these dates
				</Button>
				<Button type="button" variant="ghost" onClick={onClose}>
					Cancel
				</Button>
			</div>
		</div>
	);
}
