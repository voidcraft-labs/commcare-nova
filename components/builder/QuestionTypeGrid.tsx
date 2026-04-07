"use client";
import { Icon } from "@iconify/react/offline";
import { questionTypeIcons, questionTypeLabels } from "@/lib/questionTypeIcons";
import type { Question } from "@/lib/schemas/blueprint";
import { POPOVER_GLASS } from "@/lib/styles";

/** Types shown in the insertion grid — excludes hidden (rarely manually inserted). */
const GRID_TYPES: readonly Question["type"][] = [
	"text",
	"int",
	"decimal",
	"date",
	"single_select",
	"multi_select",
	"geopoint",
	"image",
	"barcode",
	"label",
	"group",
	"repeat",
];

interface QuestionTypeGridProps {
	onSelect: (type: Question["type"]) => void;
}

/** Two-column grid for inserting a new question — shows all available types. */
export function QuestionTypeGrid({ onSelect }: QuestionTypeGridProps) {
	return (
		<div
			className={`w-64 p-2 grid grid-cols-2 gap-1 overflow-hidden ${POPOVER_GLASS}`}
		>
			{GRID_TYPES.map((type) => {
				const icon = questionTypeIcons[type];
				return (
					<button
						type="button"
						key={type}
						onClick={() => onSelect(type)}
						className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs transition-colors cursor-pointer text-nova-text-secondary hover:bg-nova-surface hover:text-nova-text"
					>
						{icon && (
							<Icon icon={icon} width="14" height="14" className="shrink-0" />
						)}
						<span>{questionTypeLabels[type] ?? type}</span>
					</button>
				);
			})}
		</div>
	);
}
