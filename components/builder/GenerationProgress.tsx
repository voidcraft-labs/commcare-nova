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
import { type GenerationError, GenerationStage } from "@/lib/session/types";

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

/** Map a generation stage to its zero-based position in the visible stepper. */
function getStageIndex(stage: GenerationStage | null): number {
	if (!stage) return 0;
	const map: Record<GenerationStage, number> = {
		[GenerationStage.Foundation]: 0,
		[GenerationStage.Build]: 1,
		[GenerationStage.Fix]: 2,
	};
	return map[stage];
}

/** Align the fill endpoint to the current phase anchor. The first and last
 *  anchors sit on the full-width track's endpoints. */
export function generationProgressPercent(
	stage: GenerationStage | null,
	visiblePositionCount: number,
): number {
	if (visiblePositionCount <= 1) return 0;
	return (getStageIndex(stage) / (visiblePositionCount - 1)) * 100;
}

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

export function GenerationProgress() {
	const stage = useAgentStage();
	const generationError = useAgentError();
	const statusMessage = useStatusMessage();

	return (
		<GenerationProgressCard
			stage={stage}
			generationError={generationError}
			statusMessage={statusMessage}
		/>
	);
}

interface GenerationProgressCardProps {
	stage: GenerationStage | null;
	generationError: GenerationError;
	statusMessage: string;
}

/** Presentational card kept separate so every lifecycle state can be rendered
 *  directly during visual regression checks without seeding the session store. */
export function GenerationProgressCard({
	stage,
	generationError,
	statusMessage,
}: GenerationProgressCardProps) {
	const isError = generationError !== null;
	const showErrorMessage = isError && Boolean(statusMessage);

	// Track the last active stage so we can show which step failed on error
	const lastActiveStageRef = useRef(stage);
	if (stage !== null) {
		lastActiveStageRef.current = stage;
	}
	const lastErrorMessageRef = useRef(statusMessage);
	if (showErrorMessage) {
		lastErrorMessageRef.current = statusMessage;
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

	const visibleStages = [
		...displayStages,
		{ key: "done", stages: [] as GenerationStage[], label: "Done" },
	];
	const progressPercent = generationProgressPercent(
		isError ? lastActiveStageRef.current : stage,
		visibleStages.length,
	);
	const stageStatuses = visibleStages.map((displayStage) => {
		if (displayStage.key === "done") return "pending" as const;
		if (isError) {
			const status = getStageStatus(
				displayStage.stages,
				lastActiveStageRef.current,
			);
			return status === "active" ? ("error" as const) : status;
		}
		return getStageStatus(displayStage.stages, stage);
	});
	return (
		<div
			data-generation-progress-card=""
			className="relative rounded-xl shadow-lg backdrop-blur-sm border border-nova-violet/30 bg-nova-surface/90 px-8 py-5 shadow-nova-violet/10 min-w-[400px]"
		>
			{/* Zero-width anchors are distributed from edge to edge, so the first and
			    last phase centers match the full-width progress track below. Connector
			    segments are CSS rules inset around each label. */}
			<div
				data-generation-stage-row=""
				className="relative mx-auto flex h-5 w-[90%] items-center justify-between"
			>
				<div
					aria-hidden="true"
					className="pointer-events-none absolute inset-x-0 top-1/2 flex -translate-y-1/2"
				>
					{visibleStages.slice(0, -1).map((displayStage, index) => (
						<span
							key={`${displayStage.key}-connector`}
							data-progress-connector=""
							className={`mx-10 h-px min-w-0 flex-1 rounded-full transition-colors duration-300 ${
								stageStatuses[index] === "done"
									? "bg-nova-emerald/60"
									: "bg-nova-text-muted/45"
							}`}
						/>
					))}
				</div>
				{visibleStages.map((displayStage, index) => {
					const status = stageStatuses[index];

					return (
						<div
							key={displayStage.key}
							className="relative z-10 flex w-0 shrink-0 justify-center"
						>
							<div
								data-stage={displayStage.key}
								data-status={status}
								aria-current={
									status === "active" || status === "error" ? "step" : undefined
								}
								className={`flex shrink-0 items-center gap-1.5 text-sm font-medium transition-colors duration-300 ${
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
									<span>
										<Icon icon={tablerCheck} width={12} height={12} />
									</span>
								)}
								{status === "active" && (
									<span className="inline-block w-2 h-2 rounded-full bg-nova-violet-bright animate-pulse" />
								)}
								{status === "error" && (
									<span className="inline-block w-2 h-2 rounded-full bg-nova-rose" />
								)}
								<span>{displayStage.label}</span>
							</div>
						</div>
					);
				})}
			</div>

			{/* One continuous track; the visible background keeps the filled fraction
			    legible as progress rather than as an underline for the first label. */}
			<div
				role="progressbar"
				aria-label="App generation progress"
				aria-valuemin={0}
				aria-valuemax={100}
				aria-valuenow={progressPercent}
				className="relative mx-auto mt-3 h-[3px] w-[90%] rounded-full bg-nova-violet/15"
			>
				<motion.div
					className="h-full overflow-hidden rounded-full"
					style={{
						background: isError
							? "linear-gradient(90deg, var(--nova-violet), var(--nova-rose))"
							: "linear-gradient(90deg, var(--nova-violet), var(--nova-violet-bright))",
						boxShadow: isError
							? "0 0 8px var(--nova-rose)"
							: "0 0 8px var(--nova-violet)",
					}}
					initial={false}
					animate={{ width: `${progressPercent}%` }}
					transition={{ type: "spring", stiffness: 100, damping: 20 }}
				/>
				<motion.span
					aria-hidden="true"
					data-progress-marker=""
					className={`absolute top-1/2 block h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full ${
						isError ? "bg-nova-rose" : "bg-nova-violet-bright"
					}`}
					style={{
						boxShadow: isError
							? "0 0 8px var(--nova-rose)"
							: "0 0 8px var(--nova-violet)",
					}}
					initial={false}
					animate={{ left: `${progressPercent}%` }}
					transition={{ type: "spring", stiffness: 100, damping: 20 }}
				/>
			</div>

			{/* Only the error region animates. Keeping the card and phase row out of
			    Motion's layout animation prevents the active stage text from scaling. */}
			<motion.div
				data-generation-error-region=""
				aria-hidden={!showErrorMessage}
				className="grid"
				initial={false}
				animate={{
					gridTemplateRows: showErrorMessage ? "1fr" : "0fr",
					opacity: showErrorMessage ? 1 : 0,
					y: showErrorMessage ? 0 : -4,
				}}
				transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
			>
				<div className="min-h-0 overflow-hidden">
					{lastErrorMessageRef.current && (
						<p
							data-generation-error=""
							className="text-nova-rose mt-3 text-center text-xs"
						>
							{lastErrorMessageRef.current}
						</p>
					)}
				</div>
			</motion.div>
		</div>
	);
}
