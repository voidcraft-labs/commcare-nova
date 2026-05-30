"use client";

import { SingleAssetSlot } from "@/components/builder/media/MediaSlot";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useForm } from "@/lib/doc/hooks/useEntity";
import { asUuid } from "@/lib/doc/types";
import { asAssetId } from "@/lib/domain";
import type { FormSettingsSectionProps } from "./types";

/**
 * Form menu-tile appearance: the image shown on the form's tile in a
 * module's menu, and the audio version of its label (played by
 * audio-prompt mode). Both are optional single assets; changes dispatch
 * through `setFormMedia` so clears ride the JSON-safe `null` sentinel.
 */
export function FormAppearanceSection({ formUuid }: FormSettingsSectionProps) {
	const form = useForm(formUuid);
	const { setFormMedia } = useBlueprintMutations();
	if (!form) return null;
	const uuid = asUuid(formUuid);

	return (
		<div>
			<span className="text-xs font-medium text-nova-text-secondary uppercase tracking-wider mb-1.5 block">
				Menu appearance
			</span>
			<div className="space-y-2">
				<div>
					<span className="text-xs text-nova-text-muted mb-1 block">Icon</span>
					<SingleAssetSlot
						value={form.icon}
						kind="image"
						ariaLabel="Form menu icon"
						onChange={(icon) =>
							setFormMedia(uuid, {
								icon: icon ? asAssetId(icon) : null,
								audioLabel: form.audioLabel ? asAssetId(form.audioLabel) : null,
							})
						}
					/>
				</div>
				<div>
					<span className="text-xs text-nova-text-muted mb-1 block">
						Audio label
					</span>
					<SingleAssetSlot
						value={form.audioLabel}
						kind="audio"
						ariaLabel="Form audio label"
						onChange={(audioLabel) =>
							setFormMedia(uuid, {
								icon: form.icon ? asAssetId(form.icon) : null,
								audioLabel: audioLabel ? asAssetId(audioLabel) : null,
							})
						}
					/>
				</div>
			</div>
		</div>
	);
}
