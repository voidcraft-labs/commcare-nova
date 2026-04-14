"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { SignalPanel } from "@/components/chat/SignalPanel";
import { BuilderPhase } from "@/lib/services/builder";
import { showToast } from "@/lib/services/toastStore";
import {
	type GenerationError,
	GenerationStage,
	STAGE_LABELS,
} from "@/lib/session/types";
import {
	defaultLabel,
	SignalGridController,
	type SignalMode,
} from "@/lib/signalGridController";

// ── Simulated error scenarios ──────────────────────────────────────────

interface ErrorScenario {
	name: string;
	description: string;
	run: (actions: ScenarioActions) => () => void;
}

interface ScenarioActions {
	setGridMode: (m: SignalMode) => void;
	setPhase: (p: BuilderPhase) => void;
	setStage: (s: GenerationStage | null) => void;
	setGenerationError: (e: GenerationError) => void;
	setStatusMessage: (m: string) => void;
	injectEnergy: (n: number) => void;
}

const errorScenarios: ErrorScenario[] = [
	{
		name: "Invalid API Key",
		description:
			"User enters a bad API key. Stream fails immediately after sending — toast + fatal error on first step.",
		run: ({
			setGridMode,
			setPhase,
			setStage,
			setGenerationError,
			setStatusMessage,
		}) => {
			// Start with sending — builder is still in Idle (no data-start-build received yet)
			setGridMode("sending");
			setPhase(BuilderPhase.Idle);
			setStage(null);
			setGenerationError(null);
			setStatusMessage("");

			const t1 = setTimeout(() => {
				// "Server responds with auth error" — show as toast only (Idle phase → no progress bar)
				setGridMode("error-fatal");
				setPhase(BuilderPhase.Generating);
				setStage(GenerationStage.DataModel);
				setGenerationError({
					message: "Your API key is invalid or expired. Check Settings.",
					severity: "failed",
				});
				setStatusMessage("Your API key is invalid or expired. Check Settings.");
				showToast(
					"error",
					"Generation failed",
					"Your API key is invalid or expired. Check Settings.",
				);
			}, 1500);

			return () => {
				clearTimeout(t1);
				setGridMode("idle");
				setPhase(BuilderPhase.Idle);
				setStage(null);
				setGenerationError(null);
				setStatusMessage("");
			};
		},
	},
	{
		name: "Mid-Build Stream Error",
		description:
			"Generation is progressing, then the stream breaks during Build phase. Progress bar freezes, then shows error.",
		run: ({
			setGridMode,
			setPhase,
			setStage,
			setGenerationError,
			setStatusMessage,
			injectEnergy,
		}) => {
			setPhase(BuilderPhase.Generating);
			setStage(GenerationStage.DataModel);
			setGenerationError(null);
			setStatusMessage(STAGE_LABELS[GenerationStage.DataModel]);
			setGridMode("building");

			const timers: ReturnType<typeof setTimeout>[] = [];
			const intervals: ReturnType<typeof setInterval>[] = [];

			const energyId = setInterval(
				() => injectEnergy(60 + Math.random() * 40),
				200,
			);
			intervals.push(energyId);

			// Progress through stages
			timers.push(
				setTimeout(() => {
					setStage(GenerationStage.Structure);
					setStatusMessage(STAGE_LABELS[GenerationStage.Structure]);
				}, 1500),
			);
			timers.push(
				setTimeout(() => {
					setStage(GenerationStage.Modules);
					setStatusMessage(STAGE_LABELS[GenerationStage.Modules]);
				}, 3000),
			);
			timers.push(setTimeout(() => injectEnergy(200), 3500));
			timers.push(
				setTimeout(() => {
					setStage(GenerationStage.Forms);
					setStatusMessage(STAGE_LABELS[GenerationStage.Forms]);
				}, 4500),
			);
			timers.push(setTimeout(() => injectEnergy(200), 5000));

			// Error at 6s — phase stays Generating, error is metadata
			timers.push(
				setTimeout(() => {
					clearInterval(energyId);
					setGridMode("error-fatal");
					setGenerationError({
						message: "The connection was interrupted. Please try again.",
						severity: "failed",
					});
					setStatusMessage("The connection was interrupted. Please try again.");
					showToast(
						"error",
						"Generation failed",
						"The connection was interrupted. Please try again.",
					);
				}, 6000),
			);

			return () => {
				intervals.forEach(clearInterval);
				timers.forEach(clearTimeout);
				setGridMode("idle");
				setPhase(BuilderPhase.Idle);
				setStage(null);
				setGenerationError(null);
				setStatusMessage("");
			};
		},
	},
	{
		name: "Rate Limited",
		description:
			"API returns 429 during schema generation. Toast appears, generation stops.",
		run: ({
			setGridMode,
			setPhase,
			setStage,
			setGenerationError,
			setStatusMessage,
			injectEnergy,
		}) => {
			setPhase(BuilderPhase.Generating);
			setStage(GenerationStage.DataModel);
			setGenerationError(null);
			setStatusMessage(STAGE_LABELS[GenerationStage.DataModel]);
			setGridMode("building");

			const timers: ReturnType<typeof setTimeout>[] = [];
			const energyId = setInterval(
				() => injectEnergy(30 + Math.random() * 20),
				150,
			);

			timers.push(
				setTimeout(() => {
					clearInterval(energyId);
					setGridMode("error-fatal");
					setGenerationError({
						message:
							"Rate limited by the AI service. Wait a moment and try again.",
						severity: "failed",
					});
					setStatusMessage(
						"Rate limited by the AI service. Wait a moment and try again.",
					);
					showToast(
						"error",
						"Rate limited",
						"Rate limited by the AI service. Wait a moment and try again.",
					);
				}, 2500),
			);

			return () => {
				clearInterval(energyId);
				timers.forEach(clearTimeout);
				setGridMode("idle");
				setPhase(BuilderPhase.Idle);
				setStage(null);
				setGenerationError(null);
				setStatusMessage("");
			};
		},
	},
	{
		name: "Overloaded — Retry Recovers",
		description:
			"API overloaded, SA tries to recover (warm reasoning), then succeeds. Warning toast, then progress resumes.",
		run: ({
			setGridMode,
			setPhase,
			setStage,
			setGenerationError,
			setStatusMessage,
			injectEnergy,
		}) => {
			setPhase(BuilderPhase.Generating);
			setStage(GenerationStage.Modules);
			setGenerationError(null);
			setStatusMessage(STAGE_LABELS[GenerationStage.Modules]);
			setGridMode("building");

			const timers: ReturnType<typeof setTimeout>[] = [];
			const intervals: ReturnType<typeof setInterval>[] = [];

			const buildId = setInterval(
				() => injectEnergy(50 + Math.random() * 40),
				200,
			);
			intervals.push(buildId);

			// Error at 2s — recovering (phase stays Generating)
			timers.push(
				setTimeout(() => {
					clearInterval(buildId);
					setGridMode("error-recovering");
					setGenerationError({
						message: "The AI service is currently overloaded. Retrying...",
						severity: "recovering",
					});
					setStatusMessage(
						"The AI service is currently overloaded. Retrying...",
					);
					showToast(
						"warning",
						"Service overloaded",
						"The AI service is currently overloaded. Retrying...",
					);

					const recoverEnergy = setInterval(
						() => injectEnergy(10 + Math.random() * 15),
						180,
					);
					intervals.push(recoverEnergy);

					// Recovery at 5s — error clears, stage advances
					timers.push(
						setTimeout(() => {
							clearInterval(recoverEnergy);
							setGridMode("building");
							setStage(GenerationStage.Forms);
							setGenerationError(null);
							setStatusMessage(STAGE_LABELS[GenerationStage.Forms]);
							showToast(
								"info",
								"Recovered",
								"Generation resumed successfully.",
							);

							const resumeEnergy = setInterval(
								() => injectEnergy(60 + Math.random() * 40),
								200,
							);
							intervals.push(resumeEnergy);

							timers.push(setTimeout(() => injectEnergy(200), 1000));
							timers.push(
								setTimeout(() => {
									clearInterval(resumeEnergy);
									setPhase(BuilderPhase.Ready);
									setStage(null);
									setStatusMessage("");
									setGridMode("idle");
								}, 3000),
							);
						}, 3000),
					);
				}, 2000),
			);

			return () => {
				intervals.forEach(clearInterval);
				timers.forEach(clearTimeout);
				setGridMode("idle");
				setPhase(BuilderPhase.Idle);
				setStage(null);
				setGenerationError(null);
				setStatusMessage("");
			};
		},
	},
	{
		name: "Compile Error Toast",
		description:
			"Non-generation error: compile/download fails. Just a toast, no grid or progress impact.",
		run: () => {
			showToast("error", "Compile failed", "Could not generate the .ccz file.");
			return () => {};
		},
	},
	{
		name: "Toast Stack",
		description:
			"Multiple toasts in quick succession to test stacking and dismiss behavior.",
		run: () => {
			showToast("error", "Stream error", "The connection was interrupted.");
			setTimeout(
				() => showToast("warning", "Retrying...", "Attempting to reconnect."),
				800,
			);
			setTimeout(
				() => showToast("info", "Recovered", "Generation resumed."),
				2000,
			);
			return () => {};
		},
	},
];

