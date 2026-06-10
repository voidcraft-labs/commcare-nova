// components/builder/case-list-config/inspector/ListPanelInspectorBody.tsx
//
// Properties for the case list as a whole — what clicking the list's
// title chrome selects. Two clusters:
//
//   - **Sorting** — the sort-priority pill stack. Per-column sort
//     direction lives on each column's inspector; the priority ORDER
//     across sorted columns is a list-level concern, so it lives
//     here.
//   - **Appearance** — the image + audio for the "Open case list"
//     menu link. Only `caseListOnly` modules expose a standalone
//     case-list command to host the media (the local `.ccz` command
//     `<display>`, the HQ `case_list.media_*` dict), so the cluster
//     self-gates — on a module with forms the slots would be a dead
//     affordance with no wire target.

"use client";
import { Icon } from "@iconify/react/offline";
import tablerLoader2 from "@iconify-icons/tabler/loader-2";
import tablerRefresh from "@iconify-icons/tabler/refresh";
import tablerSparkles from "@iconify-icons/tabler/sparkles";
import { useState } from "react";
import { SingleAssetSlot } from "@/components/builder/media/MediaSlot";
import { setOptionalSlot } from "@/components/builder/shared/setOptionalSlot";
import { asAssetId, type CaseListConfig, type Column } from "@/lib/domain";
import { SortPriorityStack } from "../SortPriorityStack";
import type { SampleDataAction } from "../useSampleData";

export interface ListPanelInspectorBodyProps {
	readonly config: CaseListConfig;
	readonly onChange: (next: CaseListConfig) => void;
	/** Whether the module is a `caseListOnly` shape — gates the
	 *  appearance cluster (see file header). */
	readonly caseListOnly: boolean;
	/** Generate / Reset sample data — actions against the user's real
	 *  case store; the canvases reload after a successful run. */
	readonly sampleData: {
		readonly generate: SampleDataAction;
		readonly reset: SampleDataAction;
	};
}

export function ListPanelInspectorBody({
	config,
	onChange,
	caseListOnly,
	sampleData,
}: ListPanelInspectorBodyProps) {
	const setColumns = (next: readonly Column[]) => {
		onChange({ ...config, columns: [...next] });
	};

	/** Rebuild the whole `caseListConfig` with one media slot set or
	 *  dropped. `setOptionalSlot` omits the key on a clear so presence
	 *  checks (`"icon" in config`) stay honest across the wire. */
	const setMediaSlot = (
		slot: "icon" | "audioLabel",
		next: string | undefined,
	) => {
		onChange(setOptionalSlot(config, slot, next ? asAssetId(next) : undefined));
	};

	return (
		<>
			<div className="space-y-1.5">
				<div className="text-[10px] uppercase tracking-widest text-nova-text-muted/70">
					Sort order
				</div>
				<SortPriorityStack value={config.columns} onChange={setColumns} />
				<p className="text-[10px] text-nova-text-muted/60">
					Drag to rearrange priority — the first pill is the primary sort.
				</p>
			</div>

			<div className="space-y-2 pt-2 border-t border-nova-border">
				<div className="text-[10px] uppercase tracking-widest text-nova-text-muted/70">
					Sample data
				</div>
				<SampleDataControls sampleData={sampleData} />
			</div>

			{caseListOnly && (
				<div className="space-y-3 pt-2 border-t border-nova-border">
					<div className="text-[10px] uppercase tracking-widest text-nova-text-muted/70">
						Menu link appearance
					</div>
					<div>
						<span className="text-xs text-nova-text-muted mb-1 block">
							Icon
						</span>
						<SingleAssetSlot
							value={config.icon}
							kind="image"
							ariaLabel="Case list icon"
							onChange={(icon) => setMediaSlot("icon", icon)}
						/>
					</div>
					<div>
						<span className="text-xs text-nova-text-muted mb-1 block">
							Audio label
						</span>
						<SingleAssetSlot
							value={config.audioLabel}
							kind="audio"
							ariaLabel="Case list audio label"
							onChange={(audioLabel) => setMediaSlot("audioLabel", audioLabel)}
						/>
					</div>
				</div>
			)}
		</>
	);
}

// ── Sample data controls ──────────────────────────────────────────

/**
 * Generate + Reset, side by side. Reset discards every case in the
 * case type (including rows authored through Preview form
 * submissions), so it takes a second, explicitly-worded click —
 * inline rather than a dialog, since the rail IS the focused context.
 */
function SampleDataControls({
	sampleData,
}: {
	readonly sampleData: ListPanelInspectorBodyProps["sampleData"];
}) {
	const { generate, reset } = sampleData;
	const [confirmingReset, setConfirmingReset] = useState(false);

	const buttonCls =
		"inline-flex items-center justify-center gap-1.5 px-2.5 py-2 text-[11px] rounded-md border transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed";

	return (
		<div className="space-y-2">
			<div className="flex gap-2">
				<button
					type="button"
					onClick={generate.run}
					disabled={generate.status.kind === "running"}
					className={`${buttonCls} flex-1 border-nova-violet/[0.35] bg-nova-violet/[0.12] text-nova-violet-bright hover:bg-nova-violet/[0.2]`}
				>
					<Icon
						icon={
							generate.status.kind === "running"
								? tablerLoader2
								: tablerSparkles
						}
						width="12"
						height="12"
						className={
							generate.status.kind === "running" ? "animate-spin" : undefined
						}
					/>
					{generate.status.kind === "running" ? "Generating…" : "Generate"}
				</button>
				{confirmingReset ? (
					<>
						<button
							type="button"
							onClick={() => {
								setConfirmingReset(false);
								void reset.run();
							}}
							disabled={reset.status.kind === "running"}
							className={`${buttonCls} flex-1 border-nova-rose/40 bg-nova-rose/[0.1] text-nova-rose hover:bg-nova-rose/[0.18]`}
						>
							Delete all & regenerate
						</button>
						<button
							type="button"
							onClick={() => setConfirmingReset(false)}
							className={`${buttonCls} border-white/[0.08] text-nova-text-muted hover:text-nova-text`}
						>
							Cancel
						</button>
					</>
				) : (
					<button
						type="button"
						onClick={() => setConfirmingReset(true)}
						disabled={reset.status.kind === "running"}
						className={`${buttonCls} flex-1 border-white/[0.08] text-nova-text-muted hover:text-nova-rose hover:border-nova-rose/40`}
					>
						<Icon
							icon={
								reset.status.kind === "running" ? tablerLoader2 : tablerRefresh
							}
							width="12"
							height="12"
							className={
								reset.status.kind === "running" ? "animate-spin" : undefined
							}
						/>
						{reset.status.kind === "running" ? "Resetting…" : "Reset"}
					</button>
				)}
			</div>
			{confirmingReset && (
				<p className="text-[10px] text-nova-rose/80 leading-relaxed">
					Reset deletes every case in this case type — including ones edited
					through Preview — and writes fresh sample data.
				</p>
			)}
			{generate.status.kind === "error" && (
				<p className="text-[10px] text-nova-rose/90 whitespace-pre-line">
					{generate.status.message}
				</p>
			)}
			{reset.status.kind === "error" && (
				<p className="text-[10px] text-nova-rose/90 whitespace-pre-line">
					{reset.status.message}
				</p>
			)}
		</div>
	);
}
