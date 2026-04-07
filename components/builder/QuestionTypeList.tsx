"use client";
import { Icon } from "@iconify/react/offline";
import { questionTypeIcons, questionTypeLabels } from "@/lib/questionTypeIcons";
import type { Question } from "@/lib/schemas/blueprint";
import { POPOVER_ELEVATED } from "@/lib/styles";

interface QuestionTypeListProps {
	/** The conversion targets to display. */
	types: ReadonlyArray<Question["type"]>;
	/** The current type — highlighted so the user knows what they're converting from. */
	activeType?: Question["type"];
	onSelect: (type: Question["type"]) => void;
}

/** Single-column list for converting a question to a sibling type.
 *  Conversion targets are always a short list (1–3 items), so a
 *  compact vertical layout fits better than the 2-column insertion grid. */
export function QuestionTypeList({
	types,
	activeType,
	onSelect,
}: QuestionTypeListProps) {
	return (
		<div className={`overflow-hidden ${POPOVER_ELEVATED}`}>
			{types.map((type) => {
				const icon = questionTypeIcons[type];
				const isActive = type === activeType;
				return (
					<button
						type="button"
						key={type}
						onClick={() => onSelect(type)}
						className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm transition-colors cursor-pointer ${
							isActive
								? "text-nova-violet-bright bg-nova-violet/10"
								: "text-nova-text hover:bg-white/[0.06]"
						}`}
					>
						{icon && (
							<Icon
								icon={icon}
								width="16"
								height="16"
								className={
									isActive ? "text-nova-violet-bright" : "text-nova-text-muted"
								}
							/>
						)}
						<span>{questionTypeLabels[type] ?? type}</span>
					</button>
				);
			})}
		</div>
	);
}
