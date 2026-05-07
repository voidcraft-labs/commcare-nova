// components/builder/case-list-config/cards/column/PlainColumnCard.tsx
//
// Renders the `plain` Column kind — the case-list cell shows the
// property's raw value as a string, no formatting applied. The
// default kind for any displayed column.
//
// Slots:
//   - `field` — case-property name. Plain accepts every property
//     type (`applicableForAny`), so the picker surfaces every
//     declared property without filtering.
//   - `header` — column display label.
//
// No per-kind extras beyond the shared field/header pair.

"use client";
import type { Column } from "@/lib/domain";
import { plainColumn } from "@/lib/domain";
import type { ColumnEditContext } from "../../columnEditorSchemas";
import { ColumnFieldRow } from "./ColumnFieldRow";

interface PlainColumnCardProps {
	readonly value: Extract<Column, { kind: "plain" }>;
	readonly onChange: (next: Column) => void;
	readonly ctx: ColumnEditContext;
	readonly errors?: readonly string[];
}

/**
 * Plain column card. Routes every mutation through `plainColumn`
 * so the constructed shape always matches the schema. The `ctx`
 * prop is unused at the leaf level (PropertyPicker reads from
 * the surrounding `PredicateEditProvider` context the parent
 * editor mounts) but stays in the signature for parity with
 * cards that need it.
 */
export function PlainColumnCard({
	value,
	onChange,
	errors,
}: PlainColumnCardProps) {
	const setField = (next: string) => onChange(plainColumn(next, value.header));
	const setHeader = (next: string) => onChange(plainColumn(value.field, next));
	return (
		<ColumnFieldRow
			field={value.field}
			onFieldChange={setField}
			header={value.header}
			onHeaderChange={setHeader}
			errors={errors}
		/>
	);
}
