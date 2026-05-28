"use client";

import { SingleAssetSlot } from "@/components/builder/media/MediaSlot";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useForm } from "@/lib/doc/hooks/useEntity";
import { asUuid } from "@/lib/doc/types";
import type { FormSettingsSectionProps } from "./types";

/**
 * Form menu-tile appearance: the image shown on the form's tile in a
 * module's menu, and the audio version of its label (played by
 * audio-prompt mode). Both are optional single assets; clearing a slot
 * writes `undefined`, which `updateForm` drops from the doc — mirroring
 * how `AfterSubmitSection` clears `postSubmit`.
 */
export function FormAppearanceSection({ formUuid }: FormSettingsSectionProps) {
	const form = useForm(formUuid);
	const { updateForm } = useBlueprintMutations();
	if (!form) return null;

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
						onChange={(icon) => updateForm(asUuid(formUuid), { icon })}
					/>
				</div>
				<div>
					<span className="text-xs text-nova-text-muted mb-1 block">
						Audio label
					</span>
					<SingleAssetSlot
						value={form.audioLabel}
						kind="audio"
						onChange={(audioLabel) =>
							updateForm(asUuid(formUuid), { audioLabel })
						}
					/>
				</div>
			</div>
		</div>
	);
}
