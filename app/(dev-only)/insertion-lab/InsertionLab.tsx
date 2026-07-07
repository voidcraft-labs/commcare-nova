"use client";
/**
 * InsertionLab — interactive tuning bench for the insertion-intent model.
 *
 * Two mock columns (form-canvas-like 24px gaps between 72px cards; app-tree-
 * like 14px strips between 36px rows) whose gaps are REAL insertion zones on
 * the REAL model, so what you feel here is what the builder ships. Beside
 * them: a live HUD (speed / dwell / evidence / status), an open-close event
 * log, sliders over every config knob, and a pointer-trace recorder whose
 * JSON export captures samples + transitions + the active config — n=1 real
 * mouse data for tuning.
 *
 * Zones carry `data-lab-zone` / `data-status` so automation can assert
 * open/closed states.
 */
import { Icon } from "@iconify/react/offline";
import tablerPlus from "@iconify-icons/tabler/plus";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	INSERTION_CIRCLE_CLS,
	insertionCircleStyle,
	insertionLineCls,
	insertionLineStyle,
} from "@/components/ui/insertionReveal";
import {
	InsertionIntentProvider,
	useInsertionIntentDebug,
	useInsertionZone,
} from "@/lib/ui/hooks/useInsertionZone";
import {
	DEFAULT_INSERTION_INTENT_CONFIG,
	type InsertionIntentConfig,
} from "@/lib/ui/insertionIntent";

export function InsertionLab() {
	return (
		<InsertionIntentProvider>
			<div className="min-h-screen bg-nova-void text-nova-text p-8">
				<h1 className="text-lg font-semibold mb-1">Insertion Lab</h1>
				<p className="text-sm text-nova-text-muted mb-6 max-w-2xl">
					Try: (1) swipe fast across all gaps — none should open; (2) move to a
					gap deliberately — it opens as you arrive; (3) flick and stop dead on
					a gap — it opens after a beat; (4) with one open, glide to a neighbor
					— it transfers quickly; (5) scroll with the pointer parked on a gap —
					it stays shut until you stop.
				</p>
				<div className="flex gap-10 items-start">
					{/* data-insertion-surface: same unobstructed-hit contract the
					 * builder surfaces declare. */}
					<div className="flex gap-10 items-start" data-insertion-surface>
						<MockFormColumn />
						<MockTreeColumn />
					</div>
					<div className="flex flex-col gap-6 w-96 shrink-0">
						<Hud />
						<ConfigPanel />
						<TraceRecorder />
					</div>
				</div>
			</div>
		</InsertionIntentProvider>
	);
}

// ── Mock canvases ─────────────────────────────────────────────────────

const FORM_CARDS = ["1", "2", "3", "4", "5", "6", "7", "8"] as const;
const TREE_ROWS = ["1", "2", "3", "4", "5", "6"] as const;

function MockFormColumn() {
	return (
		<div className="w-80 shrink-0">
			<h2 className="text-xs uppercase tracking-wider text-nova-text-muted mb-2">
				Form canvas (24px gaps)
			</h2>
			<LabGap id="form-0" height={24} />
			{FORM_CARDS.map((n) => (
				<div key={n}>
					<div className="h-[72px] rounded-lg border border-nova-border bg-nova-surface px-4 flex items-center text-sm text-nova-text-muted">
						Field {n}
					</div>
					<LabGap id={`form-${n}`} height={24} />
				</div>
			))}
		</div>
	);
}

function MockTreeColumn() {
	return (
		<div className="w-64 shrink-0">
			<h2 className="text-xs uppercase tracking-wider text-nova-text-muted mb-2">
				App tree (14px strips)
			</h2>
			<LabGap id="tree-0" height={14} />
			{TREE_ROWS.map((n) => (
				<div key={n}>
					<div className="h-9 rounded-md border border-nova-border bg-nova-surface px-3 flex items-center text-xs text-nova-text-muted">
						Module {n}
					</div>
					<LabGap id={`tree-${n}`} height={14} />
				</div>
			))}
		</div>
	);
}

/** A real insertion zone with the product reveal visuals (line glow + "+"). */
function LabGap({ id, height }: { id: string; height: number }) {
	const zone = useInsertionZone();
	const open = zone.status === "open";
	return (
		<div
			ref={zone.ref}
			className="relative"
			style={{ height }}
			data-lab-zone={id}
			data-status={zone.status}
		>
			<div className="absolute inset-x-0 top-1/2 -translate-y-1/2 flex items-center pointer-events-none">
				<div
					className={insertionLineCls("right")}
					style={insertionLineStyle(zone.progress, open)}
				/>
				<span
					className={`${INSERTION_CIRCLE_CLS} mx-1 h-5 w-5 shrink-0`}
					style={insertionCircleStyle(open)}
				>
					<Icon icon={tablerPlus} width="12" height="12" />
				</span>
				<div
					className={insertionLineCls("left")}
					style={insertionLineStyle(zone.progress, open)}
				/>
			</div>
		</div>
	);
}

