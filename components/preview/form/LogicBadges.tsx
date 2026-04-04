"use client";
import { Icon } from "@iconify/react/offline";
import ciFilter from "@iconify-icons/ci/filter";
import ciShieldCheck from "@iconify-icons/ci/shield-check";
import tablerMath from "@iconify-icons/tabler/math";
import type { Question } from "@/lib/schemas/blueprint";
import { useEditContext } from "@/hooks/useEditContext";

interface LogicBadgesProps {
	question: Question;
}

const truncate = (s: string, max = 80) =>
	s.length > max ? s.slice(0, max) + "..." : s;

export function LogicBadges({ question }: LogicBadgesProps) {
	const ctx = useEditContext();
	if (ctx?.mode === "test") return null;

	/** Each badge maps 1:1 to a question property — use the property name as
	 *  a stable React key since a given property can only produce one badge. */
	const badges: Array<{ key: string; icon: any; tint: string; title: string }> =
		[];

	if (question.relevant) {
		badges.push({
			key: "relevant",
			icon: ciFilter,
			tint: "text-nova-cyan",
			title: `Show when: ${truncate(question.relevant)}`,
		});
	}
	if (question.validation) {
		badges.push({
			key: "validation",
			icon: ciShieldCheck,
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
				<span
					key={b.key}
					className={`w-4 h-4 rounded-full flex items-center justify-center ${b.tint} opacity-50 hover:opacity-100 transition-opacity`}
					title={b.title}
				>
					<Icon icon={b.icon} width="10" height="10" />
				</span>
			))}
		</div>
	);
}
