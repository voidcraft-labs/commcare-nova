"use client";

import { useState } from "react";
import { ToggleRow } from "@/components/builder/inspector/inspectorChrome";
import { SingleAssetSlot } from "@/components/builder/media/MediaSlot";
import { RejectionInline } from "@/components/builder/RejectionNotice";
import {
	FORM_FORMAT_TEXT_CONFIRM,
	FORM_FORMAT_TEXT_NAME,
	FORMAT_TEXT_CONFIRM_KEEP,
	FORMAT_TEXT_CONFIRM_OFF,
	formatTextGesture,
	formatTextOffLine,
} from "@/components/preview/form/formatText";
import { Button } from "@/components/shadcn/button";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useDeclaredPlatforms } from "@/lib/doc/hooks/useDeclaredPlatforms";
import { useForm } from "@/lib/doc/hooks/useEntity";
import { useFormSwitchedTexts } from "@/lib/doc/hooks/useFormSwitchedTexts";
import { asUuid } from "@/lib/doc/types";
import { proseTemplateHoldsFormatting } from "@/lib/tiptap/formatText";
import type { FormSettingsSectionProps } from "./types";

/**
 * Form appearance: the image shown on the form's tile in a module's menu,
 * the audio version of its label (played by audio-prompt mode), and the
 * form's own text formatting switch. Both media are optional single assets;
 * changes dispatch through `setFormMedia` so clears ride the JSON-safe `null`
 * sentinel. **Format text in this form** writes `plainText: true` off and
 * `plainText: null` on, asking first where some label, choice or help text of
 * the form uses formatting; each text's own setting is kept while the switch
 * is off.
 */
export function FormAppearanceSection({ formUuid }: FormSettingsSectionProps) {
	const form = useForm(formUuid);
	const { setFormMedia, inline } = useBlueprintMutations();
	const platforms = useDeclaredPlatforms();
	const uuid = asUuid(formUuid);
	const switchedTexts = useFormSwitchedTexts(uuid);
	const [confirmingOff, setConfirmingOff] = useState(false);
	const [formatRefusal, setFormatRefusal] = useState<string | null>(null);
	if (!form) return null;
	const formatted = form.plainText !== true;

	const writePlainText = (plainText: true | null) => {
		const outcome = inline.updateForm(uuid, { plainText });
		setFormatRefusal(outcome.ok ? null : outcome.messages.join(" "));
		if (outcome.ok) setConfirmingOff(false);
	};
	const toggleFormatText = () => {
		const gesture = formatTextGesture({
			plain: !formatted,
			isSource: true,
			holdsFormatting: () => switchedTexts().some(proseTemplateHoldsFormatting),
		});
		if (gesture.kind === "confirm") setConfirmingOff(true);
		else if (gesture.kind === "write") writePlainText(gesture.plainLabel);
	};

	return (
		// Leading hairline divider matches `ConnectSection`'s, so Menu appearance
		// is separated from the section above it (Connect, or After submit when
		// Connect is off) with the same seam every other section uses.
		<div className="border-t border-white/[0.06] pt-3">
			<span className="text-xs font-medium text-nova-text-secondary mb-1.5 block">
				Menu appearance
			</span>
			<div className="space-y-2">
				<div>
					<span className="text-xs text-nova-text-muted mb-1 block">Icon</span>
					<SingleAssetSlot
						value={form.icon}
						kind="image"
						iconLibrary="form"
						slotKey={`form:${formUuid}:icon`}
						ariaLabel="Form menu icon"
						onChange={(icon) =>
							setFormMedia(uuid, {
								icon: icon ?? null,
								audioLabel: form.audioLabel ?? null,
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
						slotKey={`form:${formUuid}:audioLabel`}
						ariaLabel="Form audio label"
						onChange={(audioLabel) =>
							setFormMedia(uuid, {
								icon: form.icon ?? null,
								audioLabel: audioLabel ?? null,
							})
						}
					/>
				</div>
				<div data-form-format-text={formatted ? "on" : "off"}>
					<ToggleRow
						label={FORM_FORMAT_TEXT_NAME}
						description={formatTextOffLine("form", platforms)}
						checked={formatted}
						onChange={toggleFormatText}
					/>
					{confirmingOff && (
						<fieldset
							data-format-text-prompt
							className="m-0 mt-2 min-w-0 rounded-lg border border-white/[0.06] bg-nova-deep/50 p-3"
						>
							<legend className="float-left w-full p-0 text-xs leading-relaxed text-nova-text-secondary">
								{FORM_FORMAT_TEXT_CONFIRM}
							</legend>
							<div className="clear-both flex flex-wrap gap-2 pt-2">
								<Button
									type="button"
									variant="secondary"
									data-format-text-confirm="off"
									onClick={() => writePlainText(true)}
								>
									{FORMAT_TEXT_CONFIRM_OFF}
								</Button>
								<Button
									type="button"
									variant="ghost"
									data-format-text-confirm="keep"
									onClick={() => setConfirmingOff(false)}
								>
									{FORMAT_TEXT_CONFIRM_KEEP}
								</Button>
							</div>
						</fieldset>
					)}
					<RejectionInline message={formatRefusal} />
				</div>
			</div>
		</div>
	);
}
