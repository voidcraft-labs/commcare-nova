"use client";

import { useState } from "react";
import { renderColumnCell } from "@/components/builder/case-list-config/columnCellRenderer";
import {
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "@/components/shadcn/tabs";
import type { CaseListConfig, Column } from "@/lib/domain";
import { availableDetailTabs } from "@/lib/domain/detailTabs";
import { caseColumnLabel } from "@/lib/preview/caseColumnLabel";
import { projectTileGrid } from "@/lib/preview/caseTileLayout";
import type { ColumnDisplayContext } from "@/lib/preview/columnDisplay";
import type { CaseRowWithCalculated } from "@/lib/preview/engine/caseDataBindingTypes";
import { usePreviewPlatformRules } from "@/lib/session/hooks";
import { CaseTile } from "./CaseTile";

export function CaseDetailFields({
	config,
	columns: detailColumns,
	row: displayedOpenCase,
	displayContext: columnDisplayContext,
}: {
	config: CaseListConfig | undefined;
	columns: readonly Column[];
	row: CaseRowWithCalculated;
	displayContext: ColumnDisplayContext;
}) {
	const platformRules = usePreviewPlatformRules();
	const detailSpans = availableDetailTabs(
		config,
		detailColumns,
		displayedOpenCase.calculated,
	);
	const [selection, setSelection] = useState<{ caseId: string; tab: string }>();
	const selected =
		detailSpans?.find(
			(span) =>
				selection?.caseId === displayedOpenCase.case_id &&
				span.tab.uuid === selection.tab,
		) ?? detailSpans?.[0];
	const renderDetailFields = (
		columns: typeof detailColumns,
		openCase: NonNullable<typeof displayedOpenCase>,
	) => {
		const tile = config?.detailTile;
		if (tile && platformRules.detailTile === "laid-out") {
			const placed = columns.map((column) => ({
				...column,
				tile: tile.cells[column.uuid],
			}));
			return (
				<CaseTile
					surface="detail"
					columns={placed.map((column) => ({ column, valueHidden: false }))}
					projection={projectTileGrid(placed)}
					row={openCase}
					caseProperties={columnDisplayContext.caseProperties}
					displayContext={columnDisplayContext}
				/>
			);
		}
		return (
			<dl
				data-case-detail="responsive"
				className="@container/detail overflow-hidden rounded-lg border border-pv-input-border bg-pv-surface"
			>
				{columns.map((col, i) => {
					const label = caseColumnLabel(
						col,
						columnDisplayContext.caseProperties,
						columnDisplayContext.projectProse,
					);
					return (
						<div
							key={col.uuid}
							data-case-detail-field={col.uuid}
							className={`grid grid-cols-1 items-start gap-1 px-4 py-3 @sm/detail:grid-cols-[minmax(110px,0.38fr)_minmax(0,1fr)] @sm/detail:gap-3 ${i > 0 ? "border-t border-nova-violet/[0.08]" : ""}`}
						>
							<dt className="break-words text-xs font-medium text-nova-text-muted">
								{label}
							</dt>
							<dd
								data-case-detail-value
								className="min-w-0 break-words text-[14px] leading-relaxed text-nova-text-secondary [overflow-wrap:anywhere]"
							>
								{renderColumnCell(col, openCase, columnDisplayContext)}
							</dd>
						</div>
					);
				})}
			</dl>
		);
	};
	return detailSpans ? (
		detailSpans.length ? (
			<Tabs
				key={displayedOpenCase.case_id}
				value={selected?.tab.uuid}
				onValueChange={(value) => {
					if (typeof value === "string")
						setSelection({ caseId: displayedOpenCase.case_id, tab: value });
				}}
			>
				<TabsList variant="line" className="max-w-full flex-wrap">
					{detailSpans.map(({ tab }) => (
						<TabsTrigger key={tab.uuid} value={tab.uuid}>
							{tab.title}
						</TabsTrigger>
					))}
				</TabsList>
				{detailSpans.map(({ tab, start, end }) => (
					<TabsContent key={tab.uuid} value={tab.uuid}>
						{renderDetailFields(
							detailColumns.slice(start, end),
							displayedOpenCase,
						)}
					</TabsContent>
				))}
			</Tabs>
		) : null
	) : (
		renderDetailFields(detailColumns, displayedOpenCase)
	);
}