// ── HUD ───────────────────────────────────────────────────────────────

function Hud() {
	const model = useInsertionIntentDebug();
	const [, force] = useState(0);
	const logRef = useRef<string[]>([]);
	const lastOpenRef = useRef<string | null>(null);
	const debugRef = useRef({
		speed: 0,
		trend: 0,
		settling: false,
		score: 0,
		dwellMs: 0,
	});

	// Poll the model each frame — a dev page can afford an always-on rAF.
	useEffect(() => {
		if (!model) return;
		let raf = 0;
		const loop = () => {
			const t = performance.now();
			debugRef.current = model.debugState(t);
			const snap = model.getSnapshot();
			if (snap.openId !== lastOpenRef.current) {
				const stamp = (t / 1000).toFixed(2);
				if (snap.openId) logRef.current.unshift(`${stamp}s  open`);
				else logRef.current.unshift(`${stamp}s  close`);
				logRef.current = logRef.current.slice(0, 12);
				lastOpenRef.current = snap.openId;
			}
			force((n) => n + 1);
			raf = requestAnimationFrame(loop);
		};
		raf = requestAnimationFrame(loop);
		return () => cancelAnimationFrame(raf);
	}, [model]);

	const d = debugRef.current;
	const snap = model?.getSnapshot();
	return (
		<div className="rounded-lg border border-nova-border bg-nova-surface p-4">
			<h2 className="text-xs uppercase tracking-wider text-nova-text-muted mb-3">
				Live model
			</h2>
			<div className="grid grid-cols-2 gap-y-1 text-sm font-mono">
				<span className="text-nova-text-muted">speed</span>
				<span>{d.speed.toFixed(0)} px/s</span>
				<span className="text-nova-text-muted">trend</span>
				<span>{d.trend.toFixed(0)} px/s</span>
				<span className="text-nova-text-muted">settling</span>
				<span>{d.settling ? "yes" : "—"}</span>
				<span className="text-nova-text-muted">dwell req.</span>
				<span>{d.dwellMs.toFixed(0)} ms</span>
				<span className="text-nova-text-muted">evidence</span>
				<span>{(d.score * 100).toFixed(0)}%</span>
				<span className="text-nova-text-muted">open</span>
				<span>{snap?.openId ? "yes" : "—"}</span>
			</div>
			<div className="mt-3 h-1.5 rounded bg-nova-void overflow-hidden">
				<div
					className="h-full bg-nova-violet transition-none"
					style={{ width: `${Math.min(100, d.score * 100)}%` }}
				/>
			</div>
			<div className="mt-3 text-[11px] font-mono text-nova-text-muted whitespace-pre leading-4 h-24 overflow-hidden">
				{logRef.current.join("\n") || "events…"}
			</div>
		</div>
	);
}

// ── Config sliders ────────────────────────────────────────────────────

const KNOBS: Array<{
	key: keyof InsertionIntentConfig;
	min: number;
	max: number;
	step: number;
	unit: string;
}> = [
	{ key: "minDwellMs", min: 0, max: 200, step: 5, unit: "ms" },
	{ key: "maxDwellMs", min: 100, max: 800, step: 10, unit: "ms" },
	{ key: "slowSpeed", min: 0, max: 400, step: 10, unit: "px/s" },
	{ key: "fastSpeed", min: 400, max: 3000, step: 50, unit: "px/s" },
	{ key: "speedRiseTauMs", min: 5, max: 100, step: 5, unit: "ms" },
	{ key: "speedFallTauMs", min: 20, max: 250, step: 5, unit: "ms" },
	{ key: "trendTauMs", min: 60, max: 400, step: 10, unit: "ms" },
	{ key: "settlingRatio", min: 0.5, max: 1, step: 0.01, unit: "×" },
	{ key: "scoreDecayTauMs", min: 20, max: 300, step: 10, unit: "ms" },
	{ key: "closeGraceMs", min: 0, max: 400, step: 10, unit: "ms" },
	{ key: "hitPadPx", min: 0, max: 16, step: 1, unit: "px" },
	{ key: "openPadPx", min: 0, max: 32, step: 1, unit: "px" },
	{ key: "warmWindowMs", min: 0, max: 1500, step: 50, unit: "ms" },
	{ key: "warmDwellFactor", min: 0.1, max: 1, step: 0.05, unit: "×" },
	{ key: "sampleGapResetMs", min: 40, max: 300, step: 10, unit: "ms" },
];

