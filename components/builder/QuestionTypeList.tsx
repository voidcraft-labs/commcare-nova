"use client";
import { Icon } from "@iconify/react/offline";
import { questionTypeIcons, questionTypeLabels } from "@/lib/questionTypeIcons";
import type { Question } from "@/lib/schemas/blueprint";

interface QuestionTypeListProps {
	/** The conversion targets to display. */
	types: ReadonlyArray<Question["type"]>;
	/** The current type — highlighted so the user knows what they're converting from. */
	activeType?: Question["type"];
	onSelect: (type: Question["type"]) => void;
}

/** Single-column list for converting a question to a sibling type.
 *  Surface styling (background, border, shadow) comes from the parent
 *  Menu.Positioner — this component only renders the item rows.
 *  Conversion targets are always a short list (1–3 items), so a
 *  compact vertical layout fits better than a categorised menu. */
export function QuestionTypeList({
	types,
	activeType,
	onSelect,
}: QuestionTypeListProps) {
	return (
		<div className="overflow-hidden">
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