// ── Page ───────────────────────────────────────────────────────────────

export default function ErrorTestPage() {
	const [activeScenario, setActiveScenario] = useState<number | null>(null);
	const [gridMode, setGridMode] = useState<SignalMode>("idle");
	const [phase, setPhase] = useState<BuilderPhase>(BuilderPhase.Idle);
	/* Stage/error/status state — used by the error scenario runner to drive
	 * generation lifecycle simulations. GenerationProgress self-subscribes from
	 * the store in production, but these are needed here for the scenario
	 * callbacks that simulate generation state transitions. */
	const [, setStage] = useState<GenerationStage | null>(null);
	const [, setGenerationError] = useState<GenerationError>(null);
	const [, setStatusMessage] = useState("");
	const controllerRef = useRef<SignalGridController | null>(null);
	const energyRef = useRef(0);
	const thinkEnergyRef = useRef(0);
	const cleanupRef = useRef<(() => void) | null>(null);

	const gridCallbackRef = useCallback((el: HTMLDivElement | null) => {
		if (!el) return;
		const ctrl = new SignalGridController({
			consumeEnergy: () => {
				const e = energyRef.current;
				energyRef.current = 0;
				return e;
			},
			consumeThinkEnergy: () => {
				const e = thinkEnergyRef.current;
				thinkEnergyRef.current = 0;
				return e;
			},
		});
		controllerRef.current = ctrl;
		ctrl.attach(el);
		ctrl.powerOn();
		return () => {
			ctrl.detach();
			controllerRef.current = null;
		};
	}, []);

	useEffect(() => {
		const ctrl = controllerRef.current;
		if (!ctrl) return;
		ctrl.setMode(gridMode);
		if (gridMode !== "idle") ctrl.powerOn();
	}, [gridMode]);

	const injectEnergy = useCallback((n: number) => {
		energyRef.current += n;
	}, []);

	const runScenario = useCallback(
		(index: number) => {
			cleanupRef.current?.();
			setActiveScenario(index);
			energyRef.current = 0;
			cleanupRef.current = errorScenarios[index].run({
				setGridMode,
				setPhase,
				setStage,
				setGenerationError,
				setStatusMessage,
				injectEnergy,
			});
		},
		[injectEnergy],
	);

	const stopScenario = useCallback(() => {
		cleanupRef.current?.();
		cleanupRef.current = null;
		setGridMode("idle");
		setPhase(BuilderPhase.Idle);
		setStage(null);
		setGenerationError(null);
		setStatusMessage("");
		setActiveScenario(null);
	}, []);

	return (
		<div className="min-h-screen bg-nova-void text-nova-text p-8">
			<div className="max-w-3xl mx-auto space-y-8">
				<div>
					<h1 className="text-2xl font-display font-medium mb-1">
						Error System Test
					</h1>
					<p className="text-sm text-nova-text-secondary">
						Simulate error scenarios to see toasts, signal grid error modes, and
						progress error states together.
					</p>
				</div>

				{/* Live preview — grid then progress stacked */}
				<div className="space-y-4">
					{/* Signal Grid */}
					<div className="space-y-2">
						<span className="text-xs text-nova-text-muted uppercase tracking-wider font-mono">
							Signal Grid
						</span>
						<div className="bg-nova-deep border border-nova-border rounded-xl p-4">
							<SignalPanel
								active={gridMode !== "idle"}
								label={defaultLabel(gridMode)}
								error={gridMode === "error-fatal"}
								recovering={gridMode === "error-recovering"}
							>
								<div ref={gridCallbackRef} className="signal-grid" />
							</SignalPanel>
						</div>
					</div>

					{/* GenerationProgress removed — it self-subscribes from the Zustand
					 *  store, which this dev page doesn't provide. The error scenarios
					 *  still drive the signal grid via the controller ref below. */}
				</div>

				{/* Current state readout */}
				<div className="flex gap-4 text-xs font-mono">
					<div className="px-3 py-1.5 rounded border border-nova-border bg-nova-surface">
						phase: <span className="text-nova-violet-bright">{phase}</span>
					</div>
					<div className="px-3 py-1.5 rounded border border-nova-border bg-nova-surface">
						mode: <span className="text-nova-violet-bright">{gridMode}</span>
					</div>
				</div>

				{/* Manual toast triggers */}
				<div className="space-y-2">
					<span className="text-xs text-nova-text-muted uppercase tracking-wider font-mono">
						Manual Toast Triggers
					</span>
					<div className="flex gap-2 flex-wrap">
						<button
							type="button"
							onClick={() =>
								showToast(
									"error",
									"Test Error",
									"Something went wrong during generation.",
								)
							}
							className="text-xs px-3 py-1.5 rounded border border-nova-rose/40 bg-nova-rose/10 text-nova-rose hover:bg-nova-rose/20 transition-colors cursor-pointer font-mono"
						>
							Error Toast
						</button>
						<button
							type="button"
							onClick={() =>
								showToast(
									"warning",
									"Test Warning",
									"The AI service is retrying...",
								)
							}
							className="text-xs px-3 py-1.5 rounded border border-nova-amber/40 bg-nova-amber/10 text-nova-amber hover:bg-nova-amber/20 transition-colors cursor-pointer font-mono"
						>
							Warning Toast
						</button>
						<button
							type="button"
							onClick={() =>
								showToast(
									"info",
									"Test Info",
									"Generation resumed successfully.",
								)
							}
							className="text-xs px-3 py-1.5 rounded border border-nova-violet/40 bg-nova-violet/10 text-nova-violet-bright hover:bg-nova-violet/20 transition-colors cursor-pointer font-mono"
						>
							Info Toast
						</button>
					</div>
				</div>

				{/* Scenarios */}
				<div className="space-y-3">
					<span className="text-xs text-nova-text-muted uppercase tracking-wider font-mono">
						Error Scenarios
					</span>
					<div className="grid gap-2">
						{errorScenarios.map((s, i) => (
							<div
								key={s.name}
								className={`flex items-center gap-3 p-3 rounded-lg border transition-colors ${
									activeScenario === i
										? "border-nova-rose/40 bg-nova-rose/5"
										: "border-nova-border hover:border-nova-border-bright"
								}`}
							>
								<div className="flex-1 min-w-0">
									<div className="text-sm font-medium">{s.name}</div>
									<div className="text-xs text-nova-text-muted mt-0.5">
										{s.description}
									</div>
								</div>
								{activeScenario === i ? (
									<button
										type="button"
										onClick={stopScenario}
										className="shrink-0 text-xs px-3 py-1.5 rounded border border-nova-rose/40 bg-nova-rose/10 text-nova-rose hover:bg-nova-rose/20 transition-colors cursor-pointer font-mono"
									>
										Stop
									</button>
								) : (
									<button
										type="button"
										onClick={() => runScenario(i)}
										className="shrink-0 text-xs px-3 py-1.5 rounded border border-nova-violet/40 bg-nova-violet/10 text-nova-violet-bright hover:bg-nova-violet/20 transition-colors cursor-pointer font-mono"
									>
										Run
									</button>
								)}
							</div>
						))}
					</div>
				</div>
			</div>
		</div>
	);
}