function ConfigPanel() {
	const model = useInsertionIntentDebug();
	const [cfg, setCfg] = useState<InsertionIntentConfig>(
		DEFAULT_INSERTION_INTENT_CONFIG,
	);

	const update = useCallback(
		(key: keyof InsertionIntentConfig, value: number) => {
			setCfg((prev) => {
				const next = { ...prev, [key]: value };
				model?.setConfig(next);
				return next;
			});
		},
		[model],
	);

	return (
		<div className="rounded-lg border border-nova-border bg-nova-surface p-4">
			<div className="flex items-center justify-between mb-3">
				<h2 className="text-xs uppercase tracking-wider text-nova-text-muted">
					Tuning
				</h2>
				<button
					type="button"
					className="text-[11px] text-nova-violet-bright hover:text-nova-text cursor-pointer"
					onClick={() => {
						setCfg(DEFAULT_INSERTION_INTENT_CONFIG);
						model?.setConfig(DEFAULT_INSERTION_INTENT_CONFIG);
					}}
				>
					Reset
				</button>
			</div>
			<div className="flex flex-col gap-2">
				{KNOBS.map(({ key, min, max, step, unit }) => (
					<label
						key={key}
						className="grid grid-cols-[9rem_1fr_4.5rem] items-center gap-2 text-[11px] font-mono"
					>
						<span className="text-nova-text-muted">{key}</span>
						<input
							type="range"
							min={min}
							max={max}
							step={step}
							value={cfg[key]}
							onChange={(e) => update(key, Number(e.target.value))}
							className="accent-[var(--nova-violet)]"
						/>
						<span>
							{cfg[key]}
							{unit}
						</span>
					</label>
				))}
			</div>
		</div>
	);
}

// ── Trace recorder ────────────────────────────────────────────────────

interface Trace {
	startedAt: number;
	config: InsertionIntentConfig;
	samples: Array<{ x: number; y: number; t: number }>;
	events: Array<{ t: number; kind: "open" | "close"; zone: string | null }>;
}

function TraceRecorder() {
	const model = useInsertionIntentDebug();
	const [recording, setRecording] = useState(false);
	const [lastTrace, setLastTrace] = useState<Trace | null>(null);
	const traceRef = useRef<Trace | null>(null);

	useEffect(() => {
		if (!recording || !model) return;
		const trace: Trace = {
			startedAt: performance.now(),
			config: model.getConfig(),
			samples: [],
			events: [],
		};
		traceRef.current = trace;
		const onMove = (e: PointerEvent) => {
			trace.samples.push({ x: e.clientX, y: e.clientY, t: e.timeStamp });
		};
		let lastOpen: string | null = null;
		const unsub = model.subscribe(() => {
			const snap = model.getSnapshot();
			if (snap.openId !== lastOpen) {
				trace.events.push({
					t: performance.now(),
					kind: snap.openId ? "open" : "close",
					zone: snap.openId ?? lastOpen,
				});
				lastOpen = snap.openId;
			}
		});
		document.addEventListener("pointermove", onMove, { passive: true });
		return () => {
			document.removeEventListener("pointermove", onMove);
			unsub();
		};
	}, [recording, model]);

	const stop = () => {
		setRecording(false);
		setLastTrace(traceRef.current);
	};

	const download = () => {
		if (!lastTrace) return;
		const blob = new Blob([JSON.stringify(lastTrace, null, 2)], {
			type: "application/json",
		});
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = "insertion-trace.json";
		a.click();
		URL.revokeObjectURL(url);
	};

	return (
		<div className="rounded-lg border border-nova-border bg-nova-surface p-4">
			<h2 className="text-xs uppercase tracking-wider text-nova-text-muted mb-3">
				Trace recorder
			</h2>
			<div className="flex items-center gap-2">
				{recording ? (
					<button
						type="button"
						onClick={stop}
						className="px-3 py-1.5 rounded-md bg-nova-rose text-nova-void text-xs font-medium cursor-pointer"
					>
						Stop
					</button>
				) : (
					<button
						type="button"
						onClick={() => setRecording(true)}
						className="px-3 py-1.5 rounded-md bg-nova-action text-white text-xs font-medium cursor-pointer"
					>
						Record
					</button>
				)}
				<button
					type="button"
					onClick={download}
					disabled={!lastTrace}
					className="px-3 py-1.5 rounded-md border border-nova-border text-xs cursor-pointer disabled:opacity-40"
				>
					Download JSON
				</button>
				{lastTrace && (
					<span className="text-[11px] text-nova-text-muted font-mono">
						{lastTrace.samples.length} samples · {lastTrace.events.length}{" "}
						events
					</span>
				)}
			</div>
		</div>
	);
}
