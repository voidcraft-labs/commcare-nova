"use client";
import { Icon } from "@iconify/react/offline";
import { useEditContext } from "@/hooks/useEditContext";
import { type Field, fieldRegistry } from "@/lib/domain";

/**
 * Placeholder card for media-capture kinds (image/audio/video/barcode/
 * signature/geopoint). The preview engine has no native capture affordance,
 * so we render the icon + kind label with an "(not available in preview)"
 * note outside of edit mode.
 *
 * Icon + human-readable label come from `fieldRegistry[kind]` — the
 * domain-owned metadata registry. The lookup is total over `FieldKind`,
 * so no fallback is required.
 */
export function MediaField({ question }: { question: Field }) {
	const ctx = useEditContext();
	const isDesign = ctx?.mode === "edit";
	const { icon, label } = fieldRegistry[question.kind];

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
