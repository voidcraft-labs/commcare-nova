// components/builder/case-list-config/canvas/DetailCanvas.tsx
//
// The case-detail tab's canvas: what opens after choosing a case
// from the list, rendered over the first live sample case. Detail
// fields ARE the columns — each column's `visibleInDetail` slot picks
// whether it appears here — so clicking a row opens the same column
// inspector the case-list tab uses, with the list/detail visibility
// toggles on it.
//
// Every column renders regardless of `visibleInDetail` — hidden ones
// dim with an eye-off glyph so the full structure stays reachable for
// editing. "Add detail field" seeds a column hidden from the LIST
// (`visibleInList: false`): the author's intent on this tab is "show
// another property when a case is opened", not "add a list column".

"use client";
import { Icon } from "@iconify/react/offline";
import tablerEyeOff from "@iconify-icons/tabler/eye-off";
import tablerId from "@iconify-icons/tabler/id";
import { ContentFrame } from "@/components/builder/ContentFrame";
import type { CaseListConfig } from "@/lib/domain";
import type { CaseRowWithCalculated } from "@/lib/preview/engine/caseDataBindingTypes";
import { renderColumnCell } from "../columnCellRenderer";
import { GenerateSampleDataButton } from "../SampleDataButton";
import type { CaseListPreviewState } from "../useCaseListPreview";
import type { SampleDataAction } from "../useSampleData";
import type { WorkspaceSelection } from "../workspaceSelection";
import { AddGhostButton, CanvasNotice, previewNotice } from "./canvasChrome";

export interface DetailCanvasProps {
	readonly config: CaseListConfig;
	readonly preview: CaseListPreviewState;
	readonly selection: WorkspaceSelection | null;
	readonly onSelect: (next: WorkspaceSelection) => void;
	readonly onAddDetailField: () => void;
	/** Disabled-add hint — `undefined` means add is enabled. */
	readonly addDisabledReason: string | undefined;
	/** Populate-sample-data action — surfaced at the TOP of the canvas
	 *  when the store is empty so the detail never dead-ends with a wall
	 *  of em-dashes and no way forward. */
	readonly generate: SampleDataAction;
}

export function DetailCanvas({
	config,
	preview,
	selection,
	onSelect,
	onAddDetailField,
	addDisabledReason,
	generate,
}: DetailCanvasProps) {
	const columns = config.columns;
	const selectedColumnUuid =
		selection?.type === "column" ? selection.uuid : null;

	const sampleRow: CaseRowWithCalculated | undefined =
		preview.kind === "rows" ? preview.rows[0] : undefined;

	return (
		<ContentFrame width="lg" className="px-6 pt-6 pb-24">
			<p className="mb-5 text-[13px] text-nova-text-muted">
				What opens after choosing a case from the list — click a row to set it
				up.
			</p>

			<div className="flex items-center gap-3 mb-1.5">
				<Icon
					icon={tablerId}
					width="22"
					height="22"
					className="text-nova-text-secondary"
				/>
				<h1 className="font-display font-bold text-2xl tracking-tight text-nova-text">
					{sampleRow?.case_name || "Case detail"}
				</h1>
			</div>
			<p className="mb-5 ml-[34px] text-xs text-nova-text-muted">
				{sampleRow !== undefined
					? "Shown with a live sample case."
					: "Values appear once the case list has data."}
			</p>

			{/* Empty store → the generate affordance LEADS, at the top, so
			 *  populating data is the obvious next step rather than a footnote
			 *  under a column of em-dashes. Other non-rows states explain
			 *  themselves in the same slot. Gated on having fields — with none,
			 *  the card's own "No fields yet" line is the right first ask. */}
			{columns.length > 0 &&
				(preview.kind === "empty" ? (
					<div className="mb-5 rounded-lg border border-dashed border-nova-border-bright px-5 py-6 text-center">
						<p className="text-xs text-nova-text-muted mb-3.5">
							No cases yet — generate sample data to preview this detail with
							realistic values.
						</p>
						<GenerateSampleDataButton generate={generate} />
					</div>
				) : preview.kind !== "rows" &&
					preview.kind !== "idle" &&
					preview.kind !== "loading" ? (
					<div className="mb-5 rounded-md border border-nova-border bg-nova-surface/20">
						<CanvasNotice tone={previewNotice(preview).tone}>
							{previewNotice(preview).text}
						</CanvasNotice>
					</div>
				) : null)}

			<div className="rounded-lg border border-nova-border bg-nova-surface/40 overflow-hidden">
				{columns.length === 0 ? (
					<CanvasNotice tone="muted">
						No fields yet — add one to show a property when a case is opened.
					</CanvasNotice>
				) : (
					columns.map((col, i) => {
						const hidden = col.visibleInDetail === false;
						const isSel = selectedColumnUuid === col.uuid;
						const label =
							col.kind === "calculated"
								? col.header || "untitled"
								: col.header || col.field || "untitled";
						return (
							<button
								type="button"
								key={col.uuid}
								onClick={() => onSelect({ type: "column", uuid: col.uuid })}
								className={`w-full flex items-center gap-2.5 px-4 py-3 min-h-11 text-left cursor-pointer transition-colors ${
									i > 0 ? "border-t border-nova-violet/[0.08]" : ""
								} ${
									isSel
										? "bg-nova-violet/[0.10] shadow-[inset_0_0_0_1.5px_var(--nova-violet)]"
										: "hover:bg-white/[0.03]"
								} ${hidden ? "opacity-45" : ""}`}
							>
								{hidden && (
									<span
										role="img"
										className="inline-flex shrink-0"
										aria-label="Hidden from the case detail"
									>
										<Icon
											icon={tablerEyeOff}
											width="14"
											height="14"
											className="text-nova-text-muted"
										/>
									</span>
								)}
								<span
									className={`w-[150px] shrink-0 text-[13px] text-nova-text-muted ${col.header ? "" : "italic"}`}
								>
									{label}
								</span>
								<span className="min-w-0 text-[13px] text-nova-text-secondary overflow-hidden text-ellipsis whitespace-nowrap">
									{sampleRow !== undefined
										? renderColumnCell(col, sampleRow)
										: "—"}
								</span>
							</button>
						);
					})
				)}
			</div>

			<AddGhostButton
				label="Add Detail Field"
				onClick={onAddDetailField}
				disabledReason={addDisabledReason}
				className="w-full mt-3"
			/>
		</ContentFrame>
	);
}
