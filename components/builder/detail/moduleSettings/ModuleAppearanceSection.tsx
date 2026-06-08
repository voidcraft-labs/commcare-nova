"use client";

import { SingleAssetSlot } from "@/components/builder/media/MediaSlot";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useModule } from "@/lib/doc/hooks/useEntity";
import { asUuid, type Uuid } from "@/lib/doc/types";
import { asAssetId } from "@/lib/domain";

/** Props for the module-appearance section — just the module being edited. */
interface ModuleAppearanceSectionProps {
	moduleUuid: Uuid;
}

/**
 * Module menu-tile appearance: the image shown on the module's tile on
 * the app home screen, and the audio version of its label (played by
 * audio-prompt mode, an accessibility affordance for low-literacy field
 * workers). Both are optional single assets; changes dispatch through
 * `setModuleMedia` so a clear rides the JSON-safe `null` sentinel rather
 * than the `{ key: undefined }` that the SSE wire would drop. Mirrors
 * `FormAppearanceSection` exactly — same two-slot body, same
 * reconstruct-both-slots-from-current-state pattern on each change.
 */
export function ModuleAppearanceSection({
	moduleUuid,
}: ModuleAppearanceSectionProps) {
	const module = useModule(moduleUuid);
	const { setModuleMedia } = useBlueprintMutations();
	if (!module) return null;
	const uuid = asUuid(moduleUuid);

	return (
		<div>
			<span className="text-xs font-medium text-nova-text-secondary uppercase tracking-wider mb-1.5 block">
				Menu appearance
			</span>
			<div className="space-y-2">
				<div>
					<span className="text-xs text-nova-text-muted mb-1 block">Icon</span>
					<SingleAssetSlot
						value={module.icon}
						kind="image"
						ariaLabel="Module menu icon"
						onChange={(icon) =>
							/* Both slots are reconstructed from current state on every
							 * change — the mutation carries the full `{ icon, audioLabel }`
							 * pair, so editing one slot must re-pass the other untouched. */
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
					<span className="text-xs text-nova-text-muted mb-1 block">
						Audio label
					</span>
					<SingleAssetSlot
						value={module.audioLabel}
						kind="audio"
						ariaLabel="Module audio label"
						onChange={(audioLabel) =>
							setModuleMedia(uuid, {
								icon: module.icon ? asAssetId(module.icon) : null,
								audioLabel: audioLabel ? asAssetId(audioLabel) : null,
							})
						}
					/>
				</div>
			</div>
		</div>
	);
}
