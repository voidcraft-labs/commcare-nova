// components/builder/case-list-config/cards/column/SearchOnlyCard.tsx
//
// Renders the `search-only` Column kind — declares the property
// as searchable in the case-list search UI WITHOUT rendering a
// visible cell on the case list. Pairs with the
// `searchInputModeMatchesPropertyType` validator rule which
// expands the indexable property set to include every search-only
// declaration.
//
// Slots:
//   - `field` — case-property name. Accepts every property type
//     (the search-side mode picker is what gates by data type).
//   - `header` — preserved for the authoring-surface label even
//     though the wire layer skips emission for this kind. The
//     case-list-config Display section lists every column so
//     authors need a row label even for non-rendering columns.

"use client";
import type { Column } from "@/lib/domain";
import { searchOnlyColumn } from "@/lib/domain";
import type { ColumnEditContext } from "../../columnEditorSchemas";
import { ColumnFieldRow } from "./ColumnFieldRow";

interface SearchOnlyCardProps {
	readonly value: Extract<Column, { kind: "search-only" }>;
	readonly onChange: (next: Column) => void;
	readonly ctx: ColumnEditContext;
	readonly errors?: readonly string[];
}

export function SearchOnlyCard({
	value,
	onChange,
	errors,
}: SearchOnlyCardProps) {
	const setField = (next: string) =>
		onChange(searchOnlyColumn(next, value.header));
	const setHeader = (next: string) =>
		onChange(searchOnlyColumn(value.field, next));
	return (
		<div className="space-y-2">
			<ColumnFieldRow
				field={value.field}
				onFieldChange={setField}
				header={value.header}
				onHeaderChange={setHeader}
				errors={errors}
			/>
			<p className="text-[11px] leading-snug text-nova-text-muted/70">
				This column is indexed for search but does not render on the case list.
			</p>
		</div>
	);
}
