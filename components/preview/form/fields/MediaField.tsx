"use client";
import { Icon } from "@iconify/react/offline";
import tablerPhoto from "@iconify-icons/tabler/photo";
import { useEditContext } from "@/hooks/useEditContext";
import type { Field } from "@/lib/domain";
import { fieldKindIcons, fieldKindLabels } from "@/lib/fieldTypeIcons";

/**
 * Placeholder card for media-capture kinds (image/audio/video/barcode/
 * signature/geopoint). The preview engine has no native capture affordance,
 * so we render the icon + kind label with an "(not available in preview)"
 * note outside of edit mode.
 */
export function MediaField({ question }: { question: Field }) {
	const ctx = useEditContext();
	const isDesign = ctx?.mode === "edit";
	// `kind` replaces the legacy wire `type` discriminant — both icon and
	// label registries are keyed by the same strings.
	const icon = fieldKindIcons[question.kind] ?? tablerPhoto;
	const label = fieldKindLabels[question.kind] ?? question.kind;

	return (
		<div className="flex items-center gap-3 px-4 py-3 rounded-lg bg-pv-surface border border-dashed border-pv-input-border">
			<Icon
				icon={icon}
				width="20"
				height="20"
				className="text-nova-text-muted"
			/>
			<span className="text-sm text-nova-text-muted">
				{label}
				{!isDesign && " (not available in preview)"}
			</span>
		</div>
	);
}
