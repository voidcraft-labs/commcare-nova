"use client";

import { useId } from "react";
import { INSPECTOR_LABEL_CLS } from "@/components/builder/inspector/inspectorChrome";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/shadcn/select";
import {
	type Column,
	columnKindAcceptsPropertyType,
	DATE_COUNT_PERIODS,
	type DateCountPeriod,
} from "@/lib/domain";
import { columnWithSource } from "../../columnSources";
import { ColumnFieldRow } from "./ColumnFieldRow";
import { ThresholdInput } from "./IntervalThresholdRow";

const labels: Record<DateCountPeriod, string> = {
	"days-since": "Days since",
	"weeks-since": "Weeks since",
	"months-since": "Months since",
	"years-since": "Years since",
	"days-until": "Days until",
	"weeks-until": "Weeks until",
	"months-until": "Months until",
};

type CalendarColumn = Extract<
	Column,
	{ kind: "date-count" | "overdue-marker" }
>;

interface CardProps<Value extends CalendarColumn> {
	value: Value;
	onChange: (next: Column) => void;
	errors?: readonly string[];
}

function DateSource({ value, onChange, errors }: CardProps<CalendarColumn>) {
	return (
		<ColumnFieldRow
			via={value.via}
			readFrom={value.readFrom}
			showOwner={value.showOwner}
			onSourceChange={(via, field, readFrom, showOwner) =>
				onChange(columnWithSource(value, via, field, readFrom, showOwner))
			}
			field={value.field}
			onFieldChange={(field) => onChange({ ...value, field })}
			header={value.header}
			onHeaderChange={(header) => onChange({ ...value, header })}
			propertyFilter={(p) =>
				columnKindAcceptsPropertyType(value.kind, p.data_type)
			}
			errors={errors}
		/>
	);
}

export function OverdueMarkerColumnCard(
	props: CardProps<Extract<Column, { kind: "overdue-marker" }>>,
) {
	const id = useId();
	return (
		<div className="space-y-4">
			<DateSource {...props} />
			<div>
				<label htmlFor={id} className={INSPECTOR_LABEL_CLS}>
					Days after the date
				</label>
				<ThresholdInput
					id={id}
					signed
					value={props.value.afterDays}
					onChange={(afterDays) =>
						props.onChange({ ...props.value, afterDays })
					}
				/>
				<p className="mt-2 text-[13px] text-nova-text-muted">
					A missing date also shows an asterisk. A negative number moves the
					deadline earlier.
				</p>
			</div>
		</div>
	);
}

export function DateCountColumnCard(
	props: CardProps<Extract<Column, { kind: "date-count" }>>,
) {
	const { value, onChange } = props;
	return (
		<div className="space-y-4">
			<DateSource {...props} />
			<Select
				value={value.period}
				onValueChange={(period) => {
					if (period !== null) onChange({ ...value, period });
				}}
			>
				<SelectTrigger aria-label="Time to show">
					<SelectValue>{labels[value.period]}</SelectValue>
				</SelectTrigger>
				<SelectContent>
					{DATE_COUNT_PERIODS.map((period) => (
						<SelectItem key={period} value={period}>
							{labels[period]}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</div>
	);
}
