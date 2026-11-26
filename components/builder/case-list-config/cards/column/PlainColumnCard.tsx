"use client";

import {
	INSPECTOR_LABEL_CLS,
	SegmentedRow,
} from "@/components/builder/inspector/inspectorChrome";
import type { Column, ColumnVia } from "@/lib/domain";
import {
	type ColumnEditContext,
	resolveColumnProperty,
} from "../../columnEditorSchemas";
import { columnWithSource } from "../../columnSources";
import { ColumnFieldRow } from "./ColumnFieldRow";

interface PlainColumnCardProps {
	readonly value: Extract<Column, { kind: "plain" }>;
	readonly onChange: (next: Column) => void;
	readonly ctx: ColumnEditContext;
	readonly errors?: readonly string[];
}

export function PlainColumnCard({
	value,
	onChange,
	ctx,
	errors,
}: PlainColumnCardProps) {
	const isChoice = (
		field: string,
		via?: ColumnVia,
		readFrom?: "worker-record",
	) => {
		const type = resolveColumnProperty(ctx, field, via, readFrom)?.data_type;
		return type === "single_select" || type === "multi_select";
	};
	const { showChoice, ...automatic } = value;
	const setSource = (
		via: ColumnVia | undefined,
		field: string,
		readFrom?: "worker-record",
		showOwner?: "name",
	) =>
		onChange(
			columnWithSource(
				isChoice(field, via, readFrom) ? value : automatic,
				via,
				field,
				readFrom,
				showOwner,
			),
		);
	return (
		<div className="space-y-4">
			<ColumnFieldRow
				via={value.via}
				readFrom={value.readFrom}
				showOwner={value.showOwner}
				onSourceChange={setSource}
				field={value.field}
				onFieldChange={(field) =>
					setSource(
						value.via,
						field,
						value.readFrom,
						field === value.field ? value.showOwner : undefined,
					)
				}
				header={value.header}
				onHeaderChange={(header) => onChange({ ...value, header })}
				errors={errors}
			/>
			{isChoice(value.field, value.via, value.readFrom) && (
				<div>
					<div className={`mb-2 ${INSPECTOR_LABEL_CLS}`}>Show choices as</div>
					<SegmentedRow
						legend="Show choices as"
						options={[
							{ value: "label", label: "Choice labels" },
							{ value: "saved-value", label: "Saved values" },
						]}
						value={showChoice ?? "label"}
						onChange={(display) =>
							onChange(
								display === "saved-value"
									? { ...automatic, showChoice: display }
									: automatic,
							)
						}
					/>
				</div>
			)}
		</div>
	);
}
