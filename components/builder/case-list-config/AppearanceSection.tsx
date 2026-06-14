// components/builder/case-list-config/AppearanceSection.tsx
//
// Case-list menu-link appearance: the image + audio for the "Open case
// list" affordance — the menu link from a module's home screen that opens
// its case list. These two slots live on `caseListConfig` (not the module
// itself, which carries its own home-screen-tile media), because they
// brand the case-list COMMAND, not the module tile.
//
// Gating. The slots emit ONLY on `caseListOnly` modules: that is the one
// shape where a standalone case-list command exists to host the icon (the
// local `.ccz` command `<display>`, the HQ `case_list.media_*` dict). A
// module with forms has no standalone case-list command, so the slot is a
// dead affordance there — the section returns `null` for any non-
// `caseListOnly` module so the control never appears where its bytes
// would have no wire target.

"use client";

import { SingleAssetSlot } from "@/components/builder/media/MediaSlot";
import { setOptionalSlot } from "@/components/builder/shared/setOptionalSlot";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useModule } from "@/lib/doc/hooks/useEntity";
import type { Uuid } from "@/lib/doc/types";
import { asAssetId, type CaseListConfig } from "@/lib/domain";
import { CaseListSectionHeader } from "./CaseListSectionHeader";

/** Props — the module whose case-list config is being authored. */
interface AppearanceSectionProps {
	readonly moduleUuid: Uuid;
}

/**
 * Empty `CaseListConfig` used when a `caseListOnly` module has no
 * `caseListConfig` slot yet (the appearance slots are the only authored
 * content). The wholesale-object edit path rebuilds from this base so the
 * required `columns` / `searchInputs` arrays are always present on the
 * persisted config.
 */
const EMPTY_CONFIG: CaseListConfig = { columns: [], searchInputs: [] };

/**
 * Case-list appearance section, mounted as the LAST section of
 * `CaseListWorkspace` so the section-divider above it (rendered here,
 * inside the section) vanishes together with the section when the module
 * isn't `caseListOnly` — no dangling hairline.
 *
 * The case-list config is edited wholesale via `updateModule(uuid, {
 * caseListConfig: next })` (the workspace's existing edit contract), so a
 * slot clear can't ride a dedicated `null`-carrying mutation the way
 * module / form / app media does. Instead each change rebuilds the whole
 * `caseListConfig` object via `setOptionalSlot`, which DROPS the key on a
 * clear rather than writing `{ key: undefined }`. A concrete object
 * replaces the slot wholesale, so an omitted key clears cleanly and
 * survives JSON — the JSON-safe path for this surface.
 */
export function AppearanceSection({ moduleUuid }: AppearanceSectionProps) {
	const module = useModule(moduleUuid);
	const { updateModule } = useBlueprintMutations();

	// Only `caseListOnly` modules expose a standalone case-list command to
	// host this media — return null everywhere else so the control isn't a
	// dead affordance. Also guards the transient undefined-module window.
	if (!module?.caseListOnly) return null;

	const config = module.caseListConfig ?? EMPTY_CONFIG;

	/** Rebuild the whole `caseListConfig` with one slot set or dropped, then
	 *  dispatch it wholesale. `setOptionalSlot` omits the key on a clear so
	 *  presence checks (`"icon" in config`) stay honest across the wire. */
	const setSlot = (slot: "icon" | "audioLabel", next: string | undefined) => {
		const nextConfig = setOptionalSlot(
			config,
			slot,
			next ? asAssetId(next) : undefined,
		);
		updateModule(moduleUuid, { caseListConfig: nextConfig });
	};

	return (
		<>
			{/* Section seam — mirrors the workspace's inter-section hairline.
			 *  Rendered inside the section so it disappears with the section on
			 *  a non-`caseListOnly` module. */}
			<div className="border-t border-nova-violet/[0.15]" aria-hidden="true" />
			<section>
				<CaseListSectionHeader
					title="Appearance"
					status="Image and audio for the case-list menu link."
				/>
				<div className="px-8 pt-24 pb-16 space-y-2">
					<div>
						<span className="text-xs text-nova-text-muted mb-1 block">
							Icon
						</span>
						<SingleAssetSlot
							value={config.icon}
							kind="image"
							slotKey={`caselist:${moduleUuid}:icon`}
							ariaLabel="Case list icon"
							onChange={(icon) => setSlot("icon", icon)}
						/>
					</div>
					<div>
						<span className="text-xs text-nova-text-muted mb-1 block">
							Audio label
						</span>
						<SingleAssetSlot
							value={config.audioLabel}
							kind="audio"
							slotKey={`caselist:${moduleUuid}:audioLabel`}
							ariaLabel="Case list audio label"
							onChange={(audioLabel) => setSlot("audioLabel", audioLabel)}
						/>
					</div>
				</div>
			</section>
		</>
	);
}
