// components/builder/case-list-config/cards/column/DateColumnCard.tsx
//
// Renders the `date` Column kind — formats a date / datetime
// property through a CCHQ format-date pattern.
//
// Slots:
//   - `field` — case-property name. Filtered to `date` /
//     `datetime` typed properties.
//   - `header` — column display label.
//   - `pattern` — non-empty CCHQ wire-form date pattern. The
//     pattern slot surfaces through the shared
//     `CustomDatePatternInput` primitive
//     (`primitives/CustomDatePatternInput.tsx`): segmented preset
//     toggle row + free-text custom input + empty-pattern signal.
//     The primitive is mounted by both this card and the
//     ValueExpression-side `FormatDateCard` so polish-passes apply
//     once.
//
// Preset commits: this card reads the shared domain preset table and commits
// the concrete JavaRosa pattern. The ValueExpression-side card retains the
// semantic preset id and resolves it at each runtime boundary.

"use client";
import { INSPECTOR_LABEL_CLS } from "@/components/builder/inspector/inspectorChrome";
import {
	CustomDatePatternInput,
	type DatePatternPreset,
} from "@/components/builder/shared/primitives/CustomDatePatternInput";
import type { CaseProperty, Column } from "@/lib/domain";
import {
	columnKindAcceptsPropertyType,
	DATE_FORMAT_PRESET_DEFINITIONS,
	dateColumn,
	resolveCommCareDatePattern,
} from "@/lib/domain";
import { FORMAT_DATE_PRESETS } from "@/lib/domain/predicate";
import type { ColumnEditContext } from "../../columnEditorSchemas";
import { ColumnFieldRow } from "./ColumnFieldRow";

/** The gate's own accept-set (`columnKindAcceptsPropertyType`) — an
 *  unknown-typed property is admissible, so the dropdown must offer
 *  it; a stricter picker would refuse a selection every verdict
 *  accepts. */
const acceptsDateColumn = (p: CaseProperty) =>
	columnKindAcceptsPropertyType("date", p.data_type);

/**
 * Preset table for the column's date pattern. The domain owns each label,
 * example, and concrete CommCare pattern; the column stores the supported
 * pattern while legacy semantic ids are normalized for display below.
 */
const COLUMN_DATE_PRESET_TABLE: readonly DatePatternPreset[] =
	FORMAT_DATE_PRESETS.map((id) => ({
		id,
		label: DATE_FORMAT_PRESET_DEFINITIONS[id].label,
		pattern: DATE_FORMAT_PRESET_DEFINITIONS[id].commCarePattern,
	}));

interface DateColumnCardProps {
	readonly value: Extract<Column, { kind: "date" }>;
	readonly onChange: (next: Column) => void;
	readonly ctx: ColumnEditContext;
	readonly errors?: readonly string[];
}

export function DateColumnCard({
	value,
	onChange,
	errors,
}: DateColumnCardProps) {
	const resolvedPattern = resolveCommCareDatePattern(value.pattern);
	const setField = (next: string) =>
		onChange(
			dateColumn(
				value.uuid,
				next,
				value.header,
				value.pattern,
				slotsFrom(value),
			),
		);
	const setHeader = (next: string) =>
		onChange(
			dateColumn(
				value.uuid,
				value.field,
				next,
				value.pattern,
				slotsFrom(value),
			),
		);
	const setPattern = (next: string) =>
		onChange(
			dateColumn(value.uuid, value.field, value.header, next, slotsFrom(value)),
		);

	return (
		<div className="space-y-4">
			<ColumnFieldRow
				field={value.field}
				onFieldChange={setField}
				header={value.header}
				onHeaderChange={setHeader}
				propertyFilter={acceptsDateColumn}
				errors={errors}
			/>
			<div className="space-y-2">
				<div className={INSPECTOR_LABEL_CLS}>Date style</div>
				<CustomDatePatternInput
					value={resolvedPattern}
					onChange={setPattern}
					presets={COLUMN_DATE_PRESET_TABLE}
				/>
			</div>
		</div>
	);
}

/** Re-extract the column's optional common slots so each builder call
 *  threads through them verbatim. */
function slotsFrom(value: Extract<Column, { kind: "date" }>): {
	sort?: typeof value.sort;
	visibleInList?: typeof value.visibleInList;
	visibleInDetail?: typeof value.visibleInDetail;
	listOrder?: typeof value.listOrder;
	detailOrder?: typeof value.detailOrder;
} {
	return {
		sort: value.sort,
		visibleInList: value.visibleInList,
		visibleInDetail: value.visibleInDetail,
		listOrder: value.listOrder,
		detailOrder: value.detailOrder,
	};
}
