// components/builder/case-list-config/inspector/ListPanelInspectorBody.tsx
//
// Secondary options for the results screen. Field membership, visible order,
// and the default case ordering are composed directly in the center canvas;
// this rail intentionally contains only settings that have no visible row to
// manipulate there:
//
//   - **Appearance** — the image + audio for the "Open case list"
//     menu link. Only `caseListOnly` modules expose a standalone
//     case-list command to host the media (the local `.ccz` command
//     `<display>`, the HQ `case_list.media_*` dict), so the cluster
//     self-gates — on a module with forms the slots would be a dead
//     affordance with no wire target.

"use client";
import { InspectorSection } from "@/components/builder/inspector/inspectorChrome";
import { SingleAssetSlot } from "@/components/builder/media/MediaSlot";
import { setOptionalSlot } from "@/components/builder/shared/setOptionalSlot";
import type { Uuid } from "@/lib/doc/types";
import { asAssetId, type CaseListConfig } from "@/lib/domain";

export interface ListPanelInspectorBodyProps {
	/** Owning module — keys the appearance slots' staged uploads
	 *  (`caselist:<moduleUuid>:<slot>`), the carrier-slot identity the
	 *  session store tracks an in-flight upload under. */
	readonly moduleUuid: Uuid;
	readonly config: CaseListConfig;
	readonly onChange: (next: CaseListConfig) => void;
	/** Whether the module is a `caseListOnly` shape — gates the
	 *  appearance cluster (see file header). */
	readonly caseListOnly: boolean;
}

export function ListPanelInspectorBody({
	moduleUuid,
	config,
	onChange,
	caseListOnly,
}: ListPanelInspectorBodyProps) {
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
			{caseListOnly && (
				<InspectorSection label="Menu link appearance">
					<div>
						<span className="text-xs text-nova-text-muted mb-1.5 block">
							Icon
						</span>
						<SingleAssetSlot
							value={config.icon}
							kind="image"
							slotKey={`caselist:${moduleUuid}:icon`}
							ariaLabel="Case list icon"
							onChange={(icon) => setMediaSlot("icon", icon)}
						/>
					</div>
					<div>
						<span className="text-xs text-nova-text-muted mb-1.5 block">
							Audio label
						</span>
						<SingleAssetSlot
							value={config.audioLabel}
							kind="audio"
							slotKey={`caselist:${moduleUuid}:audioLabel`}
							ariaLabel="Case list audio label"
							onChange={(audioLabel) => setMediaSlot("audioLabel", audioLabel)}
						/>
					</div>
				</InspectorSection>
			)}
		</>
	);
}
