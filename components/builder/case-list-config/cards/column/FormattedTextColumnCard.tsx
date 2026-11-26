"use client";

import type { Column } from "@/lib/domain";
import { columnWithSource } from "../../columnSources";
import { ColumnFieldRow } from "./ColumnFieldRow";

export function FormattedTextColumnCard({
	value,
	onChange,
	errors,
}: {
	value: Extract<
		Column,
		{
			kind: "formatted-text" | "worker-distance" | "map-location" | "map-layer";
		}
	>;
	onChange: (next: Column) => void;
	errors?: readonly string[];
}) {
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
			errors={errors}
		/>
	);
}
