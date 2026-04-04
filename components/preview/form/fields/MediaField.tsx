"use client";
import { Icon } from "@iconify/react/offline";
import ciImage from "@iconify-icons/ci/image";
import { useEditContext } from "@/hooks/useEditContext";
import { questionTypeIcons, questionTypeLabels } from "@/lib/questionTypeIcons";
import type { Question } from "@/lib/schemas/blueprint";

export function MediaField({ question }: { question: Question }) {
	const ctx = useEditContext();
	const isDesign = ctx?.mode === "edit";
	const icon = questionTypeIcons[question.type] ?? ciImage;
	const label = questionTypeLabels[question.type] ?? question.type;

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
