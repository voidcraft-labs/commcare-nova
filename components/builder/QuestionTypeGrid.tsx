"use client";
import { Icon } from "@iconify/react/offline";
import { questionTypeIcons, questionTypeLabels } from "@/lib/questionTypeIcons";
import type { Question } from "@/lib/schemas/blueprint";
import { POPOVER_ELEVATED, POPOVER_GLASS } from "@/lib/styles";

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
	/** Currently active type — highlighted in the grid. */
	activeType?: Question["type"];
	/** Explicit set of types to show. When omitted, falls back to the default
	 *  insertion grid (`GRID_TYPES`). Used by the footer type-change picker to
	 *  show only valid conversion targets. */
	types?: ReadonlyArray<Question["type"]>;
	/** Surface variant. `'glass'` (default) for standalone popovers, `'elevated'` for
	 *  popovers stacked above an existing glass surface. */
	variant?: "glass" | "elevated";
}

export function QuestionTypeGrid({
	onSelect,
	activeType,
	types,
	variant = "glass",
}: QuestionTypeGridProps) {
	const displayTypes = types ?? GRID_TYPES;
	return (
		<div
			className={`w-52 p-2 grid grid-cols-2 gap-1 ${variant === "elevated" ? POPOVER_ELEVATED : POPOVER_GLASS}`}
		>
			{displayTypes.map((type) => {
				const icon = questionTypeIcons[type];
				const isActive = type === activeType;
				return (
					<button
						type="button"
						key={type}
						onClick={() => onSelect(type)}
						className={`flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs transition-colors cursor-pointer
              ${
								isActive
									? "bg-nova-violet/15 text-nova-violet-bright"
									: "text-nova-text-secondary hover:bg-nova-surface hover:text-nova-text"
							}`}
					>
						{icon && (
							<Icon icon={icon} width="14" height="14" className="shrink-0" />
						)}
						<span className="truncate">{questionTypeLabels[type] ?? type}</span>
					</button>
				);
			})}
		</div>
	);
}
