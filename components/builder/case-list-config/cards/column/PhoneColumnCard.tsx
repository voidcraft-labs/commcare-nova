// components/builder/case-list-config/cards/column/PhoneColumnCard.tsx
//
// Renders the `phone` Column kind — the case-list cell renders
// the property as a tappable telephone link in the running app.
// Static contexts fall back to plain text.
//
// Slots:
//   - `field` — case-property name. The picker filters to
//     text-shaped properties (`text` / `single_select` /
//     `multi_select`) since phone numbers are stored as strings;
//     numeric-typed properties would still parse but the wire-
//     side tap binding expects a string.
//   - `header` — column display label.

"use client";
import type { Column } from "@/lib/domain";
import { isTextShaped, phoneColumn } from "@/lib/domain";
import type { ColumnEditContext } from "../../columnEditorSchemas";
import { ColumnFieldRow } from "./ColumnFieldRow";

interface PhoneColumnCardProps {
	readonly value: Extract<Column, { kind: "phone" }>;
	readonly onChange: (next: Column) => void;
	readonly ctx: ColumnEditContext;
	readonly errors?: readonly string[];
}

export function PhoneColumnCard({
	value,
	onChange,
	errors,
}: PhoneColumnCardProps) {
	const setField = (next: string) =>
		onChange(phoneColumn(value.uuid, next, value.header, slotsFrom(value)));
	const setHeader = (next: string) =>
		onChange(phoneColumn(value.uuid, value.field, next, slotsFrom(value)));
	return (
		<ColumnFieldRow
			field={value.field}
			onFieldChange={setField}
			header={value.header}
			onHeaderChange={setHeader}
			propertyFilter={isTextShaped}
			errors={errors}
		/>
	);
}

/** Re-extract the column's optional common slots so each builder call
 *  threads through them verbatim. */
function slotsFrom(value: Extract<Column, { kind: "phone" }>): {
	sort?: typeof value.sort;
	visibleInList?: typeof value.visibleInList;
	visibleInDetail?: typeof value.visibleInDetail;
} {
	return {
		sort: value.sort,
		visibleInList: value.visibleInList,
		visibleInDetail: value.visibleInDetail,
	};
}
