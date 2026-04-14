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
import { useCallback, useRef, useState } from "react";
import {
	useAgentError,
	useAgentStage,
	useStatusMessage,
} from "@/lib/session/hooks";
import { GenerationStage } from "@/lib/session/types";

/** Display stages — Modules+Forms are combined into "Build" */
const baseStages: { key: string; stages: GenerationStage[]; label: string }[] =
	[
		{
			key: "data-model",
			stages: [GenerationStage.DataModel],
			label: "Data Model",
		},
		{
			key: "structure",
			stages: [GenerationStage.Structure],
			label: "Structure",
		},
		{
			key: "build",
			stages: [GenerationStage.Modules, GenerationStage.Forms],
			label: "Build",
		},
		{ key: "validate", stages: [GenerationStage.Validate], label: "Validate" },
	];

/** Ordered list of generation stages for determining relative position. */
const stageOrder = [
	GenerationStage.DataModel,
	GenerationStage.Structure,
	GenerationStage.Modules,
	GenerationStage.Forms,
	GenerationStage.Validate,
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

/** Map generation stage to its display stage index (0-based, + stageCount for Done). */
function getStageIndex(
	stage: GenerationStage | null,
	stageCount: number,
): number {
	if (!stage) return stageCount;
	const map: Record<string, number> = {
		[GenerationStage.DataModel]: 0,
		[GenerationStage.Structure]: 1,
		[GenerationStage.Modules]: 2,
		[GenerationStage.Forms]: 2,
		[GenerationStage.Validate]: 3,
		[GenerationStage.Fix]: 4,
	};
	return map[stage] ?? 0;
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

	// Refs for measuring label centers
	const containerRef = useRef<HTMLDivElement>(null);
	const barElRef = useRef<HTMLDivElement>(null);
	const labelRefs = useRef<Map<number, HTMLDivElement>>(new Map());
	const [labelCenters, setLabelCenters] = useState<number[]>([]);

	const setLabelRef = useCallback(
		(idx: number) => (el: HTMLDivElement | null) => {
			if (el) labelRefs.current.set(idx, el);
			else labelRefs.current.delete(idx);
		},
		[],
	);

	// Measure label centers via ref callback + ResizeObserver.
	// The ResizeObserver is tracked in a ref so it can be disconnected when the
	// callback identity changes (useCallback deps shift when Fix stage appears).
	// Without this, the null call from the old callback would skip cleanup.
	const roRef = useRef<ResizeObserver | null>(null);
	const barRefCallback = useCallback(
		(el: HTMLDivElement | null) => {
			roRef.current?.disconnect();
			roRef.current = null;
			barElRef.current = el;
			if (!el) return;

			const measure = () => {
				const barRect = el.getBoundingClientRect();
				if (barRect.width === 0) return;
				const totalLabels = displayStages.length + 1; // stages + Done
				const centers: number[] = [];
				for (let i = 0; i < totalLabels; i++) {
					const labelEl = labelRefs.current.get(i);
					if (labelEl) {
						const r = labelEl.getBoundingClientRect();
						const centerX = r.left + r.width / 2 - barRect.left;
						centers[i] = (centerX / barRect.width) * 100;
					}
				}
				setLabelCenters(centers);
			};

			measure();
			const ro = new ResizeObserver(measure);
			ro.observe(el);
			roRef.current = ro;
			return () => {
				ro.disconnect();
				roRef.current = null;
			};
		},
		[displayStages.length],
	);

	// Compute progress bar width — snap to the measured center of the active stage.
	// On error, use the last active stage so the bar freezes at the point of failure.
	let pct = 0;
	if (labelCenters.length > 0) {
		const stageIdx = getStageIndex(
			isError ? lastActiveStageRef.current : stage,
			displayStages.length,
		);
		pct = labelCenters[stageIdx] ?? 0;
	}

	return (
		<motion.div
			layout
			layoutId="generation-progress"
			ref={containerRef}
			transition={{ layout: { duration: 0.5, ease: [0.4, 0, 0.2, 1] } }}
			className="relative rounded-xl shadow-lg backdrop-blur-sm border border-nova-violet/30 bg-nova-surface/90 px-8 py-5 shadow-nova-violet/10 min-w-[400px]"
		>
			{/* Stage indicators */}
			<div className="flex items-center gap-3">
				{displayStages.map((displayStage, i) => {
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
								<span ref={setLabelRef(i)}>{displayStage.label}</span>
							</div>
							<span
								className={`text-sm transition-colors duration-300 ${
									status === "done"
										? "text-nova-emerald/40"
										: "text-nova-text-muted/40"
								}`}
							>
								&mdash;
							</span>
						</div>
					);
				})}

				{/* Done — terminal label, never active while card is mounted */}
				<div className="flex items-center gap-1.5 text-sm font-medium text-nova-text-muted">
					<span ref={setLabelRef(displayStages.length)}>Done</span>
				</div>
			</div>

			{/* Progress bar */}
			<div
				ref={barRefCallback}
				className="mt-3 h-[3px] rounded-full bg-nova-surface overflow-hidden"
			>
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
					className="text-nova-rose/80 mt-1.5 text-xs"
				>
					{statusMessage}
				</motion.p>
			)}
		</motion.div>
	);
}
