"use client";

import { SingleAssetSlot } from "@/components/builder/media/MediaSlot";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useModule } from "@/lib/doc/hooks/useEntity";
import { asUuid, type Mutation, type Uuid } from "@/lib/doc/types";
import { asAssetId } from "@/lib/domain";

/** Props for the module-appearance section — just the module being edited. */
interface ModuleAppearanceSectionProps {
	moduleUuid: Uuid;
}

/**
 * The module's two distinct menu surfaces. Every module owns an app-home tile
 * (`module.icon` / `audioLabel`). A case-list-only module also owns the link
 * that opens its case list (`caseListConfig.icon` / `audioLabel`). Keeping both
 * here gives appearance one authoring home without collapsing the wire slots.
 * Each edit reconstructs the untouched sibling slot, and clears use explicit
 * JSON-safe `null` sentinels so the SSE wire never drops the intent.
 */
export function ModuleAppearanceSection({
	moduleUuid,
}: ModuleAppearanceSectionProps) {
	const module = useModule(moduleUuid);
	const { setModuleMedia, commitMany } = useBlueprintMutations();
	if (!module) return null;
	const uuid = asUuid(moduleUuid);
	const caseListConfig = module.caseListConfig;

	const setCaseListLinkMedia = (
		icon: string | undefined,
		audioLabel: string | undefined,
	) =>
		commitMany([
			{
				kind: "setCaseListMeta",
				uuid,
				patch: {
					icon: icon ? asAssetId(icon) : null,
					audioLabel: audioLabel ? asAssetId(audioLabel) : null,
				},
			} satisfies Mutation,
		]);

	return (
		<div className="space-y-5">
			<section aria-labelledby={`module-${moduleUuid}-home-tile-heading`}>
				<h3
					id={`module-${moduleUuid}-home-tile-heading`}
					className="text-sm font-medium text-nova-text-secondary"
				>
					App home tile
				</h3>
				<p className="mt-1 text-[13px] leading-relaxed text-nova-text-muted">
					Shown on the app's main menu
				</p>
				<div className="mt-3 space-y-2">
					<div>
						<span className="mb-1 block text-xs text-nova-text-muted">
							Icon
						</span>
						<SingleAssetSlot
							value={module.icon}
							kind="image"
							slotKey={`module:${moduleUuid}:icon`}
							ariaLabel="App home tile icon"
							onChange={(icon) =>
								setModuleMedia(uuid, {
									icon: icon ? asAssetId(icon) : null,
									audioLabel: module.audioLabel
										? asAssetId(module.audioLabel)
										: null,
								})
							}
						/>
					</div>
					<div>
						<span className="mb-1 block text-xs text-nova-text-muted">
							Spoken label
						</span>
						<SingleAssetSlot
							value={module.audioLabel}
							kind="audio"
							slotKey={`module:${moduleUuid}:audioLabel`}
							ariaLabel="App home tile spoken label"
							onChange={(audioLabel) =>
								setModuleMedia(uuid, {
									icon: module.icon ? asAssetId(module.icon) : null,
									audioLabel: audioLabel ? asAssetId(audioLabel) : null,
								})
							}
						/>
					</div>
				</div>
			</section>

			{module.caseListOnly && caseListConfig && (
				<section
					aria-labelledby={`module-${moduleUuid}-case-link-heading`}
					className="border-t border-nova-border pt-5"
				>
					<h3
						id={`module-${moduleUuid}-case-link-heading`}
						className="text-sm font-medium text-nova-text-secondary"
					>
						Case list link
					</h3>
					<p className="mt-1 text-[13px] leading-relaxed text-nova-text-muted">
						Shown on the link that opens this case list
					</p>
					<div className="mt-3 space-y-2">
						<div>
							<span className="mb-1 block text-xs text-nova-text-muted">
								Icon
							</span>
							<SingleAssetSlot
								value={caseListConfig.icon}
								kind="image"
								slotKey={`caselist:${moduleUuid}:icon`}
								ariaLabel="Case list link icon"
								onChange={(icon) =>
									setCaseListLinkMedia(icon, caseListConfig.audioLabel)
								}
							/>
						</div>
						<div>
							<span className="mb-1 block text-xs text-nova-text-muted">
								Spoken label
							</span>
							<SingleAssetSlot
								value={caseListConfig.audioLabel}
								kind="audio"
								slotKey={`caselist:${moduleUuid}:audioLabel`}
								ariaLabel="Case list link spoken label"
								onChange={(audioLabel) =>
									setCaseListLinkMedia(caseListConfig.icon, audioLabel)
								}
							/>
						</div>
					</div>
				</section>
			)}
		</div>
	);
}
