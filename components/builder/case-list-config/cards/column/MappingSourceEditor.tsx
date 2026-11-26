"use client";

import { useState } from "react";
import { INSPECTOR_LABEL_CLS } from "@/components/builder/inspector/inspectorChrome";
import { ConditionSlotEditor } from "@/components/builder/shared/ExpressionSlotEditors";
import { BlurCommitTextInput } from "@/components/builder/shared/primitives/BlurCommitTextInput";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/shadcn/select";
import type { Column } from "@/lib/domain";
import type { CaseMappingRow } from "@/lib/domain/caseMappingRows";
import type { ColumnEditContext } from "../../columnEditorSchemas";
import {
	type MappingComparisonMode,
	mappingComparisonPatch,
} from "../../mappingRowComparison";

export function MappingSourceEditor({
	column,
	row,
	index,
	ctx,
	onChange,
}: {
	column: Extract<Column, { kind: "id-mapping" | "image-map" }>;
	row: CaseMappingRow;
	index: number;
	ctx: ColumnEditContext;
	onChange: (patch: Partial<CaseMappingRow>) => string | null;
}) {
	const [issue, setIssue] = useState<string | null>(null);
	const image = column.kind === "image-map";
	const conditional = image || column.behavior === "first-match";
	const mode = row.when
		? "condition"
		: image && row.match !== "exact"
			? "selected"
			: "exact";
	const options = [
		...(image ? [{ mode: "selected", label: "One of the saved choices" }] : []),
		{ mode: "exact", label: "The entire saved value" },
		{ mode: "condition", label: "A condition" },
	];
	return (
		<>
			{conditional && (
				<Select
					value={mode}
					onValueChange={(next) => {
						if (!next || next === mode) return;
						setIssue(
							onChange(
								mappingComparisonPatch(
									row,
									next as MappingComparisonMode,
									image,
								),
							),
						);
					}}
				>
					<SelectTrigger aria-label={`Value ${index + 1} comparison`}>
						<SelectValue>
							{options.find((o) => o.mode === mode)?.label}
						</SelectValue>
					</SelectTrigger>
					<SelectContent>
						{options.map((o) => (
							<SelectItem key={o.mode} value={o.mode}>
								{o.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			)}
			{row.when && row.uuid && ctx.moduleUuid ? (
				<ConditionSlotEditor
					slot={{
						entity: "module",
						uuid: ctx.moduleUuid,
						slot: "case_list_mapping_condition",
						member: { columnUuid: column.uuid, rowUuid: row.uuid },
					}}
					candidate={{ entity: "column", value: column }}
					value={row.when}
					onChange={(when) => setIssue(onChange({ when }))}
					caseTypes={ctx.caseTypes}
					currentCaseType={ctx.currentCaseType}
					userProperties={ctx.userProperties}
					rootLabel={`When to show rule ${index + 1}`}
				/>
			) : (
				<div>
					<div className={`mb-2 ${INSPECTOR_LABEL_CLS}`}>Saved value</div>
					<BlurCommitTextInput
						value={row.value ?? ""}
						onCommit={(value) => setIssue(onChange({ value }))}
						ariaLabel={`Value ${index + 1} saved value`}
					/>
				</div>
			)}
			{issue && (
				<p role="status" className="text-[13px] leading-5 text-nova-rose">
					{issue}
				</p>
			)}
		</>
	);
}
