"use client";

import { useEffect, useRef, useState } from "react";
import { GenerationProgressCard } from "@/components/builder/GenerationProgress";
import { Button } from "@/components/shadcn/button";
import { GenerationStage } from "@/lib/session/types";

const states = {
	setup: {
		label: "Set Up",
		stage: GenerationStage.Foundation,
		generationError: null,
		statusMessage: "",
	},
	build: {
		label: "Build",
		stage: GenerationStage.Build,
		generationError: null,
		statusMessage: "",
	},
	error: {
		label: "Build Error",
		stage: GenerationStage.Build,
		generationError: {
			message: "Could not finish building the app.",
			severity: "failed" as const,
		},
		statusMessage: "Could not finish building the app.",
	},
	fix: {
		label: "Historical Fix",
		stage: GenerationStage.Fix,
		generationError: null,
		statusMessage: "",
	},
};

type PreviewState = keyof typeof states;

export function ProgressPreview() {
	const [selected, setSelected] = useState<PreviewState>("setup");
	const [hydrated, setHydrated] = useState(false);
	const [playing, setPlaying] = useState(false);
	const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
	const state = states[selected];

	function clearSequence() {
		for (const timer of timersRef.current) clearTimeout(timer);
		timersRef.current = [];
		setPlaying(false);
	}

	useEffect(() => {
		setHydrated(true);
		return () => {
			for (const timer of timersRef.current) clearTimeout(timer);
		};
	}, []);

	function selectState(next: PreviewState) {
		clearSequence();
		setSelected(next);
	}

	function playSequence() {
		clearSequence();
		setPlaying(true);
		setSelected("setup");
		timersRef.current = [
			setTimeout(() => setSelected("build"), 1600),
			setTimeout(() => setSelected("error"), 3200),
			setTimeout(() => setSelected("fix"), 4800),
			setTimeout(() => {
				setPlaying(false);
				timersRef.current = [];
			}, 6400),
		];
	}

	return (
		<main className="min-h-screen bg-nova-bg px-[45px] pt-[88px]">
			<div className="mx-auto w-full max-w-[800px]">
				<div className="mb-8">
					<div className="flex items-center gap-3">
						<h1 className="text-lg font-semibold text-nova-text">
							Generation progress preview
						</h1>
						<span
							data-hydrated={hydrated ? "true" : "false"}
							className={`rounded-full px-2 py-0.5 text-xs ${
								hydrated
									? "bg-nova-emerald/15 text-nova-emerald"
									: "bg-nova-surface text-nova-text-muted"
							}`}
						>
							{hydrated ? "Interactive" : "Waiting for JavaScript"}
						</span>
					</div>
					<p className="mt-1 text-sm text-nova-text-muted">
						This imports and drives the real mounted GenerationProgressCard. The
						stage anchors and bar share one width while the indicator centers
						beneath the active phase.
					</p>
				</div>

				<div className="mb-5 flex flex-wrap items-center gap-2">
					{Object.entries(states).map(([key, option]) => {
						const isSelected = selected === key;
						return (
							<Button
								key={key}
								onClick={() => selectState(key as PreviewState)}
								aria-pressed={isSelected}
								variant={isSelected ? "secondary" : "outline"}
							>
								{option.label}
							</Button>
						);
					})}
					<div className="mx-1 h-5 w-px bg-nova-border" />
					<Button
						onClick={playing ? clearSequence : playSequence}
						variant="outline"
						className="rounded-lg border border-nova-emerald/50 bg-nova-emerald/10 px-3 py-1.5 text-sm text-nova-emerald transition-colors not-disabled:hover:bg-nova-emerald/15"
					>
						{playing ? "Stop sequence" : "Play sequence"}
					</Button>
				</div>

				<p aria-live="polite" className="mb-3 text-xs text-nova-text-muted">
					Current state: {state.label}
				</p>

				<GenerationProgressCard
					stage={state.stage}
					generationError={state.generationError}
					statusMessage={state.statusMessage}
				/>
			</div>
		</main>
	);
}
