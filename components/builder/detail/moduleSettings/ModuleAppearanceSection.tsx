"use client";

import { SingleAssetSlot } from "@/components/builder/media/MediaSlot";
import { useNavigationFileLens } from "@/components/builder/media/useNavigationFileLens";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useModule, useStoredModule } from "@/lib/doc/hooks/useEntity";
import { useMenuScreenSource } from "@/lib/doc/hooks/useMenuScreenSource";
import { useIsBareCaseListModule } from "@/lib/doc/hooks/useModuleIds";
import { asUuid, type Uuid } from "@/lib/doc/types";
import { menuScreenKeptAppearanceNote } from "./menuScreenCopy";

/** Props for the module-appearance section: just the module being edited. */
interface ModuleAppearanceSectionProps {
	moduleUuid: Uuid;
}

/**
 * The module's menu tile (`lens.icon` / `audioLabel`) on Home or inside its
 * structural parent. The case list's own menu entry, with its icon and
 * spoken label, is `CaseListMenuItemSection`. Each edit reconstructs the
 * untouched sibling slot, and clears use explicit JSON-safe `null` sentinels
 * so the SSE wire never drops the intent.
 */
export function ModuleAppearanceSection({
	moduleUuid,
}: ModuleAppearanceSectionProps) {
	const module = useModule(moduleUuid);
	const parentModule = useModule(module?.parentModuleUuid);
	const lens = useNavigationFileLens(useStoredModule(moduleUuid));
	const { commitMany } = useBlueprintMutations();
	const source = useMenuScreenSource();
	/* A bare case list's name section states the note for both. */
	const bare = useIsBareCaseListModule(moduleUuid);
	if (!module) return null;
	const keptNote = bare
		? undefined
		: menuScreenKeptAppearanceNote(source, moduleUuid);
	const uuid = asUuid(moduleUuid);

	return (
		<div className="space-y-5">
			<section aria-labelledby={`module-${moduleUuid}-menu-tile-heading`}>
				<h3
					id={`module-${moduleUuid}-menu-tile-heading`}
					className="text-sm font-medium text-nova-text-secondary"
				>
					Menu tile
				</h3>
				<p className="mt-1 text-[13px] leading-relaxed text-nova-text-muted">
					{parentModule === undefined
						? "Shown on the app's main menu"
						: `Shown inside ${parentModule.name}`}
				</p>
				{keptNote !== undefined && (
					<p
						className="mt-1 text-[13px] leading-relaxed text-nova-text-muted"
						data-menu-screen-kept-note
					>
						{keptNote}
					</p>
				)}
				<div className="mt-3 space-y-2">
					<div>
						<span className="mb-1 block text-xs text-nova-text-muted">
							Icon
						</span>
						<SingleAssetSlot
							value={lens.icon}
							reading={lens.reading("icon")}
							removalLabel={lens.removalLabel("icon")}
							kind="image"
							iconLibrary="module"
							slotKey={`module:${moduleUuid}:icon:${lens.language}`}
							ariaLabel="Menu tile icon"
							onChange={(icon) =>
								commitMany([
									{
										kind: "setModuleMedia",
										uuid,
										language: lens.language,
										icon: icon ?? null,
										audioLabel: lens.audioLabel ?? null,
									},
								])
							}
						/>
					</div>
					<div>
						<span className="mb-1 block text-xs text-nova-text-muted">
							Spoken label
						</span>
						<SingleAssetSlot
							value={lens.audioLabel}
							reading={lens.reading("audioLabel")}
							removalLabel={lens.removalLabel("audioLabel")}
							kind="audio"
							slotKey={`module:${moduleUuid}:audioLabel:${lens.language}`}
							ariaLabel="Menu tile spoken label"
							onChange={(audioLabel) =>
								commitMany([
									{
										kind: "setModuleMedia",
										uuid,
										language: lens.language,
										icon: lens.icon ?? null,
										audioLabel: audioLabel ?? null,
									},
								])
							}
						/>
					</div>
				</div>
			</section>
		</div>
	);
}
