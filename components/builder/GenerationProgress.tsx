/**
 * GenerationProgress — self-subscribing progress card for app generation.
 *
 * Subscribes directly to agentStage, agentError, and statusMessage from the
 * session store via named hooks. No props needed — BuilderLayout just controls
 * mount/unmount visibility, this component owns its own data.
 */
"use client";
import { Icon } from "@iconify/react/offline";
import tablerCheck from "@iconify-icons/tabler/check";
import { motion } from "motion/react";
import { useRef } from "react";
import {
	useAgentError,
	useAgentStage,
	useStatusMessage,
} from "@/lib/session/hooks";
import { GenerationStage } from "@/lib/session/types";

/** Display milestones. Foundation covers app settings plus the optional data
 *  model; Build covers the atomic module/form tools. There is no separate
 *  Structure or Validate step because neither exists in the live workflow. */
const baseStages: { key: string; stages: GenerationStage[]; label: string }[] =
	[
		{
			key: "foundation",
			stages: [GenerationStage.Foundation],
			label: "Set Up",
		},
		{
			key: "build",
			stages: [GenerationStage.Build],
			label: "Build",
		},
	];

/** Ordered list of generation stages for determining relative position. */
const stageOrder = [
	GenerationStage.Foundation,
	GenerationStage.Build,
	GenerationStage.Fix,
];

type StageStatus = "done" | "active" | "error" | "pending";

/** Determine the status of a display stage relative to the current generation stage. */
function getStageStatus(
	displayStages: GenerationStage[],
	currentStage: GenerationStage | null,
): StageStatus {
	if (!currentStage) return "pending";
	const currentIdx = stageOrder.indexOf(currentStage);
	if (currentIdx < 0) return "pending";

	// Stage is active if current generation stage is any of its stages
	if (displayStages.includes(currentStage)) return "active";

	// Stage is done if current generation stage is past all of its stages
	const lastIdx = Math.max(...displayStages.map((s) => stageOrder.indexOf(s)));
	if (currentIdx > lastIdx) return "done";

	return "pending";
}

/** Map a generation stage to its zero-based position in the visible stepper. */
function getStageIndex(stage: GenerationStage | null): number {
	if (!stage) return 0;
	const map: Record<string, number> = {
		[GenerationStage.Foundation]: 0,
		[GenerationStage.Build]: 1,
		/* Historical replays only — live runs never reach these stages. */
		[GenerationStage.Fix]: 2,
	};
	return map[stage] ?? 0;
}

/** Progress through the visible milestones plus their terminal Done position. */
export function generationProgressPercent(
	stage: GenerationStage | null,
	displayStageCount: number,
): number {
	return ((getStageIndex(stage) + 1) / (displayStageCount + 1)) * 100;
}

export function GenerationProgress() {
	const stage = useAgentStage();
	const generationError = useAgentError();
	const statusMessage = useStatusMessage();
	const isError = generationError !== null;

	// Track the last active stage so we can show which step failed on error
	const lastActiveStageRef = useRef(stage);
	if (stage !== null) {
		lastActiveStageRef.current = stage;
	}

	// Only show Fix stage if we've reached it
	const displayStages =
		stage === GenerationStage.Fix ||
		lastActiveStageRef.current === GenerationStage.Fix
			? [
					...baseStages,
					{ key: "fix", stages: [GenerationStage.Fix], label: "Fix" },
				]
			: baseStages;

	/* Progress is the current visible position out of every visible position,
	 * including Done. It must not depend on where a label happened to render. */
	const pct = generationProgressPercent(
		isError ? lastActiveStageRef.current : stage,
		displayStages.length,
	);

	return (
		<motion.div
			layout
			layoutId="generation-progress"
			transition={{ layout: { duration: 0.5, ease: [0.4, 0, 0.2, 1] } }}
			className="relative rounded-xl shadow-lg backdrop-blur-sm border border-nova-violet/30 bg-nova-surface/90 px-8 py-5 shadow-nova-violet/10 min-w-[400px]"
		>
			{/* Stage indicators */}
			<div className="flex items-center justify-between gap-3">
				{displayStages.map((displayStage) => {
					// On error, compute status from the last active stage, then mark the active one as 'error'
					let status: StageStatus;
					if (isError) {
						status = getStageStatus(
							displayStage.stages,
							lastActiveStageRef.current,
						);
						if (status === "active") status = "error";
					} else {
						status = getStageStatus(displayStage.stages, stage);
					}

					return (
						<div key={displayStage.key} className="flex items-center gap-2">
							<div
								className={`flex items-center gap-1.5 text-sm font-medium transition-colors duration-300 ${
									status === "done"
										? "text-nova-emerald"
										: status === "active"
											? "text-nova-text"
											: status === "error"
												? "text-nova-rose"
												: "text-nova-text-muted"
								}`}
							>
								{status === "done" && (
									<motion.span
										initial={{ scale: 0 }}
										animate={{ scale: 1 }}
										transition={{ type: "spring", stiffness: 500, damping: 25 }}
									>
										<Icon icon={tablerCheck} width={12} height={12} />
									</motion.span>
								)}
								{status === "active" && (
									<motion.span
										initial={{ scale: 0 }}
										animate={{ scale: 1 }}
										transition={{ type: "spring", stiffness: 500, damping: 25 }}
										className="inline-block w-2 h-2 rounded-full bg-nova-violet-bright animate-pulse"
									/>
								)}
								{status === "error" && (
									<motion.span
										initial={{ scale: 0 }}
										animate={{ scale: 1 }}
										transition={{ type: "spring", stiffness: 500, damping: 25 }}
										className="inline-block w-2 h-2 rounded-full bg-nova-rose"
									/>
								)}
								<span>{displayStage.label}</span>
							</div>
							<span
								className={`text-sm transition-colors duration-300 ${
									status === "done"
										? "text-nova-emerald"
										: "text-nova-text-muted"
								}`}
							>
								&mdash;
							</span>
						</div>
					);
				})}

				{/* Done — terminal label, never active while card is mounted */}
				<div className="flex items-center gap-1.5 text-sm font-medium text-nova-text-muted">
					<span>Done</span>
				</div>
			</div>

			{/* Progress bar */}
			<div className="mt-3 h-[3px] overflow-hidden rounded-full bg-nova-surface">
				<motion.div
					className="h-full rounded-full"
					style={{
						background: isError
							? "linear-gradient(90deg, var(--nova-violet), var(--nova-rose))"
							: "linear-gradient(90deg, var(--nova-violet), var(--nova-violet-bright))",
						boxShadow: isError
							? "0 0 8px var(--nova-rose)"
							: "0 0 8px var(--nova-violet)",
					}}
					initial={{ width: "0%" }}
					animate={{ width: `${pct}%` }}
					transition={{ type: "spring", stiffness: 100, damping: 20 }}
				/>
			</div>

			{/* Error message */}
			{isError && statusMessage && (
				<motion.p
					initial={{ opacity: 0 }}
					animate={{ opacity: 1 }}
					className="text-nova-rose mt-1.5 text-xs"
				>
					{statusMessage}
				</motion.p>
			)}
		</motion.div>
	);
}
