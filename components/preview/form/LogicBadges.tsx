"use client";
import type { IconifyIcon } from "@iconify/react/offline";
import { Icon } from "@iconify/react/offline";
import tablerFilter from "@iconify-icons/tabler/filter";
import tablerMath from "@iconify-icons/tabler/math";
import tablerShieldCheck from "@iconify-icons/tabler/shield-check";
import { Tooltip } from "@/components/ui/Tooltip";
import { useEditContext } from "@/hooks/useEditContext";
import type { Question } from "@/lib/schemas/blueprint";

interface LogicBadgesProps {
	question: Question;
}

const truncate = (s: string, max = 80) =>
	s.length > max ? `${s.slice(0, max)}...` : s;

export function LogicBadges({ question }: LogicBadgesProps) {
	const ctx = useEditContext();
	if (ctx?.mode === "test") return null;

	/** Each badge maps 1:1 to a question property — use the property name as
	 *  a stable React key since a given property can only produce one badge. */
	const badges: Array<{
		key: string;
		icon: IconifyIcon;
		tint: string;
		title: string;
	}> = [];

	if (question.relevant) {
		badges.push({
			key: "relevant",
			icon: tablerFilter,
			tint: "text-nova-violet",
			title: `Show when: ${truncate(question.relevant)}`,
		});
	}
	if (question.validation) {
		badges.push({
			key: "validation",
			icon: tablerShieldCheck,
			tint: "text-nova-amber",
			title: `Validation: ${truncate(question.validation)}`,
		});
	}
	if (question.calculate) {
		badges.push({
			key: "calculate",
			icon: tablerMath,
			tint: "text-nova-violet",
			title: `Calculate: ${truncate(question.calculate)}`,
		});
	}

	if (badges.length === 0) return null;

	return (
		<div className="flex items-center gap-1">
			{badges.map((b) => (
				<Tooltip key={b.key} content={b.title}>
					<span
						className={`w-4 h-4 rounded-full flex items-center justify-center ${b.tint} opacity-50 hover:opacity-100 transition-opacity`}
					>
						<Icon icon={b.icon} width="10" height="10" />
					</span>
				</Tooltip>
			))}
		</div>
	);
}
